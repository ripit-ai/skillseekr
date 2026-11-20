import { parseRegistriesFile } from '../config/load.js';
import type { Ctx } from '../context.js';
import { fetchGithubFile } from '../sources/github.js';
import { fetchHttpBody } from '../sources/http.js';
import { normUrl } from '../library/layout.js';
import type { Config, IncludeEntry, Problem, RegistriesFile, RegistryEntry, SourceEntry } from '../types.js';

export interface ResolvedRegistry { name: string; entry: SourceEntry; via: string[]; trusted: boolean /* true iff declared directly in local config */ }
export interface Override { kind: 'registry' | 'skill'; key: string; replaced: { registry: string; via: string[] }; by: { registry: string; via: string[] } }
export interface IncludeInfo { name: string; via: string[]; entry: IncludeEntry; sha?: string; stale: boolean; policy: boolean /* entry.policy && depth===1 */ }
export interface Resolution { registries: ResolvedRegistry[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[]; stale: boolean }

/** Effective TTL for one registry: 0 (re-check every load) when caching is off globally or for the entry. */
export const ttlFor = (config: Pick<Config, 'cache'>, entry: { cache_enabled: boolean }): number =>
  config.cache.enabled && entry.cache_enabled ? config.cache.ttlSeconds : 0;

export type IncludeLoad = { text: string; sha?: string; stale: boolean; problems: Problem[] } | { error: Problem };
/** Supplies the text of one included registries file. `trusted` is true iff the entry is declared in the local config. */
export type IncludeLoader = (entry: IncludeEntry, trusted: boolean) => Promise<IncludeLoad>;

/** Fetches each include straight from the network: no persistence, never stale. */
export const onlineIncludeLoader = (ctx: Ctx): IncludeLoader => async (entry, trusted) => {
  if (entry.type === 'github-registry') {
    const r = await fetchGithubFile(entry, { trusted }, ctx);
    return 'error' in r ? r : { text: r.text, sha: r.sha, stale: false, problems: r.problems };
  }
  const r = await fetchHttpBody(entry, { trusted }, ctx);
  if ('error' in r) return r;
  if (r.notModified) return { error: { level: 'error', code: 'source/unreachable', message: `unexpected 304 Not Modified from ${entry.url}` } };
  return { text: r.body.toString('utf8'), stale: false, problems: r.problems };
};

/** The local config is depth 0; an include entry whose file would be deeper than this is skipped. */
export const MAX_INCLUDE_DEPTH = 5;

const isInclude = (e: RegistryEntry): e is IncludeEntry => e.type === 'github-registry' || e.type === 'http-registry';

/** Auth that names an environment variable: allowed only in the local config. */
const usesEnvAuth = (e: RegistryEntry): boolean =>
  e.auth.type === 'github_token' || e.auth.type === 'bearer' || e.auth.type === 'basic';

/**
 * Identity of the file an include points at, for loop detection and memoisation. GitHub owner/repo are
 * case-insensitive and URLs are normalised, so a hostile file can't dodge loop detection with spelling.
 */
const includeId = (e: IncludeEntry): string =>
  e.type === 'github-registry'
    ? `gh:${e.owner.toLowerCase()}/${e.repo.toLowerCase()}@${e.ref}:${e.path}`
    : `url:${normUrl(e.url)}`;

const fileLabel = (e: IncludeEntry): string =>
  e.type === 'github-registry' ? `github:${e.owner}/${e.repo}@${e.ref}:${e.path}` : e.url;

interface Level { trusted: boolean; depth: number /* of the file holding the entries */; via: string[]; file: string; seen: ReadonlySet<string> }

export async function resolve(config: Config, loader: IncludeLoader): Promise<Resolution> {
  const problems: Problem[] = [...config.problems];
  const includes: IncludeInfo[] = [];
  const overrides: Override[] = [];
  const hoisted = new Map<string, ResolvedRegistry>();
  let stale = false;

  type Loaded = Exclude<IncludeLoad, { error: Problem }> & { parsed: RegistriesFile };

  /**
   * Fetch + parse once per include target within this call (diamond / fan-out graphs). Keyed by identity,
   * trust and auth, since those decide which credentials the fetch may use. Unexpected throws become a problem.
   */
  const memo = new Map<string, Promise<Loaded | { error: Problem }>>();
  const load = (entry: IncludeEntry, id: string, trusted: boolean): Promise<Loaded | { error: Problem }> => {
    const key = `${id}\0${trusted}\0${JSON.stringify(entry.auth)}`;
    let p = memo.get(key);
    if (!p) {
      p = (async () => {
        try {
          const r = await loader(entry, trusted);
          if ('error' in r) return r;
          return { ...r, parsed: parseRegistriesFile(r.text, { file: fileLabel(entry), isLocalConfig: false }) };
        } catch (e) {
          return { error: { level: 'error', code: 'resolve/include-failed', message: `fetching ${fileLabel(entry)} failed unexpectedly: ${(e as Error)?.message ?? String(e)}` } };
        }
      })();
      memo.set(key, p);
    }
    return p;
  };

  const walk = async (registries: Array<[string, RegistryEntry]>, lvl: Level): Promise<void> => {
    for (const [name, entry] of registries) {
      const via = [...lvl.via, name];
      const at = (p: Omit<Problem, 'registry' | 'via' | 'file'>): Problem => ({ ...p, registry: name, via, file: lvl.file });

      // Checked before any fetch: the env var named by an untrusted entry is never read.
      if (!lvl.trusted && usesEnvAuth(entry)) {
        problems.push(at({
          level: 'warning', code: 'auth/untrusted-env-auth',
          message: `registry "${name}" (via ${via.join(' → ')}) uses ${entry.auth.type} auth, which is only allowed in the local config; included registries files may only use gh_cli or no auth. Skipped.`,
        }));
        continue;
      }

      if (!isInclude(entry)) {
        const prev = hoisted.get(name);
        const next: ResolvedRegistry = { name, entry, via, trusted: lvl.trusted };
        if (prev) {
          overrides.push({ kind: 'registry', key: name, replaced: { registry: name, via: prev.via }, by: { registry: name, via } });
          hoisted.delete(name); // re-insert so the winner takes the position of its last occurrence
        }
        hoisted.set(name, next);
        continue;
      }

      const depth = lvl.depth + 1;
      if (depth > MAX_INCLUDE_DEPTH) {
        problems.push(at({
          level: 'error', code: 'resolve/too-deep',
          message: `include "${name}" (via ${via.join(' → ')}) is nested deeper than ${MAX_INCLUDE_DEPTH} levels. Skipped.`,
        }));
        continue;
      }
      const id = includeId(entry);
      if (lvl.seen.has(id)) {
        problems.push(at({
          level: 'error', code: 'resolve/include-loop',
          message: `include "${name}" (via ${via.join(' → ')}) points back at ${fileLabel(entry)}, which is already being included. Skipped.`,
        }));
        continue;
      }

      const r = await load(entry, id, lvl.trusted);
      if ('error' in r) {
        problems.push({ ...r.error, registry: name, via, file: r.error.file ?? lvl.file });
        continue;
      }
      for (const p of r.problems) problems.push({ ...p, registry: name, via, file: p.file ?? lvl.file });
      if (r.stale) stale = true;
      includes.push({
        name, via, entry, ...(r.sha !== undefined ? { sha: r.sha } : {}), stale: r.stale, policy: entry.policy && depth === 1,
      });

      const file = fileLabel(entry);
      const { parsed } = r;
      for (const p of parsed.problems) {
        problems.push({ ...p, registry: p.registry ?? name, via: p.registry ? [...via, p.registry] : via, file: p.file ?? file });
      }
      await walk(parsed.registries, { trusted: false, depth, via, file, seen: new Set([...lvl.seen, id]) });
    }
  };

  await walk(config.registries, { trusted: true, depth: 0, via: [], file: config.path, seen: new Set() });
  return { registries: [...hoisted.values()], includes, overrides, problems, stale };
}
