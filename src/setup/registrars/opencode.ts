/**
 * OpenCode: a local MCP server entry in the global config.
 *
 * Docs checked 2026-11-14:
 * - https://opencode.ai/docs/mcp-servers/ (V2: local servers under `mcp.servers.<name>`, `disabled` instead of `enabled`)
 * - https://opencode.ai/docs/migrate-v1 (V2 still accepts the V1 `mcp.<name>` syntax, deprecated, without complaint)
 * - https://opencode.ai/v1/docs/mcp-servers (V1: `mcp.<name> = {type: "local", command: [...], enabled: true}`;
 *   V1 can't read `mcp.servers`)
 * - https://opencode.ai/docs/config/ (global config is `~/.config/opencode/opencode.json` or `.jsonc`)
 *
 * Ruling R19: write the spec's V1 shape `mcp.skillseekr = {type: "local", command: ["skillseekr", "mcp"],
 * enabled: true}`, which both V1 and V2 read. An existing entry in either shape (`mcp.skillseekr` or
 * `mcp.servers.skillseekr`) counts as registered, and register then does nothing, so no duplicates.
 */
import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../../context.js';
import { TOOL_TARGETS } from '../../install/targets.js';
import { entryMatches, mergeEntry } from '../jsonMerge.js';
import type { Registrar } from '../setup.js';

const PATH = ['mcp', 'skillseekr'];
const V2_PATH = ['mcp', 'servers', 'skillseekr'];
const ENTRY = { type: 'local', command: ['skillseekr', 'mcp'], enabled: true };
/** What makes an existing entry ours, in either shape (`enabled`/`disabled` are the user's call). */
const CORE = { type: 'local', command: ['skillseekr', 'mcp'] };

async function registeredAt(ctx: Ctx): Promise<string[] | undefined> {
  const file = await opencodeConfigFile(ctx);
  for (const p of [PATH, V2_PATH]) if (await entryMatches(file, p, CORE)) return p;
  return undefined;
}

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
    isRegistered: async (ctx) => (await registeredAt(ctx)) !== undefined,
    async register(ctx, opts) {
      if (await registeredAt(ctx)) return [];
      const c = await mergeEntry(await opencodeConfigFile(ctx), PATH, ENTRY, ctx, opts);
      return c ? [c] : [];
    },
    async where(ctx) { return `${await opencodeConfigFile(ctx)} (${((await registeredAt(ctx)) ?? PATH).join('.')})`; },
  };
}
