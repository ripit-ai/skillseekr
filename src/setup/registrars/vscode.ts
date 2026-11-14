/**
 * Copilot in VS Code: a stdio server in the user-profile `mcp.json` (`servers`, not `mcpServers`).
 *
 * Docs checked 2026-11-14:
 * - https://code.visualstudio.com/docs/copilot/reference/mcp-configuration
 *   (`servers.<name> = {type: "stdio", command, args}`; "MCP: Open User Configuration" opens the profile file;
 *   "MCP: Open Remote User Configuration" opens the editor-managed remote `mcp.json`)
 * - https://code.visualstudio.com/docs/copilot/customization/mcp-servers
 * - https://github.com/microsoft/vscode/pull/324124 (open, unmerged: places the remote `mcp.json` in the
 *   remote server's `data/User` folder)
 *
 * Remote (VS Code Server on this machine): `~/.vscode-server/data/User/mcp.json`. The docs confirm remote user-level
 * MCP config exists but don't state its path on disk; the path is inferred from VS Code Server's data folder
 * layout and the PR above, so it is UNCONFIRMED. `--vscode-workspace <dir>` writes `<dir>/.vscode/mcp.json`
 * instead, which VS Code documents and reads in a remote window.
 * Local: `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%/Code/User/mcp.json` (Windows),
 * `~/.config/Code/User/mcp.json` (Linux), written only when that folder already exists.
 */
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../../context.js';
import { entryMatches, mergeEntry, type Change } from '../jsonMerge.js';
import type { Registrar } from '../setup.js';

const PATH = ['servers', 'skillseekr'];
const ENTRY = { type: 'stdio', command: 'skillseekr', args: ['mcp'] };

const isDir = async (p: string) => { try { return (await stat(p)).isDirectory(); } catch { return false; } };

function localUserDir(ctx: Ctx): string {
  if (process.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support', 'Code', 'User');
  if (process.platform === 'win32') return join(ctx.env.APPDATA || join(ctx.home, 'AppData', 'Roaming'), 'Code', 'User');
  return join(ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config'), 'Code', 'User');
}

/** The mcp.json files to manage: the workspace one when asked, else the remote and/or local user files that apply. */
export async function vscodeFiles(ctx: Ctx, workspace?: string): Promise<string[]> {
  if (workspace !== undefined) return [join(workspace, '.vscode', 'mcp.json')];
  const out: string[] = [];
  const server = join(ctx.home, '.vscode-server');
  if (await isDir(server)) out.push(join(server, 'data', 'User', 'mcp.json'));
  const local = localUserDir(ctx);
  if (await isDir(local)) out.push(join(local, 'mcp.json'));
  return out;
}

export function vscodeRegistrar(opts: { workspace?: string } = {}): Registrar {
  return {
    id: 'vscode',
    detect: async (ctx) => (await vscodeFiles(ctx, opts.workspace)).length > 0,
    async isRegistered(ctx) {
      const files = await vscodeFiles(ctx, opts.workspace);
      if (files.length === 0) return false;
      for (const f of files) if (!(await entryMatches(f, PATH, ENTRY))) return false;
      return true;
    },
    async register(ctx, o) {
      const changes: Change[] = [];
      for (const f of await vscodeFiles(ctx, opts.workspace)) {
        const c = await mergeEntry(f, PATH, ENTRY, ctx, o);
        if (c) changes.push(c);
      }
      return changes;
    },
    where: async (ctx) => (await vscodeFiles(ctx, opts.workspace)).map((f) => `${f} (${PATH.join('.')})`).join(', '),
  };
}
