import { lstat, open } from 'node:fs/promises';
import { resolve, sep, isAbsolute } from 'node:path';
import type { DiscoveredSkill } from './discover.js';
import type { ResolvedRegistry, Override } from '../resolve/resolve.js';
import type { Problem } from '../types.js';
import { Bm25Index } from './search.js';
import { MAX_FILE_BYTES } from './limits.js';

export interface SkillRecord extends DiscoveredSkill { registry: string; via: string[]; ref?: string; sha?: string; instructions?: string }
export type Lookup = { kind: 'found'; skill: SkillRecord } | { kind: 'ambiguous'; ids: string[] } | { kind: 'missing' };
export type FileRead =
  | { kind: 'text'; content: string }
  | { kind: 'binary' | 'too_large'; size: number; path: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'missing' };
export interface SearchHit {
  id: string; name: string; description: string; registry: string; via: string[]; score: number;
  overrode: Array<{ registry: string; via: string[] }>;
}

const SNIFF_BYTES = 8192;
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export class Catalog {
  readonly skills: SkillRecord[];
  readonly overrides: Override[];
  readonly problems: Problem[];
  readonly stale: boolean;
  private readonly ids = new Map<string, SkillRecord>();
  private index?: Bm25Index;

  constructor(
    perRegistry: Array<{ registry: ResolvedRegistry; ref?: string; sha?: string; skills: DiscoveredSkill[] }>,
    overrides: Override[], problems: Problem[], stale: boolean,
  ) {
    const skillOverrides: Override[] = [];
    for (const r of perRegistry) {
      const instructions = r.registry.entry.instructions;
      for (const s of r.skills) {
        const prev = this.ids.get(s.id);
        if (prev) {
          skillOverrides.push({
            kind: 'skill', key: s.id,
            replaced: { registry: prev.registry, via: prev.via },
            by: { registry: r.registry.name, via: r.registry.via },
          });
        }
        const rec: SkillRecord = { ...s, registry: r.registry.name, via: r.registry.via };
        if (r.ref !== undefined) rec.ref = r.ref;
        if (r.sha !== undefined) rec.sha = r.sha;
        if (instructions !== undefined) rec.instructions = instructions;
        this.ids.set(s.id, rec);
      }
    }
    this.skills = [...this.ids.values()].sort((a, b) => byCodeUnit(a.id, b.id));
    this.overrides = [...overrides, ...skillOverrides];
    this.problems = problems;
    this.stale = stale;
  }

  /** Exact skill-id match only (no bare-name fallback): for installed markers, whose id must still exist. */
  byId(id: string): SkillRecord | undefined {
    return this.ids.get(id);
  }

  lookup(idOrName: string): Lookup {
    const exact = this.ids.get(idOrName);
    if (exact) return { kind: 'found', skill: exact };
    const named = this.skills.filter((s) => s.name === idOrName);
    if (named.length === 1) return { kind: 'found', skill: named[0]! };
    if (named.length > 1) return { kind: 'ambiguous', ids: named.map((s) => s.id).sort(byCodeUnit) };
    return { kind: 'missing' };
  }

  overridesFor(id: string): Override[] {
    return this.overrides.filter((o) => o.kind === 'skill' && o.key === id);
  }

  async readFile(skill: SkillRecord, relPath: string): Promise<FileRead> {
    if (relPath === '') return { kind: 'refused', reason: 'empty path' };
    if (relPath.includes('\0')) return { kind: 'refused', reason: 'path contains NUL' };
    if (isAbsolute(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
      return { kind: 'refused', reason: 'absolute paths are not allowed' };
    }
    const root = resolve(skill.dir);
    const target = resolve(root, relPath);
    if (!target.startsWith(root + sep)) return { kind: 'refused', reason: 'path is outside the skill folder' };

    // lstat every component below the skill folder; none may be a symlink.
    const parts = target.slice(root.length + 1).split(sep);
    let cur = root;
    let st;
    try {
      for (const p of parts) {
        cur = cur + sep + p;
        st = await lstat(cur);
        if (st.isSymbolicLink()) return { kind: 'refused', reason: 'path goes through a symlink' };
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
      return { kind: 'refused', reason: `cannot read path (${code ?? 'error'})` };
    }
    if (!st) return { kind: 'refused', reason: 'empty path' };
    if (st.isDirectory()) return { kind: 'refused', reason: 'path is a directory' };
    if (!st.isFile()) return { kind: 'refused', reason: 'not a regular file' };
    if (st.size > MAX_FILE_BYTES) return { kind: 'too_large', size: st.size, path: target };

    try {
      const fh = await open(target, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const data = buf.subarray(0, bytesRead);
        if (data.subarray(0, SNIFF_BYTES).includes(0)) return { kind: 'binary', size: st.size, path: target };
        return { kind: 'text', content: data.toString('utf8') };
      } finally {
        await fh.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
      return { kind: 'refused', reason: 'cannot read file' };
    }
  }

  search(query: string, limit = 10): SearchHit[] {
    this.index ??= new Bm25Index(this.skills);
    const scores = this.index.scores(query);
    const hits: SearchHit[] = [];
    this.skills.forEach((s, i) => {
      const score = scores[i]!;
      if (score > 0) {
        hits.push({
          id: s.id, name: s.name, description: s.description, registry: s.registry, via: s.via, score,
          overrode: this.overridesFor(s.id).map((o) => o.replaced),
        });
      }
    });
    hits.sort((a, b) => b.score - a.score || byCodeUnit(a.id, b.id));
    return hits.slice(0, Math.max(0, limit));
  }
}
