import { readFile, stat } from 'node:fs/promises';
import type { Ctx } from './context.js';
import { Catalog } from './catalog/catalog.js';
import { loadConfig } from './config/load.js';
import { catalogFromManifest, readProblems, type RegistryView } from './library/catalog.js';
import { manifestFile, readManifest, type Manifest } from './library/manifest.js';
import { configHash } from './library/pull.js';
import { configPath, libraryDir } from './paths.js';
import type { IncludeInfo, Override } from './resolve/resolve.js';
import type { Config, Problem } from './types.js';

export type { RegistryView } from './library/catalog.js';

export interface Engine {
  config(): Promise<Config>;
  catalog(): Promise<Catalog>;
  /** `overrides` holds every override: registry-name ones first, then skill-id ones (same as the catalog's). */
  registries(): Promise<{ registries: RegistryView[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[] }>;
  library(): Promise<{ dir: string; manifest?: Manifest }>;
}

export const LIBRARY_EMPTY = "the skill library is empty; run 'skillseekr update'";
export const CONFIG_CHANGED = "the config changed since the last update; run 'skillseekr update' to apply it";

/** What a memo was built from; any change to either file means the memo is stale. */
interface Stamps { configFile: string; config: string; manifestFile: string; manifest: string }

interface Loaded {
  catalog: Catalog; views: RegistryView[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[];
  dir: string; manifest?: Manifest; stamps?: Stamps;
}

async function fileStamp(file: string): Promise<string> {
  try {
    const st = await stat(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch (e) {
    return `absent:${(e as NodeJS.ErrnoException).code ?? 'error'}`;
  }
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Reads serve the library only: no resolution, no fetch, no request. A config edit takes effect at the next update. */
export function createEngine(ctx: Ctx): Engine {
  let memo: { promise: Promise<Loaded>; done?: Loaded } | undefined;

  async function loadInner(): Promise<Loaded> {
    // Stamped before reading, so a change made while loading still triggers a reload next time.
    const configFile = configPath(ctx);
    const configStamp = await fileStamp(configFile);
    const config = await loadConfig(ctx);
    const dir = config.libraryDir;
    const mFile = manifestFile(dir);
    const stamps: Stamps = { configFile, config: configStamp, manifestFile: mFile, manifest: await fileStamp(mFile) };
    const manifest = await readManifest(dir);

    // The manifest holds the local config's problems as of the last update; the current config's replace them.
    const fromConfig = (p: Problem) => p.code.startsWith('config/') && p.file === config.path;
    const problems: Problem[] = [...config.problems];
    if (!manifest) {
      problems.push({ level: 'error', code: 'library/empty', message: LIBRARY_EMPTY });
      return { catalog: new Catalog([], [], problems, false), views: [], includes: [], overrides: [], problems, dir, stamps };
    }
    problems.push(...readProblems(manifest).filter((p) => !fromConfig(p)));
    if (config.exists) {
      const text = await readFile(config.path, 'utf8').catch(() => undefined);
      if (text === undefined || configHash(text) !== manifest.configHash) {
        problems.push({ level: 'warning', code: 'library/config-changed', message: CONFIG_CHANGED });
      }
    }
    const { catalog, views, includes } = catalogFromManifest(dir, manifest, problems);
    return { catalog, views, includes, overrides: catalog.overrides, problems, dir, manifest, stamps };
  }

  async function load(): Promise<Loaded> {
    try {
      return await loadInner();
    } catch (e) {
      const problems: Problem[] = [{ level: 'error', code: 'engine/load-failed', message: `loading the catalog failed unexpectedly: ${msg(e)}` }];
      let dir = '';
      try { dir = libraryDir(ctx); } catch { /* keep '' */ }
      return { catalog: new Catalog([], [], problems, false), views: [], includes: [], overrides: [], problems, dir };
    }
  }

  /** True while the config file and the manifest are what the memo was built from. */
  async function unchanged(st: Stamps | undefined): Promise<boolean> {
    if (!st) return false;
    return (await fileStamp(st.configFile)) === st.config && (await fileStamp(st.manifestFile)) === st.manifest;
  }

  async function get(): Promise<Loaded> {
    if (memo) {
      const cur = memo;
      if (!cur.done) return cur.promise; // a load is in flight: share it
      if (await unchanged(cur.done.stamps)) return cur.promise;
      if (memo !== cur) return memo.promise; // another caller started the reload while we checked
    }
    const entry: NonNullable<typeof memo> = { promise: undefined as unknown as Promise<Loaded> };
    entry.promise = load().then((l) => { entry.done = l; return l; });
    memo = entry;
    return entry.promise;
  }

  return {
    config: () => loadConfig(ctx),
    async catalog() { return (await get()).catalog; },
    async registries() {
      const l = await get();
      return { registries: l.views, includes: l.includes, overrides: l.overrides, problems: l.problems };
    },
    async library() {
      const l = await get();
      return { dir: l.dir, ...(l.manifest ? { manifest: l.manifest } : {}) };
    },
  };
}
