import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers/tmp.js';
import { readManifest, writeManifest, manifestFile, type Manifest } from '../../src/library/manifest.js';

const entry = { type: 'github' as const, owner: 'o', repo: 'r', skills_dir: 'skills', ref: 'main', auth: { type: 'none' as const }, cache_enabled: true };
const sample = (): Manifest => ({
  version: 1, updatedAt: '2026-01-01T00:00:00.000Z', configHash: 'abc',
  sources: [{
    name: 's', via: [], trusted: true, entry, folder: 'github/o/r@main', sha: 'deadbeef', stale: false,
    skills: [{ id: 'o/a', name: 'a', description: 'd', dir: 'github/o/r@main/skills/a', files: ['SKILL.md'], contentHash: 'h', warnings: [] }],
  }],
  includes: [], overrides: [], problems: [{ level: 'warning', code: 'x/y', message: 'm' }],
});

describe('manifest', () => {
  it('round-trips, writing 0600', async () => {
    const dir = await tmpDir();
    await writeManifest(dir, sample());
    expect(await readManifest(dir)).toEqual(sample());
    const { statSync } = await import('node:fs');
    expect(statSync(manifestFile(dir)).mode & 0o777).toBe(0o600);
  });
  it('undefined when missing, wrong version or unparsable', async () => {
    const dir = await tmpDir();
    expect(await readManifest(dir)).toBeUndefined();
    await mkdir(dir, { recursive: true });
    await writeFile(manifestFile(dir), JSON.stringify({ ...sample(), version: 2 }));
    expect(await readManifest(dir)).toBeUndefined();
    await writeFile(manifestFile(dir), '{nope');
    expect(await readManifest(dir)).toBeUndefined();
  });
  it('rejects escaping folder or skill dir', async () => {
    const dir = await tmpDir();
    const m = sample();
    m.sources[0]!.folder = '../../etc';
    await writeManifest(dir, m);
    expect(await readManifest(dir)).toBeUndefined();
    const m2 = sample();
    m2.sources[0]!.skills[0]!.dir = '/abs/path';
    await writeManifest(dir, m2);
    expect(await readManifest(dir)).toBeUndefined();
  });
});
