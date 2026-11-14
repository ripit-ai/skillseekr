import { parseRegistriesFile } from '../config/load.js';
import type { Ctx } from '../context.js';
import { readGithubFile, type FetchOpts } from '../sources/github.js';
import { fetchHttpText } from '../sources/http.js';
import type { Config, IncludeEntry, Problem, RegistryEntry, SourceEntry } from '../types.js';

export interface ResolvedRegistry { name: string; entry: SourceEntry; via: string[]; trusted: boolean /* true iff declared directly in local config */ }
export interface Override { kind: 'registry' | 'skill'; key: string; replaced: { registry: string; via: string[] }; by: { registry: string; via: string[] } }
export interface IncludeInfo { name: string; via: string[]; entry: IncludeEntry; sha?: string; stale: boolean; policy: boolean /* entry.policy && depth===1 */ }
export interface Resolution { registries: ResolvedRegistry[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[]; stale: boolean }

/** The local config is depth 0; an include entry whose file would be deeper than this is skipped. */
export const MAX_INCLUDE_DEPTH = 5;

const isInclude = (e: RegistryEntry): e is IncludeEntry => e.type === 'github-registry' || e.type === 'http-registry';

/** Auth that names an environment variable: allowed only in the local config. */
const usesEnvAuth = (e: RegistryEntry): boolean =>
  e.auth.type === 'github_token' || e.auth.type === 'bearer' || e.auth.type === 'basic';

/** Identity of the file an include points at, used for loop detection and as the file label in problems. */
const includeId = (e: IncludeEntry): string =>
  e.type === 'github-registry' ? `gh:${e.owner}/${e.repo}@${e.ref}:${e.path}` : `url:${e.url}`;

const fileLabel = (e: IncludeEntry): string =>
  e.type === 'github-registry' ? `github:${e.owner}/${e.repo}@${e.ref}:${e.path}` : e.url;

interface Level { trusted: boolean; depth: number /* of the file holding the entries */; via: string[]; file: string; seen: ReadonlySet<string> }

export async function resolve(config: Config, opts: { force: boolean }, ctx: Ctx): Promise<Resolution> {
  const problems: Problem[] = [...config.problems];
  const includes: IncludeInfo[] = [];
  const overrides: Override[] = [];
  const hoisted = new Map<string, ResolvedRegistry>();
  let stale = false;

  const fetchInclude = (entry: IncludeEntry, trusted: boolean) => {
    const fo: FetchOpts = {
      force: opts.force, trusted,
      ttlSeconds: config.cache.enabled && entry.cache_enabled ? config.cache.ttlSeconds : 0,
    };
    return entry.type === 'github-registry'
      ? readGithubFile(entry, fo, config.cache, ctx)
      : fetchHttpText(entry, fo, config.cache, ctx);
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

      const r = await fetchInclude(entry, lvl.trusted);
      if ('error' in r) {
        problems.push({ ...r.error, registry: name, via });
        continue;
      }
      for (const p of r.problems) problems.push({ ...p, registry: name, via });
      if (r.stale) stale = true;
      includes.push({
        name, via, entry, ...('sha' in r && typeof r.sha === 'string' ? { sha: r.sha } : {}), stale: r.stale, policy: entry.policy && depth === 1,
      });

      const file = fileLabel(entry);
      const parsed = parseRegistriesFile(r.text, { file, isLocalConfig: false });
      for (const p of parsed.problems) {
        problems.push({ ...p, registry: p.registry ?? name, via: p.registry ? [...via, p.registry] : via, file: p.file ?? file });
      }
      await walk(parsed.registries, { trusted: false, depth, via, file, seen: new Set([...lvl.seen, id]) });
    }
  };

  await walk(config.registries, { trusted: true, depth: 0, via: [], file: config.path, seen: new Set() });
  return { registries: [...hoisted.values()], includes, overrides, problems, stale };
}
