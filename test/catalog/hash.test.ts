import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { contentHash } from '../../src/catalog/hash.js';
import { tmpDir } from '../helpers/tmp.js';

async function put(dir: string, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) {
    await mkdir(join(dir, p, '..'), { recursive: true });
    await writeFile(join(dir, p), c);
  }
}

describe('contentHash', () => {
  it('has the sha256: format and matches the specified algorithm', async () => {
    const d = await tmpDir();
    await put(d, { 'b.txt': 'B', 'a/x.md': 'X' });
    const sha = (s: string) => createHash('sha256').update(s).digest('hex');
    const expected = 'sha256:' + sha(`a/x.md\0${sha('X')}\nb.txt\0${sha('B')}\n`);
    const r = await contentHash(d);
    expect(r.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.hash).toBe(expected);
    expect(r.files).toEqual(['a/x.md', 'b.txt']);
  });
  it('is stable regardless of creation order', async () => {
    const a = await tmpDir(); const b = await tmpDir();
    await put(a, { 'one.md': '1', 'two/x.md': '2', 'three.md': '3' });
    await put(b, { 'three.md': '3', 'two/x.md': '2', 'one.md': '1' });
    expect((await contentHash(a)).hash).toBe((await contentHash(b)).hash);
  });
  it('changes when one byte changes', async () => {
    const a = await tmpDir(); const b = await tmpDir();
    await put(a, { 'f.md': 'hello' }); await put(b, { 'f.md': 'hellp' });
    expect((await contentHash(a)).hash).not.toBe((await contentHash(b)).hash);
  });
  it('ignores .skillseekr.json at the root only', async () => {
    const a = await tmpDir(); const b = await tmpDir();
    await put(a, { 'f.md': 'x' });
    await put(b, { 'f.md': 'x', '.skillseekr.json': '{}' });
    expect(await contentHash(b)).toEqual(await contentHash(a));
    await put(b, { 'sub/.skillseekr.json': '{}' });
    expect((await contentHash(b)).files).toContain('sub/.skillseekr.json');
  });
  it('hashes regular files only (symlinks skipped)', async () => {
    const d = await tmpDir(); const out = await tmpDir();
    await put(d, { 'f.md': 'x' }); await put(out, { 'secret.md': 's' });
    await symlink(join(out, 'secret.md'), join(d, 'link.md'));
    await symlink(out, join(d, 'linkdir'));
    expect((await contentHash(d)).files).toEqual(['f.md']);
  });
});
