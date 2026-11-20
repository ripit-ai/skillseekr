import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import type { Ctx } from '../context.js';
import { discoverSkills, type DiscoveredSkill } from '../catalog/discover.js';
import { loadConfig } from '../config/load.js';
import { onlineIncludeLoader, resolve, type IncludeLoader, type ResolvedRegistry } from '../resolve/resolve.js';
import { fetchGithubTree, invalidRepo } from '../sources/github.js';
import { fetchHttpBody, invalidSkillName } from '../sources/http.js';
import type { IncludeEntry, Problem } from '../types.js';
import { githubFolder, httpFolder, includeFile, MARKER, OLD_PREFIX, STAGING } from './layout.js';
import { acquireLock, LockBusyError } from './lock.js';
import { configHash, MANIFEST_VERSION, manifestFile, readManifest, writeManifest, type IncludeRecord, type Manifest, type ManifestSkill, type SourceRecord } from './manifest.js';
export { configHash } from './manifest.js';
import { cleanLeftovers, prune, removeOld, rollBack, swapIn } from './swap.js';
import { textHash, verifyFolders } from './verify.js';

export interface SkillChange { id: string; registry: string; change: 'added' | 'changed' | 'removed' }
export interface StagedSource { name: string; folder: string /* library-relative target */; stagedDir: string /* absolute */ }
export interface PullResult { aborted: boolean; manifest?: Manifest; changes: SkillChange[]; problems: Problem[]; stale: boolean; /** Set when not aborted. */ libDir?: string }

/** The security hook: runs after everything is staged, before anything goes live. Replaceable. */
export const pullHooks = {
  beforeSwap: async (_s: StagedSource[]): Promise<{ reject?: string[]; abort?: string }> => ({}),
};

/** Filesystem steps of the swap, replaceable in tests to inject failures. */
export const pullFs = { swapIn, writeManifest };


const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const err = (code: string, message: string): Problem => ({ level: 'error', code, message });
const writeFailed = (path: string, e: unknown): Problem => err('library/write-failed', `cannot write ${path}: ${msg(e)}`);
const abort = (problems: Problem[]): PullResult => ({ aborted: true, changes: [], problems, stale: false });

/** The file an include points at, for matching it against the previous manifest. */
const targetKey = (e: IncludeEntry): string =>
  e.type === 'github-registry' ? JSON.stringify([e.type, e.owner, e.repo, e.ref, e.path]) : JSON.stringify([e.type, e.url]);

type Outcome =
  | { kind: 'staged' | 'kept'; sha?: string; etag?: string; stagedDir?: string; skills: Map<string, ManifestSkill[]> }
  | { kind: 'failed'; error: Problem };

interface Group { folder: string; regs: ResolvedRegistry[]; outcome?: Outcome; warnings: Problem[] /* from the fetch */ }

export async function pullLibrary(ctx: Ctx, deps: { discover?: typeof discoverSkills } = {}): Promise<PullResult> {
  const config = await loadConfig(ctx);
  if (config.problems.some((p) => p.level === 'error' && p.code.startsWith('config/') && p.registry === undefined)) return abort(config.problems);
  let text: string;
  try { text = await readFile(config.path, 'utf8'); } catch (e) {
    return abort([err('config/unreadable', `Cannot read config ${config.path}: ${msg(e)}`)]);
  }
  const libDir = config.libraryDir;
  if (await foreignDir(libDir)) {
    return abort([err('library/not-a-library', `${libDir} is not empty and is not a skillseekr library (it has no ${MARKER} or manifest.json); refusing to update it`)]);
  }
  let release: () => Promise<void>;
  try { release = await acquireLock(libDir, ctx); } catch (e) {
    if (e instanceof LockBusyError) throw e;
    return abort([writeFailed(libDir, e)]);
  }
  try {
    return await pullLocked(ctx, config, text, libDir, deps.discover ?? discoverSkills);
  } catch (e) {
    return abort([err('library/write-failed', `the update of ${libDir} failed unexpectedly: ${msg(e)}`)]);
  } finally {
    await cleanLeftovers(libDir);
    await release().catch(() => {});
  }
}

async function pullLocked(
  ctx: Ctx, config: Awaited<ReturnType<typeof loadConfig>>, text: string, libDir: string, discover: typeof discoverSkills,
): Promise<PullResult> {
  try {
    await writeFile(join(libDir, MARKER), 'This folder is a skillseekr library. Its contents are replaced on `skillseekr update`.\n', { mode: 0o600, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return abort([writeFailed(join(libDir, MARKER), e)]);
  }
  await cleanLeftovers(libDir);
  const prev = await readManifest(libDir);
  const badPrev = new Set(prev ? await verifyFolders(libDir, prev) : []);
  const staging = join(libDir, STAGING);
  const now = new Date(ctx.now()).toISOString();

  // ---- resolve, staging each fetched include file ----
  const incInfo = new Map<string, { file: string; textHash?: string; fetchedAt?: string }>();
  const stagedFiles = new Map<string, string>(); // library-relative file → staged path
  const online = onlineIncludeLoader(ctx);
  const loader: IncludeLoader = async (entry, trusted) => {
    if (entry.type === 'github-registry') { const bad = invalidRepo(entry); if (bad) return { error: bad }; }
    const key = targetKey(entry);
    const r = await online(entry, trusted);
    if ('error' in r) {
      const old = prev?.includes.find((i) => i.file && !badPrev.has(i.file) && targetKey(i.entry) === key);
      const oldText = old?.file ? await readFile(join(libDir, old.file), 'utf8').catch(() => undefined) : undefined;
      if (!old?.file || oldText === undefined) return r;
      incInfo.set(key, { file: old.file, ...(old.textHash ? { textHash: old.textHash } : {}), ...(old.fetchedAt ? { fetchedAt: old.fetchedAt } : {}) });
      return {
        text: oldText, ...(old.sha ? { sha: old.sha } : {}), stale: true,
        problems: [{ level: 'warning', code: 'source/stale', message: `${r.error.message}; using the library's previous copy of ${old.file}, which may be stale` }],
      };
    }
    const file = includeFile(entry); // the fetch has validated owner, repo and path
    if (!file) return { error: err('source/invalid', `include path ${JSON.stringify(entry.type === 'github-registry' ? entry.path : entry.url)} is not safe`) };
    const staged = join(staging, 'registries', file);
    try {
      await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
      await writeFile(staged, r.text, { mode: 0o600 });
    } catch (e) {
      return { ...r, problems: [...r.problems, writeFailed(staged, e)] };
    }
    stagedFiles.set(file, staged);
    incInfo.set(key, { file, textHash: textHash(r.text), fetchedAt: now });
    return r;
  };
  const res = await resolve(config, loader);
  const problems: Problem[] = [...res.problems];
  const attach = (p: Problem, reg: ResolvedRegistry): Problem => ({ ...p, registry: reg.name, via: reg.via });

  // ---- stage sources (one folder per owner/repo/ref or url/skill_name) and discover ----
  const invalid = new Map<string, Problem>();
  const groups = new Map<string, Group>();
  for (const reg of res.registries) {
    const e = reg.entry;
    // Validated before any folder name is built from the entry.
    const bad = e.type === 'github' ? invalidRepo(e) : invalidSkillName(e.skill_name);
    if (bad) { invalid.set(reg.name, bad); continue; }
    const folder = e.type === 'github' ? githubFolder(e.owner, e.repo, e.ref) : httpFolder(e.url, e.skill_name);
    const g = groups.get(folder) ?? { folder, regs: [], warnings: [] };
    g.regs.push(reg);
    groups.set(folder, g);
  }
  await Promise.all([...groups.values()].map(async (g, i) => {
    try {
      g.outcome = await stage(g, i);
    } catch (e) {
      g.outcome = { kind: 'failed', error: err('engine/source-failed', `fetching ${g.folder} failed unexpectedly: ${msg(e)}`) };
    }
  }));

  async function stage(g: Group, i: number): Promise<Outcome> {
    const fetcher = g.regs.find((r) => r.trusted) ?? g.regs[0]!;
    const e = fetcher.entry;
    const known = badPrev.has(g.folder) ? undefined : prev?.sources.find((s) => s.folder === g.folder);
    const dir = join(staging, `s${i}`);
    let out: { kind: 'staged' | 'kept'; sha?: string; etag?: string; stagedDir?: string; base: string };
    if (e.type === 'github') {
      const r = await fetchGithubTree(e, { trusted: fetcher.trusted, ...(known?.sha ? { knownSha: known.sha } : {}) }, dir, ctx);
      if ('error' in r) return { kind: 'failed', error: r.error.code === 'source/write-failed' ? { ...r.error, code: 'library/write-failed' } : r.error };
      g.warnings.push(...r.problems.map((p) => attach(p, fetcher)));
      out = r.unchanged ? { kind: 'kept', sha: r.sha, base: join(libDir, g.folder) } : { kind: 'staged', sha: r.sha, stagedDir: dir, base: dir };
    } else {
      const r = await fetchHttpBody(e, { trusted: fetcher.trusted, ...(known?.etag ? { etag: known.etag } : {}) }, ctx);
      if ('error' in r) return { kind: 'failed', error: r.error };
      g.warnings.push(...r.problems.map((p) => attach(p, fetcher)));
      if (r.notModified) out = { kind: 'kept', ...(known?.etag ? { etag: known.etag } : {}), base: join(libDir, g.folder) };
      else {
        const skillDir = join(dir, e.skill_name);
        try {
          await mkdir(skillDir, { recursive: true, mode: 0o700 });
          await writeFile(join(skillDir, 'SKILL.md'), r.body, { mode: 0o600 });
        } catch (x) {
          return { kind: 'failed', error: writeFailed(skillDir, x) };
        }
        out = { kind: 'staged', ...(r.etag ? { etag: r.etag } : {}), stagedDir: skillDir, base: skillDir };
      }
    }
    const toRel = (abs: string): string => {
      const r = relative(out.base, abs).split(sep).join('/');
      return r ? `${g.folder}/${r}` : g.folder;
    };
    const skills = new Map<string, ManifestSkill[]>();
    for (const reg of g.regs) {
      const re = reg.entry;
      const reuse = out.kind === 'kept'
        ? prev?.sources.find((s) => s.folder === g.folder && (re.type === 'http' || (s.entry.type === 'github' && s.entry.skills_dir === re.skills_dir)))
        : undefined;
      let found: DiscoveredSkill[] | ManifestSkill[];
      if (reuse) found = reuse.skills;
      else if (re.type === 'github') found = (await discover(out.base, re.skills_dir)).map((k) => ({ ...k, dir: toRel(k.dir) }));
      else found = (await discover(dirname(out.base), '')).filter((k) => k.id === re.skill_name).map((k) => ({ ...k, dir: toRel(k.dir) }));
      skills.set(reg.name, found);
    }
    const { base: _b, ...rest } = out;
    return { ...rest, skills };
  }

  for (const g of groups.values()) problems.push(...g.warnings);

  // ---- security hook ----
  const staged: StagedSource[] = [];
  for (const g of groups.values()) {
    if (g.outcome?.kind === 'staged') for (const reg of g.regs) staged.push({ name: reg.name, folder: g.folder, stagedDir: g.outcome.stagedDir! });
  }
  let verdict: { reject?: string[]; abort?: string };
  try { verdict = await pullHooks.beforeSwap(staged); } catch (e) { verdict = { abort: `the security check failed: ${msg(e)}` }; }
  if (verdict.abort !== undefined) return abort([err('library/rejected', `the update was rejected: ${verdict.abort}`)]);
  const rejected = new Set(verdict.reject ?? []);
  for (const g of groups.values()) {
    const hit = g.regs.filter((r) => rejected.has(r.name));
    if (g.outcome?.kind === 'staged' && hit.length) {
      g.outcome = { kind: 'failed', error: err('library/rejected', `the security check rejected ${g.folder} (registry ${hit.map((r) => `"${r.name}"`).join(', ')})`) };
    }
  }

  // ---- swap, records, manifest: any failure here rolls every swap back ----
  const swapped: Array<{ rel: string; old?: string }> = [];
  let failure: Problem | undefined;
  let manifest: Manifest | undefined;
  let clean = false;
  try {
    ({ manifest, clean } = await swapAndRecord());
  } catch (e) {
    failure = e instanceof ManifestWriteError ? writeFailed(manifestFile(libDir), e.cause)
      : err('library/write-failed', `the update of ${libDir} failed unexpectedly: ${msg(e)}`);
  }
  if (failure || !manifest) {
    const lost = await rollBack(libDir, swapped);
    return abort([...problems, failure!, ...lost.map((p) => err('library/write-failed', `cannot restore ${p} after a failed update`))]);
  }
  const stale = res.stale || manifest.sources.some((s) => s.stale) || manifest.includes.some((i) => i.stale);
  await removeOld(swapped.flatMap((x) => (x.old ? [x.old] : [])));
  if (clean) {
    const keep = [
      ...manifest.sources.flatMap((s) => (s.folder ? [s.folder] : [])), ...manifest.includes.flatMap((i) => (i.file ? [i.file] : [])),
      // A failed fetch never costs the previous copy, whatever record (if any) now points at it.
      ...[...groups.values()].filter((g) => g.outcome?.kind === 'failed').map((g) => g.folder),
    ];
    for (const f of await prune(libDir, keep)) problems.push(err('library/write-failed', `cannot remove ${join(libDir, f)}, which is no longer used`));
  }
  return { aborted: false, manifest, changes: diff(prev, manifest), problems, stale, libDir };

  async function swapAndRecord(): Promise<{ manifest: Manifest; clean: boolean }> {
    for (const g of groups.values()) {
      if (g.outcome?.kind !== 'staged') continue;
      try {
        swapped.push({ rel: g.folder, old: await pullFs.swapIn(libDir, g.outcome.stagedDir!, g.folder) });
      } catch (e) {
        g.outcome = { kind: 'failed', error: writeFailed(join(libDir, g.folder), e) };
      }
    }
    const unswapped = new Set<string>();
    for (const [file, path] of stagedFiles) {
      try {
        swapped.push({ rel: file, old: await pullFs.swapIn(libDir, path, file) });
      } catch (e) {
        unswapped.add(file);
        problems.push(writeFailed(join(libDir, file), e));
      }
    }

    // ---- records ----
    // A folder another source fetched this run holds that source's content, not an old record's.
    const claimed = (folder: string) => groups.get(folder)?.outcome?.kind === 'staged' || groups.get(folder)?.outcome?.kind === 'kept';
    let sources: SourceRecord[] = [];
    for (const reg of res.registries) {
      const g = [...groups.values()].find((x) => x.regs.includes(reg));
      const o: Outcome = g?.outcome ?? { kind: 'failed', error: invalid.get(reg.name)! };
      if (o.kind === 'failed') {
        problems.push(attach(o.error, reg));
        // The previous copy: by name, else (a renamed registry) the record that used this source's folder.
        const byName = prev?.sources.find((s) => s.name === reg.name && s.folder && !claimed(s.folder));
        const byFolder = g ? prev?.sources.find((s) => s.folder === g.folder) : undefined;
        if (byName) sources.push({ ...byName, stale: true });
        else if (byFolder) sources.push({ ...byFolder, name: reg.name, via: reg.via, trusted: reg.trusted, entry: reg.entry, stale: true });
        else sources.push({ name: reg.name, via: reg.via, trusted: reg.trusted, entry: reg.entry, stale: false, skills: [] });
        continue;
      }
      sources.push({
        name: reg.name, via: reg.via, trusted: reg.trusted, entry: reg.entry, folder: g!.folder,
        ...(o.sha ? { sha: o.sha } : {}), ...(o.etag ? { etag: o.etag } : {}), fetchedAt: now, stale: false,
        skills: o.skills.get(reg.name) ?? [],
      });
    }
    const includes: IncludeRecord[] = res.includes.map((i) => {
      const x = incInfo.get(targetKey(i.entry));
      const base = { name: i.name, via: i.via, entry: i.entry, policy: i.policy };
      if (x && unswapped.has(x.file)) {
        // The new text could not be stored: the restored previous copy (if it verified) stays referenced, stale.
        const old = prev?.includes.find((p) => p.file === x.file && !badPrev.has(x.file));
        return old ? { ...old, ...base, stale: true } : { ...base, stale: true };
      }
      return {
        ...base, stale: i.stale, ...(i.sha !== undefined ? { sha: i.sha } : {}),
        ...(x ? { file: x.file, ...(x.textHash ? { textHash: x.textHash } : {}) } : {}),
        ...(x?.fetchedAt ? { fetchedAt: x.fetchedAt } : {}),
      };
    });

    // Prune only after a clean resolution and no failed write; otherwise keep what went missing, marked stale.
    const clean = !res.stale && !res.problems.some((p) => p.level === 'error') && invalid.size === 0
      && !problems.some((p) => p.code === 'library/write-failed');
    if (!clean && prev) {
      // Carried records go first: they have the lowest precedence ("last wins").
      const carried: SourceRecord[] = [];
      for (const old of prev.sources) {
        if (!old.folder || sources.some((s) => s.name === old.name || s.folder === old.folder)) continue;
        carried.push({ ...old, stale: true });
        problems.push({
          level: 'warning', code: 'source/stale', registry: old.name, via: old.via,
          message: `registry "${old.name}" is no longer in the resolution, but the resolution had errors; keeping its previous copy until an update without errors`,
        });
      }
      sources = [...carried, ...sources];
      for (const old of prev.includes) {
        if (old.file && !includes.some((i) => i.file === old.file)) includes.push({ ...old, stale: true });
      }
    }

    const manifest: Manifest = {
      version: MANIFEST_VERSION, updatedAt: now, configHash: configHash(text),
      sources, includes, overrides: res.overrides, problems: [...problems],
    };
    try {
      await pullFs.writeManifest(libDir, manifest);
    } catch (e) {
      throw new ManifestWriteError(e);
    }
    return { manifest, clean };
  }
}

class ManifestWriteError extends Error {
  constructor(cause: unknown) { super(msg(cause), { cause }); }
}

function diff(prev: Manifest | undefined, next: Manifest): SkillChange[] {
  const index = (m: Manifest | undefined) => {
    const out = new Map<string, { id: string; registry: string; hash: string }>();
    for (const s of m?.sources ?? []) for (const k of s.skills) out.set(`${s.name}\0${k.id}`, { id: k.id, registry: s.name, hash: k.contentHash });
    return out;
  };
  const before = index(prev);
  const after = index(next);
  const changes: SkillChange[] = [];
  for (const [key, a] of after) {
    const b = before.get(key);
    if (!b) changes.push({ id: a.id, registry: a.registry, change: 'added' });
    else if (b.hash !== a.hash) changes.push({ id: a.id, registry: a.registry, change: 'changed' });
  }
  for (const [key, b] of before) if (!after.has(key)) changes.push({ id: b.id, registry: b.registry, change: 'removed' });
  return changes;
}

/** True when dir exists, holds something other than our own lock or leftovers, and has neither the marker nor a manifest. */
async function foreignDir(dir: string): Promise<boolean> {
  const names = await readdir(dir).catch(() => [] as string[]);
  const own = (n: string) => n.startsWith('.lock') || n === STAGING || n.startsWith(OLD_PREFIX);
  return names.some((n) => !own(n)) && !names.includes(MARKER) && !names.includes('manifest.json');
}
