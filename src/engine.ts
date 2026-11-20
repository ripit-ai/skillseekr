import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Ctx } from './context.js';
import { Catalog } from './catalog/catalog.js';
import { discoverSkills, type DiscoveredSkill } from './catalog/discover.js';
import { loadConfig } from './config/load.js';
import { configPath } from './paths.js';
import { readState } from './cache/state.js';
import { resolve, ttlFor, type IncludeLoader, type IncludeInfo, type Override, type ResolvedRegistry } from './resolve/resolve.js';
import { isShaRef, materializeGithub, readGithubFile, type FetchOpts } from './sources/github.js';
import { fetchHttpText, materializeHttpSkill } from './sources/http.js';
import type { CacheSettings, Config, Problem, SourceEntry } from './types.js';

export interface RegistryView {
  name: string; type: SourceEntry['type']; auth: SourceEntry['auth']['type']; via: string[]; description?: string; instructions?: string;
  ref?: string; sha?: string; cacheAgeSeconds?: number; stale: boolean; skillCount: number;
  /** The registries this one replaced by name ("last wins"); absent when it replaced none. */
  overrode?: Array<{ registry: string; via: string[] }>;
}
export interface Engine {
  config(): Promise<Config>;
  catalog(opts?: { force?: boolean }): Promise<Catalog>;
  /** `overrides` holds every override: registry-name ones first, then skill-id ones (same as the catalog's). */
  registries(): Promise<{ registries: RegistryView[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[] }>;
}
export interface EngineDeps { discover?: typeof discoverSkills }

/** What a memo was built from; any change to either means the memo is stale. */
interface Stamps { configFile: string; config: string; generationFile: string; generation: string }

interface Loaded {
  catalog: Catalog; views: RegistryView[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[];
  /** ms timestamp after which the memo is stale; Infinity when nothing is ever re-checked. */
  expiresAt: number;
  stamps?: Stamps;
}

/** A load with any error-level problem is retried at least this often, whatever the TTL. */
export const ERROR_RETRY_MS = 60_000;

/** `<cacheDir>/state/generation`: rewritten by every forced load (`sync`) so other processes reload. */
export const generationFile = (cacheDir: string): string => join(cacheDir, 'state', 'generation');

async function fileStamp(file: string): Promise<string> {
  try {
    const st = await stat(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch (e) {
    return `absent:${(e as NodeJS.ErrnoException).code ?? 'error'}`;
  }
}

async function generationStamp(file: string): Promise<string> {
  try { return await readFile(file, 'utf8'); } catch { return 'absent'; }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function validSkills(v: unknown): v is DiscoveredSkill[] {
  return Array.isArray(v) && v.every((s) => s && typeof s === 'object'
    && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.description === 'string'
    && typeof s.dir === 'string' && typeof s.contentHash === 'string'
    && Array.isArray(s.files) && Array.isArray(s.warnings));
}

async function writeAtomic(file: string, data: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, data, { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

export function createEngine(ctx: Ctx, deps: EngineDeps = {}): Engine {
  const discover = deps.discover ?? discoverSkills;
  let memo: { promise: Promise<Loaded>; done?: Loaded } | undefined;

  async function indexed(cache: CacheSettings, owner: string, repo: string, sha: string, skillsDir: string, root: string): Promise<DiscoveredSkill[]> {
    const file = join(cache.dir, 'index', owner, repo, sha, `${sha256(skillsDir)}.json`);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (validSkills(parsed)) return parsed;
    } catch { /* missing or unreadable: recompute */ }
    const skills = await discover(root, skillsDir);
    await writeAtomic(file, JSON.stringify(skills)).catch(() => {});
    return skills;
  }

  async function loadOne(reg: ResolvedRegistry, config: Config, force: boolean) {
    const { entry } = reg;
    const attach = (p: Problem): Problem => ({ ...p, registry: reg.name, via: reg.via });
    const fo: FetchOpts = {
      force, trusted: reg.trusted,
      ttlSeconds: ttlFor(config, entry),
    };
    const problems: Problem[] = [];
    let skills: DiscoveredSkill[] = [];
    let sha: string | undefined;
    let stale = false;
    let cacheAgeSeconds: number | undefined;
    let recheck = false;
    try {
      if (entry.type === 'github') {
        recheck = !isShaRef(entry.ref);
        const r = await materializeGithub(entry, fo, config.cache, ctx);
        if ('error' in r) {
          problems.push(attach(r.error));
        } else {
          sha = r.sha; stale = r.stale;
          problems.push(...r.problems.map(attach));
          skills = await indexed(config.cache, entry.owner, entry.repo, r.sha, entry.skills_dir, r.root);
          if (recheck) {
            const rec = await readState<{ checkedAt?: unknown }>(config.cache.dir, `ref/${entry.owner}/${entry.repo}/${entry.ref}`);
            if (typeof rec?.checkedAt === 'number') cacheAgeSeconds = (ctx.now() - rec.checkedAt) / 1000;
          }
        }
      } else {
        recheck = true;
        const r = await materializeHttpSkill(entry, fo, config.cache, ctx);
        if ('error' in r) {
          problems.push(attach(r.error));
        } else {
          stale = r.stale;
          problems.push(...r.problems.map(attach));
          skills = (await discover(dirname(r.root), '')).filter((s) => s.id === entry.skill_name);
          const rec = await readState<{ checkedAt?: unknown }>(config.cache.dir, `http/${sha256(entry.url)}`);
          if (typeof rec?.checkedAt === 'number') cacheAgeSeconds = (ctx.now() - rec.checkedAt) / 1000;
        }
      }
    } catch (e) {
      skills = [];
      problems.push(attach({ level: 'error', code: 'engine/source-failed', message: `registry "${reg.name}" failed unexpectedly: ${msg(e)}` }));
    }
    return { reg, sha, stale, skills, problems, cacheAgeSeconds, ttl: fo.ttlSeconds, recheck };
  }

  async function loadInner(force: boolean): Promise<Loaded> {
    // Stamped before reading, so an edit made while loading still triggers a reload next time.
    const configFile = configPath(ctx);
    const configStamp = await fileStamp(configFile);
    const config = await loadConfig(ctx);
    const genFile = generationFile(config.cache.dir);
    const stamps: Stamps = { configFile, config: configStamp, generationFile: genFile, generation: await generationStamp(genFile) };
    const cachedLoader: IncludeLoader = (entry, trusted) => {
      const fo: FetchOpts = { force, trusted, ttlSeconds: ttlFor(config, entry) };
      return entry.type === 'github-registry' ? readGithubFile(entry, fo, config.cache, ctx) : fetchHttpText(entry, fo, config.cache, ctx);
    };
    const res = await resolve(config, cachedLoader);
    const results = await Promise.all(res.registries.map((r) => loadOne(r, config, force)));

    const problems = [...res.problems, ...results.flatMap((r) => r.problems)];
    const stale = res.stale || results.some((r) => r.stale);
    const catalog = new Catalog(
      results.map((r) => ({
        registry: r.reg, skills: r.skills,
        ...(r.reg.entry.type === 'github' ? { ref: r.reg.entry.ref } : {}),
        ...(r.sha !== undefined ? { sha: r.sha } : {}),
      })),
      res.overrides, problems, stale,
    );

    const views: RegistryView[] = results.map((r) => {
      const e = r.reg.entry;
      const overrode = res.overrides
        .filter((o) => o.kind === 'registry' && o.by.registry === r.reg.name && o.by.via.join('\0') === r.reg.via.join('\0'))
        .map((o) => o.replaced);
      return {
        name: r.reg.name, type: e.type, auth: e.auth.type, via: r.reg.via,
        ...(e.description !== undefined ? { description: e.description } : {}),
        ...(e.instructions !== undefined ? { instructions: e.instructions } : {}),
        ...(e.type === 'github' ? { ref: e.ref } : {}),
        ...(r.sha !== undefined ? { sha: r.sha } : {}),
        ...(r.cacheAgeSeconds !== undefined ? { cacheAgeSeconds: r.cacheAgeSeconds } : {}),
        stale: r.stale, skillCount: r.skills.length,
        ...(overrode.length ? { overrode } : {}),
      };
    });

    // The memo lasts until the earliest re-check of any non-SHA github source, http source or include.
    const ttls = results.filter((r) => r.recheck).map((r) => r.ttl);
    for (const i of res.includes) if (i.entry.type === 'http-registry' || !isShaRef(i.entry.ref)) ttls.push(ttlFor(config, i.entry));
    const doneAt = ctx.now(); // anchored at load completion, not start
    let expiresAt = ttls.length ? doneAt + Math.min(...ttls) * 1000 : Infinity;
    if (!config.exists) expiresAt = doneAt; // setup may create the config at any moment
    if (problems.some((p) => p.level === 'error')) expiresAt = Math.min(expiresAt, doneAt + ERROR_RETRY_MS);
    return { catalog, views, includes: res.includes, overrides: catalog.overrides, problems, expiresAt, stamps };
  }

  async function load(force: boolean): Promise<Loaded> {
    try {
      return await loadInner(force);
    } catch (e) {
      const problems: Problem[] = [{ level: 'error', code: 'engine/load-failed', message: `loading the catalog failed unexpectedly: ${msg(e)}` }];
      let now = 0;
      try { now = ctx.now(); } catch { /* keep 0 */ }
      return { catalog: new Catalog([], [], problems, false), views: [], includes: [], overrides: [], problems, expiresAt: now };
    }
  }

  /** True while the config file and the sync generation are what the memo was built from. */
  async function unchanged(st: Stamps | undefined): Promise<boolean> {
    if (!st) return false;
    return (await fileStamp(st.configFile)) === st.config && (await generationStamp(st.generationFile)) === st.generation;
  }

  /** Marks a forced load for other processes; this engine records the new generation so it doesn't reload itself. */
  async function bumpGeneration(l: Loaded): Promise<void> {
    if (!l.stamps) return;
    const value = `${ctx.now()}-${process.pid}-${randomBytes(6).toString('hex')}\n`;
    try {
      await writeAtomic(l.stamps.generationFile, value);
      l.stamps.generation = value;
    } catch { /* unwritable cache: other processes reload on their own TTL */ }
  }

  async function get(force: boolean): Promise<Loaded> {
    if (!force && memo) {
      const cur = memo;
      if (!cur.done) return cur.promise; // a load is in flight: share it
      if (ctx.now() < cur.done.expiresAt && await unchanged(cur.done.stamps)) return cur.promise;
      if (memo !== cur) return memo.promise; // another caller started the reload while we checked
    }
    const entry: NonNullable<typeof memo> = { promise: undefined as unknown as Promise<Loaded> };
    entry.promise = load(force).then(
      async (l) => { if (force) await bumpGeneration(l); entry.done = l; return l; },
      (e) => { if (memo === entry) memo = undefined; throw e; }, // unreachable: load() never rejects
    );
    memo = entry;
    return entry.promise;
  }

  return {
    config: () => loadConfig(ctx),
    async catalog(opts) { return (await get(opts?.force ?? false)).catalog; },
    async registries() {
      const l = await get(false);
      return { registries: l.views, includes: l.includes, overrides: l.overrides, problems: l.problems };
    },
  };
}
