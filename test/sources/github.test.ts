import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  extractTarball, ExtractTooLargeError, fetchGithubFile, fetchGithubTree, invalidRepo, isShaRef, materializeGithub, readGithubFile, type FetchOpts,
} from '../../src/sources/github.js';
import { fetchHttp, NetworkError, type Http, type HttpResponse } from '../../src/net/http.js';
import { resetGhTokenCache } from '../../src/auth.js';
import type { Ctx, Exec } from '../../src/context.js';
import type { Auth, CacheSettings, Problem } from '../../src/types.js';
import { buildTarGz, fakeGithub, listTar, type FakeFile, type FakeSpec } from '../helpers/fakeGithub.js';
import { tmpDir } from '../helpers/tmp.js';

const SHA1 = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SHA2 = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FILES: Record<string, FakeFile> = {
  'README.md': '# acme skills\n',
  'skills/foo/SKILL.md': '---\nname: foo\ndescription: Foo\n---\nbody\n',
  'skills/foo/references/notes.md': 'notes\n',
  'skills/cat/bar/SKILL.md': '---\nname: bar\n---\n',
  'evil-link': { symlink: '/etc/passwd' },
};
const REAL_FILES = Object.keys(FILES).filter((k) => typeof FILES[k] === 'string');
const TTL = 3600;

const noExec: Exec = async () => ({ code: 1, stdout: '', stderr: 'not logged in' });

async function setup(o: { token?: string; exec?: Exec; http?: (fake: Http) => Http } = {}) {
  const dir = await tmpDir();
  const spec: FakeSpec = {
    'acme/skills': { refs: { main: SHA1 }, commits: { [SHA1]: { ...FILES }, [SHA2]: { 'README.md': 'v2\n' } }, token: o.token },
  };
  const fake = fakeGithub(spec);
  let now = 1_700_000_000_000;
  const ctx: Ctx = {
    env: {}, home: join(dir, 'home'), cwd: dir, http: o.http ? o.http(fake.http) : fake.http,
    exec: o.exec ?? noExec, now: () => now, githubApi: 'https://api.github.com',
  };
  const cache: CacheSettings = { enabled: true, ttlSeconds: TTL, dir: join(dir, 'cache') };
  return { dir, spec, fake, ctx, cache, advance: (s: number) => { now += s * 1000; } };
}

const src = (ref = 'main', auth: Auth = { type: 'none' }) => ({ owner: 'acme', repo: 'skills', ref, auth });
const opts = (o: Partial<FetchOpts> = {}): FetchOpts => ({ force: false, trusted: true, ttlSeconds: TTL, ...o });
const commitCalls = (calls: string[]) => calls.filter((c) => c.includes('/commits/')).length;
const tarballCalls = (calls: string[]) => calls.filter((c) => c.includes('/tarball/')).length;

function ok<T extends object>(r: T | { error: Problem }): T {
  if ('error' in r) throw new Error(`unexpected error: ${JSON.stringify(r.error)}`);
  return r as T;
}
function err(r: object): Problem {
  if (!('error' in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  return (r as { error: Problem }).error;
}
const stub = (fn: (url: string, headers: Record<string, string>) => HttpResponse | undefined, fallback: Http): Http => ({
  async get(url, headers = {}) { return fn(url, headers) ?? fallback.get(url, headers); },
});
const res = (status: number, body = '', headers: Record<string, string> = {}): HttpResponse =>
  ({ status, headers, body: Buffer.from(body) });

/** Every path under dir (recursively), with lstat results. */
async function walk(dir: string): Promise<Array<{ path: string; symlink: boolean }>> {
  const out: Array<{ path: string; symlink: boolean }> = [];
  for (const name of await readdir(dir)) {
    const p = join(dir, name);
    const st = await lstat(p);
    out.push({ path: p, symlink: st.isSymbolicLink() });
    if (st.isDirectory()) out.push(...await walk(p));
  }
  return out;
}

beforeEach(() => resetGhTokenCache());

describe('isShaRef', () => {
  it('accepts 7-40 lowercase hex only', () => {
    expect(isShaRef('a1b2c3d')).toBe(true);
    expect(isShaRef('main')).toBe(false);
    expect(isShaRef('v1.2.3')).toBe(false);
    expect(isShaRef('0123456789abcdef0123456789abcdef01234567')).toBe(true);
    expect(isShaRef('a1b2c3')).toBe(false);
    expect(isShaRef('A1B2C3D')).toBe(false);
  });
});

describe('materializeGithub', () => {
  it('branch ref resolves to sha, extracts tree to <cache>/github/<owner>/<repo>/<sha>/ without the top folder', async () => {
    const { ctx, cache } = await setup();
    const r = ok(await materializeGithub(src(), opts(), cache, ctx));
    expect(r.sha).toBe(SHA1);
    expect(r.stale).toBe(false);
    expect(r.root).toBe(join(cache.dir, 'github', 'acme', 'skills', SHA1));
    for (const f of REAL_FILES) expect(await readFile(join(r.root, f), 'utf8')).toBe(FILES[f]);
    expect(existsSync(join(r.root, `acme-skills-${SHA1.slice(0, 7)}`))).toBe(false);
    expect(await readdir(join(cache.dir, 'github', 'acme', 'skills'))).toEqual([SHA1]);
  });

  it('sha ref is never re-resolved', async () => {
    const { ctx, cache, fake } = await setup();
    const a = ok(await materializeGithub(src(SHA1), opts({ ttlSeconds: 0 }), cache, ctx));
    const b = ok(await materializeGithub(src(SHA1), opts({ ttlSeconds: 0 }), cache, ctx));
    expect(a.root).toBe(b.root);
    expect(commitCalls(fake.calls)).toBe(0);
    expect(tarballCalls(fake.calls)).toBe(1);
  });

  it('branch ref is re-checked only after ttl', async () => {
    const { ctx, cache, fake, spec, advance } = await setup();
    ok(await materializeGithub(src(), opts(), cache, ctx));
    expect(commitCalls(fake.calls)).toBe(1);
    spec['acme/skills'].refs.main = SHA2;
    advance(TTL - 1);
    const fresh = ok(await materializeGithub(src(), opts(), cache, ctx));
    expect(commitCalls(fake.calls)).toBe(1);
    expect(fresh.sha).toBe(SHA1);
    advance(2); // now ttl + 1 after the first check
    const rechecked = ok(await materializeGithub(src(), opts(), cache, ctx));
    expect(commitCalls(fake.calls)).toBe(2);
    expect(rechecked.sha).toBe(SHA2);
    expect(await readFile(join(rechecked.root, 'README.md'), 'utf8')).toBe('v2\n');
  });

  it('ttlSeconds 0 re-checks every time but reuses the stored tree', async () => {
    const { ctx, cache, fake } = await setup();
    ok(await materializeGithub(src(), opts({ ttlSeconds: 0 }), cache, ctx));
    ok(await materializeGithub(src(), opts({ ttlSeconds: 0 }), cache, ctx));
    expect(commitCalls(fake.calls)).toBe(2);
    expect(tarballCalls(fake.calls)).toBe(1);
  });

  it('force re-checks a branch ref regardless of ttl', async () => {
    const { ctx, cache, fake } = await setup();
    ok(await materializeGithub(src(), opts(), cache, ctx));
    ok(await materializeGithub(src(), opts({ force: true }), cache, ctx));
    expect(commitCalls(fake.calls)).toBe(2);
  });

  it('offline with a previous resolution returns the cached tree with stale: true and a warning problem', async () => {
    const { ctx, cache, fake, advance } = await setup();
    const first = ok(await materializeGithub(src(), opts(), cache, ctx));
    advance(TTL + 1);
    fake.offline(true);
    const r = ok(await materializeGithub(src(), opts(), cache, ctx));
    expect(r).toMatchObject({ sha: SHA1, root: first.root, stale: true });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ level: 'warning', code: 'source/stale' });
    expect(r.problems[0].message).toContain('acme/skills');
    expect(r.problems[0].registry).toBeUndefined();
  });

  it('a 5xx on re-check with a previous resolution is also stale', async () => {
    let down = false;
    const { ctx, cache } = await setup({ http: (f) => stub(() => (down ? res(502, 'bad gateway') : undefined), f) });
    ok(await materializeGithub(src(), opts(), cache, ctx));
    down = true;
    const r = ok(await materializeGithub(src(), opts({ force: true }), cache, ctx));
    expect(r.stale).toBe(true);
    expect(r.problems.map((p) => p.code)).toEqual(['source/stale']);
  });

  it('offline with no previous resolution returns { error: { code: "source/unreachable" } }', async () => {
    const { ctx, cache, fake } = await setup();
    fake.offline(true);
    const e = err(await materializeGithub(src(), opts(), cache, ctx));
    expect(e).toMatchObject({ level: 'error', code: 'source/unreachable' });
    expect(e.message).toContain('acme/skills');
    const e2 = err(await materializeGithub(src(SHA1), opts(), cache, ctx));
    expect(e2.code).toBe('source/unreachable');
  });

  it('404/401/403 returns error code "source/no-access" whose message names owner/repo and suggests "gh auth login" when auth is gh_cli', async () => {
    const { ctx, cache } = await setup({ token: 'sekrit' });
    const none = err(await materializeGithub(src(), opts(), cache, ctx));
    expect(none).toMatchObject({ level: 'error', code: 'source/no-access' });
    expect(none.message).toContain('acme/skills');
    const gh = err(await materializeGithub(src('main', { type: 'gh_cli' }), opts(), cache, ctx));
    expect(gh.code).toBe('source/no-access');
    expect(gh.message).toContain('acme/skills');
    expect(gh.message).toContain('gh auth login');

    for (const status of [401, 403]) {
      const s = await setup({ http: (f) => stub(() => res(status, '{"message":"Bad credentials"}'), f) });
      const e = err(await materializeGithub(src('main', { type: 'gh_cli' }), opts(), s.cache, s.ctx));
      expect(e.code).toBe('source/no-access');
      expect(e.message).toContain('acme/skills');
      expect(e.message).toContain('gh auth login');
    }
  });

  it('a rate-limit 403 (x-ratelimit-remaining: 0) gives "source/rate-limited"', async () => {
    const { ctx, cache } = await setup({
      http: (f) => stub(() => res(403, '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0' }), f),
    });
    const e = err(await materializeGithub(src(), opts(), cache, ctx));
    expect(e).toMatchObject({ level: 'error', code: 'source/rate-limited' });
    expect(e.message).toContain('acme/skills');
  });

  it('gh_cli sends the gh token to the API and reaches a private repo', async () => {
    const exec: Exec = async () => ({ code: 0, stdout: 'sekrit\n', stderr: '' });
    const { ctx, cache } = await setup({ token: 'sekrit', exec });
    const r = ok(await materializeGithub(src('main', { type: 'gh_cli' }), opts(), cache, ctx));
    expect(r.sha).toBe(SHA1);
  });

  it('an unknown ref names owner/repo and the ref', async () => {
    const { ctx, cache } = await setup();
    const e = err(await materializeGithub(src('no-such-branch'), opts(), cache, ctx));
    expect(e.code).toBe('source/ref-not-found');
    expect(e.message).toContain('acme/skills');
    expect(e.message).toContain('no-such-branch');
  });

  it('rejects owner/repo/ref values that could escape the cache or the API path, without any request', async () => {
    const { ctx, cache, fake } = await setup();
    for (const bad of [
      { owner: '..', repo: 'skills', ref: 'main' },
      { owner: 'acme', repo: '../x', ref: 'main' },
      { owner: 'acme', repo: 'skills', ref: '../../x' },
      { owner: 'acme', repo: 'skills', ref: 'a//b' },
    ]) {
      const e = err(await materializeGithub({ ...bad, auth: { type: 'none' } }, opts(), cache, ctx));
      expect(e.code).toBe('source/invalid');
    }
    expect(fake.calls).toEqual([]);
  });

  it('a tarball over 100 MB gives "source/too-large"', async () => {
    const big = Buffer.alloc(100 * 1024 * 1024 + 1);
    const { ctx, cache } = await setup({
      http: (f) => ({ async get(url, h) { return url.includes('/tarball/') ? { status: 200, headers: {}, body: big } : f.get(url, h); } }),
    });
    const e = err(await materializeGithub(src(), opts(), cache, ctx));
    expect(e.code).toBe('source/too-large');
    expect(e.message).toContain('acme/skills');
  });

  it('a corrupt tarball gives "source/bad-archive" and leaves no tree or temp dir', async () => {
    const { ctx, cache } = await setup({
      http: (f) => stub((url) => (url.includes('/tarball/') ? res(200, 'this is not a tarball') : undefined), f),
    });
    const e = err(await materializeGithub(src(), opts(), cache, ctx));
    expect(e.code).toBe('source/bad-archive');
    expect(await readdir(join(cache.dir, 'github', 'acme', 'skills'))).toEqual([]);
  });

  it('tar entries with ../ or absolute paths are skipped; symlinks and hard links are not created', async () => {
    const { dir, ctx, cache } = await setup();
    const top = `acme-skills-${SHA1.slice(0, 7)}`;
    const absTarget = join(dir, 'abs-evil');
    const hostile = buildTarGz([
      { path: `${top}/`, type: 'Directory' },
      { path: `${top}/ok.txt`, type: 'File', body: 'ok' },
      { path: '../evil', type: 'File', body: 'pwned' },
      { path: `${top}/../../evil2`, type: 'File', body: 'pwned' },
      { path: `${top}/sub/../../../evil3`, type: 'File', body: 'pwned' },
      { path: '/abs/evil', type: 'File', body: 'pwned' },
      { path: absTarget, type: 'File', body: 'pwned' },
      { path: `${top}/sym`, type: 'SymbolicLink', linkpath: '/etc/passwd' },
      { path: `${top}/up`, type: 'SymbolicLink', linkpath: '../../../..' },
      { path: `${top}/up/through-symlink`, type: 'File', body: 'pwned' },
      { path: `${top}/hard`, type: 'Link', linkpath: '/etc/passwd' },
      { path: `${top}/hard-rel`, type: 'Link', linkpath: `${top}/ok.txt` },
    ]);
    // The fixture really contains the hostile entries (R2): nothing was sanitised on creation.
    const entries = await listTar(hostile);
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['../evil', `${top}/../../evil2`, '/abs/evil', absTarget]));
    expect(entries.filter((e) => e.type === 'SymbolicLink').map((e) => e.linkpath)).toEqual(['/etc/passwd', '../../../..']);
    expect(entries.filter((e) => e.type === 'Link').map((e) => e.linkpath)).toEqual(['/etc/passwd', `${top}/ok.txt`]);

    ctx.http = stub((url) => (url.includes('/tarball/') ? { status: 200, headers: {}, body: hostile } : undefined), ctx.http);
    const r = ok(await materializeGithub(src(), opts(), cache, ctx));
    expect(await readFile(join(r.root, 'ok.txt'), 'utf8')).toBe('ok');

    // Nothing anywhere in the test dir besides the cache's tree (and its state) was written.
    const all = await walk(dir);
    const outsideTree = all.filter((e) => !e.path.startsWith(r.root + '/') && e.path !== r.root)
      .map((e) => relative(dir, e.path));
    expect(outsideTree.every((p) => ['cache', 'cache/github', 'cache/github/acme', 'cache/github/acme/skills'].includes(p)
      || p.startsWith('cache/state'))).toBe(true);
    expect(existsSync('/abs/evil')).toBe(false);
    expect(existsSync(absTarget)).toBe(false);

    // Inside the tree: no symlinks or links. "up/through-symlink" lands as a plain dir + file inside the tree.
    const inTree = all.filter((e) => e.path.startsWith(r.root + '/'));
    expect(inTree.filter((e) => e.symlink)).toEqual([]);
    expect(inTree.map((e) => relative(r.root, e.path)).sort()).toEqual(['ok.txt', 'up', 'up/through-symlink']);
  });

  it('a { symlink } file in the fake repo is never created in the tree', async () => {
    const { ctx, cache } = await setup();
    const r = ok(await materializeGithub(src(), opts(), cache, ctx));
    expect(existsSync(join(r.root, 'evil-link'))).toBe(false);
    expect((await walk(r.root)).filter((e) => e.symlink)).toEqual([]);
  });

  it('concurrent materialize of the same sha yields one complete tree', async () => {
    const { ctx, cache, fake } = await setup();
    const results = (await Promise.all([1, 2, 3, 4].map(() => materializeGithub(src(), opts(), cache, ctx)))).map(ok);
    const roots = new Set(results.map((r) => r.root));
    expect(roots.size).toBe(1);
    const [root] = roots;
    for (const f of REAL_FILES) expect(await readFile(join(root, f), 'utf8')).toBe(FILES[f]);
    expect(await readdir(join(cache.dir, 'github', 'acme', 'skills'))).toEqual([SHA1]);
    expect(tarballCalls(fake.calls)).toBeGreaterThanOrEqual(1);
    const stateFiles = await readdir(join(cache.dir, 'state'), { recursive: true });
    expect(stateFiles.filter((f) => String(f).includes('.tmp'))).toEqual([]);
  });

  it('works over real HTTP through fakeGithub.nodeHandler and fetchHttp', async () => {
    const { ctx, cache, fake } = await setup();
    const server = createServer(fake.nodeHandler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      ctx.http = fetchHttp();
      ctx.githubApi = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const r = ok(await materializeGithub(src(), opts(), cache, ctx));
      expect(await readFile(join(r.root, 'skills/foo/SKILL.md'), 'utf8')).toBe(FILES['skills/foo/SKILL.md']);
      fake.offline(true);
      await expect(ctx.http.get(`${ctx.githubApi}/repos/acme/skills/commits/main`)).rejects.toBeInstanceOf(NetworkError);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('readGithubFile', () => {
  it('readGithubFile returns raw text at the resolved sha and caches it by sha', async () => {
    const { ctx, cache, fake, spec } = await setup();
    const f = { ...src(), path: 'skills/foo/SKILL.md' };
    const a = ok(await readGithubFile(f, opts(), cache, ctx));
    expect(a).toMatchObject({ sha: SHA1, text: FILES['skills/foo/SKILL.md'], stale: false });
    expect(fake.calls.filter((c) => c.includes('/contents/'))).toEqual([`/repos/acme/skills/contents/skills/foo/SKILL.md?ref=${SHA1}`]);
    expect(await readFile(join(cache.dir, 'files', 'acme', 'skills', SHA1, 'skills/foo/SKILL.md'), 'utf8'))
      .toBe(FILES['skills/foo/SKILL.md']);

    spec['acme/skills'].commits[SHA1]['skills/foo/SKILL.md'] = 'changed upstream (cannot happen for a sha, proves the cache is used)';
    const b = ok(await readGithubFile(f, opts(), cache, ctx));
    expect(b.text).toBe(FILES['skills/foo/SKILL.md']);
    expect(fake.calls.filter((c) => c.includes('/contents/'))).toHaveLength(1);
    expect(commitCalls(fake.calls)).toBe(1); // second call within ttl: no re-check
  });

  it('offline after a previous read returns the cached file as stale; a missing file is no-access', async () => {
    const { ctx, cache, fake, advance } = await setup();
    const f = { ...src(), path: 'README.md' };
    ok(await readGithubFile(f, opts(), cache, ctx));
    advance(TTL + 1);
    fake.offline(true);
    const r = ok(await readGithubFile(f, opts(), cache, ctx));
    expect(r).toMatchObject({ sha: SHA1, text: FILES['README.md'], stale: true });
    expect(r.problems.map((p) => p.code)).toEqual(['source/stale']);
    fake.offline(false);
    const e = err(await readGithubFile({ ...src(), path: 'nope.md' }, opts(), cache, ctx));
    expect(e.code).toBe('source/no-access');
    expect(e.message).toContain('acme/skills');
  });

  it('rejects .. and absolute paths without any request', async () => {
    const { ctx, cache, fake } = await setup();
    for (const path of ['../x', 'a/../../x', '/etc/passwd', 'a/./../..', '', 'a\0b']) {
      const e = err(await readGithubFile({ ...src(), path }, opts(), cache, ctx));
      expect(e.code).toBe('source/invalid');
    }
    expect(fake.calls).toEqual([]);
  });
});

describe('review fixes (R8 stale on any failure, R9 lazy auth and extraction cap)', () => {
  const rateLimited = () => res(403, '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0' });

  it('a rate-limited re-check with a cached tree returns the tree as stale, with the rate-limit message', async () => {
    let limited = false;
    const { ctx, cache } = await setup({ http: (f) => stub(() => (limited ? rateLimited() : undefined), f) });
    const first = ok(await materializeGithub(src(), opts(), cache, ctx));
    limited = true;
    const r = ok(await materializeGithub(src(), opts({ force: true }), cache, ctx));
    expect(r).toMatchObject({ sha: SHA1, root: first.root, stale: true });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatchObject({ level: 'warning', code: 'source/stale' });
    expect(r.problems[0].message).toContain('rate limit');
    expect(r.problems[0].message).toContain('acme/skills');
  });

  it('a 401 re-check with a cached tree returns the tree as stale and keeps the gh auth login hint', async () => {
    let denied = false;
    const exec: Exec = async () => ({ code: 0, stdout: 'tok\n', stderr: '' });
    const { ctx, cache } = await setup({ exec, http: (f) => stub(() => (denied ? res(401, '{"message":"Bad credentials"}') : undefined), f) });
    ok(await materializeGithub(src('main', { type: 'gh_cli' }), opts(), cache, ctx));
    denied = true;
    const r = ok(await materializeGithub(src('main', { type: 'gh_cli' }), opts({ force: true }), cache, ctx));
    expect(r).toMatchObject({ sha: SHA1, stale: true });
    expect(r.problems.map((p) => p.code)).toEqual(['source/stale']);
    expect(r.problems[0].message).toContain('gh auth login');
  });

  it('ref-not-found on re-check with a cached tree is stale; without one it is still the original error', async () => {
    const { ctx, cache, spec } = await setup();
    ok(await materializeGithub(src(), opts(), cache, ctx));
    delete spec['acme/skills'].refs.main;
    const r = ok(await materializeGithub(src(), opts({ force: true }), cache, ctx));
    expect(r.stale).toBe(true);
    expect(r.problems[0].message).toContain('was not found');
    const fresh = await setup();
    delete fresh.spec['acme/skills'].refs.main;
    expect(err(await materializeGithub(src(), opts(), fresh.cache, fresh.ctx)).code).toBe('source/ref-not-found');
  });

  it('a failed download of a newly resolved sha falls back to the previous tree as stale', async () => {
    const { ctx, cache, spec } = await setup({
      http: (f) => stub((url) => (url.includes(`/tarball/${SHA2}`) ? res(404, 'Not Found') : undefined), f),
    });
    ok(await materializeGithub(src(), opts(), cache, ctx));
    spec['acme/skills'].refs.main = SHA2;
    const r = ok(await materializeGithub(src(), opts({ force: true }), cache, ctx));
    expect(r).toMatchObject({ sha: SHA1, stale: true });
    expect(r.problems.map((p) => p.code)).toEqual(['source/stale']);
    expect(r.problems[0].message).toContain(SHA2.slice(0, 7));
  });

  it('readGithubFile: a 401 or rate-limited re-check with a cached file returns it as stale', async () => {
    let mode: 'ok' | 'denied' | 'limited' = 'ok';
    const { ctx, cache } = await setup({
      http: (f) => stub(() => (mode === 'denied' ? res(401, '') : mode === 'limited' ? rateLimited() : undefined), f),
    });
    const f = { ...src('main', { type: 'gh_cli' } as Auth), path: 'README.md' };
    ok(await readGithubFile(f, opts(), cache, ctx));
    for (const m of ['denied', 'limited'] as const) {
      mode = m;
      const r = ok(await readGithubFile(f, opts({ force: true }), cache, ctx));
      expect(r).toMatchObject({ sha: SHA1, text: FILES['README.md'], stale: true });
      expect(r.problems.filter((p) => p.code === 'source/stale')).toHaveLength(1);
    }
  });

  it('auth is resolved lazily: cache hits and an offline sha-pinned tree never spawn gh or report auth problems', async () => {
    let spawned = 0;
    const exec: Exec = async () => { spawned++; return { code: 1, stdout: '', stderr: 'not logged in' }; };
    const { ctx, cache, fake } = await setup({ exec });
    const gh = { type: 'gh_cli' } as Auth;
    const first = ok(await materializeGithub(src('main', gh), opts(), cache, ctx));
    expect(spawned).toBe(1);
    expect(first.problems.map((p) => p.code)).toEqual(['auth/gh-unavailable']);

    resetGhTokenCache();
    const hit = ok(await materializeGithub(src('main', gh), opts(), cache, ctx)); // fresh ref state + tree on disk
    expect(hit.problems).toEqual([]);
    fake.offline(true);
    const pinned = ok(await materializeGithub(src(SHA1, gh), opts(), cache, ctx));
    expect(pinned.problems).toEqual([]);
    const file = await readGithubFile({ ...src(SHA1, gh), path: 'README.md' }, opts(), cache, ctx);
    expect(err(file).code).toBe('source/unreachable'); // not cached: a request was needed
    fake.offline(false);
    ok(await readGithubFile({ ...src(SHA1, gh), path: 'README.md' }, opts(), cache, ctx));
    resetGhTokenCache();
    const fileHit = ok(await readGithubFile({ ...src(SHA1, gh), path: 'README.md' }, opts(), cache, ctx));
    expect(fileHit.problems).toEqual([]);
    // first materialize, then the offline file read (gh's answer is then cached for the online read)
    expect(spawned).toBe(2);
  });

  it('extractTarball aborts once the declared entry sizes pass the cap', async () => {
    const dir = await tmpDir();
    const tgz = buildTarGz([
      { path: 'top/', type: 'Directory' },
      { path: 'top/a', type: 'File', body: '12345678' },
      { path: 'top/b', type: 'File', body: '12345678' },
    ]);
    await expect(extractTarball(tgz, dir, 10)).rejects.toBeInstanceOf(ExtractTooLargeError);
    await expect(extractTarball(tgz, await tmpDir(), 16)).resolves.toBeUndefined();
  });

  it('a tarball expanding past 500 MB gives source/too-large and leaves no temp dir', async () => {
    const top = `acme-skills-${SHA1.slice(0, 7)}`;
    const huge = buildTarGz([
      { path: `${top}/`, type: 'Directory' },
      { path: `${top}/small`, type: 'File', body: 'x' },
      { path: `${top}/huge`, type: 'File', size: 500 * 1024 * 1024 },
    ]);
    const { ctx, cache } = await setup({
      http: (f) => stub((url) => (url.includes('/tarball/') ? { status: 200, headers: {}, body: huge } : undefined), f),
    });
    const e = err(await materializeGithub(src(), opts(), cache, ctx));
    expect(e.code).toBe('source/too-large');
    expect(e.message).toContain('acme/skills');
    expect(await readdir(join(cache.dir, 'github', 'acme', 'skills'))).toEqual([]);
  });
});

describe('auth cause on errors', () => {
  it('names the unset env var when a no-cache 404 follows an auth problem (GitHub answers 404 for a private repo without access)', async () => {
    const t = await setup({ token: 'secret' });
    const r = await materializeGithub(src('main', { type: 'bearer', env_var: 'BEARER_X' }), opts(), t.cache, t.ctx);
    expect('error' in r && r.error.code).toBe('source/no-access');
    expect('error' in r && r.error.message).toContain('BEARER_X');
  });
});

describe('fetchGithubTree', () => {
  const tree = (t: Awaited<ReturnType<typeof setup>>, into: string, o: { ref?: string; auth?: Auth; knownSha?: string } = {}) =>
    fetchGithubTree(src(o.ref, o.auth), { trusted: true, knownSha: o.knownSha }, into, t.ctx);

  it('a knownSha equal to the ref sha is unchanged and downloads nothing', async () => {
    const t = await setup();
    const into = join(t.dir, 'out');
    const r = ok(await tree(t, into, { knownSha: SHA1 }));
    expect(r).toMatchObject({ sha: SHA1, unchanged: true });
    expect(t.fake.calls).toEqual(['/repos/acme/skills/commits/main']);
    expect(existsSync(into)).toBe(false);
  });

  it('extracts the repo into intoDir and returns the ref sha', async () => {
    const t = await setup();
    const into = join(t.dir, 'out');
    const r = ok(await tree(t, into, { knownSha: SHA2 }));
    expect(r).toMatchObject({ sha: SHA1, unchanged: false });
    for (const f of REAL_FILES) expect(await readFile(join(into, f), 'utf8')).toBe(FILES[f]);
    expect(existsSync(join(into, 'evil-link'))).toBe(false);
    expect(existsSync(join(t.dir, 'cache'))).toBe(false);
  });

  it('a sha ref makes no /commits/ request', async () => {
    const t = await setup();
    ok(await tree(t, join(t.dir, 'out'), { ref: SHA1 }));
    expect(commitCalls(t.fake.calls)).toBe(0);
    expect(tarballCalls(t.fake.calls)).toBe(1);
  });

  it('refuses an intoDir that already exists and leaves it alone', async () => {
    const t = await setup();
    const into = join(t.dir, 'out');
    await mkdir(into);
    await writeFile(join(into, 'keep'), 'x');
    expect(err(await tree(t, into)).code).toBe('source/write-failed');
    expect(await readFile(join(into, 'keep'), 'utf8')).toBe('x');
  });

  it('rejects an invalid repo without any request', async () => {
    const t = await setup();
    const e = err(await fetchGithubTree({ ...src(), owner: '..' }, { trusted: true }, join(t.dir, 'out'), t.ctx));
    expect(e.code).toBe('source/invalid');
    expect(t.fake.calls).toEqual([]);
    expect(invalidRepo({ ...src(), repo: 'a/b' })?.code).toBe('source/invalid');
  });

  it('hostile tarballs write nothing outside intoDir', async () => {
    const t = await setup();
    const top = `acme-skills-${SHA1.slice(0, 7)}`;
    const absTarget = join(t.dir, 'abs-evil');
    const hostile = buildTarGz([
      { path: `${top}/`, type: 'Directory' },
      { path: `${top}/ok.txt`, type: 'File', body: 'ok' },
      { path: '../evil', type: 'File', body: 'pwned' },
      { path: `${top}/../../evil2`, type: 'File', body: 'pwned' },
      { path: '/abs/evil', type: 'File', body: 'pwned' },
      { path: absTarget, type: 'File', body: 'pwned' },
      { path: `${top}/sym`, type: 'SymbolicLink', linkpath: '/etc/passwd' },
      { path: `${top}/hard`, type: 'Link', linkpath: '/etc/passwd' },
    ]);
    t.ctx.http = stub((url) => (url.includes('/tarball/') ? { status: 200, headers: {}, body: hostile } : undefined), t.ctx.http);
    const into = join(t.dir, 'work', 'out');
    ok(await tree(t, into));
    expect(await readdir(into)).toEqual(['ok.txt']);
    expect((await walk(t.dir)).map((e) => relative(t.dir, e.path)).sort()).toEqual(['work', 'work/out', 'work/out/ok.txt']);
    expect(existsSync('/abs/evil')).toBe(false);
    expect(existsSync(absTarget)).toBe(false);
  });

  it('an oversize download or expansion gives source/too-large and removes intoDir', async () => {
    const huge = buildTarGz([
      { path: 'top/', type: 'Directory' },
      { path: 'top/small', type: 'File', body: 'x' },
      { path: 'top/huge', type: 'File', size: 500 * 1024 * 1024 },
    ]);
    const big = Buffer.alloc(100 * 1024 * 1024 + 1);
    for (const body of [huge, big]) {
      const t = await setup();
      t.ctx.http = stub((url) => (url.includes('/tarball/') ? { status: 200, headers: {}, body } : undefined), t.ctx.http);
      const into = join(t.dir, 'out');
      const e = err(await tree(t, into));
      expect(e.code).toBe('source/too-large');
      expect(existsSync(into)).toBe(false);
    }
  });

  it('a corrupt tarball gives source/bad-archive and removes intoDir', async () => {
    const t = await setup();
    t.ctx.http = stub((url) => (url.includes('/tarball/') ? res(200, 'not a tarball') : undefined), t.ctx.http);
    const into = join(t.dir, 'out');
    expect(err(await tree(t, into)).code).toBe('source/bad-archive');
    expect(existsSync(into)).toBe(false);
  });

  it('a 404 with gh_cli auth gives source/no-access mentioning gh auth login', async () => {
    const t = await setup({ token: 'secret' });
    const e = err(await tree(t, join(t.dir, 'out'), { auth: { type: 'gh_cli' } }));
    expect(e.code).toBe('source/no-access');
    expect(e.message).toContain('gh auth login');
  });

  it('never serves a stale copy: offline is an error', async () => {
    const t = await setup();
    t.fake.offline(true);
    expect(err(await tree(t, join(t.dir, 'out'))).code).toBe('source/unreachable');
  });
});

describe('fetchGithubFile', () => {
  it('reads a file at the resolved sha', async () => {
    const t = await setup();
    const r = ok(await fetchGithubFile({ ...src(), path: 'README.md' }, { trusted: true }, t.ctx));
    expect(r).toMatchObject({ sha: SHA1, text: FILES['README.md'] });
  });

  it('a sha ref makes no /commits/ request', async () => {
    const t = await setup();
    ok(await fetchGithubFile({ ...src(SHA1), path: 'README.md' }, { trusted: true }, t.ctx));
    expect(commitCalls(t.fake.calls)).toBe(0);
  });

  it('rejects an escaping path without any request', async () => {
    const t = await setup();
    expect(err(await fetchGithubFile({ ...src(), path: '../x' }, { trusted: true }, t.ctx)).code).toBe('source/invalid');
    expect(t.fake.calls).toEqual([]);
  });

  it('a missing file is source/no-access', async () => {
    const t = await setup();
    expect(err(await fetchGithubFile({ ...src(), path: 'nope.md' }, { trusted: true }, t.ctx)).code).toBe('source/no-access');
  });
});
