import { describe, it, expect } from 'vitest';
import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../../src/context.js';
import { mergeJsonFile, readJsonValue } from '../../src/setup/jsonMerge.js';
import { tmpDir } from '../helpers/tmp.js';

const ctxAt = (home: string, now = 1_700_000_000_000): Ctx => ({
  env: {}, home, cwd: home, http: { get: async () => { throw new Error('no network'); } },
  exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => now, githubApi: 'https://api.github.com',
});

describe('mergeJsonFile', () => {
  it('mergeJsonFile adds the key, keeps other keys and comments, writes a backup, and returns null when equal', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'conf.json');
    const original = '{\n  // keep me\n  "other": 1,\n  "mcp": { "foo": true }\n}\n';
    await writeFile(file, original);
    const ctx = ctxAt(dir);
    const value = { type: 'local', command: ['skillseekr', 'mcp'] };

    const change = await mergeJsonFile(file, ['mcp', 'servers', 'skillseekr'], value, ctx);
    expect(change).not.toBeNull();
    expect(change!.file).toBe(file);
    expect(change!.before).toContain('(unset)');
    expect(change!.after).toContain('"skillseekr"');
    expect(change!.backup).toBe(`${file}.skillseekr-backup-1700000000000`);
    expect(await readFile(change!.backup!, 'utf8')).toBe(original);

    const text = await readFile(file, 'utf8');
    expect(text).toContain('// keep me');
    expect(text).toContain('"other": 1');
    expect(await readJsonValue(file, ['mcp', 'foo'])).toBe(true);
    expect(await readJsonValue(file, ['mcp', 'servers', 'skillseekr'])).toEqual(value);

    const before = (await stat(file)).mtimeMs;
    expect(await mergeJsonFile(file, ['mcp', 'servers', 'skillseekr'], { ...value }, ctxAt(dir, 1_700_000_000_001))).toBeNull();
    expect((await stat(file)).mtimeMs).toBe(before);
    expect((await readdir(dir)).filter((f) => f.includes('backup'))).toHaveLength(1);
  });

  it('creates a missing file and its parent dirs without a backup', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'a', 'b', 'mcp.json');
    const change = await mergeJsonFile(file, ['servers', 'skillseekr'], { type: 'stdio' }, ctxAt(dir));
    expect(change?.backup).toBeUndefined();
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ servers: { skillseekr: { type: 'stdio' } } });
  });

  it('dryRun reports the change without writing', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'x.json');
    const change = await mergeJsonFile(file, ['k'], 1, ctxAt(dir), { dryRun: true });
    expect(change).not.toBeNull();
    await expect(stat(file)).rejects.toThrow();
  });

  it('refuses to rewrite a file that does not parse', async () => {
    const dir = await tmpDir();
    const file = join(dir, 'bad.json');
    await writeFile(file, '{ "a": ');
    await expect(mergeJsonFile(file, ['k'], 1, ctxAt(dir))).rejects.toThrow(/bad\.json/);
    expect(await readFile(file, 'utf8')).toBe('{ "a": ');
  });

  it('follows a symlinked file and keeps the link', async () => {
    const dir = await tmpDir();
    await mkdir(join(dir, 'real'));
    const real = join(dir, 'real', 'c.json');
    await writeFile(real, '{}');
    const link = join(dir, 'c.json');
    await symlink(real, link);
    await mergeJsonFile(link, ['k'], 2, ctxAt(dir));
    expect(JSON.parse(await readFile(real, 'utf8'))).toEqual({ k: 2 });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });
});
