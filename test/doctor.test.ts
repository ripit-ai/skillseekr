import { describe, it, expect } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../src/context.js';
import { createEngine } from '../src/engine.js';
import { doctor } from '../src/doctor.js';
import { fakeGithub } from './helpers/fakeGithub.js';
import { tmpDir } from './helpers/tmp.js';

const SHA = 'd'.repeat(40);
const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} things\n---\nbody\n`;

async function env(config: string | undefined) {
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
  if (config !== undefined) await writeFile(file, config);
  const ctx: Ctx = {
    env: { SKILLSEEKR_CONFIG: file }, home, cwd: home, http: github.http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => 1_700_000_000_000, githubApi: 'https://api.github.com',
  };
  return { ctx, home, file, run: () => doctor(createEngine(ctx), ctx) };
}

describe('doctor', () => {
  it('doctor reports config parse, each registry\'s access (fail names the registry), include loops, overrides (warn), unauthenticated GitHub sources (warn: rate limits), MCP registration per detected tool, and skill folder paths', async () => {
    const e = await env(JSON.stringify({
      cache: { dir: '~/cache' },
      registries: {
        one: { type: 'github', owner: 'o', repo: 'one', skills_dir: 'skills', ref: 'main' },
        bad: { type: 'github', owner: 'o', repo: 'missing', skills_dir: 'skills', ref: 'main', auth: { type: 'gh_cli' } },
        list: { type: 'github-registry', owner: 'o', repo: 'list', ref: 'main', auth: { type: 'gh_cli' } },
        three: { type: 'github', owner: 'o', repo: 'one', skills_dir: 'skills', ref: 'main', auth: { type: 'gh_cli' } },
      },
    }));
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
});
