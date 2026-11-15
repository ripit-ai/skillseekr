import { lstat, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from './context.js';
import type { Engine } from './engine.js';
import { blockedReason } from './catalog/catalog.js';
import { listInstalled } from './install/installer.js';
import { removeHint } from './install/security.js';
import { nearDuplicates } from './scan/quality.js';
import { TOOL_TARGETS, presentTools } from './install/targets.js';
import { allRegistrars, starterDir, STARTER_NAME } from './setup/setup.js';
import type { Auth, Problem } from './types.js';

export interface DoctorCheck { id: string; status: 'ok' | 'warn' | 'fail'; message: string }
export interface DoctorReport { checks: DoctorCheck[] }

const LOOP_CODES = new Set(['resolve/include-loop', 'resolve/too-deep']);
const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ');
const viaText = (via: string[]) => via.join(' → ');
const isGithubType = (t: string) => t === 'github' || t === 'github-registry';
/** Comma-joined, at most 10 entries, then "… and N more". */
const list = (items: string[]) => (items.length <= 10 ? items : [...items.slice(0, 10), `… and ${items.length - 10} more`]).join(', ');
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Checks the config parse, every registry's access and auth, include loops, overrides, MCP registration for each
 * detected tool, and each present tool's skill folder. Never throws; a failing check is reported instead.
 */
export async function doctor(engine: Engine, ctx: Ctx, opts: { vscodeWorkspace?: string } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const add = (id: string, status: DoctorCheck['status'], message: string) => checks.push({ id, status, message: oneLine(message) });

  // Config.
  const config = await engine.config();
  const configProblems = config.problems.filter((p) => !p.registry && p.level === 'error');
  if (configProblems.length > 0) add('config', 'fail', configProblems.map((p) => p.message).join('; '));
  else add('config', 'ok', `${config.path}: ${config.registries.length} top-level ${config.registries.length === 1 ? 'entry' : 'entries'}`);

  const catalog = await engine.catalog();
  const { registries: views, includes, problems } = await engine.registries();
  const forName = (name: string) => problems.filter((p) => p.registry === name);

  // Registry access, one check per name (top-level entries, includes, resolved sources, and anything a problem names).
  const names: string[] = [];
  const note = (n: string) => { if (!names.includes(n)) names.push(n); };
  config.registries.forEach(([n]) => note(n));
  includes.forEach((i) => note(i.name));
  views.forEach((v) => note(v.name));
  problems.forEach((p) => { if (p.registry && !p.code.startsWith('auth/') && !LOOP_CODES.has(p.code)) note(p.registry); });
  for (const name of names) {
    const own = forName(name).filter((p) => !p.code.startsWith('auth/') && !LOOP_CODES.has(p.code));
    const errs = own.filter((p) => p.level === 'error');
    const warns = own.filter((p) => p.level === 'warning');
    const view = views.find((v) => v.name === name);
    const inc = includes.find((i) => i.name === name);
    if (errs.length > 0) add(`registry:${name}`, 'fail', `registry "${name}" can't be used: ${errs.map((p) => p.message).join('; ')}`);
    else if (warns.length > 0) add(`registry:${name}`, 'warn', `registry "${name}": ${warns.map((p) => p.message).join('; ')}`);
    else if (view) add(`registry:${name}`, 'ok', `registry "${name}" (${view.type}, via ${viaText(view.via)}): ${view.skillCount} skills${view.sha ? ` at ${view.sha.slice(0, 7)}` : ''}`);
    else if (inc) add(`registry:${name}`, 'ok', `registries file "${name}" (${inc.entry.type}, via ${viaText(inc.via)}) read${inc.sha ? ` at ${inc.sha.slice(0, 7)}` : ''}`);
    else add(`registry:${name}`, 'warn', `registry "${name}" was not loaded`);
  }

  // Include loops and depth.
  const loops = problems.filter((p) => p.code === 'resolve/include-loop');
  if (loops.length > 0) add('include-loop', 'warn', `include loop skipped: ${loops.map((p) => p.message).join('; ')}`);
  else add('include-loop', 'ok', 'no include loops');
  const deep = problems.filter((p) => p.code === 'resolve/too-deep');
  if (deep.length > 0) add('include-depth', 'warn', deep.map((p) => p.message).join('; '));

  // Overrides.
  for (const o of catalog.overrides) {
    add(`override:${o.kind}:${o.key}`, 'warn',
      `${o.kind} "${o.key}" from ${o.by.registry} (via ${viaText(o.by.via)}) replaces the one from ${o.replaced.registry} (via ${viaText(o.replaced.via)})`);
  }

  // Auth, per registry name (last declaration wins, as in resolution).
  const auths = new Map<string, { type: string; auth: Auth['type'] }>();
  config.registries.forEach(([n, e]) => auths.set(n, { type: e.type, auth: e.auth.type }));
  includes.forEach((i) => auths.set(i.name, { type: i.entry.type, auth: i.entry.auth.type }));
  views.forEach((v) => auths.set(v.name, { type: v.type, auth: v.auth }));
  const authNames = [...auths.keys()];
  problems.forEach((p) => { if (p.registry && p.code.startsWith('auth/') && !authNames.includes(p.registry)) authNames.push(p.registry); });
  for (const name of authNames) {
    const a = auths.get(name);
    const authProblems: Problem[] = forName(name).filter((p) => p.code.startsWith('auth/'));
    if (authProblems.length > 0) add(`auth:${name}`, 'warn', `registry "${name}": ${[...new Set(authProblems.map((p) => p.message))].join('; ')}`);
    else if (a && isGithubType(a.type) && a.auth === 'none') {
      add(`auth:${name}`, 'warn', `registry "${name}" uses unauthenticated GitHub API requests, which hit GitHub's rate limit of 60 per hour; use "auth": { "type": "gh_cli" }`);
    } else if (a) add(`auth:${name}`, 'ok', `registry "${name}": ${a.auth} auth`);
  }

  // MCP registration per detected tool.
  for (const r of allRegistrars(opts)) {
    try {
      if (!(await r.detect(ctx))) continue;
      if (await r.isRegistered(ctx)) {
        const note = r.warning ? await r.warning(ctx) : undefined;
        if (note) add(`mcp:${r.id}`, 'warn', note);
        else add(`mcp:${r.id}`, 'ok', `registered: ${r.where ? await r.where(ctx) : r.id}`);
      }
      else add(`mcp:${r.id}`, 'warn', `skillseekr is not registered with ${r.id}${r.where ? ` (${await r.where(ctx)})` : ''}; run "skillseekr setup"`);
    } catch (e) {
      add(`mcp:${r.id}`, 'fail', `checking ${r.id} failed: ${msg(e)}`);
    }
  }

  // Skill folders of present tools.
  const installed = await listInstalled(ctx, { projectDir: ctx.cwd, catalog });
  for (const tool of await presentTools(ctx)) {
    const dir = join(ctx.home, TOOL_TARGETS[tool].userSkillsDir);
    let isDir: boolean | undefined;
    try { isDir = (await stat(dir)).isDirectory(); } catch { /* missing */ }
    if (isDir === false) { add(`skills-dir:${tool}`, 'fail', `${dir} exists but is not a folder`); continue; }
    const starter = starterDir(ctx, tool);
    let starterPresent = false;
    try { await lstat(starter); starterPresent = true; } catch { /* none */ }
    const mine = installed.filter((i) => i.scope === 'user' && i.tool === tool);
    const starterManaged = mine.find((i) => i.dir === starter && i.marker.id === STARTER_NAME);
    if (starterPresent && !starterManaged) {
      add(`skills-dir:${tool}`, 'warn', `${starter} exists without a skillseekr marker (or holds another skill); setup leaves it alone, so the starter skill is not installed there`);
    } else if (isDir === undefined) {
      add(`skills-dir:${tool}`, 'ok', `${dir} (not created yet)`);
    } else {
      add(`skills-dir:${tool}`, 'ok', `${dir}: ${mine.length} skillseekr-managed ${mine.length === 1 ? 'skill' : 'skills'}`);
    }
  }

  // Security, policy and quality.
  const blocked = catalog.blocked();
  if (blocked.length > 0) add('security:blocked', 'warn', `${blocked.length} blocked ${blocked.length === 1 ? 'skill' : 'skills'}: ${list(blocked.map((b) => `${b.id} (${blockedReason(b.security)})`))}`);
  for (const i of installed) {
    if (i.security?.status === 'blocked') add(`security:installed:${i.name}:${i.scope}${i.tool ? `:${i.tool}` : ''}`, 'fail', `installed copy at ${i.dir} is blocked: ${blockedReason(i.security)}. ${removeHint(i)}`);
  }
  const allows = catalog.policy.sources.filter((s) => s.source.kind === 'local').flatMap((s) => Object.entries(s.allow));
  if (allows.length > 0) add('policy:allow', 'warn', `${allows.length} local allow ${allows.length === 1 ? 'entry' : 'entries'}: ${list(allows.map(([id, a]) => `${id} (added ${a.added}; rules: ${a.rules.join(', ')})`))}`);
  const ignored = catalog.problems.filter((p) => p.code.startsWith('policy/ignored-'));
  if (ignored.length > 0) add('policy:ignored', 'warn', list([...new Set(ignored.map((p) => p.message))]));
  const dups = nearDuplicates(catalog.skills.filter((k) => k.security.status !== 'blocked'));
  if (dups.length > 0) add('quality:near-duplicates', 'warn', `skills with near-identical descriptions: ${list(dups.map((d) => `${d.a} ~ ${d.b} (${d.similarity.toFixed(2)})`))}`);
  for (const t of catalog.policy.trust) add(`trust:${t.owner}`, 'ok', `${t.public_keys.length} trusted ${t.public_keys.length === 1 ? 'key' : 'keys'} for ${t.owner}`);

  return { checks };
}
