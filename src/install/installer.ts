import { lstat, mkdir, readdir, readFile, rename, rm, writeFile, copyFile, mkdtemp } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { Ctx } from '../context.js';
import type { Catalog, SkillRecord } from '../catalog/catalog.js';
import { contentHash } from '../catalog/hash.js';
import { PROJECT_SKILLS_DIR, TOOL_IDS, TOOL_TARGETS, presentTools, type Scope, type ToolId } from './targets.js';

export interface Marker { id: string; name: string; registry: string; via: string[]; ref?: string; sha?: string; contentHash: string; installedAt: string }
export interface Installed { name: string; scope: Scope; dir: string; tool?: ToolId; marker: Marker; modified: boolean }
export type InstallStatus = 'current' | 'outdated' | 'modified' | 'missing-from-catalog';

const MARKER_FILE = '.skillseekr.json';

export class InstallError extends Error {
  constructor(public code: 'name-conflict' | 'unmanaged-folder' | 'not-installed', message: string) {
    super(message);
    this.name = 'InstallError';
  }
}

interface Target { dir: string; tool?: ToolId }

function validateName(name: string): void {
  if (name === '' || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    throw new InstallError('name-conflict', `Skill name ${JSON.stringify(name)} cannot be used as an install folder: it must be a single path segment (not empty, ".", "..", and without "/", "\\" or NUL).`);
  }
}

const projectRoot = (ctx: Ctx, opts?: { projectDir?: string }) => join(opts?.projectDir ?? ctx.cwd, PROJECT_SKILLS_DIR);
const userDir = (ctx: Ctx, tool: ToolId) => join(ctx.home, TOOL_TARGETS[tool].userSkillsDir);

async function readMarker(dir: string): Promise<Marker | undefined> {
  try {
    const m = JSON.parse(await readFile(join(dir, MARKER_FILE), 'utf8')) as Record<string, unknown>;
    const str = (k: string) => typeof m[k] === 'string';
    if (!m || !str('id') || !str('name') || !str('registry') || !str('contentHash') || !str('installedAt')) return undefined;
    if (!Array.isArray(m.via) || !m.via.every((v) => typeof v === 'string')) return undefined;
    if ((m.ref !== undefined && typeof m.ref !== 'string') || (m.sha !== undefined && typeof m.sha !== 'string')) return undefined;
    return m as unknown as Marker;
  } catch {
    return undefined;
  }
}

async function exists(p: string): Promise<boolean> {
  try { await lstat(p); return true; } catch { return false; }
}

/** Throws if folder exists and is not a managed folder for this skill id. */
async function checkSlot(dir: string, skill: SkillRecord): Promise<void> {
  if (!(await exists(dir))) return;
  const st = await lstat(dir);
  const marker = st.isDirectory() ? await readMarker(dir) : undefined;
  if (!marker) throw new InstallError('unmanaged-folder', `${dir} already exists and was not installed by skillseekr; refusing to touch it.`);
  if (marker.id !== skill.id) {
    throw new InstallError('name-conflict', `${dir} already holds skill "${marker.id}" (from ${marker.registry}); cannot install "${skill.id}" under the same name "${basename(dir)}".`);
  }
}

async function installInto(skill: SkillRecord, parent: string, folder: string, ctx: Ctx): Promise<string> {
  const dest = join(parent, folder);
  await checkSlot(dest, skill);
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(join(parent, `.tmp-${folder}-`));
  try {
    const srcRoot = resolve(skill.dir);
    for (const rel of skill.files) {
      const from = resolve(srcRoot, rel);
      const to = resolve(tmp, rel);
      if (rel === '' || rel.includes('\0') || !from.startsWith(srcRoot + sep) || !to.startsWith(tmp + sep)) {
        throw new Error(`Refusing unsafe file path in skill "${skill.id}": ${JSON.stringify(rel)}`);
      }
      if (rel === MARKER_FILE) continue;
      if (!(await lstat(from)).isFile()) throw new Error(`Skill file is not a regular file: ${rel}`);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
    const marker: Marker = {
      id: skill.id, name: skill.name, registry: skill.registry, via: skill.via,
      ...(skill.ref !== undefined && { ref: skill.ref }),
      ...(skill.sha !== undefined && { sha: skill.sha }),
      contentHash: skill.contentHash,
      installedAt: new Date(ctx.now()).toISOString(),
    };
    await writeFile(join(tmp, MARKER_FILE), JSON.stringify(marker, null, 2) + '\n');
    await checkSlot(dest, skill);
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { recursive: true, force: true });
    throw e;
  }
  return dest;
}

export async function installSkill(skill: SkillRecord, scope: Scope, ctx: Ctx, opts?: { projectDir?: string }): Promise<{ dirs: string[]; tools: ToolId[] }> {
  validateName(skill.name);
  const targets: Target[] = scope === 'project'
    ? [{ dir: projectRoot(ctx, opts) }]
    : (await presentTools(ctx)).map((tool) => ({ dir: userDir(ctx, tool), tool }));
  // Check every slot before writing to any.
  for (const t of targets) await checkSlot(join(t.dir, skill.name), skill);
  const dirs: string[] = [];
  const tools: ToolId[] = [];
  for (const t of targets) {
    dirs.push(await installInto(skill, t.dir, skill.name, ctx));
    if (t.tool) tools.push(t.tool);
  }
  return { dirs, tools };
}

function scanTargets(ctx: Ctx, scope: Scope | undefined, opts?: { projectDir?: string }): Array<Target & { scope: Scope }> {
  const out: Array<Target & { scope: Scope }> = [];
  if (scope !== 'user') out.push({ dir: projectRoot(ctx, opts), scope: 'project' });
  if (scope !== 'project') for (const tool of TOOL_IDS) out.push({ dir: userDir(ctx, tool), tool, scope: 'user' });
  return out;
}

export async function listInstalled(ctx: Ctx, opts?: { scope?: Scope; projectDir?: string }): Promise<Installed[]> {
  const out: Installed[] = [];
  for (const t of scanTargets(ctx, opts?.scope, opts)) {
    let entries;
    try { entries = await readdir(t.dir, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = join(t.dir, e.name);
      const marker = await readMarker(dir);
      if (!marker) continue;
      let modified = true;
      try { modified = (await contentHash(dir)).hash !== marker.contentHash; } catch { /* unreadable: treat as modified */ }
      out.push({ name: marker.name, scope: t.scope, dir, ...(t.tool && { tool: t.tool }), marker, modified });
    }
  }
  return out;
}

export function statusOf(i: Installed, catalog: Catalog): InstallStatus {
  const found = catalog.lookup(i.marker.id);
  if (found.kind !== 'found') return 'missing-from-catalog';
  if (i.modified) return 'modified';
  if (found.skill.contentHash !== i.marker.contentHash) return 'outdated';
  return 'current';
}

export async function removeInstalled(name: string, scope: Scope, ctx: Ctx, opts?: { projectDir?: string }): Promise<string[]> {
  validateName(name);
  const removed: string[] = [];
  const unmanaged: string[] = [];
  for (const t of scanTargets(ctx, scope, opts)) {
    const dir = join(t.dir, name);
    if (!(await exists(dir))) continue;
    const st = await lstat(dir);
    if (st.isDirectory() && (await readMarker(dir))) {
      await rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } else {
      unmanaged.push(dir);
    }
  }
  if (removed.length > 0) return removed;
  if (unmanaged.length > 0) throw new InstallError('unmanaged-folder', `${unmanaged.join(', ')} exists but was not installed by skillseekr (no ${MARKER_FILE}); refusing to remove it.`);
  throw new InstallError('not-installed', `Skill "${name}" is not installed in ${scope} scope.`);
}

export async function updateInstalled(
  catalog: Catalog, ctx: Ctx,
  opts: { name?: string; force: boolean; scope?: Scope; projectDir?: string },
): Promise<Array<{ name: string; dir: string; result: 'updated' | 'current' | 'skipped-modified' | 'missing-from-catalog' }>> {
  const out: Array<{ name: string; dir: string; result: 'updated' | 'current' | 'skipped-modified' | 'missing-from-catalog' }> = [];
  for (const i of await listInstalled(ctx, opts)) {
    if (opts.name !== undefined && i.name !== opts.name && i.marker.id !== opts.name) continue;
    const base = { name: i.name, dir: i.dir };
    const status = statusOf(i, catalog);
    if (status === 'missing-from-catalog') { out.push({ ...base, result: status }); continue; }
    if (status === 'modified' && !opts.force) { out.push({ ...base, result: 'skipped-modified' }); continue; }
    if (status === 'current') { out.push({ ...base, result: 'current' }); continue; }
    const found = catalog.lookup(i.marker.id);
    if (found.kind !== 'found') { out.push({ ...base, result: 'missing-from-catalog' }); continue; }
    await installInto(found.skill, dirname(i.dir), basename(i.dir), ctx);
    out.push({ ...base, result: 'updated' });
  }
  return out;
}
