import { describe, it, expect } from 'vitest';
import { readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEngine } from '../src/engine.js';
import { discoverSkills } from '../src/catalog/discover.js';
import type { Ctx } from '../src/context.js';
import type { Http } from '../src/net/http.js';
import { fakeGithub, type FakeSpec } from './helpers/fakeGithub.js';
import { fakeHttp, type FakeRoute } from './helpers/fakeHttp.js';
import { tmpDir } from './helpers/tmp.js';

const API = 'https://api.github.com';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\nbody ${name}\n`;
const gh = (repo: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'github', owner: 'o', repo, skills_dir: 'skills', ref: 'main', ...extra });
const incl = (repo: string) => ({ type: 'github-registry', owner: 'o', repo, ref: 'main' });

async function setup(o: { repos?: FakeSpec; routes?: Record<string, FakeRoute> }) {
  const dir = await tmpDir();
  const github = fakeGithub(o.repos ?? {});
  const web = fakeHttp(o.routes ?? {});
  const http: Http = { get: (url, h, opts) => (url.startsWith(API) ? github.http : web.http).get(url, h, opts) };
  let now = 1_700_000_000_000;
  const path = join(dir, 'config.jsonc');
  const ctx: Ctx = {
    env: { SKILLSEEKR_CONFIG: path }, home: join(dir, 'home'), cwd: dir, http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => now, githubApi: API,
  };
  const write = (registries: Record<string, unknown>, cache: Record<string, unknown> = {}) =>
    writeFile(path, JSON.stringify({ cache: { dir: join(dir, 'cache'), ...cache }, registries }));
  return { ctx, github, web, path, dir, write, advance: (ms: number) => { now += ms; } };
}

const repoWith = (files: Record<string, string>, sha = SHA1) => ({ refs: { main: sha }, commits: { [sha]: files } });

describe('engine', () => {
  it('end-to-end: config with an include → catalog contains skills from both repos with correct via', async () => {
    const s = await setup({
      repos: {
        'o/inc': repoWith({ 'registries.jsonc': JSON.stringify({ registries: { remote: gh('remote') } }) }),
        'o/remote': repoWith({ 'skills/a/SKILL.md': skill('a') }, SHA2),
        'o/local': repoWith({ 'skills/cat/b/SKILL.md': skill('b') }),
      },
    });
    await s.write({ inc: incl('inc'), local: gh('local') });
    const cat = await createEngine(s.ctx).catalog();
    expect(cat.problems).toEqual([]);
    expect(cat.skills.map((x) => [x.id, x.registry, x.via, x.sha])).toEqual([
      ['a', 'remote', ['inc', 'remote'], SHA2],
      ['cat/b', 'local', ['local'], SHA1],
    ]);
  });

  it('discovery results are cached per (owner, repo, sha, skills_dir) and not recomputed', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    let calls = 0;
    const engine = createEngine(s.ctx, { discover: (...a) => { calls++; return discoverSkills(...a); } });
    expect((await engine.catalog({ force: true })).skills).toHaveLength(1);
    const again = await engine.catalog({ force: true });
    expect(again.skills.map((x) => x.id)).toEqual(['a']);
    expect(calls).toBe(1);
    const idx = await readdir(join(s.dir, 'cache', 'index', 'o', 'r', SHA1));
    expect(idx).toHaveLength(1);
    expect(idx[0]).toMatch(/^[0-9a-f]{64}\.json$/);
  });

  it('a corrupt cached index is recomputed without throwing', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    let calls = 0;
    const engine = createEngine(s.ctx, { discover: (...a) => { calls++; return discoverSkills(...a); } });
    await engine.catalog();
    const dir = join(s.dir, 'cache', 'index', 'o', 'r', SHA1);
    const [f] = await readdir(dir);
    await writeFile(join(dir, f!), '{not json');
    const cat = await engine.catalog({ force: true });
    expect(cat.skills).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('missing config → empty catalog with problem config/missing naming the path, no throw', async () => {
    const s = await setup({});
    const engine = createEngine(s.ctx);
    const cat = await engine.catalog();
    expect(cat.skills).toEqual([]);
    expect(cat.problems).toHaveLength(1);
    expect(cat.problems[0]).toMatchObject({ code: 'config/missing' });
    expect(cat.problems[0]!.message).toContain(s.path);
    const r = await engine.registries();
    expect(r.registries).toEqual([]);
    expect(r.problems[0]!.code).toBe('config/missing');
  });

  it('broken config → empty catalog with config/parse-error problem, no throw', async () => {
    const s = await setup({});
    await writeFile(s.path, '{ "registries": ');
    const cat = await createEngine(s.ctx).catalog();
    expect(cat.skills).toEqual([]);
    expect(cat.problems.some((p) => p.code === 'config/parse-error')).toBe(true);
  });

  it('offline after a successful load → catalog.stale === true and skills still present', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    const engine = createEngine(s.ctx);
    expect((await engine.catalog()).stale).toBe(false);
    s.github.offline(true);
    const cat = await engine.catalog({ force: true });
    expect(cat.stale).toBe(true);
    expect(cat.skills.map((x) => x.id)).toEqual(['a']);
    expect(cat.problems.some((p) => p.code === 'source/stale' && p.registry === 'r' && p.via?.join() === 'r')).toBe(true);
    expect((await engine.registries()).registries[0]!.stale).toBe(true);
  });

  it('an unreachable registry becomes a problem with registry and via; others still load', async () => {
    const s = await setup({ repos: { 'o/ok': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ bad: gh('nope'), ok: gh('ok') });
    const cat = await createEngine(s.ctx).catalog();
    expect(cat.skills.map((x) => x.id)).toEqual(['a']);
    expect(cat.problems.find((x) => x.registry === 'bad')).toMatchObject({ level: 'error', via: ['bad'] });
  });

  it('http registry yields one skill with id = skill_name', async () => {
    const url = 'https://example.test/s/SKILL.md';
    const s = await setup({ routes: { [url]: { body: skill('web'), etag: 'e1' } } });
    await s.write({ w: { type: 'http', url, skill_name: 'web' } });
    const engine = createEngine(s.ctx);
    const cat = await engine.catalog();
    expect(cat.problems).toEqual([]);
    expect(cat.skills.map((x) => [x.id, x.registry])).toEqual([['web', 'w']]);
    expect((await engine.registries()).registries[0]).toMatchObject({ type: 'http', skillCount: 1, cacheAgeSeconds: 0 });
  });

  it('memoizes concurrent and repeated calls; reloads on force or elapsed TTL; ttl 0 always reloads', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') }, { ttl_seconds: 60 });
    const engine = createEngine(s.ctx);
    const [c1, c2] = await Promise.all([engine.catalog(), engine.catalog()]);
    expect(c2).toBe(c1);
    expect(await engine.catalog()).toBe(c1);
    s.advance(59_000);
    expect(await engine.catalog()).toBe(c1);
    s.advance(2_000);
    const c3 = await engine.catalog();
    expect(c3).not.toBe(c1);
    expect(await engine.catalog()).toBe(c3);
    expect(await engine.catalog({ force: true })).not.toBe(c3);

    await s.write({ r: gh('r') }, { ttl_seconds: 0 });
    const e0 = createEngine(s.ctx);
    const first = await e0.catalog();
    expect(await e0.catalog()).not.toBe(first);
  });

  it('SHA-pinned registries are memoized indefinitely', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r', { ref: SHA1 }) }, { ttl_seconds: 1 });
    const engine = createEngine(s.ctx);
    const c = await engine.catalog();
    s.advance(10_000_000);
    expect(await engine.catalog()).toBe(c);
  });

  it('registries() lists each source with via, sha, stale, skillCount, and overrides', async () => {
    const s = await setup({
      repos: {
        'o/inc': repoWith({ 'registries.jsonc': JSON.stringify({ registries: { dup: gh('remote'), solo: gh('solo') } }) }),
        'o/remote': repoWith({ 'skills/x/SKILL.md': skill('x'), 'skills/y/SKILL.md': skill('y') }, SHA2),
        'o/solo': repoWith({ 'skills/x/SKILL.md': skill('x2') }),
        'o/local': repoWith({ 'skills/z/SKILL.md': skill('z') }),
      },
    });
    await s.write({ dup: gh('local', { description: 'mine', instructions: 'use me' }), inc: incl('inc') });
    const engine = createEngine(s.ctx);
    const r = await engine.registries();
    expect(r.problems).toEqual([]);
    expect(r.includes.map((i) => i.name)).toEqual(['inc']);
    expect(r.registries.map((v) => [v.name, v.via, v.sha, v.stale, v.skillCount])).toEqual([
      ['dup', ['inc', 'dup'], SHA2, false, 2],
      ['solo', ['inc', 'solo'], SHA1, false, 1],
    ]);
    expect(r.registries[0]).toMatchObject({ type: 'github', ref: 'main', cacheAgeSeconds: 0 });
    // registry overrides first, then skill overrides (the same list the catalog and doctor use)
    expect(r.overrides.map((o) => [o.kind, o.key])).toEqual([['registry', 'dup'], ['skill', 'x']]);
    expect(r.overrides[1]).toEqual({
      kind: 'skill', key: 'x', replaced: { registry: 'dup', via: ['inc', 'dup'] }, by: { registry: 'solo', via: ['inc', 'solo'] },
    });
    expect(r.overrides).toEqual((await engine.catalog()).overrides);
    // the winning registry lists what it replaced; the replaced one is dropped by resolve
    expect(r.registries[0]!.overrode).toEqual([{ registry: 'dup', via: ['dup'] }]);
    expect(r.registries[1]).not.toHaveProperty('overrode');
    expect(r.registries[0]).not.toHaveProperty('overriddenBy');
  });

  it('an unexpected throw during load becomes engine/load-failed with an empty catalog, never a rejection', async () => {
    const s = await setup({});
    const bad = { ...s.ctx, env: new Proxy({}, { get() { throw new Error('boom'); } }) as Ctx['env'] };
    const engine = createEngine(bad);
    const cat = await engine.catalog();
    expect(cat.skills).toEqual([]);
    expect(cat.problems).toHaveLength(1);
    expect(cat.problems[0]).toMatchObject({ level: 'error', code: 'engine/load-failed' });
    expect(cat.problems[0]!.message).toContain('boom');
    const r = await engine.registries();
    expect(r.registries).toEqual([]);
    expect(r.problems[0]!.code).toBe('engine/load-failed');
  });

  it('a config file edit reloads the memo even before the TTL', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }), 'o/q': repoWith({ 'skills/b/SKILL.md': skill('b') }) } });
    await s.write({ r: gh('r', { ref: SHA1 }) });
    const engine = createEngine(s.ctx);
    const c1 = await engine.catalog();
    expect(await engine.catalog()).toBe(c1);
    await s.write({ r: gh('r', { ref: SHA1 }), q: gh('q', { ref: SHA1 }) });
    const c2 = await engine.catalog();
    expect(c2).not.toBe(c1);
    expect(c2.skills.map((x) => x.id)).toEqual(['a', 'b']);
    expect((await engine.registries()).registries.map((v) => v.name)).toEqual(['r', 'q']);
    expect(await engine.catalog()).toBe(c2);
    // same size, new mtime: still a change
    await utimes(s.path, new Date(2001, 0, 1), new Date(2001, 0, 1));
    expect(await engine.catalog()).not.toBe(c2);
  });

  it('a sync (forced load) in another process reloads this engine; the syncing engine keeps its own result', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r', { ref: SHA1 }) });
    const server = createEngine(s.ctx);
    const cli = createEngine(s.ctx);
    const c1 = await server.catalog();
    expect(await server.catalog()).toBe(c1);
    const synced = await cli.catalog({ force: true });
    expect(await cli.catalog()).toBe(synced);
    const c2 = await server.catalog();
    expect(c2).not.toBe(c1);
    expect(await server.catalog()).toBe(c2);
  });

  it('a load with an error-level problem is retried after 60s even when the TTL is longer', async () => {
    const s = await setup({ repos: { 'o/ok': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ bad: gh('nope', { ref: SHA2 }), ok: gh('ok', { ref: SHA1 }) }, { ttl_seconds: 3600 });
    const engine = createEngine(s.ctx);
    const c1 = await engine.catalog();
    expect(c1.problems.some((p) => p.level === 'error' && p.registry === 'bad')).toBe(true);
    s.advance(59_000);
    expect(await engine.catalog()).toBe(c1);
    s.advance(1_000);
    expect(await engine.catalog()).not.toBe(c1);
  });

  it('a clean SHA-pinned load is not capped at 60s', async () => {
    const s = await setup({ repos: { 'o/ok': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ ok: gh('ok', { ref: SHA1 }) });
    const engine = createEngine(s.ctx);
    const c1 = await engine.catalog();
    s.advance(120_000);
    expect(await engine.catalog()).toBe(c1);
  });

  it('concurrent callers after an expiry share one reload', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') }, { ttl_seconds: 60 });
    const engine = createEngine(s.ctx);
    const c1 = await engine.catalog();
    s.advance(61_000);
    const [a, b] = await Promise.all([engine.catalog(), engine.catalog()]);
    expect(a).not.toBe(c1);
    expect(b).toBe(a);
  });

  it('memo expiry is anchored at load completion, not load start', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') }, { ttl_seconds: 60 });
    const slow: Ctx = { ...s.ctx, http: { get: async (...a) => { s.advance(50_000); return s.ctx.http.get(...a); } } };
    const engine = createEngine(slow);
    const c1 = await engine.catalog();
    s.advance(30_000); // 80s after start, but only 30s after completion
    expect(await engine.catalog()).toBe(c1);
    s.advance(31_000);
    expect(await engine.catalog()).not.toBe(c1);
  });
});
