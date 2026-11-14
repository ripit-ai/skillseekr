import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchHttpText, materializeHttpSkill } from '../../src/sources/http.js';
import type { FetchOpts } from '../../src/sources/github.js';
import type { Ctx } from '../../src/context.js';
import type { Auth, CacheSettings } from '../../src/types.js';
import { fakeHttp, type FakeRoute } from '../helpers/fakeHttp.js';
import { tmpDir } from '../helpers/tmp.js';

const URL1 = 'https://example.test/skills/foo/SKILL.md';
const BODY = '---\nname: foo\n---\nbody\n';
const TTL = 3600;

async function setup(routes: Record<string, FakeRoute>, env: Record<string, string> = {}) {
  const dir = await tmpDir();
  const fake = fakeHttp(routes);
  let now = 1_700_000_000_000;
  const ctx: Ctx = {
    env, home: join(dir, 'home'), cwd: dir, http: fake.http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => now, githubApi: 'https://api.github.com',
  };
  const cache: CacheSettings = { enabled: true, ttlSeconds: TTL, dir: join(dir, 'cache') };
  return { dir, fake, ctx, cache, advance: (s: number) => { now += s * 1000; } };
}
const opts = (o: Partial<FetchOpts> = {}): FetchOpts => ({ force: false, trusted: true, ttlSeconds: TTL, ...o });
const entry = (auth: Auth = { type: 'none' }, url = URL1) => ({ url, skill_name: 'foo', auth });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

describe('materializeHttpSkill', () => {
  it('stores SKILL.md at <cache>/http/<sha256(url)>/<skill_name>/', async () => {
    const t = await setup({ [URL1]: { body: BODY, etag: '"a"' } });
    const r = await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    if ('error' in r) throw new Error(r.error.message);
    expect(r.root).toBe(join(t.cache.dir, 'http', hash(URL1), 'foo'));
    expect(await readFile(join(r.root, 'SKILL.md'), 'utf8')).toBe(BODY);
    expect(r.stale).toBe(false);
    expect((await readdir(r.root))).toEqual(['SKILL.md']);
  });

  it('makes no request within the TTL', async () => {
    const t = await setup({ [URL1]: { body: BODY } });
    await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    t.advance(TTL - 1);
    const r = await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    expect('error' in r).toBe(false);
    expect(t.fake.calls).toHaveLength(1);
  });

  it('sends If-None-Match after the TTL and keeps the cached content on 304', async () => {
    const t = await setup({ [URL1]: { body: BODY, etag: '"a"' } });
    await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    t.advance(TTL + 1);
    const r = await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    if ('error' in r) throw new Error(r.error.message);
    expect(t.fake.calls).toHaveLength(2);
    expect(t.fake.calls[1].headers['If-None-Match']).toBe('"a"');
    expect(r.stale).toBe(false);
    expect(await readFile(join(r.root, 'SKILL.md'), 'utf8')).toBe(BODY);
    // the 304 renewed the TTL
    t.advance(TTL - 1);
    await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    expect(t.fake.calls).toHaveLength(2);
  });

  it('force re-checks inside the TTL', async () => {
    const t = await setup({ [URL1]: { body: BODY, etag: '"a"' } });
    await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    await materializeHttpSkill(entry(), opts({ force: true }), t.cache, t.ctx);
    expect(t.fake.calls).toHaveLength(2);
  });

  it('ttl 0 re-checks every time', async () => {
    const t = await setup({ [URL1]: { body: BODY } });
    await materializeHttpSkill(entry(), opts({ ttlSeconds: 0 }), t.cache, t.ctx);
    await materializeHttpSkill(entry(), opts({ ttlSeconds: 0 }), t.cache, t.ctx);
    expect(t.fake.calls).toHaveLength(2);
  });

  it('serves stale from the cache when offline, embedding the error', async () => {
    const t = await setup({ [URL1]: { body: BODY } });
    await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    t.advance(TTL + 1);
    t.fake.offline(true);
    const r = await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    if ('error' in r) throw new Error(r.error.message);
    expect(r.stale).toBe(true);
    expect(r.problems.find((p) => p.code === 'source/stale')?.message).toContain('offline');
    expect(await readFile(join(r.root, 'SKILL.md'), 'utf8')).toBe(BODY);
  });

  it('serves stale on 5xx, 404 and too-large when a cache exists', async () => {
    for (const next of [{ status: 503, body: 'x' }, { status: 404, body: 'x' }, { body: 'x'.repeat(1024 * 1024 + 1) }]) {
      const routes: Record<string, FakeRoute> = { [URL1]: { body: BODY } };
      const t = await setup(routes);
      await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
      routes[URL1] = next;
      t.advance(TTL + 1);
      const r = await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
      if ('error' in r) throw new Error(r.error.message);
      expect(r.stale).toBe(true);
      expect(r.problems.some((p) => p.code === 'source/stale')).toBe(true);
      expect(await readFile(join(r.root, 'SKILL.md'), 'utf8')).toBe(BODY);
    }
  });

  it('offline without a cache is source/unreachable', async () => {
    const t = await setup({ [URL1]: { body: BODY } });
    t.fake.offline(true);
    const r = await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    expect('error' in r && r.error.code).toBe('source/unreachable');
  });

  it('a 5xx without a cache is source/unreachable', async () => {
    const t = await setup({ [URL1]: { status: 502, body: '' } });
    const r = await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    expect('error' in r && r.error.code).toBe('source/unreachable');
  });

  it('401, 403 and 404 without a cache are source/no-access naming the URL', async () => {
    for (const status of [401, 403, 404]) {
      const t = await setup({ [URL1]: { status, body: '' } });
      const r = await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
      expect('error' in r && r.error.code).toBe('source/no-access');
      expect('error' in r && r.error.message).toContain(URL1);
    }
  });

  it('a body over 1 MB without a cache is source/too-large', async () => {
    const t = await setup({ [URL1]: { body: 'x'.repeat(1024 * 1024 + 1) } });
    const r = await materializeHttpSkill(entry(), opts(), t.cache, t.ctx);
    expect('error' in r && r.error.code).toBe('source/too-large');
  });

  it('sends auth only when a request is made; a fresh hit reports no auth problems', async () => {
    const t = await setup({ [URL1]: { body: BODY, requireAuth: 'Bearer tok' } }, { TOK: 'tok' });
    const auth: Auth = { type: 'bearer', env_var: 'TOK' };
    const first = await materializeHttpSkill(entry(auth), opts(), t.cache, t.ctx);
    expect('error' in first).toBe(false);
    expect(t.fake.calls[0].headers.Authorization).toBe('Bearer tok');
    delete t.ctx.env.TOK;
    const hit = await materializeHttpSkill(entry(auth), opts(), t.cache, t.ctx);
    if ('error' in hit) throw new Error(hit.error.message);
    expect(hit.problems).toEqual([]);
    expect(t.fake.calls).toHaveLength(1);
  });

  it('untrusted env auth is reported and the env var is not read', async () => {
    const t = await setup({ [URL1]: { body: BODY } }, { TOK: 'tok' });
    const r = await materializeHttpSkill(entry({ type: 'bearer', env_var: 'TOK' }), opts({ trusted: false }), t.cache, t.ctx);
    if ('error' in r) throw new Error(r.error.message);
    expect(r.problems.map((p) => p.code)).toEqual(['auth/untrusted-env-auth']);
    expect(t.fake.calls[0].headers.Authorization).toBeUndefined();
  });

  it('names the unset env var on a no-cache 401 and leaves no temp file in the skill root', async () => {
    const t = await setup({ [URL1]: { body: BODY, requireAuth: 'Bearer tok' } });
    const auth: Auth = { type: 'bearer', env_var: 'BEARER_X' };
    const r = await materializeHttpSkill(entry(auth), opts(), t.cache, t.ctx);
    expect('error' in r && r.error.code).toBe('source/no-access');
    expect('error' in r && r.error.message).toContain('BEARER_X');
    expect('error' in r && r.error.message).toContain(URL1);
    t.ctx.env.BEARER_X = 'tok';
    const ok = await materializeHttpSkill(entry(auth), opts(), t.cache, t.ctx);
    if ('error' in ok) throw new Error(ok.error.message);
    expect(await readdir(ok.root)).toEqual(['SKILL.md']);
    expect((await readdir(join(t.cache.dir, 'http', hash(URL1)))).sort()).toEqual(['foo']);
  });

  it('rejects unsafe skill_name values with source/invalid and no I/O', async () => {
    for (const skill_name of ['', '.', '..', 'a/b', 'a\\b', 'a\0b', '../x']) {
      const t = await setup({ [URL1]: { body: BODY } });
      const r = await materializeHttpSkill({ url: URL1, skill_name, auth: { type: 'none' } }, opts(), t.cache, t.ctx);
      expect('error' in r && r.error.code).toBe('source/invalid');
      expect(t.fake.calls).toHaveLength(0);
      expect(existsSync(t.cache.dir)).toBe(false);
    }
  });
});

describe('fetchHttpText', () => {
  const URL2 = 'https://example.test/registries.jsonc';
  it('uses the same caching: TTL, ETag 304, stale fallback', async () => {
    const t = await setup({ [URL2]: { body: '{"registries":{}}', etag: '"r"' } });
    const a = await fetchHttpText({ url: URL2, auth: { type: 'none' } }, opts(), t.cache, t.ctx);
    expect(a).toEqual({ text: '{"registries":{}}', stale: false, problems: [] });
    await fetchHttpText({ url: URL2, auth: { type: 'none' } }, opts(), t.cache, t.ctx);
    expect(t.fake.calls).toHaveLength(1);
    t.advance(TTL + 1);
    const b = await fetchHttpText({ url: URL2, auth: { type: 'none' } }, opts(), t.cache, t.ctx);
    expect(t.fake.calls[1].headers['If-None-Match']).toBe('"r"');
    expect('error' in b ? b.error.message : b.text).toBe('{"registries":{}}');
    t.advance(TTL + 1);
    t.fake.offline(true);
    const c = await fetchHttpText({ url: URL2, auth: { type: 'none' } }, opts(), t.cache, t.ctx);
    if ('error' in c) throw new Error(c.error.message);
    expect(c.stale).toBe(true);
    expect(c.text).toBe('{"registries":{}}');
  });

  it('offline without a cache is source/unreachable; 404 is source/no-access', async () => {
    const t = await setup({});
    const r = await fetchHttpText({ url: URL2, auth: { type: 'none' } }, opts(), t.cache, t.ctx);
    expect('error' in r && r.error.code).toBe('source/no-access');
    t.fake.offline(true);
    const r2 = await fetchHttpText({ url: URL2, auth: { type: 'none' } }, opts(), t.cache, t.ctx);
    expect('error' in r2 && r2.error.code).toBe('source/unreachable');
  });
});
