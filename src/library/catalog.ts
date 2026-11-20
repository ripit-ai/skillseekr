import { join } from 'node:path';
import { Catalog } from '../catalog/catalog.js';
import type { IncludeInfo } from '../resolve/resolve.js';
import type { Problem, SourceEntry } from '../types.js';
import type { Manifest } from './manifest.js';

export interface RegistryView {
  name: string; type: SourceEntry['type']; auth: SourceEntry['auth']['type']; via: string[]; description?: string; instructions?: string;
  ref?: string; sha?: string; /** ISO time of the last successful fetch. */ fetchedAt?: string; stale: boolean; skillCount: number;
  /** The registries this one replaced by name ("last wins"); absent when it replaced none. */
  overrode?: Array<{ registry: string; via: string[] }>;
}

/**
 * The manifest's problems as reads report them. A source whose last update failed but which kept its previous
 * copy is served stale: its fetch error (source/*) becomes a source/stale warning (the message, with any auth hint,
 * is kept).
 */
export function readProblems(m: Manifest): Problem[] {
  const kept = new Set(m.sources.filter((s) => s.stale && s.folder).map((s) => s.name));
  // Only fetch failures (source/*): a library/* error (a security rejection, a failed write) stays an error.
  return m.problems.map((p) => (p.level === 'error' && p.code.startsWith('source/') && p.registry !== undefined && kept.has(p.registry)
    ? { ...p, level: 'warning', code: 'source/stale', message: `${p.message}; using the library's copy from the last successful update, which may be stale` }
    : p));
}

/**
 * The catalog a manifest describes, built in the manifest's source order (so "last wins" and the skill
 * overrides come out as in resolution). Skill folders are made absolute under libDir. `problems` defaults
 * to the manifest's, as reads report them.
 */
export function catalogFromManifest(
  libDir: string, m: Manifest, problems: Problem[] = readProblems(m),
): { catalog: Catalog; views: RegistryView[]; includes: IncludeInfo[] } {
  const stale = m.sources.some((s) => s.stale) || m.includes.some((i) => i.stale);
  const catalog = new Catalog(
    m.sources.map((s) => ({
      registry: { name: s.name, entry: s.entry, via: s.via, trusted: s.trusted },
      skills: s.skills.map((k) => ({ ...k, dir: join(libDir, k.dir) })),
      ...(s.entry.type === 'github' ? { ref: s.entry.ref } : {}),
      ...(s.sha !== undefined ? { sha: s.sha } : {}),
    })),
    m.overrides, problems, stale,
  );
  const views: RegistryView[] = m.sources.map((s) => {
    const e = s.entry;
    const overrode = m.overrides
      .filter((o) => o.kind === 'registry' && o.by.registry === s.name && o.by.via.join('\0') === s.via.join('\0'))
      .map((o) => o.replaced);
    return {
      name: s.name, type: e.type, auth: e.auth.type, via: s.via,
      ...(e.description !== undefined ? { description: e.description } : {}),
      ...(e.instructions !== undefined ? { instructions: e.instructions } : {}),
      ...(e.type === 'github' ? { ref: e.ref } : {}),
      ...(s.sha !== undefined ? { sha: s.sha } : {}),
      ...(s.fetchedAt !== undefined ? { fetchedAt: s.fetchedAt } : {}),
      stale: s.stale, skillCount: s.skills.length,
      ...(overrode.length ? { overrode } : {}),
    };
  });
  const includes: IncludeInfo[] = m.includes.map((i) => ({
    name: i.name, via: i.via, entry: i.entry, ...(i.sha !== undefined ? { sha: i.sha } : {}), stale: i.stale, policy: i.policy,
  }));
  return { catalog, views, includes };
}
