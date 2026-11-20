import { describe, it, expect, afterEach, beforeEach, onTestFinished } from 'vitest';
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { pullLibrary, pullHooks, pullFs } from '../../src/library/pull.js';
import { verifyFolders } from '../../src/library/verify.js';
import { acquireLock, LockBusyError } from '../../src/library/lock.js';
import { readManifest, manifestFile } from '../../src/library/manifest.js';
import { resetGhTokenCache } from '../../src/auth.js';
import type { Ctx, ExecResult } from '../../src/context.js';
import type { Http } from '../../src/net/http.js';
import { fakeGithub, type FakeSpec } from '../helpers/fakeGithub.js';
import { fakeHttp, type FakeRoute } from '../helpers/fakeHttp.js';
import { tmpDir } from '../helpers/tmp.js';
import { pull } from '../helpers/library.js';

const API = 'https://api.github.com';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const SHA3 = 'c'.repeat(40);
const skill = (name: string, extra = '') => `---\nname: ${name}\ndescription: ${name} desc\n---\nbody ${name}${extra}\n`;
const gh = (repo: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'github', owner: 'o', repo, skills_dir: 'skills', ref: 'main', ...extra });
const repoWith = (files: Record<string, string>, sha = SHA1) => ({ refs: { main: sha }, commits: { [sha]: files } });

const realHook = pullHooks.beforeSwap;
const realFs = { ...pullFs };
beforeEach(() => resetGhTokenCache());
afterEach(() => { pullHooks.beforeSwap = realHook; Object.assign(pullFs, realFs); resetGhTokenCache(); });

async function setup(o: { repos?: FakeSpec; routes?: Record<string, FakeRoute>; lib?: (dir: string) => string } = {}) {
  const dir = await tmpDir();
  const repos = o.repos ?? {};
  const github = fakeGithub(repos);
  const web = fakeHttp(o.routes ?? {});
  const http: Http = { get: (url, h, opts) => (url.startsWith(API) ? github.http : web.http).get(url, h, opts) };
  const path = join(dir, 'config.jsonc');
  const lib = o.lib ? o.lib(dir) : join(dir, 'lib');
  let exec: () => Promise<ExecResult> = async () => ({ code: 1, stdout: '', stderr: '' });
  const ctx: Ctx = {
    env: { SKILLSEEKR_CONFIG: path, SKILLSEEKR_LIBRARY: lib }, home: join(dir, 'home'), cwd: dir, http,
    exec: () => exec(), now: () => 1_700_000_000_000, githubApi: API,
  };
  const write = (registries: Record<string, unknown>) => writeFile(path, JSON.stringify({ registries }));
  return { ctx, github, web, repos, path, dir, lib, write, setExec: (f: typeof exec) => { exec = f; } };
}

/** Every path under dir with file contents, for byte-identical comparisons. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (abs: string, rel: string): Promise<void> => {
    for (const e of await readdir(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[`${r}/`] = ''; await walk(join(abs, e.name), r); } else out[r] = await readFile(join(abs, e.name), 'utf8');
    }
  };
  await walk(dir, '');
  return out;
}

const tarballs = (calls: string[]) => calls.filter((c) => c.includes('/tarball/'));
const changes = (r: { changes: Array<{ id: string; registry: string; change: string }> }) => r.changes.map((c) => `${c.change} ${c.registry}/${c.id}`);

describe('pullLibrary', () => {
  it('first pull writes the manifest and the tree, reports added skills, library is 0700', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    const r = await pull(s.ctx);
    expect(r.problems).toEqual([]);
    expect(r.changes).toEqual([{ id: 'a', registry: 'r', change: 'added' }]);
    expect(await readFile(join(s.lib, 'github/o/r@main/skills/a/SKILL.md'), 'utf8')).toBe(skill('a'));
    expect((await stat(s.lib)).mode & 0o777).toBe(0o700);
    const m = await readManifest(s.lib);
    expect(m).toBeDefined();
    expect(m!.configHash).toBe(createHash('sha256').update(await readFile(s.path, 'utf8')).digest('hex'));
    expect(m!.sources).toMatchObject([{ name: 'r', folder: 'github/o/r@main', sha: SHA1, stale: false, skills: [{ id: 'a', dir: 'github/o/r@main/skills/a' }] }]);
    expect(m!.sources[0]!.fetchedAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(r.manifest).toEqual(m);
    // no staging or lock left behind
    expect((await readdir(s.lib)).sort()).toEqual(['github', 'manifest.json']);
  });

  it('an unchanged SHA downloads no tarball and reports no changes', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    s.github.calls.length = 0;
    const r = await pull(s.ctx);
    expect(tarballs(s.github.calls)).toEqual([]);
    expect(r.changes).toEqual([]);
    expect((await readManifest(s.lib))!.sources[0]!.skills.map((x) => x.id)).toEqual(['a']);
  });

  it('change list: changed, added, then removed', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    s.repos['o/r'] = repoWith({ 'skills/a/SKILL.md': skill('a', ' v2'), 'skills/b/SKILL.md': skill('b') }, SHA2);
    expect(changes(await pull(s.ctx))).toEqual(['changed r/a', 'added r/b']);
    s.repos['o/r'] = repoWith({ 'skills/a/SKILL.md': skill('a', ' v2') }, SHA3);
    expect(changes(await pull(s.ctx))).toEqual(['removed r/b']);
    expect(await readdir(join(s.lib, 'github/o/r@main/skills'))).toEqual(['a']);
  });

  it('two refs of the same repo get two folders and both sets of skills', async () => {
    const s = await setup({
      repos: { 'o/r': { refs: { main: SHA1, 'feature/x': SHA2 }, commits: { [SHA1]: { 'skills/a/SKILL.md': skill('a') }, [SHA2]: { 'skills/b/SKILL.md': skill('b') } } } },
    });
    await s.write({ m: gh('r'), f: gh('r', { ref: 'feature/x' }) });
    const r = await pull(s.ctx);
    expect(r.problems).toEqual([]);
    expect((await readdir(join(s.lib, 'github/o'))).sort()).toEqual(['r@feature%2Fx', 'r@main']);
    expect(r.manifest!.sources.map((x) => [x.name, x.folder, x.skills.map((k) => k.dir)])).toEqual([
      ['m', 'github/o/r@main', ['github/o/r@main/skills/a']],
      ['f', 'github/o/r@feature%2Fx', ['github/o/r@feature%2Fx/skills/b']],
    ]);
  });

  it('two entries for the same owner/repo/ref share one folder', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a'), 'other/b/SKILL.md': skill('b') }) } });
    await s.write({ x: gh('r'), y: gh('r', { skills_dir: 'other' }) });
    const r = await pull(s.ctx);
    expect(tarballs(s.github.calls)).toHaveLength(1);
    expect(r.manifest!.sources.map((x) => [x.name, x.folder, x.skills.map((k) => k.id)])).toEqual([
      ['x', 'github/o/r@main', ['a']], ['y', 'github/o/r@main', ['b']],
    ]);
  });

  it('gh logged out on a private repo: previous folder kept, record stale, hint to gh auth login', async () => {
    const s = await setup({ repos: { 'o/p': { ...repoWith({ 'skills/a/SKILL.md': skill('a') }), token: 'tok' } } });
    await s.write({ p: gh('p', { auth: { type: 'gh_cli' } }) });
    s.setExec(async () => ({ code: 0, stdout: 'tok\n', stderr: '' }));
    await pull(s.ctx);
    resetGhTokenCache();
    s.setExec(async () => ({ code: 1, stdout: '', stderr: 'not logged in' }));
    const r = await pull(s.ctx);
    expect(r.stale).toBe(true);
    expect(r.manifest!.sources[0]).toMatchObject({ name: 'p', stale: true, folder: 'github/o/p@main', sha: SHA1 });
    expect(r.manifest!.sources[0]!.skills.map((x) => x.id)).toEqual(['a']);
    expect(r.problems.some((p) => p.level === 'error' && p.registry === 'p' && p.message.includes('gh auth login'))).toBe(true);
    expect(await readFile(join(s.lib, 'github/o/p@main/skills/a/SKILL.md'), 'utf8')).toBe(skill('a'));
    expect(r.changes).toEqual([]);
  });

  it('one of two sources failing: the other still updates', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }), 'o/q': repoWith({ 'skills/q/SKILL.md': skill('q') }) } });
    await s.write({ r: gh('r'), q: gh('q') });
    await pull(s.ctx);
    delete s.repos['o/q'];
    s.repos['o/r'] = repoWith({ 'skills/a/SKILL.md': skill('a', ' v2') }, SHA2);
    const r = await pull(s.ctx);
    expect(changes(r)).toEqual(['changed r/a']);
    const q = r.manifest!.sources.find((x) => x.name === 'q')!;
    expect(q).toMatchObject({ stale: true, sha: SHA1 });
    expect(await readFile(join(s.lib, 'github/o/q@main/skills/q/SKILL.md'), 'utf8')).toBe(skill('q'));
    expect(await readFile(join(s.lib, 'github/o/r@main/skills/a/SKILL.md'), 'utf8')).toBe(skill('a', ' v2'));
  });

  it('a source that never succeeded has a record with no folder and no skills', async () => {
    const s = await setup();
    await s.write({ gone: gh('gone') });
    const r = await pull(s.ctx);
    expect(r.manifest!.sources).toMatchObject([{ name: 'gone', skills: [] }]);
    expect(r.manifest!.sources[0]!.folder).toBeUndefined();
    expect(r.problems.some((p) => p.level === 'error' && p.registry === 'gone')).toBe(true);
  });

  it('a source removed from the config is pruned', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }), 'o/q': repoWith({ 'skills/q/SKILL.md': skill('q') }) } });
    await s.write({ r: gh('r'), q: gh('q') });
    await pull(s.ctx);
    await s.write({ q: gh('q') });
    const r = await pull(s.ctx);
    expect(changes(r)).toEqual(['removed r/a']);
    expect(await readdir(join(s.lib, 'github/o'))).toEqual(['q@main']);
    expect(r.manifest!.sources.map((x) => x.name)).toEqual(['q']);
  });

  it('with an invalid entry in the config nothing is pruned and the old record is carried over stale', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }), 'o/q': repoWith({ 'skills/q/SKILL.md': skill('q') }) } });
    await s.write({ r: gh('r'), q: gh('q') });
    await pull(s.ctx);
    await s.write({ q: gh('q'), bad: { type: 'github' } });
    const r = await pull(s.ctx);
    expect(r.changes).toEqual([]);
    expect((await readdir(join(s.lib, 'github/o'))).sort()).toEqual(['q@main', 'r@main']);
    expect(r.manifest!.sources.find((x) => x.name === 'r')).toMatchObject({ stale: true, folder: 'github/o/r@main' });
    expect(r.problems.some((p) => p.level === 'warning' && p.registry === 'r')).toBe(true);
  });

  it('a missing or unparsable config aborts and leaves the library byte-identical', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    const before = await snapshot(s.lib);
    await writeFile(s.path, '{ not json');
    const bad = await pullLibrary(s.ctx);
    expect(bad.aborted).toBe(true);
    expect(bad.problems.some((p) => p.code === 'config/parse-error')).toBe(true);
    expect(await snapshot(s.lib)).toEqual(before);
    await rm(s.path);
    const missing = await pullLibrary(s.ctx);
    expect(missing.aborted).toBe(true);
    expect(await snapshot(s.lib)).toEqual(before);
    expect(before['manifest.json']).toBe(await readFile(manifestFile(s.lib), 'utf8'));
  });

  it('a missing config with no library does not create the library', async () => {
    const s = await setup();
    expect((await pullLibrary(s.ctx)).aborted).toBe(true);
    await expect(stat(s.lib)).rejects.toThrow();
  });

  it('beforeSwap rejecting a source keeps its previous copy with library/rejected', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }), 'o/q': repoWith({ 'skills/q/SKILL.md': skill('q') }) } });
    await s.write({ r: gh('r'), q: gh('q') });
    await pull(s.ctx);
    s.repos['o/r'] = repoWith({ 'skills/a/SKILL.md': skill('a', ' evil') }, SHA2);
    s.repos['o/q'] = repoWith({ 'skills/q/SKILL.md': skill('q', ' v2') }, SHA2);
    let seen: string[] = [];
    pullHooks.beforeSwap = async (staged) => { seen = staged.map((x) => `${x.name}:${x.folder}`); return { reject: ['r'] }; };
    const r = await pull(s.ctx);
    expect(seen.sort()).toEqual(['q:github/o/q@main', 'r:github/o/r@main']);
    expect(r.problems).toEqual([expect.objectContaining({ level: 'error', code: 'library/rejected', registry: 'r' })]);
    expect(r.manifest!.sources.find((x) => x.name === 'r')).toMatchObject({ stale: true, sha: SHA1 });
    expect(await readFile(join(s.lib, 'github/o/r@main/skills/a/SKILL.md'), 'utf8')).toBe(skill('a'));
    expect(await readFile(join(s.lib, 'github/o/q@main/skills/q/SKILL.md'), 'utf8')).toBe(skill('q', ' v2'));
    expect(changes(r)).toEqual(['changed q/q']);
  });

  it('beforeSwap abort changes nothing', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    const before = await snapshot(s.lib);
    s.repos['o/r'] = repoWith({ 'skills/a/SKILL.md': skill('a', ' evil') }, SHA2);
    pullHooks.beforeSwap = async () => ({ abort: 'malware found' });
    const r = await pullLibrary(s.ctx);
    expect(r.aborted).toBe(true);
    expect(r.problems).toEqual([expect.objectContaining({ level: 'error', code: 'library/rejected', message: expect.stringContaining('malware found') })]);
    expect(await snapshot(s.lib)).toEqual(before);
  });

  it('a hand-edited SKILL.md is reported by verifyFolders and re-downloaded by the next pull', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    const first = await pull(s.ctx);
    const file = join(s.lib, 'github/o/r@main/skills/a/SKILL.md');
    await writeFile(file, 'hand edit');
    expect(await verifyFolders(s.lib, first.manifest!)).toEqual(['github/o/r@main']);
    s.github.calls.length = 0;
    const r = await pull(s.ctx);
    expect(tarballs(s.github.calls)).toHaveLength(1);
    expect(await readFile(file, 'utf8')).toBe(skill('a'));
    expect(r.changes).toEqual([]);
    expect(await verifyFolders(s.lib, r.manifest!)).toEqual([]);
  });

  it('leftover .staging and .old-* folders from a crash are removed', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await mkdir(join(s.lib, '.staging/x'), { recursive: true });
    await mkdir(join(s.lib, '.old-y/z'), { recursive: true });
    await pull(s.ctx);
    expect((await readdir(s.lib)).sort()).toEqual(['github', 'manifest.json']);
  });

  it('an unwritable library parent gives library/write-failed naming the path, without throwing', async () => {
    if (process.getuid?.() === 0) return; // root ignores permissions
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) }, lib: (d) => join(d, 'ro', 'lib') });
    await s.write({ r: gh('r') });
    const ro = join(s.dir, 'ro');
    await mkdir(ro);
    await chmod(ro, 0o500);
    onTestFinished(() => chmod(ro, 0o700));
    const r = await pullLibrary(s.ctx);
    expect(r.problems).toEqual([expect.objectContaining({ level: 'error', code: 'library/write-failed', message: expect.stringContaining(s.lib) })]);
  });

  it('a held lock makes a concurrent pull reject with LockBusyError', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    const release = await acquireLock(s.lib, s.ctx);
    await expect(pullLibrary(s.ctx)).rejects.toBeInstanceOf(LockBusyError);
    await release();
  });

  it('http source: staged under http/<hash>/<skill_name>, a 304 keeps the copy', async () => {
    const url = 'https://example.com/s/SKILL.md';
    const s = await setup({ routes: { [url]: { body: skill('h'), etag: '"e1"' } } });
    await s.write({ h: { type: 'http', url, skill_name: 'h' } });
    const r = await pull(s.ctx);
    const folder = r.manifest!.sources[0]!.folder!;
    expect(folder).toMatch(/^http\/[0-9a-f]{16}\/h$/);
    expect(r.manifest!.sources[0]).toMatchObject({ etag: '"e1"', skills: [{ id: 'h', dir: folder }] });
    expect(await readFile(join(s.lib, folder, 'SKILL.md'), 'utf8')).toBe(skill('h'));
    const again = await pull(s.ctx);
    expect(s.web.calls.at(-1)!.headers['If-None-Match']).toBe('"e1"');
    expect(again.changes).toEqual([]);
    expect(again.manifest!.sources[0]!.skills.map((x) => x.id)).toEqual(['h']);
  });

  it('includes are stored in the library and a failed include falls back to that copy, stale', async () => {
    const s = await setup({
      repos: {
        'o/inc': repoWith({ 'registries.jsonc': JSON.stringify({ registries: { remote: gh('remote') } }) }),
        'o/remote': repoWith({ 'skills/a/SKILL.md': skill('a') }),
      },
    });
    await s.write({ inc: { type: 'github-registry', owner: 'o', repo: 'inc', ref: 'main' } });
    const first = await pull(s.ctx);
    expect(first.problems).toEqual([]);
    expect(first.manifest!.includes).toMatchObject([{ name: 'inc', sha: SHA1, file: 'registries/github/o/inc@main/registries.jsonc', stale: false }]);
    expect(await readFile(join(s.lib, 'registries/github/o/inc@main/registries.jsonc'), 'utf8')).toContain('remote');
    delete s.repos['o/inc'];
    const r = await pull(s.ctx);
    expect(r.stale).toBe(true);
    expect(r.problems.some((p) => p.code === 'source/stale' && p.registry === 'inc')).toBe(true);
    expect(r.manifest!.includes).toMatchObject([{ name: 'inc', stale: true, file: 'registries/github/o/inc@main/registries.jsonc' }]);
    expect(r.manifest!.sources.map((x) => [x.name, x.stale, x.skills.length])).toEqual([['remote', false, 1]]);
  });

  it('hostile owner/repo/skill_name are failed sources and nothing is written outside the library', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    const url = 'https://example.com/x';
    await s.write({
      r: gh('r'),
      o1: { type: 'github', owner: '..', repo: '..', skills_dir: 'skills', ref: 'main' },
      o2: { type: 'github', owner: 'o', repo: '..', skills_dir: 'skills', ref: 'main' },
      h: { type: 'http', url, skill_name: '..' },
      i: { type: 'github-registry', owner: '..', repo: 'x', ref: 'main' },
    });
    const r = await pullLibrary(s.ctx);
    expect(r.aborted).toBe(false);
    for (const name of ['o1', 'o2', 'h', 'i']) {
      expect(r.problems.some((p) => p.level === 'error' && p.code === 'source/invalid' && p.registry === name), name).toBe(true);
    }
    expect((await readdir(s.dir)).sort()).toEqual(['config.jsonc', 'lib']);
    expect((await readdir(s.lib)).sort()).toEqual(['github', 'manifest.json']);
    expect(await readdir(join(s.lib, 'github'))).toEqual(['o']);
    expect(await readdir(join(s.lib, 'github/o'))).toEqual(['r@main']);
    expect(r.manifest!.sources.filter((x) => x.folder).map((x) => x.name)).toEqual(['r']);
    expect(s.github.calls.every((c) => c.startsWith('/repos/o/r/'))).toBe(true);
    expect(s.web.calls).toEqual([]);
  });

  it('a failed manifest write rolls every swap back: old trees, include files and manifest intact', async () => {
    const s = await setup({
      repos: {
        'o/inc': repoWith({ 'registries.jsonc': JSON.stringify({ registries: { r: gh('r') } }) }),
        'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }),
      },
    });
    await s.write({ inc: { type: 'github-registry', owner: 'o', repo: 'inc', ref: 'main' } });
    await pull(s.ctx);
    const before = await snapshot(s.lib);
    s.repos['o/r'] = repoWith({ 'skills/a/SKILL.md': skill('a', ' v2'), 'skills/b/SKILL.md': skill('b') }, SHA2);
    s.repos['o/inc'] = repoWith({ 'registries.jsonc': JSON.stringify({ registries: { r: gh('r'), extra: gh('r', { description: 'x' }) } }) }, SHA2);
    pullFs.writeManifest = async () => { throw new Error('disk full'); };
    const r = await pullLibrary(s.ctx);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: 'library/write-failed', message: expect.stringContaining(manifestFile(s.lib)) }));
    expect(r.changes).toEqual([]);
    expect(await snapshot(s.lib)).toEqual(before);
  });

  it('a failed include swap keeps the previous include file and record, so a later pull can fall back to it', async () => {
    const s = await setup({
      repos: {
        'o/inc': repoWith({ 'registries.jsonc': JSON.stringify({ registries: { r: gh('r') } }) }),
        'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }),
      },
    });
    await s.write({ inc: { type: 'github-registry', owner: 'o', repo: 'inc', ref: 'main' } });
    await pull(s.ctx);
    const file = join(s.lib, 'registries/github/o/inc@main/registries.jsonc');
    const oldText = await readFile(file, 'utf8');
    s.repos['o/inc'] = repoWith({ 'registries.jsonc': JSON.stringify({ registries: { r: gh('r', { description: 'new' }) } }) }, SHA2);
    pullFs.swapIn = async (lib, staged, rel) => {
      if (rel.startsWith('registries/')) throw new Error('EACCES');
      return realFs.swapIn(lib, staged, rel);
    };
    const r = await pull(s.ctx);
    expect(r.problems).toContainEqual(expect.objectContaining({ code: 'library/write-failed', message: expect.stringContaining(file) }));
    expect(await readFile(file, 'utf8')).toBe(oldText);
    expect(r.manifest!.includes).toMatchObject([{ name: 'inc', stale: true, file: 'registries/github/o/inc@main/registries.jsonc' }]);
    expect(await verifyFolders(s.lib, r.manifest!)).toEqual([]);
    Object.assign(pullFs, realFs);
    delete s.repos['o/inc'];
    const later = await pull(s.ctx);
    expect(later.problems.some((p) => p.code === 'source/stale' && p.registry === 'inc')).toBe(true);
    expect(later.manifest!.sources.map((x) => [x.name, x.skills.length])).toEqual([['r', 1]]);
  });
});
