import nodemailer from 'nodemailer';
import type { PluginContext } from '@omadia/plugin-api';

/**
 * The `smtp_send_email` tool handler — all of the plugin's security posture
 * lives here:
 *
 *   - The sender is FIXED to `from_address` config. Any agent-supplied sender
 *     is impossible (there is no `from` input field) — defence in depth, the
 *     schema simply omits it.
 *   - Every recipient is checked against the operator allow-list. An empty
 *     allow-list rejects everything (fail closed).
 *   - Header-injection is blocked: CR/LF/NUL in any address or the subject is
 *     rejected before nodemailer ever sees it.
 *   - TLS is required unless the operator explicitly opted out for a trusted
 *     local relay.
 *   - Attachment bytes are size-capped; URL attachments only work when the
 *     operator allow-listed the source host for HTTP (ctx.http present).
 */

export const SMTP_TOOL_NAME = 'smtp_send_email';

export const SMTP_TOOL_SPEC = {
  name: SMTP_TOOL_NAME,
  description:
    'Send an email (optionally with attachments) through the configured SMTP server. The sender is fixed by the operator; recipients must pass the operator allow-list.',
  input_schema: {
    type: 'object' as const,
    required: ['to', 'subject'],
    properties: {
      to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses.' },
      cc: { type: 'array', items: { type: 'string' }, description: 'Carbon-copy addresses.' },
      bcc: { type: 'array', items: { type: 'string' }, description: 'Blind-carbon-copy addresses.' },
      subject: { type: 'string', description: 'Email subject line.' },
      text: { type: 'string', description: 'Plain-text body.' },
      html: { type: 'string', description: 'HTML body (only if the operator enabled HTML).' },
      attachments: {
        type: 'array',
        description: 'Optional file attachments.',
        items: {
          type: 'object',
          required: ['filename'],
          properties: {
            filename: { type: 'string' },
            content_base64: { type: 'string' },
            url: { type: 'string' },
            content_type: { type: 'string' },
          },
        },
      },
    },
  },
};

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  requireTls: boolean;
  user: string | undefined;
  pass: string | undefined;
  fromAddress: string;
  fromName: string | undefined;
  allowEntries: string[];
  allowHtml: boolean;
  maxAttachmentBytes: number;
  maxRecipients: number;
}

interface AttachmentInput {
  filename?: unknown;
  content_base64?: unknown;
  url?: unknown;
  content_type?: unknown;
}

interface EmailInput {
  to?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
  attachments?: unknown;
}

/** A value the tool returns to the model — always serialised JSON. */
function reply(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function fail(error: string): string {
  return reply({ ok: false, error });
}

/** Reject control characters that enable SMTP header injection. */
function hasControlChars(value: string): boolean {
  return /[\r\n\0]/.test(value);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normaliseAddress(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 254) return undefined;
  if (hasControlChars(trimmed)) return undefined;
  if (!EMAIL_RE.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

function toStringArray(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

/** Parse the operator allow-list textarea into normalised entries. */
export function parseAllowlist(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(/[\r\n,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

/**
 * Allow-list match. Entry forms:
 *   - `*`               → allow anyone (operator opt-in to unrestricted)
 *   - `alice@acme.com`  → exact full-address match
 *   - `@acme.com`       → any address in that domain
 *   - `acme.com`        → any address in that domain (bare domain)
 */
export function isRecipientAllowed(address: string, entries: string[]): boolean {
  const addr = address.toLowerCase();
  const at = addr.lastIndexOf('@');
  const domain = at >= 0 ? addr.slice(at + 1) : '';
  for (const entry of entries) {
    if (entry === '*') return true;
    if (entry.includes('@')) {
      if (entry.startsWith('@')) {
        if (domain === entry.slice(1)) return true;
      } else if (addr === entry) {
        return true;
      }
    } else if (domain === entry) {
      return true;
    }
  }
  return false;
}

function readConfig(ctx: PluginContext): SmtpConfig | { error: string } {
  const host = (ctx.config.get<string>('smtp_host') ?? '').trim();
  if (!host) return { error: 'smtp_host is not configured' };
  const portRaw = ctx.config.get<number | string>('smtp_port');
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { error: 'smtp_port is not a valid port' };
  }
  const fromAddress = normaliseAddress(ctx.config.get<string>('from_address'));
  if (!fromAddress) return { error: 'from_address is missing or invalid' };

  // The display name lands in the From header — guard it against CR/LF/NUL
  // header injection exactly like the subject and addresses.
  const fromName = (ctx.config.get<string>('from_name') ?? '').trim() || undefined;
  if (fromName && hasControlChars(fromName)) {
    return { error: 'from_name must not contain line breaks' };
  }

  const allowEntries = parseAllowlist(ctx.config.get<string>('recipient_allowlist'));

  const maxAttachmentMb = Number(ctx.config.get<number | string>('max_attachment_mb') ?? 10);
  const maxRecipients = Number(ctx.config.get<number | string>('max_recipients') ?? 25);

  return {
    host,
    port,
    secure: ctx.config.get<boolean>('smtp_secure') === true,
    requireTls: ctx.config.get<boolean>('smtp_require_tls') !== false,
    user: (ctx.config.get<string>('smtp_user') ?? '').trim() || undefined,
    pass: undefined, // filled from the vault in the handler
    fromAddress,
    fromName,
    allowEntries,
    allowHtml: ctx.config.get<boolean>('allow_html') !== false,
    maxAttachmentBytes: (Number.isFinite(maxAttachmentMb) ? maxAttachmentMb : 10) * 1024 * 1024,
    maxRecipients: Number.isFinite(maxRecipients) && maxRecipients > 0 ? Math.floor(maxRecipients) : 25,
  };
}

interface ResolvedAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

async function resolveAttachments(
  ctx: PluginContext,
  raw: unknown,
  maxBytes: number,
): Promise<ResolvedAttachment[] | { error: string }> {
  const list = Array.isArray(raw) ? (raw as AttachmentInput[]) : [];
  const out: ResolvedAttachment[] = [];
  let total = 0;

  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const filename = typeof item.filename === 'string' ? item.filename.trim() : '';
    if (!filename || hasControlChars(filename) || filename.includes('/') || filename.includes('\\')) {
      return { error: `attachment has a missing or unsafe filename` };
    }

    const overLimit = (): { error: string } => ({
      error: `attachments exceed the ${String(Math.round(maxBytes / 1024 / 1024))} MB limit`,
    });

    let content: Buffer | undefined;
    if (typeof item.content_base64 === 'string' && item.content_base64.length > 0) {
      // Reject by the cheap decoded-size upper bound BEFORE allocating the
      // buffer, so a huge base64 string can't blow memory ahead of the check.
      const estimated = Math.floor((item.content_base64.length * 3) / 4);
      if (total + estimated > maxBytes) return overLimit();
      try {
        content = Buffer.from(item.content_base64, 'base64');
      } catch {
        return { error: `attachment '${filename}' has invalid base64 content` };
      }
    } else if (typeof item.url === 'string' && item.url.length > 0) {
      if (!ctx.http) {
        return {
          error: `attachment '${filename}' is a URL but this install has no HTTP egress allow-listed — provide content_base64 instead, or have the operator allow-list the source host`,
        };
      }
      try {
        const res = await ctx.http.fetch(item.url);
        if (!res.ok) return { error: `failed to fetch attachment '${filename}' (HTTP ${String(res.status)})` };
        // Pre-check a declared Content-Length so an oversized body is rejected
        // before it is read into memory. (A lying/absent length still hits the
        // post-buffer cap below.) Tolerate both Headers and plain-object shapes.
        const headers = res.headers as unknown;
        const rawLen =
          headers && typeof (headers as { get?: unknown }).get === 'function'
            ? (headers as { get(name: string): string | null }).get('content-length')
            : (headers as Record<string, string> | undefined)?.['content-length'];
        const declared = rawLen ? Number(rawLen) : NaN;
        if (Number.isFinite(declared) && total + declared > maxBytes) return overLimit();
        content = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        return { error: `failed to fetch attachment '${filename}': ${(err as Error).message}` };
      }
    } else {
      return { error: `attachment '${filename}' has neither content_base64 nor url` };
    }

    total += content.length;
    if (total > maxBytes) return overLimit();

    out.push({
      filename,
      content,
      ...(typeof item.content_type === 'string' && item.content_type.trim()
        ? { contentType: item.content_type.trim() }
        : {}),
    });
  }
  return out;
}

export function createSmtpToolHandler(ctx: PluginContext) {
  return async function handle(rawInput: unknown): Promise<string> {
    try {
      const cfg = readConfig(ctx);
      if ('error' in cfg) return fail(cfg.error);

      if (!ctx.net) {
        return fail(
          'no raw-TCP egress available (ctx.net is unset) — the core may predate permissions.network.outbound_tcp, or smtp_host/smtp_port are unset',
        );
      }

      const input = (rawInput ?? {}) as EmailInput;

      // --- subject -------------------------------------------------------
      const subject = typeof input.subject === 'string' ? input.subject : '';
      if (!subject.trim()) return fail('subject is required');
      if (hasControlChars(subject)) return fail('subject must not contain line breaks');

      // --- recipients + allow-list --------------------------------------
      if (cfg.allowEntries.length === 0) {
        return fail('the recipient allow-list is empty — the operator must configure who may be emailed');
      }
      const buckets: Array<['to' | 'cc' | 'bcc', string[]]> = [
        ['to', toStringArray(input.to)],
        ['cc', toStringArray(input.cc)],
        ['bcc', toStringArray(input.bcc)],
      ];
      const resolved: Record<'to' | 'cc' | 'bcc', string[]> = { to: [], cc: [], bcc: [] };
      const blocked: string[] = [];
      let count = 0;
      for (const [field, addrs] of buckets) {
        for (const a of addrs) {
          const norm = normaliseAddress(a);
          if (!norm) return fail(`invalid recipient address: ${JSON.stringify(a)}`);
          if (!isRecipientAllowed(norm, cfg.allowEntries)) {
            blocked.push(norm);
            continue;
          }
          resolved[field].push(norm);
          count += 1;
        }
      }
      if (blocked.length > 0) {
        return fail(`these recipients are not on the operator allow-list: ${blocked.join(', ')}`);
      }
      if (resolved.to.length === 0) {
        return fail('at least one allowed "to" recipient is required');
      }
      if (count > cfg.maxRecipients) {
        return fail(`too many recipients (${String(count)}) — the limit is ${String(cfg.maxRecipients)}`);
      }

      // --- body ----------------------------------------------------------
      const text = typeof input.text === 'string' ? input.text : undefined;
      let html = typeof input.html === 'string' ? input.html : undefined;
      if (html && !cfg.allowHtml) {
        return fail('HTML bodies are disabled by the operator — send a plain-text body instead');
      }
      if (!text && !html) return fail('an email body is required (text and/or html)');

      // --- attachments ---------------------------------------------------
      const attResult = await resolveAttachments(ctx, input.attachments, cfg.maxAttachmentBytes);
      if ('error' in attResult) return fail(attResult.error);

      // --- credentials ---------------------------------------------------
      const pass = (await ctx.secrets.get('smtp_password')) ?? undefined;
      if (cfg.user && !pass) {
        return fail('smtp_user is set but smtp_password is missing in the vault');
      }

      // --- send ----------------------------------------------------------
      const transport = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        // Force STARTTLS on the plaintext port unless the operator opted out.
        requireTLS: !cfg.secure && cfg.requireTls,
        ...(cfg.user ? { auth: { user: cfg.user, pass: pass ?? '' } } : {}),
        tls: { servername: cfg.host, minVersion: 'TLSv1.2' },
        // Route the socket through the kernel's allow-listed raw-TCP egress,
        // instead of letting nodemailer open its own connection. This is what
        // keeps the plugin inside permissions.network.outbound_tcp.
        getSocket(_options: unknown, callback: (err: Error | null, info?: unknown) => void): void {
          ctx
            .net!.connect({ host: cfg.host, port: cfg.port, tls: cfg.secure, servername: cfg.host })
            .then((socket) => callback(null, { connection: socket, secured: cfg.secure }))
            .catch((err: Error) => callback(err));
        },
      } as Parameters<typeof nodemailer.createTransport>[0]);

      try {
        const info = await transport.sendMail({
          from: cfg.fromName ? { name: cfg.fromName, address: cfg.fromAddress } : cfg.fromAddress,
          to: resolved.to,
          ...(resolved.cc.length ? { cc: resolved.cc } : {}),
          ...(resolved.bcc.length ? { bcc: resolved.bcc } : {}),
          subject,
          ...(text ? { text } : {}),
          ...(html ? { html } : {}),
          ...(attResult.length
            ? {
                attachments: attResult.map((a) => ({
                  filename: a.filename,
                  content: a.content,
                  ...(a.contentType ? { contentType: a.contentType } : {}),
                })),
              }
            : {}),
        });

        return reply({
          ok: true,
          messageId: info.messageId,
          accepted: (info.accepted ?? []).map(String),
          rejected: (info.rejected ?? []).map(String),
        });
      } finally {
        transport.close();
      }
    } catch (err) {
      return fail(`send failed: ${(err as Error).message}`);
    }
  };
}
