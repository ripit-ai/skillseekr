import { parseRegistriesFile } from '../config/load.js';
import type { Ctx } from '../context.js';
import { readGithubFile, type FetchOpts } from '../sources/github.js';
import { fetchHttpText } from '../sources/http.js';
import { policyProblemKey } from '../policy/parse.js';
import type { Policy } from '../policy/types.js';
import type { Config, IncludeEntry, Problem, RegistriesFile, RegistryEntry, SourceEntry } from '../types.js';

export interface ResolvedRegistry { name: string; entry: SourceEntry; via: string[]; trusted: boolean /* true iff declared directly in local config */ }
export interface Override { kind: 'registry' | 'skill'; key: string; replaced: { registry: string; via: string[] }; by: { registry: string; via: string[] } }
export interface IncludeInfo { name: string; via: string[]; entry: IncludeEntry; sha?: string; stale: boolean; policy: boolean /* entry.policy && depth===1 */ }
export interface Resolution { registries: ResolvedRegistry[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[]; stale: boolean; policy: Policy }

/** Effective TTL for one registry: 0 (re-check every load) when caching is off globally or for the entry. */
export const ttlFor = (config: Pick<Config, 'cache'>, entry: { cache_enabled: boolean }): number =>
  config.cache.enabled && entry.cache_enabled ? config.cache.ttlSeconds : 0;

/** The local config is depth 0; an include entry whose file would be deeper than this is skipped. */
export const MAX_INCLUDE_DEPTH = 5;

const isInclude = (e: RegistryEntry): e is IncludeEntry => e.type === 'github-registry' || e.type === 'http-registry';

/** Auth that names an environment variable: allowed only in the local config. */
const usesEnvAuth = (e: RegistryEntry): boolean =>
  e.auth.type === 'github_token' || e.auth.type === 'bearer' || e.auth.type === 'basic';

/** Normalised URL (scheme/host case, default port, dot segments); the raw string when it doesn't parse. */
const normUrl = (u: string): string => { try { return new URL(u).href; } catch { return u; } };

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

export async function resolve(config: Config, opts: { force: boolean }, ctx: Ctx): Promise<Resolution> {
  const problems: Problem[] = [...config.problems];
  const includes: IncludeInfo[] = [];
  const overrides: Override[] = [];
  const hoisted = new Map<string, ResolvedRegistry>();
  let stale = false;
  const policySeen = new Set<string>();
  const policy: Policy = {
    sources: [{ source: { kind: 'local', file: config.path }, allow: config.policy.allow, block: config.policy.block }],
    trust: config.policy.trust,
  };

  type Fetched = Awaited<ReturnType<typeof readGithubFile>> | Awaited<ReturnType<typeof fetchHttpText>>;
  type Loaded = Exclude<Fetched, { error: Problem }> & { sha?: string; parsed: RegistriesFile };

  const fetchInclude = (entry: IncludeEntry, trusted: boolean): Promise<Fetched> => {
    const fo: FetchOpts = {
      force: opts.force, trusted, ttlSeconds: ttlFor(config, entry),
    };
    return entry.type === 'github-registry'
      ? readGithubFile(entry, fo, config.cache, ctx)
      : fetchHttpText(entry, fo, config.cache, ctx);
  };

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
          const r = await fetchInclude(entry, trusted);
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
      const honoured = entry.policy && depth === 1;
      for (const p0 of parsed.problems) {
        let p = p0;
        const pk = p0.code === 'policy/invalid-entry' ? policyProblemKey(p0) : undefined;
        if (pk && (pk === 'trust' || !honoured)) {
          p = { ...p0, level: 'warning', message: `${p0.message.replace(/ Skipped\.$/, '')} ${pk} in this file is ignored anyway (${pk === 'trust' ? 'only the local config may set trust' : 'only the local config and policy:true includes from it may ' + pk}). Skipped.` };
        }
        problems.push({ ...p, registry: p.registry ?? name, via: p.registry ? [...via, p.registry] : via, file: p.file ?? file });
      }
      const ignored = (key: 'allow' | 'block' | 'trust', code: string, rule: string): void => {
        problems.push({
          level: 'warning', code, registry: name, via, file,
          message: `${key} entries in ${file} are ignored (${rule})`,
        });
      };
      const pol = parsed.policy;
      if (honoured) { if (!policySeen.has(id)) { policySeen.add(id); policy.sources.push({ source: { kind: 'include', name, via, file }, allow: pol.allow, block: pol.block }); } }
      else {
        if (Object.keys(pol.allow).length > 0) ignored('allow', 'policy/ignored-allow', 'only the local config and policy:true includes from it may allow');
        if (pol.block.length > 0) ignored('block', 'policy/ignored-block', 'only the local config and policy:true includes from it may block');
      }
      if (pol.trust.length > 0) ignored('trust', 'policy/ignored-trust', 'only the local config may set trust');
      await walk(parsed.registries, { trusted: false, depth, via, file, seen: new Set([...lvl.seen, id]) });
    }
  };

  await walk(config.registries, { trusted: true, depth: 0, via: [], file: config.path, seen: new Set() });
  return { registries: [...hoisted.values()], includes, overrides, problems, stale, policy };
}
