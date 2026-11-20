import { describe, it, expect, beforeEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import {
  extractTarball, ExtractTooLargeError, fetchGithubFile, fetchGithubTree, invalidRepo, isShaRef,
} from '../../src/sources/github.js';
import { fetchHttp, NetworkError, type Http, type HttpResponse } from '../../src/net/http.js';
import { resetGhTokenCache } from '../../src/auth.js';
import type { Ctx, Exec } from '../../src/context.js';
import type { Auth, Problem } from '../../src/types.js';
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

const noExec: Exec = async () => ({ code: 1, stdout: '', stderr: 'not logged in' });

async function setup(o: { token?: string; exec?: Exec; http?: (fake: Http) => Http } = {}) {
  const dir = await tmpDir();
  const spec: FakeSpec = {
    'acme/skills': { refs: { main: SHA1 }, commits: { [SHA1]: { ...FILES }, [SHA2]: { 'README.md': 'v2\n' } }, token: o.token },
  };
  const fake = fakeGithub(spec);
  const ctx: Ctx = {
    env: {}, home: join(dir, 'home'), cwd: dir, http: o.http ? o.http(fake.http) : fake.http,
    exec: o.exec ?? noExec, now: () => 1_700_000_000_000, githubApi: 'https://api.github.com',
  };
  return { dir, spec, fake, ctx };
}

const src = (ref = 'main', auth: Auth = { type: 'none' }) => ({ owner: 'acme', repo: 'skills', ref, auth });
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

describe('fetchGithubTree: errors, auth and extraction', () => {
  const into = (t: { dir: string }) => join(t.dir, 'out');
  const fetchTree = (t: Awaited<ReturnType<typeof setup>>, ref = 'main', auth: Auth = { type: 'none' }) =>
    fetchGithubTree(src(ref, auth), { trusted: true }, into(t), t.ctx);

  it('404/401/403 returns error code "source/no-access" whose message names owner/repo and suggests "gh auth login" when auth is gh_cli', async () => {
    const t = await setup({ token: 'sekrit' });
    const none = err(await fetchTree(t));
    expect(none).toMatchObject({ level: 'error', code: 'source/no-access' });
    expect(none.message).toContain('acme/skills');
    const gh = err(await fetchTree(t, 'main', { type: 'gh_cli' }));
    expect(gh.code).toBe('source/no-access');
    expect(gh.message).toContain('acme/skills');
    expect(gh.message).toContain('gh auth login');

    for (const status of [401, 403]) {
      const s = await setup({ http: (f) => stub(() => res(status, '{"message":"Bad credentials"}'), f) });
      const e = err(await fetchTree(s, 'main', { type: 'gh_cli' }));
      expect(e.code).toBe('source/no-access');
      expect(e.message).toContain('acme/skills');
      expect(e.message).toContain('gh auth login');
    }
  });

  it('a rate-limit 403 (x-ratelimit-remaining: 0) gives "source/rate-limited"; a 5xx gives "source/unreachable"', async () => {
    const t = await setup({
      http: (f) => stub(() => res(403, '{"message":"API rate limit exceeded"}', { 'x-ratelimit-remaining': '0' }), f),
    });
    const e = err(await fetchTree(t));
    expect(e).toMatchObject({ level: 'error', code: 'source/rate-limited' });
    expect(e.message).toContain('acme/skills');
    const u = await setup({ http: (f) => stub(() => res(502, 'bad gateway'), f) });
    expect(err(await fetchTree(u)).code).toBe('source/unreachable');
  });

  it('gh_cli sends the gh token to the API and reaches a private repo', async () => {
    const exec: Exec = async () => ({ code: 0, stdout: 'sekrit\n', stderr: '' });
    const t = await setup({ token: 'sekrit', exec });
    expect(ok(await fetchTree(t, 'main', { type: 'gh_cli' })).sha).toBe(SHA1);
  });

  it('an unknown ref names owner/repo and the ref', async () => {
    const t = await setup();
    const e = err(await fetchTree(t, 'no-such-branch'));
    expect(e.code).toBe('source/ref-not-found');
    expect(e.message).toContain('acme/skills');
    expect(e.message).toContain('no-such-branch');
  });

  it('rejects owner/repo/ref values that could escape a folder or the API path, without any request', async () => {
    const t = await setup();
    for (const bad of [
      { owner: '..', repo: 'skills', ref: 'main' },
      { owner: 'acme', repo: '../x', ref: 'main' },
      { owner: 'acme', repo: 'skills', ref: '../../x' },
      { owner: 'acme', repo: 'skills', ref: 'a//b' },
    ]) {
      const e = err(await fetchGithubTree({ ...bad, auth: { type: 'none' } }, { trusted: true }, into(t), t.ctx));
      expect(e.code).toBe('source/invalid');
    }
    expect(t.fake.calls).toEqual([]);
  });

  it('tar entries with ../ or absolute paths are skipped; symlinks and hard links are not created', async () => {
    const t = await setup();
    const { dir, ctx } = t;
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
    const root = into(t);
    ok(await fetchTree(t));
    expect(await readFile(join(root, 'ok.txt'), 'utf8')).toBe('ok');

    // Nothing anywhere in the test dir besides the tree was written.
    const all = await walk(dir);
    expect(all.filter((e) => !e.path.startsWith(root + '/') && e.path !== root)).toEqual([]);
    expect(existsSync('/abs/evil')).toBe(false);
    expect(existsSync(absTarget)).toBe(false);

    // Inside the tree: no symlinks or links. "up/through-symlink" lands as a plain dir + file inside the tree.
    const inTree = all.filter((e) => e.path.startsWith(root + '/'));
    expect(inTree.filter((e) => e.symlink)).toEqual([]);
    expect(inTree.map((e) => relative(root, e.path)).sort()).toEqual(['ok.txt', 'up', 'up/through-symlink']);
  });

  it('works over real HTTP through fakeGithub.nodeHandler and fetchHttp', async () => {
    const t = await setup();
    const server = createServer(t.fake.nodeHandler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      t.ctx.http = fetchHttp();
      t.ctx.githubApi = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      ok(await fetchTree(t));
      expect(await readFile(join(into(t), 'skills/foo/SKILL.md'), 'utf8')).toBe(FILES['skills/foo/SKILL.md']);
      t.fake.offline(true);
      await expect(t.ctx.http.get(`${t.ctx.githubApi}/repos/acme/skills/commits/main`)).rejects.toBeInstanceOf(NetworkError);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });

  it('auth is resolved lazily: a sha ref equal to knownSha makes no request and never spawns gh', async () => {
    let spawned = 0;
    const exec: Exec = async () => { spawned++; return { code: 1, stdout: '', stderr: 'not logged in' }; };
    const t = await setup({ exec });
    const gh = { type: 'gh_cli' } as Auth;
    const r = ok(await fetchGithubTree(src(SHA1, gh), { trusted: true, knownSha: SHA1 }, into(t), t.ctx));
    expect(r).toMatchObject({ sha: SHA1, unchanged: true, problems: [] });
    expect(t.fake.calls).toEqual([]);
    expect(spawned).toBe(0);
    const first = ok(await fetchTree(t, 'main', gh));
    expect(spawned).toBe(1);
    expect(first.problems.map((p) => p.code)).toEqual(['auth/gh-unavailable']);
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

});

describe('auth cause on errors', () => {
  it('names the unset env var when a 404 follows an auth problem (GitHub answers 404 for a private repo without access)', async () => {
    const t = await setup({ token: 'secret' });
    const r = await fetchGithubTree(src('main', { type: 'bearer', env_var: 'BEARER_X' }), { trusted: true }, join(t.dir, 'out'), t.ctx);
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

  it('rejects .. and absolute paths without any request', async () => {
    const t = await setup();
    for (const path of ['../x', 'a/../../x', '/etc/passwd', 'a/./../..', '', 'a\0b']) {
      expect(err(await fetchGithubFile({ ...src(), path }, { trusted: true }, t.ctx)).code).toBe('source/invalid');
    }
    expect(t.fake.calls).toEqual([]);
  });

  it('a missing file is source/no-access naming owner/repo', async () => {
    const t = await setup();
    const e = err(await fetchGithubFile({ ...src(), path: 'nope.md' }, { trusted: true }, t.ctx));
    expect(e.code).toBe('source/no-access');
    expect(e.message).toContain('acme/skills');
  });
});
