import { describe, it, expect } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers/tmp.js';
import { contentHash } from '../../src/catalog/hash.js';
import { textHash, verifyFolders } from '../../src/library/verify.js';
import type { Manifest } from '../../src/library/manifest.js';

const entry = { type: 'github' as const, owner: 'o', repo: 'r', skills_dir: 'skills', ref: 'main', auth: { type: 'none' as const }, cache_enabled: true };
const inc = { type: 'http-registry' as const, url: 'https://x/r.jsonc', policy: false, auth: { type: 'none' as const }, cache_enabled: true };

async function fixture() {
  const lib = await tmpDir();
  const dir = join(lib, 'github/o/r@main/skills/a');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), 'hello');
  await mkdir(join(lib, 'registries/http'), { recursive: true });
  await writeFile(join(lib, 'registries/http/h.jsonc'), '{}');
  const { hash, files } = await contentHash(dir);
  const m: Manifest = {
    version: 1, updatedAt: 'x', configHash: 'y', overrides: [], problems: [],
    sources: [{
      name: 'r', via: ['r'], trusted: true, entry, folder: 'github/o/r@main', stale: false,
      skills: [{ id: 'a', name: 'a', description: '', dir: 'github/o/r@main/skills/a', files, contentHash: hash, warnings: [] }],
    }],
    includes: [{ name: 'i', via: ['i'], entry: inc, policy: false, stale: false, file: 'registries/http/h.jsonc', textHash: textHash('{}') }],
  };
  return { lib, m, dir };
}

describe('verifyFolders', () => {
  it('nothing when everything matches', async () => {
    const { lib, m } = await fixture();
    expect(await verifyFolders(lib, m)).toEqual([]);
  });
  it('names a folder with an edited skill and an include file with edited text', async () => {
    const { lib, m, dir } = await fixture();
    await writeFile(join(dir, 'SKILL.md'), 'edited');
    await writeFile(join(lib, 'registries/http/h.jsonc'), '{"x":1}');
    expect((await verifyFolders(lib, m)).sort()).toEqual(['github/o/r@main', 'registries/http/h.jsonc']);
  });
  it('names a missing folder, even one with no skills, and a missing include file', async () => {
    const { lib, m } = await fixture();
    m.sources[0]!.skills = [];
    await rm(join(lib, 'github'), { recursive: true });
    await rm(join(lib, 'registries'), { recursive: true });
    expect((await verifyFolders(lib, m)).sort()).toEqual(['github/o/r@main', 'registries/http/h.jsonc']);
  });
});
