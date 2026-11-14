import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { resolve } from '../../src/resolve/resolve.js';
import { parseRegistriesFile } from '../../src/config/load.js';
import { resetGhTokenCache } from '../../src/auth.js';
import type { Ctx, Exec } from '../../src/context.js';
import type { Http } from '../../src/net/http.js';
import type { Config } from '../../src/types.js';
import { fakeGithub, type FakeSpec } from '../helpers/fakeGithub.js';
import { fakeHttp, type FakeRoute } from '../helpers/fakeHttp.js';
import { tmpDir } from '../helpers/tmp.js';

const SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const API = 'https://api.github.com';
const noExec: Exec = async () => ({ code: 1, stdout: '', stderr: 'not logged in' });

type Entries = Record<string, Record<string, unknown>>;
const file = (registries: Entries, extra: Record<string, unknown> = {}) => JSON.stringify({ ...extra, registries });
const gh = (repo: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'github', owner: 'o', repo, skills_dir: 'skills', ref: 'main', ...extra });
const ghInclude = (repo: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'github-registry', owner: 'o', repo, ref: 'main', ...extra });
/** A repo whose main branch has registries.jsonc = the given entries. */
const repoWith = (registries: Entries, extra: Record<string, unknown> = {}) =>
  ({ refs: { main: SHA }, commits: { [SHA]: { 'registries.jsonc': file(registries, extra) } } });

async function setup(o: {
  local: Entries; repos?: FakeSpec; routes?: Record<string, FakeRoute>;
  env?: Record<string, string | undefined>; cache?: { enabled: boolean; ttlSeconds: number };
  wrap?: (http: Http) => Http;
}) {
  const dir = await tmpDir();
  const github = fakeGithub(o.repos ?? {});
  const web = fakeHttp(o.routes ?? {});
  const routed: Http = { get: (url, h, opts) => (url.startsWith(API) ? github.http : web.http).get(url, h, opts) };
  const http = o.wrap ? o.wrap(routed) : routed;
  const ctx: Ctx = {
    env: o.env ?? {}, home: join(dir, 'home'), cwd: dir, http, exec: noExec, now: () => 1_700_000_000_000, githubApi: API,
  };
  const path = join(dir, 'config.jsonc');
  const parsed = parseRegistriesFile(file(o.local), { file: path, isLocalConfig: true });
  const config: Config = {
    path, exists: true, ...parsed,
    cache: { ...(o.cache ?? { enabled: true, ttlSeconds: 3600 }), dir: join(dir, 'cache') },
  };
  return { config, ctx, github, web };
}

beforeEach(() => resetGhTokenCache());

describe('resolve', () => {
  it('expands includes depth-first in file order', async () => {
    const { config, ctx } = await setup({
      local: { A: ghInclude('a'), z: gh('z') },
      repos: { 'o/a': repoWith({ x: gh('x'), y: gh('y') }) },
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.problems).toEqual([]);
    expect(r.registries.map((x) => x.name)).toEqual(['x', 'y', 'z']);
    expect(r.registries[0]).toMatchObject({ name: 'x', via: ['A', 'x'], trusted: false, entry: { repo: 'x' } });
    expect(r.registries[2]).toMatchObject({ name: 'z', via: ['z'], trusted: true });
    expect(r.includes).toEqual([{ name: 'A', via: ['A'], entry: config.registries[0][1], sha: SHA, stale: false, policy: false }]);
    expect(r.stale).toBe(false);
  });

  it('registry name collision: last wins and is recorded', async () => {
    const { config, ctx } = await setup({
      local: { A: ghInclude('a'), shared: gh('local-shared'), after: gh('after') },
      repos: { 'o/a': repoWith({ shared: gh('remote-shared'), other: gh('other') }) },
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.registries.map((x) => [x.name, x.via])).toEqual([['other', ['A', 'other']], ['shared', ['shared']], ['after', ['after']]]);
    expect(r.registries[1].entry).toMatchObject({ repo: 'local-shared' });
    expect(r.overrides).toEqual([{
      kind: 'registry', key: 'shared',
      replaced: { registry: 'shared', via: ['A', 'shared'] }, by: { registry: 'shared', via: ['shared'] },
    }]);
  });

  it('loop is detected and reported, not infinite', async () => {
    const { config, ctx } = await setup({
      local: { A: ghInclude('a') },
      repos: {
        'o/a': repoWith({ B: ghInclude('b'), fromA: gh('fa') }),
        'o/b': repoWith({ backToA: ghInclude('a'), fromB: gh('fb') }),
      },
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.registries.map((x) => x.name)).toEqual(['fromB', 'fromA']);
    const loop = r.problems.filter((p) => p.code === 'resolve/include-loop');
    expect(loop).toHaveLength(1);
    expect(loop[0]).toMatchObject({ level: 'error', registry: 'backToA', via: ['A', 'B', 'backToA'], file: 'github:o/b@main:registries.jsonc' });
    expect(r.includes.map((i) => i.name)).toEqual(['A', 'B']);
  });

  it('depth beyond 5 is skipped with resolve/too-deep', async () => {
    // local (0) -> d1 (1) -> d2 -> d3 -> d4 -> d5 (5); d5 includes d6, which would be depth 6.
    const repos: FakeSpec = {};
    for (let i = 1; i <= 6; i++) repos[`o/d${i}`] = repoWith({ [`s${i}`]: gh(`s${i}`), [`I${i + 1}`]: ghInclude(`d${i + 1}`) });
    const { config, ctx, github } = await setup({ local: { I1: ghInclude('d1') }, repos });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.registries.map((x) => x.name)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(r.registries[4].via).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 's5']);
    expect(r.problems).toEqual([expect.objectContaining({
      level: 'error', code: 'resolve/too-deep', registry: 'I6', via: ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'],
      file: 'github:o/d5@main:registries.jsonc',
    })]);
    expect(r.includes).toHaveLength(5);
    expect(github.calls.some((c) => c.includes('/o/d6/'))).toBe(false);
  });

  it('included entry with github_token is skipped with auth/untrusted-env-auth and its env var never read', async () => {
    const reads: string[] = [];
    const env = new Proxy({} as Record<string, string | undefined>, {
      get(_t, key) { reads.push(String(key)); throw new Error(`env read: ${String(key)}`); },
      has(_t, key) { reads.push(String(key)); throw new Error(`env has: ${String(key)}`); },
      ownKeys() { reads.push('<keys>'); throw new Error('env enumerated'); },
    });
    const { config, ctx, github, web } = await setup({
      env,
      local: { A: ghInclude('a') },
      repos: {
        'o/a': repoWith({
          tok: gh('t', { auth: { type: 'github_token', env_var: 'AWS_SECRET_ACCESS_KEY' } }),
          bear: { type: 'http-registry', url: 'https://evil.example/r.jsonc', auth: { type: 'bearer', env_var: 'SECRET2' } },
          bas: { type: 'http', url: 'https://evil.example/S.md', skill_name: 's', auth: { type: 'basic', username_env_var: 'U', password_env_var: 'P' } },
          fine: gh('fine', { auth: { type: 'gh_cli' } }),
        }),
      },
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(reads).toEqual([]);
    expect(r.registries.map((x) => x.name)).toEqual(['fine']);
    const untrusted = r.problems.filter((p) => p.code === 'auth/untrusted-env-auth');
    expect(untrusted.map((p) => [p.registry, p.via])).toEqual([['tok', ['A', 'tok']], ['bear', ['A', 'bear']], ['bas', ['A', 'bas']]]);
    expect(untrusted[0].message).toContain('github_token');
    expect(r.problems).toHaveLength(3);
    expect(web.calls).toEqual([]);
    expect(github.calls.every((c) => c.includes('/o/a/'))).toBe(true);
  });

  it('cache in included file is ignored; policy only set for depth-1 includes from local config', async () => {
    const { config, ctx, github } = await setup({
      local: { A: ghInclude('a', { policy: true }), C: ghInclude('c') },
      repos: {
        'o/a': repoWith({ B: ghInclude('b', { policy: true }) }, { cache: { enabled: false, ttl_seconds: 0 } }),
        'o/b': repoWith({ x: gh('x') }, { cache: { enabled: false } }),
        'o/c': repoWith({ y: gh('y') }),
      },
    });
    const r1 = await resolve(config, { force: false }, ctx);
    expect(r1.problems).toEqual([]);
    expect(r1.includes.map((i) => [i.name, i.policy])).toEqual([['A', true], ['B', false], ['C', false]]);
    // The local cache settings (TTL 3600) apply to every include: a second run within the TTL makes no requests.
    const before = github.calls.length;
    const r2 = await resolve(config, { force: false }, ctx);
    expect(github.calls.length).toBe(before);
    expect(r2.registries.map((x) => x.name)).toEqual(['x', 'y']);
    // force re-checks.
    await resolve(config, { force: true }, ctx);
    expect(github.calls.length).toBeGreaterThan(before);
  });

  it('uses TTL 0 when the local cache or the include entry disables caching', async () => {
    const { config, ctx, github } = await setup({
      local: { A: ghInclude('a', { cache_enabled: false }), C: ghInclude('c') },
      repos: { 'o/a': repoWith({ x: gh('x') }), 'o/c': repoWith({ y: gh('y') }) },
    });
    await resolve(config, { force: false }, ctx);
    github.calls.length = 0;
    await resolve(config, { force: false }, ctx);
    expect(github.calls).toEqual(['/repos/o/a/commits/main']);

    config.cache.enabled = false;
    github.calls.length = 0;
    await resolve(config, { force: false }, ctx);
    expect(github.calls).toEqual(['/repos/o/a/commits/main', '/repos/o/c/commits/main']);
  });

  it('inaccessible registry is reported by name and others still load', async () => {
    const { config, ctx } = await setup({
      local: { before: gh('b'), priv: ghInclude('private', { auth: { type: 'gh_cli' } }), web: { type: 'http-registry', url: 'https://x.example/r.jsonc' }, after: gh('a') },
      repos: { 'o/private': { ...repoWith({ hidden: gh('h') }), token: 'secret' } },
      routes: { 'https://x.example/r.jsonc': { body: file({ w: { type: 'http', url: 'https://x.example/W.md', skill_name: 'w' } }) } },
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.registries.map((x) => [x.name, x.via])).toEqual([['before', ['before']], ['w', ['web', 'w']], ['after', ['after']]]);
    const noAccess = r.problems.find((p) => p.code === 'source/no-access');
    expect(noAccess).toMatchObject({ level: 'error', registry: 'priv', via: ['priv'], file: config.path });
    expect(noAccess?.message).toContain('o/private');
    expect(noAccess?.message).toContain('gh auth login');
    expect(r.includes.map((i) => i.name)).toEqual(['web']);
    expect(r.includes[0].sha).toBeUndefined();
  });

  it('forwards problems from an included file with registry, via and file', async () => {
    const { config, ctx } = await setup({
      local: { web: { type: 'http-registry', url: 'https://x.example/r.jsonc' } },
      routes: { 'https://x.example/r.jsonc': { body: '{ "registries": { "bad": { "type": "nope" }, "ok": { "type": "http", "url": "https://x.example/O.md", "skill_name": "o" } } }' } },
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.registries.map((x) => x.name)).toEqual(['ok']);
    expect(r.problems).toEqual([expect.objectContaining({
      code: 'config/invalid-entry', registry: 'bad', via: ['web', 'bad'], file: 'https://x.example/r.jsonc',
    })]);
  });

  it('marks the resolution stale when an include fell back to a cached copy', async () => {
    const { config, ctx, github } = await setup({
      local: { A: ghInclude('a') }, repos: { 'o/a': repoWith({ x: gh('x') }) },
    });
    await resolve(config, { force: false }, ctx);
    github.offline(true);
    const r = await resolve(config, { force: true }, ctx);
    expect(r.stale).toBe(true);
    expect(r.includes[0]).toMatchObject({ name: 'A', stale: true, sha: SHA });
    expect(r.registries.map((x) => x.name)).toEqual(['x']);
    expect(r.problems).toEqual([expect.objectContaining({ level: 'warning', code: 'source/stale', registry: 'A', via: ['A'], file: config.path })]);
  });

  it('passes config problems through', async () => {
    const { config, ctx } = await setup({ local: { z: gh('z') } });
    config.problems.push({ level: 'error', code: 'config/invalid-entry', message: 'bad', file: config.path });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.problems).toEqual([{ level: 'error', code: 'config/invalid-entry', message: 'bad', file: config.path }]);
  });

  it('a skills-mcp-only config (github + http) resolves to the same entries, in order, with via = [name]', async () => {
    const { config, ctx, github, web } = await setup({
      local: {
        b: gh('b', { auth: { type: 'github_token', env_var: 'GH_TOK' } }),
        a: { type: 'http', url: 'https://x.example/A.md', skill_name: 'a', auth: { type: 'bearer', env_var: 'TOK' } },
        c: gh('c', { ref: 'v1.0', cache_enabled: false }),
      },
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.registries).toEqual(config.registries.map(([name, entry]) => ({ name, entry, via: [name], trusted: true })));
    expect(r).toMatchObject({ includes: [], overrides: [], problems: [], stale: false });
    expect(github.calls).toEqual([]);
    expect(web.calls).toEqual([]);
  });

  it('loop identity ignores owner/repo case and URL spelling', async () => {
    const { config, ctx, web } = await setup({
      local: { A: ghInclude('a'), W: { type: 'http-registry', url: 'https://x.example/r.jsonc' } },
      repos: { 'o/a': repoWith({ upper: { type: 'github-registry', owner: 'O', repo: 'A', ref: 'main' }, fromA: gh('fa') }) },
      routes: { 'https://x.example/r.jsonc': { body: file({ again: { type: 'http-registry', url: 'HTTPS://X.EXAMPLE:443/./r.jsonc' }, w: gh('w') }) } },
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.registries.map((x) => x.name)).toEqual(['fromA', 'w']);
    expect(r.problems.map((p) => [p.code, p.registry, p.via])).toEqual([
      ['resolve/include-loop', 'upper', ['A', 'upper']],
      ['resolve/include-loop', 'again', ['W', 'again']],
    ]);
    expect(web.calls).toHaveLength(1);
  });

  it('fetches a repeated include target once per resolve, even with force', async () => {
    const { config, ctx, github } = await setup({
      local: { H: ghInclude('hub') },
      repos: {
        'o/hub': repoWith({ T1: ghInclude('t'), T2: ghInclude('t'), T3: ghInclude('t') }),
        'o/t': repoWith({ x: gh('x') }),
      },
    });
    const r = await resolve(config, { force: true }, ctx);
    expect(github.calls.filter((c) => c.startsWith('/repos/o/t/'))).toEqual(['/repos/o/t/commits/main', `/repos/o/t/contents/registries.jsonc?ref=${SHA}`]);
    // Still walked three times for via and override bookkeeping.
    expect(r.includes.map((i) => i.via)).toEqual([['H'], ['H', 'T1'], ['H', 'T2'], ['H', 'T3']]);
    expect(r.registries).toEqual([expect.objectContaining({ name: 'x', via: ['H', 'T3', 'x'] })]);
    expect(r.overrides.map((o) => [o.replaced.via, o.by.via])).toEqual([
      [['H', 'T1', 'x'], ['H', 'T2', 'x']],
      [['H', 'T2', 'x'], ['H', 'T3', 'x']],
    ]);
    expect(r.problems).toEqual([]);
  });

  it('a nested fetch error carries the containing file', async () => {
    const { config, ctx } = await setup({
      local: { A: ghInclude('a') },
      repos: { 'o/a': repoWith({ gone: ghInclude('missing'), ok: gh('ok') }) },
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.registries.map((x) => x.name)).toEqual(['ok']);
    expect(r.problems).toEqual([expect.objectContaining({
      code: 'source/no-access', registry: 'gone', via: ['A', 'gone'], file: 'github:o/a@main:registries.jsonc',
    })]);
  });

  it('an unexpected throw while fetching an include becomes resolve/include-failed and resolution continues', async () => {
    const { config, ctx } = await setup({
      local: { boom: { type: 'http-registry', url: 'https://boom.example/r.jsonc' }, after: gh('after') },
      wrap: (http) => ({
        get: (url, h, opts) => (url.startsWith('https://boom.example/') ? Promise.reject(new Error('kaboom')) : http.get(url, h, opts)),
      }),
    });
    const r = await resolve(config, { force: false }, ctx);
    expect(r.registries.map((x) => x.name)).toEqual(['after']);
    expect(r.includes).toEqual([]);
    expect(r.problems).toEqual([expect.objectContaining({
      level: 'error', code: 'resolve/include-failed', registry: 'boom', via: ['boom'], file: config.path,
    })]);
    expect(r.problems[0].message).toContain('kaboom');
  });
});
