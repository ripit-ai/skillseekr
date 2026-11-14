import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, symlink, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Catalog, type SkillRecord } from '../../src/catalog/catalog.js';
import { discoverSkills, type DiscoveredSkill } from '../../src/catalog/discover.js';
import type { ResolvedRegistry } from '../../src/resolve/resolve.js';
import { tmpDir } from '../helpers/tmp.js';

const FX = resolve(import.meta.dirname, '../fixtures/skills');
const reg = (name: string, via: string[] = [name]): ResolvedRegistry =>
  ({ name, via, trusted: true, entry: { type: 'github', owner: 'o', repo: 'r', skills_dir: 'skills', ref: 'main', auth: { type: 'none' }, cache_enabled: true, instructions: `ins-${name}` } }) as unknown as ResolvedRegistry;
const sk = (id: string, name = id.split('/').pop()!, dir = '/nowhere'): DiscoveredSkill =>
  ({ id, name, description: `${name} desc`, dir, files: ['SKILL.md'], contentHash: 'sha256:x', warnings: [] });
const cat = (...r: Array<[ResolvedRegistry, DiscoveredSkill[]]>) =>
  new Catalog(r.map(([registry, skills]) => ({ registry, ref: 'main', sha: 'abc', skills })), [], [], false);

describe('Catalog dedupe', () => {
  it('skill id collision: later registry wins, override recorded with both registries and vias', () => {
    const c = cat([reg('a', ['x', 'a']), [sk('s1'), sk('s2')]], [reg('b', ['y', 'b']), [sk('s1')]]);
    expect(c.skills.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(c.skills[0]!.registry).toBe('b');
    expect(c.skills[0]!.via).toEqual(['y', 'b']);
    expect(c.skills[0]!.instructions).toBe('ins-b');
    expect(c.skills[0]!.sha).toBe('abc');
    expect(c.overrides).toEqual([{ kind: 'skill', key: 's1', replaced: { registry: 'a', via: ['x', 'a'] }, by: { registry: 'b', via: ['y', 'b'] } }]);
    expect(c.overridesFor('s1')).toHaveLength(1);
    expect(c.overridesFor('s2')).toEqual([]);
  });
  it('registry overrides come first, then skill overrides', () => {
    const ro = { kind: 'registry' as const, key: 'k', replaced: { registry: 'k', via: ['a'] }, by: { registry: 'k', via: ['b'] } };
    const c = new Catalog([{ registry: reg('a'), skills: [sk('s')] }, { registry: reg('b'), skills: [sk('s')] }], [ro], [], true);
    expect(c.overrides.map((o) => o.kind)).toEqual(['registry', 'skill']);
    expect(c.stale).toBe(true);
  });
  it('same name at different ids are both kept', () => {
    const c = cat([reg('a'), [sk('eng/tdd', 'tdd'), sk('biz/tdd', 'tdd')]]);
    expect(c.skills).toHaveLength(2);
    expect(c.overrides).toEqual([]);
  });
});

describe('Catalog lookup', () => {
  const c = cat([reg('a'), [sk('eng/tdd', 'tdd'), sk('biz/tdd', 'tdd'), sk('solo'), sk('tdd', 'other')]]);
  it('exact id wins over a name', () => {
    const r = c.lookup('tdd');
    expect(r.kind === 'found' && r.skill.id).toBe('tdd');
  });
  it('unique bare name resolves', () => {
    const r = cat([reg('a'), [sk('x/solo', 'solo')]]).lookup('solo');
    expect(r.kind === 'found' && r.skill.id).toBe('x/solo');
  });
  it('duplicate bare name is ambiguous with sorted ids', () => {
    const r = cat([reg('a'), [sk('eng/tdd', 'tdd'), sk('biz/tdd', 'tdd')]]).lookup('tdd');
    expect(r).toEqual({ kind: 'ambiguous', ids: ['biz/tdd', 'eng/tdd'] });
  });
  it('unknown is missing', () => {
    expect(c.lookup('nope')).toEqual({ kind: 'missing' });
  });
  it('byId matches only an exact id, never a bare name', () => {
    const m = cat([reg('a'), [sk('engineering/tdd', 'tdd')]]);
    expect(m.byId('engineering/tdd')?.id).toBe('engineering/tdd');
    expect(m.byId('tdd')).toBeUndefined();
  });
});

describe('Catalog readFile', () => {
  async function setup(): Promise<{ c: Catalog; s: SkillRecord; dir: string }> {
    const root = await tmpDir();
    await cp(join(FX, 'flat'), root, { recursive: true });
    const found = await discoverSkills(root, 'skills');
    const c = cat([reg('a'), found]);
    const s = c.skills.find((x) => x.id === 'another-skill')!;
    return { c, s, dir: s.dir };
  }
  it('returns text for a contained file', async () => {
    const { c, s } = await setup();
    const r = await c.readFile(s, 'references/guide.md');
    expect(r.kind).toBe('text');
    expect(r.kind === 'text' && r.content.length).toBeGreaterThan(0);
  });
  it('allows a ../ that stays inside the skill', async () => {
    const { c, s } = await setup();
    expect((await c.readFile(s, 'references/../SKILL.md')).kind).toBe('text');
  });
  it('refuses hostile paths', async () => {
    const { c, s } = await setup();
    for (const p of ['', '../x', '/etc/passwd', 'references/../../x', 'a\0b', '..', '.']) {
      expect((await c.readFile(s, p)).kind, p).toBe('refused');
    }
  });
  it('refuses a symlinked file and a symlinked parent dir', async () => {
    const { c, s, dir } = await setup();
    const outside = await tmpDir();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    await symlink(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    await symlink(outside, join(dir, 'linkdir'));
    expect((await c.readFile(s, 'link.txt')).kind).toBe('refused');
    expect((await c.readFile(s, 'linkdir/secret.txt')).kind).toBe('refused');
    expect((await c.readFile(s, 'linkdir')).kind).toBe('refused');
  });
  it('refuses directories, reports missing', async () => {
    const { c, s } = await setup();
    expect((await c.readFile(s, 'references')).kind).toBe('refused');
    expect(await c.readFile(s, 'nope.md')).toEqual({ kind: 'missing' });
    expect(await c.readFile(s, 'SKILL.md/x')).toEqual({ kind: 'missing' });
  });
  it('binary when the first 8KB hold a NUL; NUL after 8KB is text', async () => {
    const { c, s, dir } = await setup();
    await writeFile(join(dir, 'a.bin'), Buffer.from([65, 0, 66]));
    const r = await c.readFile(s, 'a.bin');
    expect(r).toEqual({ kind: 'binary', size: 3, path: join(dir, 'a.bin') });
    const late = Buffer.alloc(9000, 65); late[8500] = 0;
    await writeFile(join(dir, 'late.txt'), late);
    expect((await c.readFile(s, 'late.txt')).kind).toBe('text');
  });
  it('too_large over 1MB with absolute path; exactly 1MB is readable', async () => {
    const { c, s, dir } = await setup();
    await writeFile(join(dir, 'big.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
    expect(await c.readFile(s, 'big.txt')).toEqual({ kind: 'too_large', size: 1024 * 1024 + 1, path: join(dir, 'big.txt') });
    await writeFile(join(dir, 'ok.txt'), Buffer.alloc(1024 * 1024, 65));
    expect((await c.readFile(s, 'ok.txt')).kind).toBe('text');
  });
  it('decodes UTF-8', async () => {
    const { c, s, dir } = await setup();
    await mkdir(join(dir, 'u'), { recursive: true });
    await writeFile(join(dir, 'u/x.txt'), 'héllo €');
    expect(await c.readFile(s, 'u/x.txt')).toEqual({ kind: 'text', content: 'héllo €' });
  });
});
