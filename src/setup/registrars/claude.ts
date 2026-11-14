/**
 * Claude Code: install the skillseekr plugin (bundles the MCP server and the starter skill); fall back to
 * `claude mcp add` when the plugin commands are unavailable or fail. Every command goes through `ctx.exec`.
 *
 * Docs checked 2026-11-14:
 * - https://code.claude.com/docs/en/plugins/cli-reference (`claude plugin marketplace add <owner/repo>`,
 *   `claude plugin install <plugin>@<marketplace> --scope user`, `claude plugin list --json` → array of
 *   `{id: "name@marketplace", enabled, scope, ...}`; exit 0 on success, 1 on failure; repeat adds/installs exit 0)
 * - https://code.claude.com/docs/en/plugin-marketplaces
 * - https://code.claude.com/docs/en/mcp (`claude mcp add --scope user <name> -- <command> [args...]`
 *   stores the server in ~/.claude.json; `claude mcp get <name>` shows one server)
 *
 * Matches the brief's starting values; `--scope user` is passed to `plugin install` explicitly (it is the default).
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx, ExecResult } from '../../context.js';
import { TOOL_TARGETS } from '../../install/targets.js';
import type { Change } from '../jsonMerge.js';
import type { Registrar } from '../setup.js';

export const MARKETPLACE = 'ripit-ai/skillseekr';
export const PLUGIN = 'skillseekr@skillseekr';

const MARKETPLACE_ADD = ['plugin', 'marketplace', 'add', MARKETPLACE];
const PLUGIN_INSTALL = ['plugin', 'install', PLUGIN, '--scope', 'user'];
const MCP_ADD = ['mcp', 'add', '--scope', 'user', 'skillseekr', '--', 'skillseekr', 'mcp'];

const cmdText = (args: string[]) => ['claude', ...args].join(' ');
const run = (ctx: Ctx, args: string[], timeoutMs: number): Promise<ExecResult> =>
  ctx.exec('claude', args, { timeoutMs }).catch((e: unknown) => ({ code: 127, stdout: '', stderr: String(e) }));

export type ClaudeRoute = 'plugin' | 'mcp';

/** Installed plugins from `claude plugin list --json`, or undefined when the plugin commands aren't available. */
async function pluginList(ctx: Ctx): Promise<Array<{ id?: unknown; enabled?: unknown }> | undefined> {
  const r = await run(ctx, ['plugin', 'list', '--json'], 30_000);
  if (r.code !== 0) return undefined;
  const lines = r.stdout.trim().split('\n');
  for (const text of [r.stdout.trim(), lines[lines.length - 1] ?? '']) {
    try {
      const v: unknown = JSON.parse(text);
      if (Array.isArray(v)) return v as Array<{ id?: unknown; enabled?: unknown }>;
    } catch { /* try the last line */ }
  }
  return undefined;
}

export interface ClaudeRegistrar extends Registrar {
  /** How skillseekr is registered with Claude Code now, if at all. */
  route(ctx: Ctx): Promise<ClaudeRoute | undefined>;
}

export function claudeRegistrar(): ClaudeRegistrar {
  async function route(ctx: Ctx): Promise<ClaudeRoute | undefined> {
    const plugins = await pluginList(ctx);
    if (plugins?.some((p) => p.id === PLUGIN && p.enabled !== false)) return 'plugin';
    if ((await run(ctx, ['mcp', 'get', 'skillseekr'], 30_000)).code === 0) return 'mcp';
    return undefined;
  }

  return {
    id: 'claude',
    route,
    async detect(ctx) {
      try {
        if (!(await stat(join(ctx.home, TOOL_TARGETS.claude.homeMarker))).isDirectory()) return false;
      } catch { return false; }
      return (await run(ctx, ['--version'], 10_000)).code === 0;
    },
    isRegistered: async (ctx) => (await route(ctx)) !== undefined,
    async register(ctx, opts) {
      if ((await route(ctx)) !== undefined) return [];
      const pluginsAvailable = (await pluginList(ctx)) !== undefined;
      if (opts.dryRun) {
        return (pluginsAvailable ? [MARKETPLACE_ADD, PLUGIN_INSTALL] : [MCP_ADD]).map((a) => ({ command: cmdText(a) }));
      }
      const changes: Change[] = [];
      let why = 'the plugin commands are not available';
      if (pluginsAvailable) {
        const m = await run(ctx, MARKETPLACE_ADD, 180_000);
        if (m.code === 0) {
          changes.push({ command: cmdText(MARKETPLACE_ADD) });
          const i = await run(ctx, PLUGIN_INSTALL, 180_000);
          if (i.code === 0) return [...changes, { command: cmdText(PLUGIN_INSTALL) }];
          why = `${cmdText(PLUGIN_INSTALL)} failed: ${(i.stderr || i.stdout).trim()}`;
        } else {
          why = `${cmdText(MARKETPLACE_ADD)} failed: ${(m.stderr || m.stdout).trim()}`;
        }
      }
      const a = await run(ctx, MCP_ADD, 30_000);
      // `mcp get` can fail for reasons other than absence (say, a health check); an existing entry is fine.
      if (a.code !== 0 && /already exists/i.test(`${a.stderr}\n${a.stdout}`)) return changes;
      if (a.code !== 0) {
        throw new Error(`could not register with Claude Code: ${why}; and ${cmdText(MCP_ADD)} failed: ${(a.stderr || a.stdout).trim()}`);
      }
      return [...changes, { command: cmdText(MCP_ADD) }];
    },
    where: async (ctx) => {
      const r = await route(ctx);
      return r === 'plugin' ? `plugin ${PLUGIN}` : r === 'mcp' ? 'user-scope MCP server (claude mcp)' : 'not registered';
    },
  };
}
