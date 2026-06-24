import type { PluginContext } from '@omadia/plugin-api';

import { SMTP_TOOL_SPEC, createSmtpToolHandler } from './smtpTool.js';

/** Reverse-DNS identity — MUST equal `identity.id` in manifest.yaml and the
 *  `name` field of package.json. */
export const PLUGIN_ID = '@omadia/plugin-smtp' as const;

export interface SmtpPluginHandle {
  close(): Promise<void>;
}

/**
 * Tool plugins export `activate(ctx)`. The host calls it once, scoped to this
 * plugin's identity, and keeps the returned handle until shutdown. We register
 * the single `smtp_send_email` tool and dispose it on close.
 */
export async function activate(ctx: PluginContext): Promise<SmtpPluginHandle> {
  ctx.log('[smtp] activating', { pluginId: PLUGIN_ID });

  const dispose = ctx.tools.register(SMTP_TOOL_SPEC, createSmtpToolHandler(ctx));

  ctx.log('[smtp] activated', { tools: [SMTP_TOOL_SPEC.name] });

  return {
    async close() {
      ctx.log('[smtp] deactivating');
      // `ctx.tools.register` returns a dispose handle on the real host; the
      // ambient stub types it as void, so guard before calling.
      if (typeof dispose === 'function') (dispose as () => void)();
    },
  };
}

export default { PLUGIN_ID, activate };
