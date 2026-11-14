import { describe, it, expect, vi } from 'vitest';
import { mkdir, writeFile, symlink, cp, chmod } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { discoverSkills } from '../../src/catalog/discover.js';
import { tmpDir } from '../helpers/tmp.js';

const FX = resolve(import.meta.dirname, '../fixtures/skills');
const ids = async (root: string, dir: string) => (await discoverSkills(root, dir)).map((s) => s.id);
const skillMd = (name: string) => `---\nname: ${name}\ndescription: d\n---\n`;
async function put(root: string, p: string, c: string) {
  await mkdir(join(root, p, '..'), { recursive: true });
  await writeFile(join(root, p), c);
}

describe('discoverSkills', () => {
  it('flat layout ids', async () => {
    expect(await ids(join(FX, 'flat'), 'skills')).toEqual(['another-skill', 'my-skill']);
  });
  it('nested layout ids', async () => {
    expect(await ids(join(FX, 'nested'), 'skills')).toEqual(['business/brainstorming', 'engineering/testing/tdd-development']);
  });
  it('lists files, dir, and a hash', async () => {
    const s = (await discoverSkills(join(FX, 'flat'), 'skills'))[0]!;
    expect(s.dir).toBe(join(FX, 'flat/skills/another-skill'));
    expect(s.files).toEqual(['SKILL.md', 'references/guide.md']);
    expect(s.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(s.warnings).toEqual([]);
  });
  it('skills_dir "" means the repo root; "." and slashes normalize', async () => {
    const root = join(FX, 'flat');
    const want = ['skills/another-skill', 'skills/my-skill'];
    expect(await ids(root, '')).toEqual(want);
    expect(await ids(root, '.')).toEqual(want);
    expect(await ids(root, '/skills/')).toEqual(['another-skill', 'my-skill']);
  });
  it('refuses .., missing dirs and non-directories with []', async () => {
    const root = join(FX, 'flat');
    expect(await ids(root, '../nested/skills')).toEqual([]);
    expect(await ids(root, 'skills/../skills')).toEqual([]);
    expect(await ids(root, 'nope')).toEqual([]);
    expect(await ids(root, 'skills/my-skill/SKILL.md')).toEqual([]);
    expect(await ids(join(FX, 'does-not-exist'), 'skills')).toEqual([]);
  });
  it('nested SKILL.md inside a skill is pruned (shallowest wins)', async () => {
    expect(await ids(join(FX, 'bundled'), 'skills')).toEqual(['outer']);
  });
  it('SKILL.md at skills_dir itself is not a skill', async () => {
    expect(await ids(join(FX, 'rootskill'), 'skills')).toEqual(['real']);
  });
  it('category folders without SKILL.md are not skills', async () => {
    expect(await ids(join(FX, 'nested'), 'skills')).not.toContain('engineering');
  });
  it('CRLF and BOM frontmatter parse', async () => {
    const root = await tmpDir();
    const text = '﻿---\r\nname: crlf-bom\r\ndescription: works\r\n---\r\nbody\r\n';
    await put(root, 'skills/crlf-bom/SKILL.md', text);
    const bytes = (await import('node:fs')).readFileSync(join(root, 'skills/crlf-bom/SKILL.md'));
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.includes(Buffer.from('\r\n'))).toBe(true);
    const [s] = await discoverSkills(root, 'skills');
    expect(s).toMatchObject({ id: 'crlf-bom', name: 'crlf-bom', description: 'works', warnings: [] });
  });
  it('missing frontmatter → name = folder basename, warning "missing frontmatter"', async () => {
    const s = (await discoverSkills(join(FX, 'malformed'), 'skills')).find((x) => x.id === 'no-fm')!;
    expect(s.name).toBe('no-fm');
    expect(s.description).toBe('');
    expect(s.warnings).toContain('missing frontmatter');
  });
  it('name mismatch → indexed with warning naming both', async () => {
    const s = (await discoverSkills(join(FX, 'malformed'), 'skills')).find((x) => x.id === 'mismatch')!;
    expect(s.name).toBe('other-name');
    expect(s.warnings).toHaveLength(1);
    expect(s.warnings[0]).toContain('other-name');
    expect(s.warnings[0]).toContain('mismatch');
    expect(s.warnings[0]!.match(/"mismatch"/)).not.toBeNull();
  });
  it('missing description → description "" and warning', async () => {
    const s = (await discoverSkills(join(FX, 'malformed'), 'skills')).find((x) => x.id === 'no-desc')!;
    expect(s.description).toBe('');
    expect(s.warnings.join('\n')).toMatch(/description/);
  });
  it('non-string name falls back to folder with a warning', async () => {
    const root = await tmpDir();
    await put(root, 's/a/SKILL.md', '---\nname: 42\ndescription: d\n---\n');
    const [s] = await discoverSkills(root, 's');
    expect(s!.name).toBe('a');
    expect(s!.warnings.length).toBe(1);
  });
  it('discovery never follows symlinks out of the tree', async () => {
    const outside = await tmpDir();
    await put(outside, 'evil/SKILL.md', skillMd('evil'));
    await put(outside, 'secret.md', 'secret');
    const tree = await tmpDir();
    await put(tree, 'skills/real/SKILL.md', skillMd('real'));
    await symlink(outside, join(tree, 'skills/linked-dir'));                       // symlinked dir
    await symlink(join(outside, 'evil'), join(tree, 'skills/evil-skill'));         // symlinked skill dir
    await mkdir(join(tree, 'skills/linked-md'));
    await symlink(join(outside, 'evil/SKILL.md'), join(tree, 'skills/linked-md/SKILL.md')); // symlinked SKILL.md
    await symlink(join(outside, 'secret.md'), join(tree, 'skills/real/leak.md'));  // symlinked file in a skill
    await symlink(outside, join(tree, 'skills/real/leakdir'));
    const found = await discoverSkills(tree, 'skills');
    expect(found.map((s) => s.id)).toEqual(['real']);
    expect(found[0]!.files).toEqual(['SKILL.md']);
    // skills_dir itself being a symlink (or traversing one) is refused
    await symlink(join(tree, 'skills'), join(tree, 'alias'));
    expect(await ids(tree, 'alias')).toEqual([]);
    const viaOutside = await tmpDir();
    await symlink(outside, join(viaOutside, 'x'));
    expect(await ids(viaOutside, 'x')).toEqual([]);
  });
  it('is sorted by id', async () => {
    const root = await tmpDir();
    await cp(join(FX, 'nested'), root, { recursive: true });
    const got = await ids(root, '');
    expect(got).toEqual([...got].sort());
  });
  it.skipIf(process.getuid?.() === 0)('an unreadable SKILL.md or dir skips only that skill', async () => {
    const root = await tmpDir();
    await put(root, 's/good/SKILL.md', skillMd('good'));
    await put(root, 's/bad/SKILL.md', skillMd('bad'));
    await put(root, 's/locked/deep/SKILL.md', skillMd('deep'));
    await chmod(join(root, 's/bad/SKILL.md'), 0o000);
    await chmod(join(root, 's/locked'), 0o000);
    try {
      expect(await ids(root, 's')).toEqual(['good']);
    } finally {
      await chmod(join(root, 's/locked'), 0o755);
      await chmod(join(root, 's/bad/SKILL.md'), 0o644);
    }
  });
  it('odd YAML tags never write warnings', async () => {
    const root = await tmpDir();
    await put(root, 's/a/SKILL.md', '---\nname: !foo bar\ndescription: d\n---\n');
    const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const [s] = await discoverSkills(root, 's');
      expect(s!.id).toBe('a');
      expect(emit).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(err).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it('blank description warns like a missing one; name is trimmed', async () => {
    const root = await tmpDir();
    await put(root, 's/a/SKILL.md', '---\nname: "  a  "\ndescription: "   "\n---\n');
    const [s] = await discoverSkills(root, 's');
    expect(s).toMatchObject({ name: 'a', description: '' });
    expect(s!.warnings).toEqual(['missing description in frontmatter']);
  });
});
