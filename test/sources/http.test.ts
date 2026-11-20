import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fetchHttpBody, invalidSkillName } from '../../src/sources/http.js';
import type { Ctx } from '../../src/context.js';
import type { Auth } from '../../src/types.js';
import { fakeHttp, type FakeRoute } from '../helpers/fakeHttp.js';
import { tmpDir } from '../helpers/tmp.js';

const URL1 = 'https://example.test/skills/foo/SKILL.md';
const BODY = '---\nname: foo\n---\nbody\n';

async function setup(routes: Record<string, FakeRoute>, env: Record<string, string> = {}) {
  const dir = await tmpDir();
  const fake = fakeHttp(routes);
  const ctx: Ctx = {
    env, home: join(dir, 'home'), cwd: dir, http: fake.http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => 1_700_000_000_000, githubApi: 'https://api.github.com',
  };
  return { dir, fake, ctx };
}
const get = (t: Awaited<ReturnType<typeof setup>>, auth: Auth = { type: 'none' }, trusted = true) =>
  fetchHttpBody({ url: URL1, auth }, { trusted }, t.ctx);

describe('fetchHttpBody: errors and auth', () => {
  it('a 5xx is source/unreachable', async () => {
    const t = await setup({ [URL1]: { status: 502, body: '' } });
    const r = await get(t);
    expect('error' in r && r.error.code).toBe('source/unreachable');
  });

  it('401, 403 and 404 are source/no-access naming the URL', async () => {
    for (const status of [401, 403, 404]) {
      const t = await setup({ [URL1]: { status, body: '' } });
      const r = await get(t);
      expect('error' in r && r.error.code).toBe('source/no-access');
      expect('error' in r && r.error.message).toContain(URL1);
    }
  });

  it('a body over 1 MB is source/too-large by default', async () => {
    const t = await setup({ [URL1]: { body: 'x'.repeat(1024 * 1024 + 1) } });
    const r = await get(t);
    expect('error' in r && r.error.code).toBe('source/too-large');
  });

  it('sends the configured bearer token', async () => {
    const t = await setup({ [URL1]: { body: BODY, requireAuth: 'Bearer tok' } }, { TOK: 'tok' });
    const r = await get(t, { type: 'bearer', env_var: 'TOK' });
    expect(r).toMatchObject({ notModified: false, problems: [] });
    expect(t.fake.calls[0]!.headers.Authorization).toBe('Bearer tok');
  });

  it('untrusted env auth is reported and the env var is not read', async () => {
    const t = await setup({ [URL1]: { body: BODY } }, { TOK: 'tok' });
    const r = await get(t, { type: 'bearer', env_var: 'TOK' }, false);
    if ('error' in r) throw new Error(r.error.message);
    expect(r.problems.map((p) => p.code)).toEqual(['auth/untrusted-env-auth']);
    expect(t.fake.calls[0]!.headers.Authorization).toBeUndefined();
  });

  it('names the unset env var on a 401', async () => {
    const t = await setup({ [URL1]: { body: BODY, requireAuth: 'Bearer tok' } });
    const r = await get(t, { type: 'bearer', env_var: 'BEARER_X' });
    expect('error' in r && r.error.code).toBe('source/no-access');
    expect('error' in r && r.error.message).toContain('BEARER_X');
    expect('error' in r && r.error.message).toContain(URL1);
  });
});

describe('fetchHttpBody', () => {
  it('returns the body and etag, and sends no If-None-Match without one', async () => {
    const t = await setup({ [URL1]: { body: BODY, etag: '"a"' } });
    const r = await fetchHttpBody({ url: URL1, auth: { type: 'none' } }, { trusted: true }, t.ctx);
    expect(r).toMatchObject({ notModified: false, etag: '"a"' });
    expect('body' in r && r.body.toString()).toBe(BODY);
    expect(t.fake.calls[0].headers['If-None-Match']).toBeUndefined();
  });

  it('a matching etag gives notModified', async () => {
    const t = await setup({ [URL1]: { body: BODY, etag: '"a"' } });
    const r = await fetchHttpBody({ url: URL1, auth: { type: 'none' } }, { trusted: true, etag: '"a"' }, t.ctx);
    expect(r).toMatchObject({ notModified: true });
  });

  it('a changed body gives the new etag', async () => {
    const t = await setup({ [URL1]: { body: 'new', etag: '"b"' } });
    const r = await fetchHttpBody({ url: URL1, auth: { type: 'none' } }, { trusted: true, etag: '"a"' }, t.ctx);
    expect(r).toMatchObject({ notModified: false, etag: '"b"' });
    expect('body' in r && r.body.toString()).toBe('new');
  });

  it('an oversize body is source/too-large, honouring maxBytes', async () => {
    const t = await setup({ [URL1]: { body: 'x'.repeat(100) } });
    const r = await fetchHttpBody({ url: URL1, auth: { type: 'none' } }, { trusted: true, maxBytes: 10 }, t.ctx);
    expect('error' in r && r.error.code).toBe('source/too-large');
    const ok = await fetchHttpBody({ url: URL1, auth: { type: 'none' } }, { trusted: true, maxBytes: 100 }, t.ctx);
    expect(ok).toMatchObject({ notModified: false });
  });

  it('never falls back to a copy: offline and 404 are errors, and nothing is cached', async () => {
    const t = await setup({ [URL1]: { body: BODY } });
    t.fake.offline(true);
    const off = await fetchHttpBody({ url: URL1, auth: { type: 'none' } }, { trusted: true }, t.ctx);
    expect('error' in off && off.error.code).toBe('source/unreachable');
    const miss = await fetchHttpBody({ url: 'https://example.test/none', auth: { type: 'none' } }, { trusted: true }, { ...t.ctx, http: fakeHttp({}).http });
    expect('error' in miss && miss.error.code).toBe('source/no-access');
    expect(existsSync(join(t.dir, 'cache'))).toBe(false);
  });

  it('names the auth cause on an error', async () => {
    const t = await setup({ [URL1]: { body: BODY, requireAuth: 'Bearer s' } });
    const r = await fetchHttpBody({ url: URL1, auth: { type: 'bearer', env_var: 'NOPE' } }, { trusted: true }, t.ctx);
    expect('error' in r && r.error.code).toBe('source/no-access');
    expect('error' in r && r.error.message).toContain('(auth:');
  });
});

describe('invalidSkillName', () => {
  it('rejects names that cannot be a folder', () => {
    for (const n of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', '../x']) expect(invalidSkillName(n)?.code).toBe('source/invalid');
    expect(invalidSkillName('foo')).toBeUndefined();
  });
});
