/**
 * OpenCode: a local MCP server entry in the global config.
 *
 * Docs checked 2026-11-14:
 * - https://opencode.ai/docs/mcp-servers/ (local servers live under `mcp.servers.<name>`; fields `type: "local"`,
 *   `command` as an array; `disabled` defaults to false)
 * - https://opencode.ai/docs/config/ (global config is `~/.config/opencode/opencode.json` or `.jsonc`)
 * - https://opencode.ai/config.json (schema: `mcp.<name>` directly is now marked deprecated)
 *
 * Differs from the brief's starting value `mcp.skillseekr = {type, command, enabled: true}`: current docs put
 * servers under `mcp.servers` and use `disabled` (default false) instead of `enabled`, so we write
 * `mcp.servers.skillseekr = {type: "local", command: ["skillseekr", "mcp"]}`.
 */
import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../../context.js';
import { TOOL_TARGETS } from '../../install/targets.js';
import { entryMatches, mergeEntry } from '../jsonMerge.js';
import type { Registrar } from '../setup.js';

const PATH = ['mcp', 'servers', 'skillseekr'];
const ENTRY = { type: 'local', command: ['skillseekr', 'mcp'] };

/** `opencode.json`, unless only `opencode.jsonc` exists. */
export async function opencodeConfigFile(ctx: Ctx): Promise<string> {
  const dir = join(ctx.home, TOOL_TARGETS.opencode.homeMarker);
  const json = join(dir, 'opencode.json');
  const jsonc = join(dir, 'opencode.jsonc');
  const exists = async (p: string) => { try { await lstat(p); return true; } catch { return false; } };
  return !(await exists(json)) && (await exists(jsonc)) ? jsonc : json;
}

export function opencodeRegistrar(): Registrar {
  return {
    id: 'opencode',
    async detect(ctx) {
      try { return (await stat(join(ctx.home, TOOL_TARGETS.opencode.homeMarker))).isDirectory(); } catch { return false; }
    },
    async isRegistered(ctx) { return entryMatches(await opencodeConfigFile(ctx), PATH, ENTRY); },
    async register(ctx, opts) {
      const c = await mergeEntry(await opencodeConfigFile(ctx), PATH, ENTRY, ctx, opts);
      return c ? [c] : [];
    },
    async where(ctx) { return `${await opencodeConfigFile(ctx)} (${PATH.join('.')})`; },
  };
}
