import { describe, it, expect, vi } from 'vitest';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cachedScan } from '../../src/scan/cache.js';
import { RULES_VERSION } from '../../src/scan/rules.js';
import type { ScanResult } from '../../src/scan/scan.js';
import { tmpDir } from '../helpers/tmp.js';

const HEX = 'c'.repeat(64);
const HASH = `sha256:${HEX}`;
const result: ScanResult = {
  findings: [{ rule: 'download-and-run/curl-pipe-shell', severity: 'critical', file: 'scripts/a.sh', line: 2, message: 'm' }],
  critical: 1, warning: 0,
};

describe('cachedScan', () => {
  it('a miss scans and stores the result at <cache>/scan/<RULES_VERSION>/<hex>.json; a hit does not scan', async () => {
    const dir = await tmpDir();
    const scan = vi.fn(async () => result);
    expect(await cachedScan(dir, HASH, scan)).toEqual(result);
    expect(scan).toHaveBeenCalledTimes(1);
    const file = join(dir, 'scan', RULES_VERSION, `${HEX}.json`);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ contentHash: HASH, result });
    expect(await readdir(join(dir, 'scan', RULES_VERSION))).toEqual([`${HEX}.json`]); // no temp files left
    expect(await cachedScan(dir, HASH, scan)).toEqual(result);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('a different rules version misses the cache', async () => {
    const dir = await tmpDir();
    const scan = vi.fn(async () => result);
    await cachedScan(dir, HASH, scan);
    await cachedScan(dir, HASH, scan, `${RULES_VERSION}-next`);
    expect(scan).toHaveBeenCalledTimes(2);
    expect((await readdir(join(dir, 'scan'))).sort()).toEqual([RULES_VERSION, `${RULES_VERSION}-next`].sort());
  });

  it('invalid JSON or a wrong shape triggers a rescan that replaces the file', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'scan', RULES_VERSION, `${HEX}.json`);
    await mkdir(join(dir, 'scan', RULES_VERSION), { recursive: true });
    const entry = (r: unknown) => JSON.stringify({ contentHash: HASH, result: r });
    for (const bad of ['{not json', entry({ findings: 'x', critical: 0, warning: 0 }), '[]', 'null', JSON.stringify(result),
      entry({ findings: [{ rule: 1 }], critical: 0, warning: 0 })]) {
      await writeFile(file, bad);
      const scan = vi.fn(async () => result);
      expect(await cachedScan(dir, HASH, scan)).toEqual(result);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ contentHash: HASH, result });
    }
  });

  it('an entry is bound to its key: a clean result copied under another hash is not trusted', async () => {
    const dir = await tmpDir();
    const clean: ScanResult = { findings: [], critical: 0, warning: 0 };
    const other = `sha256:${'d'.repeat(64)}`;
    await cachedScan(dir, other, async () => clean);
    const v = join(dir, 'scan', RULES_VERSION);
    await copyFile(join(v, `${'d'.repeat(64)}.json`), join(v, `${HEX}.json`));
    const scan = vi.fn(async () => result);
    expect(await cachedScan(dir, HASH, scan)).toEqual(result);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('a scan that throws propagates and caches nothing', async () => {
    const dir = await tmpDir();
    await expect(cachedScan(dir, HASH, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await readdir(dir)).toEqual([]);
  });

  it('a hash that is not sha256 hex is never used as a path: it scans and writes nothing', async () => {
    const dir = await tmpDir();
    for (const h of ['sha256:../../etc', `sha256:${'C'.repeat(64)}`, HEX, `md5:${HEX}`, `sha256:${HEX}/x`]) {
      const scan = vi.fn(async () => result);
      expect(await cachedScan(dir, h, scan)).toEqual(result);
      expect(scan).toHaveBeenCalledTimes(1);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('a write failure is swallowed (the cache is best effort)', async () => {
    const dir = await tmpDir();
    await writeFile(join(dir, 'scan'), 'a file where the scan dir should be');
    const scan = vi.fn(async () => result);
    expect(await cachedScan(dir, HASH, scan)).toEqual(result);
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
