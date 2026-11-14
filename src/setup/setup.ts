import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SkillRecord } from '../catalog/catalog.js';
import { parseFrontmatter } from '../catalog/frontmatter.js';
import { contentHash } from '../catalog/hash.js';
import { defaultConfigText } from '../config/edit.js';
import type { Ctx } from '../context.js';
import { doctor, type DoctorReport } from '../doctor.js';
import { createEngine } from '../engine.js';
import { installSkill, listInstalled } from '../install/installer.js';
import { TOOL_TARGETS, type ToolId } from '../install/targets.js';
import { configPath } from '../paths.js';
import type { Change } from './jsonMerge.js';
import { claudeRegistrar, type ClaudeRegistrar } from './registrars/claude.js';
import { copilotCliRegistrar } from './registrars/copilotCli.js';
import { opencodeRegistrar } from './registrars/opencode.js';
import { vscodeRegistrar } from './registrars/vscode.js';

export type { Change } from './jsonMerge.js';

export type SetupTool = ToolId | 'vscode';
export const SETUP_TOOLS: SetupTool[] = ['claude', 'opencode', 'copilot', 'vscode'];
export const DEFAULT_REGISTRY = 'ripit-ai/agent-skills';
export const STARTER_NAME = 'skillseekr';

export interface Registrar {
  id: SetupTool;
  detect(ctx: Ctx): Promise<boolean>;
  isRegistered(ctx: Ctx): Promise<boolean>;
  /** With `dryRun`, returns the changes it would make and touches nothing. */
  register(ctx: Ctx, opts: { yes: boolean; dryRun?: boolean }): Promise<Change[]>;
  /** Where the registration lives, for doctor messages. */
  where?(ctx: Ctx): Promise<string>;
}

export interface SetupOptions {
  tools?: SetupTool[];
  yes: boolean;
  /** "owner/repo" of the registries file the default config points at. */
  registry?: string;
  /** Write `<dir>/.vscode/mcp.json` instead of VS Code's user-level mcp.json. */
  vscodeWorkspace?: string;
  /** Asked once, with the planned changes, when `yes` is false and there is something to change. */
  confirm?: (planned: Change[]) => Promise<boolean>;
}

export interface SetupResult { changes: Change[]; doctor: DoctorReport; errors: string[]; aborted?: boolean }

export function allRegistrars(opts: { vscodeWorkspace?: string } = {}): Registrar[] {
  return [claudeRegistrar(), opencodeRegistrar(), copilotCliRegistrar(), vscodeRegistrar({ workspace: opts.vscodeWorkspace })];
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const exists = async (p: string) => { try { await lstat(p); return true; } catch { return false; } };

/** The built-in starter skill as an installable record (marker id "skillseekr", registry "builtin"). */
export async function starterSkill(): Promise<SkillRecord> {
  const dir = fileURLToPath(new URL('../../assets/starter-skill', import.meta.url));
  const fm = parseFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8'));
  const { hash, files } = await contentHash(dir);
  return {
    id: STARTER_NAME, name: STARTER_NAME, description: String(fm.data.description ?? ''),
    dir, files, contentHash: hash, warnings: [], registry: 'builtin', via: [],
  };
}

export const starterDir = (ctx: Ctx, tool: ToolId) => join(ctx.home, TOOL_TARGETS[tool].userSkillsDir, STARTER_NAME);

/**
 * Whether the starter skill should be (re)installed for a tool. Never touches a folder without a marker, one
 * holding another skill, or one with local edits; skips one already at this content hash.
 */
export async function starterState(ctx: Ctx, tool: ToolId, skill: SkillRecord): Promise<'missing' | 'outdated' | 'current' | 'unmanaged' | 'modified'> {
  const dir = starterDir(ctx, tool);
  if (!(await exists(dir))) return 'missing';
  const found = (await listInstalled(ctx, { scope: 'user' })).find((i) => i.tool === tool && i.dir === dir);
  if (!found || found.marker.id !== STARTER_NAME) return 'unmanaged';
  if (found.modified) return 'modified';
  return found.marker.contentHash === skill.contentHash ? 'current' : 'outdated';
}

function parseRegistry(registry: string): { owner: string; repo: string } {
  const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(registry);
  if (!m) throw new Error(`--registry must be "owner/repo", got ${JSON.stringify(registry)}`);
  return { owner: m[1]!, repo: m[2]! };
}

const isToolId = (id: SetupTool): id is ToolId => id !== 'vscode';

/**
 * Writes the config if missing, registers the MCP server with each detected tool, installs the starter skill
 * into each tool's user skill folder (not Claude's when the plugin bundles it), then runs doctor.
 * Idempotent: a second run returns no changes and rewrites nothing.
 */
export async function setup(ctx: Ctx, opts: SetupOptions): Promise<SetupResult> {
  const { owner, repo } = parseRegistry(opts.registry ?? DEFAULT_REGISTRY);
  const regs: Registrar[] = [];
  for (const r of allRegistrars(opts)) {
    if (opts.tools && !opts.tools.includes(r.id)) continue;
    if (await r.detect(ctx)) regs.push(r);
  }
  const claude = regs.find((r): r is ClaudeRegistrar => r.id === 'claude');
  const skill = await starterSkill();
  const cfg = configPath(ctx);
  const errors: string[] = [];

  const starterTargets = async (claudeGetsStarter: boolean) => {
    const out: Array<{ tool: ToolId; state: 'missing' | 'outdated' }> = [];
    for (const r of regs) {
      if (!isToolId(r.id) || (r.id === 'claude' && !claudeGetsStarter)) continue;
      const state = await starterState(ctx, r.id, skill);
      if (state === 'missing' || state === 'outdated') out.push({ tool: r.id, state });
    }
    return out;
  };
  const starterChange = (tool: ToolId, state: 'missing' | 'outdated'): Change => ({
    file: starterDir(ctx, tool),
    before: state === 'missing' ? 'starter skill: (not installed)' : 'starter skill: older version',
    after: `starter skill: ${STARTER_NAME} (${skill.contentHash.slice(0, 15)}…)`,
  });

  // Plan: what would change, without touching anything.
  const planned: Change[] = [];
  const configMissing = !(await exists(cfg));
  if (configMissing) planned.push({ file: cfg, before: '(missing)', after: `default config: github-registry ${owner}/${repo}` });
  let claudeViaMcp = false;
  for (const r of regs) {
    try {
      const c = await r.register(ctx, { yes: opts.yes, dryRun: true });
      if (r.id === 'claude') claudeViaMcp = c.some((x) => x.command?.includes(' mcp add '));
      planned.push(...c);
    } catch (e) {
      errors.push(`${r.id}: ${msg(e)}`);
    }
  }
  if (claude && !claudeViaMcp) claudeViaMcp = (await claude.route(ctx)) === 'mcp';
  for (const t of await starterTargets(claudeViaMcp)) planned.push(starterChange(t.tool, t.state));

  if (planned.length > 0 && !opts.yes) {
    if (!opts.confirm) throw new Error('setup needs confirmation: pass yes, or a confirm function');
    if (!(await opts.confirm(planned))) return { changes: [], doctor: { checks: [] }, errors: [], aborted: true };
  }

  // Apply.
  const changes: Change[] = [];
  if (configMissing) {
    await mkdir(dirname(cfg), { recursive: true });
    // 'wx': never overwrite a config that appeared since the plan.
    await writeFile(cfg, defaultConfigText({ owner, repo, name: owner }), { flag: 'wx', mode: 0o600 });
    changes.push(planned[0]!);
  }
  for (const r of regs) {
    try {
      changes.push(...await r.register(ctx, { yes: opts.yes }));
    } catch (e) {
      if (!errors.some((x) => x.startsWith(`${r.id}: `))) errors.push(`${r.id}: ${msg(e)}`);
    }
  }
  const claudeRoute = claude ? await claude.route(ctx) : undefined;
  // R4: the plugin bundles the starter skill; only the `claude mcp add` route needs it in ~/.claude/skills.
  for (const t of await starterTargets(claudeRoute === 'mcp')) {
    try {
      await installSkill(skill, 'user', ctx, { tools: [t.tool] });
      changes.push(starterChange(t.tool, t.state));
    } catch (e) {
      errors.push(`${t.tool}: starter skill: ${msg(e)}`);
    }
  }

  return { changes, doctor: await doctor(createEngine(ctx), ctx, { vscodeWorkspace: opts.vscodeWorkspace }), errors };
}
