/**
 * End-to-end integration test for the BUILT plugin bundle (dist/plugin.js)
 * against a real SMTP server (Mailpit).
 *
 * It calls `activate(ctx)` with a fake context whose `net.connect` opens a real
 * TCP socket (exactly what the core netAccessor returns on the happy path), then
 * drives the captured `smtp_send_email` handler through the security gates and
 * verifies delivery via the Mailpit API.
 *
 *   SMTP : 127.0.0.1:1026   API : http://127.0.0.1:8026
 *
 * Run:  node test/integration.mjs
 */
import net from 'node:net';
import { activate } from '../dist/plugin.js';

const SMTP_HOST = '127.0.0.1';
const SMTP_PORT = 1026;
const API = 'http://127.0.0.1:8026';

let pass = 0;
let fail = 0;
const ok = (name) => {
  pass++;
  console.log(`  ✓ ${name}`);
};
const bad = (name, detail) => {
  fail++;
  console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
};

function makeCtx(overrides = {}) {
  const config = {
    smtp_host: SMTP_HOST,
    smtp_port: SMTP_PORT,
    smtp_secure: false,
    smtp_require_tls: false,
    smtp_user: '',
    from_address: 'agent@omadia.local',
    from_name: 'Omadia Agent',
    recipient_allowlist: 'alice@acme.com\n@allowed.com',
    allow_html: true,
    max_attachment_mb: 10,
    max_recipients: 25,
    ...overrides,
  };
  let handler = null;
  const ctx = {
    agentId: '@omadia/plugin-smtp',
    domain: 'smtp.mail',
    config: { get: (k) => config[k] },
    secrets: { get: async () => undefined, require: async () => '' },
    net: {
      connect: ({ host, port }) =>
        new Promise((resolve, reject) => {
          const sock = net.connect({ host, port });
          sock.once('connect', () => resolve(sock));
          sock.once('error', reject);
        }),
    },
    http: undefined,
    tools: {
      register: (_spec, h) => {
        handler = h;
        return () => {};
      },
    },
    log: () => {},
  };
  return { ctx, getHandler: () => handler };
}

async function clearMailpit() {
  await fetch(`${API}/api/v1/messages`, { method: 'DELETE' });
}

async function latestMessage() {
  const res = await fetch(`${API}/api/v1/messages`);
  const body = await res.json();
  if (!body.messages || body.messages.length === 0) return null;
  const id = body.messages[0].ID;
  const detail = await fetch(`${API}/api/v1/message/${id}`);
  return detail.json();
}

async function run() {
  // sanity: Mailpit reachable
  try {
    await fetch(`${API}/api/v1/messages`);
  } catch (err) {
    console.error(`Mailpit not reachable at ${API}: ${err.message}`);
    process.exit(2);
  }

  // ---- Scenario 1: happy path with attachment + fixed-sender enforcement ----
  console.log('Scenario 1: happy path (allowed recipient, attachment, fixed sender)');
  await clearMailpit();
  {
    const { ctx, getHandler } = makeCtx();
    await activate(ctx);
    const handler = getHandler();
    const out = JSON.parse(
      await handler({
        from: 'attacker-spoof@evil.com', // must be IGNORED (no `from` honoured)
        to: ['alice@acme.com'],
        subject: 'Q3 summary',
        text: 'Hello from the agent.',
        attachments: [
          { filename: 'note.txt', content_base64: Buffer.from('attached bytes').toString('base64') },
        ],
      }),
    );
    if (out.ok) ok('handler returned ok');
    else bad('handler returned ok', out.error);

    const msg = await latestMessage();
    if (msg) ok('message delivered to Mailpit');
    else bad('message delivered to Mailpit');

    if (msg && msg.From?.Address === 'agent@omadia.local') ok('From is the fixed sender (spoof ignored)');
    else bad('From is the fixed sender', msg && msg.From?.Address);

    if (msg && msg.To?.some((t) => t.Address === 'alice@acme.com')) ok('To matches recipient');
    else bad('To matches recipient');

    if (msg && msg.Subject === 'Q3 summary') ok('Subject preserved');
    else bad('Subject preserved', msg && msg.Subject);

    if (msg && Array.isArray(msg.Attachments) && msg.Attachments.length === 1) ok('attachment present');
    else bad('attachment present', msg && JSON.stringify(msg.Attachments));
  }

  // ---- Scenario 2: recipient NOT on allow-list is blocked (no delivery) ----
  console.log('Scenario 2: recipient off allow-list is rejected');
  await clearMailpit();
  {
    const { ctx, getHandler } = makeCtx();
    await activate(ctx);
    const out = JSON.parse(
      await getHandler()({ to: ['mallory@evil.com'], subject: 'hi', text: 'x' }),
    );
    if (!out.ok && /allow-list/i.test(out.error)) ok('blocked with allow-list error');
    else bad('blocked with allow-list error', JSON.stringify(out));
    const msg = await latestMessage();
    if (!msg) ok('nothing delivered');
    else bad('nothing delivered', 'a message leaked through');
  }

  // ---- Scenario 3: domain-form allow-list entry (@allowed.com) ----
  console.log('Scenario 3: domain allow-list entry matches');
  await clearMailpit();
  {
    const { ctx, getHandler } = makeCtx();
    await activate(ctx);
    const out = JSON.parse(
      await getHandler()({ to: ['bob@allowed.com'], subject: 'domain ok', text: 'x' }),
    );
    if (out.ok) ok('domain-allowed recipient sent');
    else bad('domain-allowed recipient sent', out.error);
  }

  // ---- Scenario 4: header injection in subject is rejected ----
  console.log('Scenario 4: header injection blocked');
  {
    const { ctx, getHandler } = makeCtx();
    await activate(ctx);
    const out = JSON.parse(
      await getHandler()({ to: ['alice@acme.com'], subject: 'evil\r\nBcc: x@y.com', text: 'x' }),
    );
    if (!out.ok && /line break/i.test(out.error)) ok('CRLF subject rejected');
    else bad('CRLF subject rejected', JSON.stringify(out));
  }

  // ---- Scenario 5: empty allow-list fails closed ----
  console.log('Scenario 5: empty allow-list fails closed');
  {
    const { ctx, getHandler } = makeCtx({ recipient_allowlist: '' });
    await activate(ctx);
    const out = JSON.parse(
      await getHandler()({ to: ['alice@acme.com'], subject: 'hi', text: 'x' }),
    );
    if (!out.ok && /empty/i.test(out.error)) ok('empty allow-list blocks all');
    else bad('empty allow-list blocks all', JSON.stringify(out));
  }

  // ---- Scenario 6: HTML disabled by operator ----
  console.log('Scenario 6: HTML disabled by operator');
  {
    const { ctx, getHandler } = makeCtx({ allow_html: false });
    await activate(ctx);
    const out = JSON.parse(
      await getHandler()({ to: ['alice@acme.com'], subject: 'hi', html: '<b>x</b>' }),
    );
    if (!out.ok && /HTML/i.test(out.error)) ok('HTML body rejected when disabled');
    else bad('HTML body rejected when disabled', JSON.stringify(out));
  }

  // ---- Scenario 7: from_name header injection is rejected (config guard) ----
  console.log('Scenario 7: from_name header injection blocked');
  {
    const { ctx, getHandler } = makeCtx({ from_name: 'Evil\r\nBcc: x@y.com' });
    await activate(ctx);
    const out = JSON.parse(
      await getHandler()({ to: ['alice@acme.com'], subject: 'hi', text: 'x' }),
    );
    if (!out.ok && /from_name/i.test(out.error)) ok('CRLF from_name rejected');
    else bad('CRLF from_name rejected', JSON.stringify(out));
  }

  // ---- Scenario 8: oversized attachment rejected before send ----
  console.log('Scenario 8: oversized attachment rejected');
  await clearMailpit();
  {
    const { ctx, getHandler } = makeCtx({ max_attachment_mb: 0 });
    await activate(ctx);
    const out = JSON.parse(
      await getHandler()({
        to: ['alice@acme.com'],
        subject: 'big',
        text: 'x',
        attachments: [{ filename: 'big.bin', content_base64: Buffer.from('not tiny at all').toString('base64') }],
      }),
    );
    if (!out.ok && /exceed/i.test(out.error)) ok('oversized attachment rejected');
    else bad('oversized attachment rejected', JSON.stringify(out));
    const msg = await latestMessage();
    if (!msg) ok('nothing delivered for oversized attachment');
    else bad('nothing delivered for oversized attachment');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('test crashed:', err);
  process.exit(3);
});
