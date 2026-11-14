import { describe, it, expect, beforeEach } from 'vitest';
import { authHeaders, resetGhTokenCache } from '../src/auth.js';
import type { Ctx, Exec } from '../src/context.js';

const okExec = (calls: { n: number }): Exec => async () => { calls.n++; return { code: 0, stdout: 'ghtok\n', stderr: '' }; };
const mk = (env: Record<string, string | undefined> = {}, exec?: Exec): Ctx => ({
  env, home: '/h', cwd: '/w', http: { get: async () => { throw new Error('unexpected http request'); } },
  exec: exec ?? (async () => ({ code: 0, stdout: '', stderr: '' })),
  now: () => 0, githubApi: 'https://api.github.com',
});
const gh = { url: 'https://api.github.com/repos/a/b', kind: 'github' as const };
const web = { url: 'https://example.com/x', kind: 'http' as const };
const trusted = { trusted: true };
const untrusted = { trusted: false };

beforeEach(() => resetGhTokenCache());

describe('authHeaders', () => {
  it('github_token reads the named env var and sends "Authorization: Bearer <value>"', async () => {
    const r = await authHeaders({ type: 'github_token', env_var: 'T' }, gh, trusted, mk({ T: 'abc' }));
    expect(r).toEqual({ headers: { Authorization: 'Bearer abc' } });
    const r2 = await authHeaders({ type: 'github_token', env_var: 'T' }, web, trusted, mk({ T: 'abc' }));
    expect(r2.headers).toEqual({ Authorization: 'Bearer abc' });
  });

  it('bearer sends Bearer and basic encodes user:pass as base64', async () => {
    const b = await authHeaders({ type: 'bearer', env_var: 'T' }, web, trusted, mk({ T: 'xyz' }));
    expect(b.headers).toEqual({ Authorization: 'Bearer xyz' });
    const r = await authHeaders({ type: 'basic', username_env_var: 'U', password_env_var: 'P' }, web, trusted, mk({ U: 'user', P: 'pass' }));
    expect(r.headers).toEqual({ Authorization: 'Basic ' + Buffer.from('user:pass').toString('base64') });
  });

  it('none returns {}', async () => {
    expect(await authHeaders({ type: 'none' }, web, trusted, mk())).toEqual({ headers: {} });
  });

  it('env-var auth in an untrusted (included) entry never reads the env var', async () => {
    const env = new Proxy({}, { get(_t, p) { throw new Error(`read ${String(p)}`); } }) as Record<string, string | undefined>;
    for (const auth of [
      { type: 'github_token', env_var: 'SECRET' },
      { type: 'bearer', env_var: 'SECRET' },
      { type: 'basic', username_env_var: 'SECRET', password_env_var: 'SECRET' },
    ] as const) {
      const r = await authHeaders(auth, gh, untrusted, mk(env));
      expect(r.headers).toEqual({});
      expect(r.problem?.code).toBe('auth/untrusted-env-auth');
    }
  });

  it('a missing env var gives auth/env-missing naming the variable', async () => {
    const r = await authHeaders({ type: 'bearer', env_var: 'NOPE_VAR' }, web, trusted, mk({}));
    expect(r.headers).toEqual({});
    expect(r.problem?.code).toBe('auth/env-missing');
    expect(r.problem?.message).toContain('NOPE_VAR');
    const b = await authHeaders({ type: 'basic', username_env_var: 'U', password_env_var: 'P' }, web, trusted, mk({ U: 'u' }));
    expect(b.problem?.code).toBe('auth/env-missing');
    expect(b.problem?.message).toContain('P');
    expect(b.problem?.message).not.toContain('"u"');
  });

  it('gh_cli runs "gh auth token" once per process and caches it', async () => {
    const calls = { n: 0 };
    const ctx = mk({}, okExec(calls));
    const a = await authHeaders({ type: 'gh_cli' }, gh, trusted, ctx);
    const b = await authHeaders({ type: 'gh_cli' }, gh, untrusted, ctx);
    expect(a.headers).toEqual({ Authorization: 'Bearer ghtok' });
    expect(b.headers).toEqual({ Authorization: 'Bearer ghtok' });
    expect(calls.n).toBe(1);
  });

  it('gh_cli falls back to no auth with a warning problem when gh is missing or exits non-zero', async () => {
    const calls = { n: 0 };
    const exec: Exec = async () => { calls.n++; return { code: 127, stdout: '', stderr: 'not found' }; };
    const ctx = mk({}, exec);
    const a = await authHeaders({ type: 'gh_cli' }, gh, trusted, ctx);
    expect(a.headers).toEqual({});
    expect(a.problem?.code).toBe('auth/gh-unavailable');
    expect(a.problem?.level).toBe('warning');
    const b = await authHeaders({ type: 'gh_cli' }, gh, trusted, ctx);
    expect(b.problem?.code).toBe('auth/gh-unavailable');
    expect(calls.n).toBe(1);
  });

  it('gh_cli does not keep a failure: after 30s it asks gh again and picks up a new login', async () => {
    let now = 0;
    let loggedIn = false;
    const calls = { n: 0 };
    const exec: Exec = async () => {
      calls.n++;
      return loggedIn ? { code: 0, stdout: 'fresh\n', stderr: '' } : { code: 1, stdout: '', stderr: 'not logged in' };
    };
    const ctx = { ...mk({}, exec), now: () => now };
    expect((await authHeaders({ type: 'gh_cli' }, gh, trusted, ctx)).problem?.code).toBe('auth/gh-unavailable');
    loggedIn = true; // the user runs "gh auth login"
    now = 29_999;
    expect((await authHeaders({ type: 'gh_cli' }, gh, trusted, ctx)).headers).toEqual({});
    expect(calls.n).toBe(1);
    now = 30_000;
    expect((await authHeaders({ type: 'gh_cli' }, gh, trusted, ctx)).headers).toEqual({ Authorization: 'Bearer fresh' });
    now = 10_000_000; // a success stays cached
    expect((await authHeaders({ type: 'gh_cli' }, gh, trusted, ctx)).headers).toEqual({ Authorization: 'Bearer fresh' });
    expect(calls.n).toBe(2);
  });

  it('gh_cli treats empty output as unavailable', async () => {
    const r = await authHeaders({ type: 'gh_cli' }, gh, trusted, mk({}, async () => ({ code: 0, stdout: '\n', stderr: '' })));
    expect(r.problem?.code).toBe('auth/gh-unavailable');
  });

  it('gh_cli never attaches the token to a host other than the GitHub API host', async () => {
    const calls = { n: 0 };
    const r = await authHeaders({ type: 'gh_cli' }, { url: 'https://evil.example/x', kind: 'github' }, trusted, mk({}, okExec(calls)));
    expect(r.headers).toEqual({});
    expect(calls.n).toBe(0);
  });

  it.each([
    'http://api.github.com/x',
    'https://api.github.com:8443/x',
    'https://api.github.com@evil.example/x',
    'not a url',
  ])('gh_cli sends no token to a non-matching origin: %s', async (url) => {
    const calls = { n: 0 };
    const r = await authHeaders({ type: 'gh_cli' }, { url, kind: 'github' }, trusted, mk({}, okExec(calls)));
    expect(r.headers).toEqual({});
    expect(calls.n).toBe(0);
  });

  it('gh_cli works against an http githubApi override with the same origin', async () => {
    const ctx = { ...mk({}, okExec({ n: 0 })), githubApi: 'http://127.0.0.1:9999' };
    const r = await authHeaders({ type: 'gh_cli' }, { url: 'http://127.0.0.1:9999/x', kind: 'github' }, trusted, ctx);
    expect(r.headers).toEqual({ Authorization: 'Bearer ghtok' });
  });

  it('gh_cli with an exec that rejects gives the auth/gh-unavailable warning', async () => {
    const exec: Exec = async () => { throw new Error('spawn gh ENOENT'); };
    const r = await authHeaders({ type: 'gh_cli' }, gh, trusted, mk({}, exec));
    expect(r.headers).toEqual({});
    expect(r.problem?.code).toBe('auth/gh-unavailable');
  });

  it('an unknown auth type fails loudly', async () => {
    await expect(authHeaders({ type: 'weird' } as never, gh, trusted, mk({}))).rejects.toThrow(/unknown auth type/);
  });
});
