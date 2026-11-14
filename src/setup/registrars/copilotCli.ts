/**
 * Copilot CLI: an entry in the user MCP config.
 *
 * Docs checked 2026-11-14:
 * - https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers
 *   (`~/.copilot/mcp-config.json`, `mcpServers.<name>` with `type: "local"`, `command`, `args`, `tools: ["*"]`)
 *
 * Matches the brief's starting value.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../../context.js';
import { TOOL_TARGETS } from '../../install/targets.js';
import { entryMatches, mergeEntry } from '../jsonMerge.js';
import type { Registrar } from '../setup.js';

const PATH = ['mcpServers', 'skillseekr'];
const ENTRY = { type: 'local', command: 'skillseekr', args: ['mcp'], tools: ['*'] };
const file = (ctx: Ctx) => join(ctx.home, TOOL_TARGETS.copilot.homeMarker, 'mcp-config.json');

export function copilotCliRegistrar(): Registrar {
  return {
    id: 'copilot',
    async detect(ctx) {
      try { return (await stat(join(ctx.home, TOOL_TARGETS.copilot.homeMarker))).isDirectory(); } catch { return false; }
    },
    isRegistered: (ctx) => entryMatches(file(ctx), PATH, ENTRY),
    async register(ctx, opts) {
      const c = await mergeEntry(file(ctx), PATH, ENTRY, ctx, opts);
      return c ? [c] : [];
    },
    where: async (ctx) => `${file(ctx)} (${PATH.join('.')})`,
  };
}
