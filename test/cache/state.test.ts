import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../helpers/tmp.js';

const fsCalls: Array<[string, ...string[]]> = [];
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    writeFile: vi.fn(async (...args: Parameters<typeof real.writeFile>) => {
      fsCalls.push(['writeFile', String(args[0])]);
      return real.writeFile(...args);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      fsCalls.push(['rename', from, to]);
      return real.rename(from, to);
    }),
  };
});

const { readState, writeState, isFresh } = await import('../../src/cache/state.js');

beforeEach(() => { fsCalls.length = 0; });

describe('state', () => {
  it('writeState is atomic: it writes a temp file, then renames it over the target', async () => {
    const dir = await tmpDir();
    await writeState(dir, 'ref/acme/skills/feature/x', { sha: 'abc', checkedAt: 5 });
    expect(fsCalls.map((c) => c[0])).toEqual(['writeFile', 'rename']);
    const [, tmp] = fsCalls[0];
    const [, from, to] = fsCalls[1];
    expect(from).toBe(tmp);
    expect(to).not.toBe(tmp);
    expect(to.startsWith(join(dir, 'state'))).toBe(true);
    expect(await readState(dir, 'ref/acme/skills/feature/x')).toEqual({ sha: 'abc', checkedAt: 5 });
    expect((await readdir(join(dir, 'state'))).filter((f) => f.includes('.tmp'))).toEqual([]);
  });

  it('keys are isolated, overwrite works, and missing or corrupt state reads as undefined', async () => {
    const dir = await tmpDir();
    expect(await readState(dir, 'nope')).toBeUndefined();
    await writeState(dir, 'a', 1);
    await writeState(dir, 'a/b', 2);
    await writeState(dir, '../../escape', 3);
    await writeState(dir, 'a', 4);
    expect(await readState(dir, 'a')).toBe(4);
    expect(await readState(dir, 'a/b')).toBe(2);
    expect(await readState(dir, '../../escape')).toBe(3);
    expect(await readdir(dir)).toEqual(['state']);
    const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    const [file] = fsCalls.filter((c) => c[0] === 'rename').map((c) => c[2]);
    await real.writeFile(file, '{not json');
    expect(await readState(dir, 'a')).toBeUndefined();
  });

  it('concurrent writes of one key leave valid JSON and no temp files', async () => {
    const dir = await tmpDir();
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeState(dir, 'k', { i })));
    const v = await readState<{ i: number }>(dir, 'k');
    expect(v?.i).toBeTypeOf('number');
    expect((await readdir(join(dir, 'state'))).length).toBe(1);
  });

  it('isFresh boundaries', () => {
    expect(isFresh(0, 10, 0)).toBe(true);
    expect(isFresh(0, 10, 9_999)).toBe(true);
    expect(isFresh(0, 10, 10_000)).toBe(false);
    expect(isFresh(0, 10, 10_001)).toBe(false);
    expect(isFresh(1000, 0, 1000)).toBe(false);
    // checkedAt in the future (clock went back): not fresh
    expect(isFresh(1001, 10, 1000)).toBe(false);
    expect(isFresh(1000, 10, 1000)).toBe(true);
  });
});
