import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../src/context.js';
import { createEngine } from '../src/engine.js';
import { doctor } from '../src/doctor.js';
import { fakeGithub } from './helpers/fakeGithub.js';
import { tmpDir } from './helpers/tmp.js';
import { pull } from './helpers/library.js';

const SHA = 'd'.repeat(40);
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} things\n---\nbody\n`;

async function env(config: string | undefined | ((home: string) => string)) {
  const home = await tmpDir();
  const github = fakeGithub({
    'o/one': { refs: { main: SHA }, commits: { [SHA]: { 'skills/alpha/SKILL.md': skill('alpha') } } },
    'o/two': { refs: { main: SHA }, commits: { [SHA]: { 'skills/alpha/SKILL.md': skill('alpha') } } },
    'o/list': {
      refs: { main: SHA },
      commits: {
        [SHA]: {
          'registries.jsonc': JSON.stringify({
            registries: {
              one: { type: 'github', owner: 'o', repo: 'two', skills_dir: 'skills', ref: 'main' },
              loop: { type: 'github-registry', owner: 'o', repo: 'list', ref: 'main' },
            },
          }),
        },
      },
    },
  });
  const file = join(home, 'config.jsonc');
  if (config !== undefined) await writeFile(file, typeof config === 'function' ? config(home) : config);
  const ctx: Ctx = {
    env: { SKILLSEEKR_CONFIG: file }, home, cwd: home, http: github.http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => 1_700_000_000_000, githubApi: 'https://api.github.com',
  };
  return { ctx, home, file, run: () => doctor(createEngine(ctx), ctx) };
}

describe('doctor', () => {
  it('doctor reports config parse, each registry\'s access (fail names the registry), include loops, overrides (warn), unauthenticated GitHub sources (warn: rate limits), MCP registration per detected tool, and skill folder paths', async () => {
    const e = await env((home) => JSON.stringify({
      library: { dir: join(home, 'library') },
      registries: {
        one: { type: 'github', owner: 'o', repo: 'one', skills_dir: 'skills', ref: 'main' },
        bad: { type: 'github', owner: 'o', repo: 'missing', skills_dir: 'skills', ref: 'main', auth: { type: 'gh_cli' } },
        list: { type: 'github-registry', owner: 'o', repo: 'list', ref: 'main', auth: { type: 'gh_cli' } },
        three: { type: 'github', owner: 'o', repo: 'one', skills_dir: 'skills', ref: 'main', auth: { type: 'gh_cli' } },
      },
    }));
    await pull(e.ctx);
    await mkdir(join(e.home, '.copilot', 'skills'), { recursive: true });
    await mkdir(join(e.home, '.config', 'opencode'), { recursive: true });
    await writeFile(join(e.home, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ mcp: { servers: { skillseekr: { type: 'local', command: ['skillseekr', 'mcp'] } } } }));

    const { checks } = await e.run();
    const by = (id: string) => checks.find((c) => c.id === id);

    expect(by('config')).toMatchObject({ status: 'ok' });
    expect(by('registry:one')).toMatchObject({ status: 'ok' });
    expect(by('registry:bad')?.status).toBe('fail');
    expect(by('registry:bad')?.message).toContain('bad');
    expect(by('include-loop')?.status).toBe('warn');
    expect(by('include-loop')?.message).toContain('loop');
    expect(checks.filter((c) => c.id.startsWith('override:')).every((c) => c.status === 'warn')).toBe(true);
    expect(by('override:registry:one')?.message).toContain('list');
    expect(by('override:skill:alpha')?.message).toContain('three');
    expect(by('auth:one')?.status).toBe('warn');
    expect(by('auth:one')?.message).toMatch(/rate limit/);
    expect(by('auth:list')?.status).not.toBe('fail');
    expect(by('mcp:opencode')).toMatchObject({ status: 'ok' });
    expect(by('mcp:copilot')).toMatchObject({ status: 'warn' });
    expect(by('mcp:claude')).toBeUndefined();
    expect(by('skills-dir:copilot')?.message).toContain(join(e.home, '.copilot', 'skills'));
    expect(by('skills-dir:opencode')).toBeDefined();
    expect(by('skills-dir:claude')).toBeUndefined();
  });

  it('a config that does not parse is a fail naming the file', async () => {
    const e = await env('{ "registries": { ');
    const { checks } = await e.run();
    const c = checks.find((x) => x.id === 'config');
    expect(c?.status).toBe('fail');
    expect(c?.message).toContain(e.file);
  });

  it('a missing config is a fail that says to run setup', async () => {
    const e = await env(undefined);
    const { checks } = await e.run();
    const c = checks.find((x) => x.id === 'config');
    expect(c?.status).toBe('fail');
    expect(c?.message).toMatch(/setup/);
  });

  describe('library checks', () => {
    const one = { registries: { one: { type: 'github', owner: 'o', repo: 'one', skills_dir: 'skills', ref: 'main' } } };
    const cfg = (home: string, extra: object = {}) => JSON.stringify({ library: { dir: join(home, 'library') }, ...one, ...extra });

    it('an empty library is a warn and nothing fails from library state', async () => {
      const e = await env((h) => cfg(h));
      const { checks } = await e.run();
      expect(checks.find((c) => c.id === 'library')).toMatchObject({ status: 'warn', message: "the skill library is empty; run 'skillseekr update'" });
      expect(checks.filter((c) => c.id.startsWith('library')).every((c) => c.status !== 'fail')).toBe(true);
      expect(checks.filter((c) => c.status === 'fail')).toEqual([]);
    });

    it('a pulled library is ok with its dir, time and skill count; no request is made', async () => {
      const e = await env((h) => cfg(h));
      await pull(e.ctx);
      const calls: string[] = [];
      const ctx = { ...e.ctx, http: { get: async (u: string) => { calls.push(u); throw new Error('no network'); } } };
      const { checks } = await doctor(createEngine(ctx), ctx);
      const c = checks.find((x) => x.id === 'library')!;
      expect(c.status).toBe('ok');
      expect(c.message).toContain(join(e.home, 'library'));
      expect(c.message).toMatch(/updated 2023-11-14T22:13:20\.000Z, 1 skills/);
      expect(checks.find((x) => x.id === 'library:edited')).toBeUndefined();
      expect(calls).toEqual([]);
    });

    it('a hand-edited file is listed by library:edited', async () => {
      const e = await env((h) => cfg(h));
      const { manifest } = await pull(e.ctx);
      const sk = manifest!.sources[0]!;
      await writeFile(join(e.home, 'library', sk.skills[0]!.dir, 'SKILL.md'), skill('alpha') + 'edited\n');
      const { checks } = await e.run();
      const c = checks.find((x) => x.id === 'library:edited');
      expect(c?.status).toBe('warn');
      expect(c?.message).toContain(sk.folder!);
    });

    it('a lock held by a dead pid is a warn; a changed config warns library:config', async () => {
      const e = await env((h) => cfg(h));
      await pull(e.ctx);
      await writeFile(join(e.home, 'library', '.lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: '2023-01-01T00:00:00.000Z' }));
      await writeFile(e.file, cfg(e.home, { extra: 1 }) + '\n');
      const { checks } = await e.run();
      expect(checks.find((x) => x.id === 'library:lock')).toMatchObject({ status: 'warn', message: `stale update lock from pid ${2 ** 22 + 12345}` });
      expect(checks.find((x) => x.id === 'library:config')?.status).toBe('warn');
    });

    it('a cache section warns config:cache', async () => {
      const e = await env((h) => cfg(h, { cache: { ttl: 5 } }));
      const { checks } = await e.run();
      expect(checks.find((x) => x.id === 'config:cache')?.status).toBe('warn');
    });
  });
});
