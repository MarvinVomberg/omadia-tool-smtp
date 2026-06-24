# @omadia/plugin-smtp — SMTP Email for omadia

Send email over **any** SMTP server from your omadia agent team — with
attachments, a **fixed sender**, and a **recipient allow-list**. Built on the
[omadia plugin starter](https://github.com/byte5ai/omadia-plugin-starter)
skeleton (esbuild bundle → uploadable ZIP).

It registers one native tool, **`smtp_send_email`**, that the orchestrator can
call. Unlike the Gmail-only Google Workspace integration, this works with any
SMTP relay: your provider, a corporate Exchange connector, Postmark/SES SMTP, or
a local relay.

> **Requires a core with raw-TCP egress.** SMTP needs a raw socket, which the
> plugin opens through `ctx.net.connect` gated by
> `permissions.network.outbound_tcp`. That accessor is added by a small core
> change (see [Core requirement](#core-requirement)). On a core without it, the
> tool returns a clear error instead of sending.

## Security model

This plugin is designed so agents cannot turn your mail server into an open
relay. Every send passes these gates, all operator-controlled:

| Control | Behaviour |
| --- | --- |
| **Fixed sender** | The `From` is always `from_address` from config. The tool input has **no** `from` field — agents cannot spoof a sender. |
| **Recipient allow-list** | Every `to`/`cc`/`bcc` must match `recipient_allowlist` (full address, `@domain`, bare `domain`, or `*`). **Empty list ⇒ nothing sends** (fail closed). |
| **Pinned egress** | The only host the plugin may reach is the configured `smtp_host:smtp_port`. The kernel resolves that from config and refuses any other target. No general network access. |
| **TLS by default** | STARTTLS is required on the plaintext port unless the operator turns *Require TLS* off for a trusted local relay. Implicit TLS (465) is supported too. |
| **Header-injection safe** | CR/LF/NUL in any address or the subject is rejected before nodemailer sees it. |
| **Size & count caps** | Total attachment bytes (`max_attachment_mb`) and recipient count (`max_recipients`) are bounded per message. |
| **HTML opt-in** | HTML bodies only go out when the operator enables them. |

## Configuration

Set on install (see the in-app setup guide for the long form):

- `smtp_host`, `smtp_port` (587 STARTTLS / 465 implicit TLS / 25 plain relay)
- `smtp_secure` (implicit TLS), `smtp_require_tls` (default on)
- `smtp_user`, `smtp_password` (vault-encrypted; both optional for a no-auth relay)
- `from_address` (**fixed sender**), `from_name` (optional)
- `recipient_allowlist` (one entry per line — fail closed when empty)
- `allow_html`, `max_attachment_mb`, `max_recipients`

## Tool: `smtp_send_email`

```jsonc
{
  "to": ["alice@acme.com"],
  "cc": [],
  "bcc": [],
  "subject": "Q3 summary",
  "text": "Plain-text body.",
  "html": "<p>Optional HTML body.</p>",
  "attachments": [
    { "filename": "report.pdf", "content_base64": "JVBERi0x..." },
    { "filename": "logo.png", "url": "https://your-omadia-host/files/logo.png" }
  ]
}
```

Attachments come in two forms:

- **`content_base64`** — file bytes inline. Needs no extra network access; the
  strict default.
- **`url`** — fetched via `ctx.http`. Only works if the operator allow-listed
  the source host under `permissions.network.outbound`. Absent that, the tool
  returns a clear error and you should use `content_base64`.

## Build

```bash
npm install
npm run typecheck
npm run build        # → out/omadia-plugin-smtp-0.1.0.zip
```

Upload the ZIP in the omadia admin store, fill in the setup fields, and the
`smtp_send_email` tool becomes available to your agents.

## Core requirement

The plugin relies on `ctx.net` — a raw-TCP egress accessor gated by
`permissions.network.outbound_tcp`:

```yaml
permissions:
  network:
    outbound_tcp:
      - host: "$config.smtp_host"
        port: "$config.smtp_port"
```

The `$config.*` references mean egress is pinned to exactly the SMTP host/port
the operator entered — a generic mail plugin can't know that at authoring time,
and this keeps internal relays reachable without opening a broad socket API.
The accessor lives in the core (`middleware/src/platform/netAccessor.ts`); until
it ships upstream, run a core build that includes it.

## License

MIT © Marvin Vomberg
