import { describe, it, expect, afterEach } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEngine } from '../src/engine.js';
import type { Ctx } from '../src/context.js';
import type { Http } from '../src/net/http.js';
import { fakeGithub, type FakeSpec } from './helpers/fakeGithub.js';
import { fakeHttp, type FakeRoute } from './helpers/fakeHttp.js';
import { tmpDir } from './helpers/tmp.js';
import { pull } from './helpers/library.js';
import { pullHooks } from '../src/library/pull.js';

const realHook = pullHooks.beforeSwap;
afterEach(() => { pullHooks.beforeSwap = realHook; });

const API = 'https://api.github.com';
const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\nbody ${name}\n`;
const gh = (repo: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'github', owner: 'o', repo, skills_dir: 'skills', ref: 'main', ...extra });
const incl = (repo: string) => ({ type: 'github-registry', owner: 'o', repo, ref: 'main' });
const EMPTY = "the skill library is empty; run 'skillseekr update'";
const CHANGED = "the config changed since the last update; run 'skillseekr update' to apply it";

/** Any request is a test failure: reads must never touch the network. */
const noNetwork: Http = { get: async (url) => { throw new Error(`unexpected request: GET ${url}`); } };

async function setup(o: { repos?: FakeSpec; routes?: Record<string, FakeRoute> } = {}) {
  const dir = await tmpDir();
  const repos = o.repos ?? {};
  const github = fakeGithub(repos);
  const web = fakeHttp(o.routes ?? {});
  const http: Http = { get: (url, h, opts) => (url.startsWith(API) ? github.http : web.http).get(url, h, opts) };
  const path = join(dir, 'config.jsonc');
  const lib = join(dir, 'library');
  const ctx: Ctx = {
    env: { SKILLSEEKR_CONFIG: path }, home: join(dir, 'home'), cwd: dir, http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => 1_700_000_000_000, githubApi: API,
  };
  const offline: Ctx = { ...ctx, http: noNetwork };
  const write = (registries: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    writeFile(path, JSON.stringify({ library: { dir: lib }, registries, ...extra }));
  return { ctx, offline, github, web, repos, path, dir, lib, write };
}

const repoWith = (files: Record<string, string>, sha = SHA1) => ({ refs: { main: sha }, commits: { [sha]: files } });

describe('engine', () => {
  it('after a pull, serves the catalog from the library with no request (include, via, sha, absolute dirs)', async () => {
    const s = await setup({
      repos: {
        'o/inc': repoWith({ 'registries.jsonc': JSON.stringify({ registries: { remote: gh('remote') } }) }),
        'o/remote': repoWith({ 'skills/a/SKILL.md': skill('a') }, SHA2),
        'o/local': repoWith({ 'skills/cat/b/SKILL.md': skill('b') }),
      },
    });
    await s.write({ inc: incl('inc'), local: gh('local') });
    await pull(s.ctx);
    const engine = createEngine(s.offline);
    const cat = await engine.catalog();
    expect(cat.problems).toEqual([]);
    expect(cat.stale).toBe(false);
    expect(cat.skills.map((x) => [x.id, x.registry, x.via, x.ref, x.sha])).toEqual([
      ['a', 'remote', ['inc', 'remote'], 'main', SHA2],
      ['cat/b', 'local', ['local'], 'main', SHA1],
    ]);
    expect(cat.skills[0]!.dir).toBe(join(s.lib, 'github', 'o', 'remote@main', 'skills', 'a'));
    expect(await cat.readFile(cat.skills[0]!, 'SKILL.md')).toEqual({ kind: 'text', content: skill('a') });
    const r = await engine.registries();
    expect(r.registries.map((v) => v.name)).toEqual(['remote', 'local']);
    expect(r.includes.map((i) => [i.name, i.via, i.sha])).toEqual([['inc', ['inc'], SHA1]]);
    expect((await engine.config()).registries.map(([n]) => n)).toEqual(['inc', 'local']);
    expect(await engine.library()).toMatchObject({ dir: s.lib, manifest: { version: 1 } });
  });

  it('no library: empty catalog with a library/empty error, and no request is made', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    const engine = createEngine(s.ctx);
    const cat = await engine.catalog();
    expect(cat.skills).toEqual([]);
    expect(cat.problems).toEqual([{ level: 'error', code: 'library/empty', message: EMPTY }]);
    expect((await engine.registries()).problems.map((p) => p.code)).toEqual(['library/empty']);
    expect(await engine.library()).toEqual({ dir: s.lib });
    expect(s.github.calls).toEqual([]);
  });

  it('a config edited after the pull changes nothing that reads see, makes no request, and warns (Review Focus 1)', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }), 'o/q': repoWith({ 'skills/b/SKILL.md': skill('b') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    const engine = createEngine(s.offline);
    expect((await engine.catalog()).problems).toEqual([]);
    await s.write({ r: gh('r'), q: gh('q') });
    const cat = await engine.catalog();
    expect(cat.skills.map((x) => x.id)).toEqual(['a']);
    expect(cat.problems).toEqual([{ level: 'warning', code: 'library/config-changed', message: CHANGED }]);
    const r = await engine.registries();
    expect(r.registries.map((v) => v.name)).toEqual(['r']);
    expect(r.problems.map((p) => p.code)).toEqual(['library/config-changed']);
    // a fresh engine (another process) sees the same
    expect((await createEngine(s.offline).catalog()).problems.map((p) => p.code)).toEqual(['library/config-changed']);
  });

  it('a manifest rewritten by a second pull is served by the same engine on its next call', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    const engine = createEngine(s.offline);
    const c1 = await engine.catalog();
    expect(c1.skills.map((x) => x.id)).toEqual(['a']);
    expect(await engine.catalog()).toBe(c1); // memoised while nothing changed
    s.repos['o/r'] = { refs: { main: SHA2 }, commits: { [SHA2]: { 'skills/a/SKILL.md': skill('a'), 'skills/n/SKILL.md': skill('n') } } };
    await pull(s.ctx);
    const c2 = await engine.catalog();
    expect(c2).not.toBe(c1);
    expect(c2.skills.map((x) => [x.id, x.sha])).toEqual([['a', SHA2], ['n', SHA2]]);
    expect(await engine.catalog()).toBe(c2);
  });

  it('a config with a cache section gets one config/cache-ignored warning', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') }, { cache: { enabled: true, ttl_seconds: 60, dir: join(s.dir, 'cache') } });
    await pull(s.ctx);
    const cat = await createEngine(s.offline).catalog();
    expect(cat.skills.map((x) => x.id)).toEqual(['a']);
    const ignored = cat.problems.filter((p) => p.code === 'config/cache-ignored');
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toMatchObject({ level: 'warning', file: s.path });
    expect(cat.problems.filter((p) => p.code !== 'config/cache-ignored')).toEqual([]);
  });

  it('missing config → config/missing naming the path and library/empty, no throw', async () => {
    const s = await setup();
    const engine = createEngine(s.offline);
    const cat = await engine.catalog();
    expect(cat.skills).toEqual([]);
    expect(cat.problems.map((p) => p.code)).toEqual(['config/missing', 'library/empty']);
    expect(cat.problems[0]!.message).toContain(s.path);
    const r = await engine.registries();
    expect(r.registries).toEqual([]);
    expect(r.problems[0]!.code).toBe('config/missing');
  });

  it('broken config after a pull → the library is still served, with the parse error and config-changed', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    const env = { ...s.offline.env, SKILLSEEKR_LIBRARY: s.lib }; // the broken config no longer names the library
    await writeFile(s.path, '{ "registries": ');
    const cat = await createEngine({ ...s.offline, env }).catalog();
    expect(cat.skills.map((x) => x.id)).toEqual(['a']);
    expect(cat.problems.some((p) => p.code === 'config/parse-error')).toBe(true);
    expect(cat.problems.some((p) => p.code === 'library/config-changed')).toBe(true);
  });

  it('a source that failed in the last update is stale with its previous skills; registries() shows fetchedAt', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    s.github.offline(true);
    await pull(s.ctx);
    const engine = createEngine(s.offline);
    const cat = await engine.catalog();
    expect(cat.stale).toBe(true);
    expect(cat.skills.map((x) => x.id)).toEqual(['a']);
    // the last update's fetch error is served as a stale warning, keeping its message
    expect(cat.problems).toEqual([expect.objectContaining({ level: 'warning', code: 'source/stale', registry: 'r', via: ['r'] })]);
    expect(cat.problems[0]!.message).toMatch(/unreachable.*may be stale/);
    const [v] = (await engine.registries()).registries;
    expect(v).toMatchObject({ name: 'r', stale: true, skillCount: 1, fetchedAt: new Date(1_700_000_000_000).toISOString() });
    expect(v).not.toHaveProperty('cacheAgeSeconds');
  });

  it('a source the security hook rejected keeps its previous copy, but reads still report library/rejected as an error', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    s.repos['o/r'] = { refs: { main: SHA2 }, commits: { [SHA2]: { 'skills/a/SKILL.md': skill('a'), 'skills/n/SKILL.md': skill('n') } } };
    pullHooks.beforeSwap = async () => ({ reject: ['r'] });
    await pull(s.ctx);
    const cat = await createEngine(s.offline).catalog();
    expect(cat.skills.map((x) => [x.id, x.sha])).toEqual([['a', SHA1]]);
    expect(cat.stale).toBe(true);
    expect(cat.problems).toEqual([expect.objectContaining({ level: 'error', code: 'library/rejected', registry: 'r' })]);
  });

  it('an unreachable registry is a problem with registry and via; others still load', async () => {
    const s = await setup({ repos: { 'o/ok': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ bad: gh('nope'), ok: gh('ok') });
    await pull(s.ctx);
    const engine = createEngine(s.offline);
    const cat = await engine.catalog();
    expect(cat.skills.map((x) => x.id)).toEqual(['a']);
    expect(cat.problems.find((x) => x.registry === 'bad')).toMatchObject({ level: 'error', via: ['bad'] });
    expect((await engine.registries()).registries.map((v) => [v.name, v.skillCount])).toEqual([['bad', 0], ['ok', 1]]);
  });

  it('http registry yields one skill with id = skill_name', async () => {
    const url = 'https://example.test/s/SKILL.md';
    const s = await setup({ routes: { [url]: { body: skill('web'), etag: 'e1' } } });
    await s.write({ w: { type: 'http', url, skill_name: 'web' } });
    await pull(s.ctx);
    const engine = createEngine(s.offline);
    const cat = await engine.catalog();
    expect(cat.problems).toEqual([]);
    expect(cat.skills.map((x) => [x.id, x.registry])).toEqual([['web', 'w']]);
    expect(await cat.readFile(cat.skills[0]!, 'SKILL.md')).toEqual({ kind: 'text', content: skill('web') });
    expect((await engine.registries()).registries[0]).toMatchObject({ type: 'http', skillCount: 1, stale: false, fetchedAt: expect.any(String) });
  });

  it('memoizes concurrent and repeated calls', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    const engine = createEngine(s.offline);
    const [c1, c2] = await Promise.all([engine.catalog(), engine.catalog()]);
    expect(c2).toBe(c1);
    expect(await engine.catalog()).toBe(c1);
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
    await pull(s.ctx);
    const engine = createEngine(s.offline);
    const r = await engine.registries();
    expect(r.problems).toEqual([]);
    expect(r.includes.map((i) => i.name)).toEqual(['inc']);
    expect(r.registries.map((v) => [v.name, v.via, v.sha, v.stale, v.skillCount])).toEqual([
      ['dup', ['inc', 'dup'], SHA2, false, 2],
      ['solo', ['inc', 'solo'], SHA1, false, 1],
    ]);
    expect(r.registries[0]).toMatchObject({ type: 'github', ref: 'main' });
    // registry overrides first, then skill overrides (the same list the catalog and doctor use)
    expect(r.overrides.map((o) => [o.kind, o.key])).toEqual([['registry', 'dup'], ['skill', 'x']]);
    expect(r.overrides[1]).toEqual({
      kind: 'skill', key: 'x', replaced: { registry: 'dup', via: ['inc', 'dup'] }, by: { registry: 'solo', via: ['inc', 'solo'] },
    });
    expect(r.overrides).toEqual((await engine.catalog()).overrides);
    // the winning registry lists what it replaced; the replaced one is dropped by resolve
    expect(r.registries[0]!.overrode).toEqual([{ registry: 'dup', via: ['dup'] }]);
    expect(r.registries[1]).not.toHaveProperty('overrode');
    // last wins for the skill id
    expect((await engine.catalog()).lookup('x')).toMatchObject({ kind: 'found', skill: { registry: 'solo' } });
  });

  it('an unexpected throw during load becomes engine/load-failed with an empty catalog, never a rejection', async () => {
    const s = await setup();
    const bad = { ...s.offline, env: new Proxy({}, { get() { throw new Error('boom'); } }) as Ctx['env'] };
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

  it('a config file edit reloads the memo (for the config-changed check)', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    await pull(s.ctx);
    const engine = createEngine(s.offline);
    const c1 = await engine.catalog();
    expect(await engine.catalog()).toBe(c1);
    await s.write({ r: gh('r', { description: 'edited' }) });
    const c2 = await engine.catalog();
    expect(c2).not.toBe(c1);
    expect(c2.problems.map((p) => p.code)).toEqual(['library/config-changed']);
  });
});
