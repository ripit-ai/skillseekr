import { describe, it, expect, afterEach } from 'vitest';
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createEngine, type Engine } from '../../src/engine.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { Ctx } from '../../src/context.js';
import type { Http } from '../../src/net/http.js';
import { fakeGithub, type FakeSpec } from '../helpers/fakeGithub.js';
import { tmpDir } from '../helpers/tmp.js';
import { pull } from '../helpers/library.js';

const API = 'https://api.github.com';
const SHA = 'a'.repeat(40);
const skill = (name: string, body = `body ${name}`) => `---\nname: ${name}\ndescription: ${name} helps with ${name} tasks\n---\n${body}\n`;
const gh = (repo: string) => ({ type: 'github', owner: 'o', repo, skills_dir: 'skills', ref: 'main' });

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { while (closers.length) await closers.pop()!(); });

async function setup(opts: { repos?: FakeSpec; registries?: Record<string, unknown>; roots?: string[] | 'none'; hangRoots?: boolean; engine?: Engine } = {}) {
  const dir = await tmpDir();
  const github = fakeGithub(opts.repos ?? {});
  const http: Http = { get: (url, h, o) => github.http.get(url, h, o) };
  const path = join(dir, 'config.jsonc');
  const project = join(dir, 'project');
  await mkdir(project);
  if (opts.registries) await writeFile(path, JSON.stringify({ library: { dir: join(dir, 'library') }, registries: opts.registries }));
  const ctx: Ctx = {
    env: { SKILLSEEKR_CONFIG: path }, home: join(dir, 'home'), cwd: join(dir, 'cwd'), http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => 1_700_000_000_000, githubApi: API,
  };
  if (opts.registries) await pull(ctx);
  const server = createMcpServer(opts.engine ?? createEngine(ctx), ctx, { rootsTimeoutMs: 100 });
  const withRoots = opts.roots !== 'none';
  const client = new Client({ name: 't', version: '0' }, { capabilities: withRoots ? { roots: {} } : {} });
  if (withRoots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => opts.hangRoots ? new Promise<never>(() => {}) : ({
      roots: (opts.roots as string[] | undefined ?? [project]).map((p) => ({ uri: /^[a-z]+:\/\//.test(p) ? p : pathToFileURL(p).href })),
    }));
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  closers.push(async () => { await client.close(); await server.close(); });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const content = r.content as Array<{ type: string; text: string }>;
    expect(content).toHaveLength(1);
    expect(content[0]!.type).toBe('text');
    return { isError: r.isError === true, data: JSON.parse(content[0]!.text) as any };
  };
  return { client, call, dir, project, ctx };
}

const fixture = (): { repos: FakeSpec; registries: Record<string, unknown> } => ({
  repos: {
    'o/one': { refs: { main: SHA }, commits: { [SHA]: {
      'skills/alpha/SKILL.md': skill('alpha', 'ALPHA BODY'), 'skills/alpha/ref/notes.md': 'notes here',
      'skills/alpha/bin.dat': '\0\0\0', 'skills/dup/SKILL.md': skill('dup'),
    } } },
    'o/two': { refs: { main: SHA }, commits: { [SHA]: { 'skills/team/dup/SKILL.md': skill('dup') } } },
  },
  registries: { one: gh('one'), two: gh('two') },
});

describe('mcp server', () => {
  it('listTools returns exactly the six tool names', async () => {
    const s = await setup(fixture());
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['get_skill', 'install_skill', 'list_installed', 'list_registries', 'read_skill_file', 'search_skills']);
    expect(s.client.getServerVersion()?.name).toBe('skillseekr');
    expect(s.client.getInstructions()).toMatch(/^Use skillseekr to find organization skills/);
  });

  it('search → get → read_skill_file round trip on the fixture catalog', async () => {
    const s = await setup(fixture());
    const search = await s.call('search_skills', { query: 'alpha' });
    expect(search.isError).toBe(false);
    expect(search.data.results[0]).toMatchObject({ id: 'alpha', registry: 'one' });
    expect(search.data.results[0]).not.toHaveProperty('score');
    expect(search.data).toMatchObject({ stale: false, problems: [] });

    const got = await s.call('get_skill', { skill: 'alpha' });
    expect(got.data).toMatchObject({ id: 'alpha', name: 'alpha', registry: 'one', via: ['one'], overrides: [], warnings: [], stale: false });
    expect(got.data.body).toContain('ALPHA BODY');
    expect(got.data.body).toContain('name: alpha');
    expect(got.data.files).toContain('ref/notes.md');
    expect(got.data.path).toMatch(/alpha$/);

    expect((await s.call('read_skill_file', { skill: 'alpha', path: 'ref/notes.md' })).data).toEqual({ content: 'notes here' });
    const bin = await s.call('read_skill_file', { skill: 'alpha', path: 'bin.dat' });
    expect(bin.data).toMatchObject({ kind: 'binary', size: 3 });
    const missing = await s.call('read_skill_file', { skill: 'alpha', path: 'nope.md' });
    expect(missing).toMatchObject({ isError: true, data: { error: 'not-found' } });
  });

  it('get_skill on a missing skill returns isError with suggestions', async () => {
    const s = await setup(fixture());
    const amb = await s.call('get_skill', { skill: 'nosuch' });
    expect(amb).toMatchObject({ isError: true, data: { error: 'not-found' } });
    expect(Array.isArray(amb.data.suggestions)).toBe(true);
  });

  it('get_skill returns metadata instead of the body for a SKILL.md over 1 MB', async () => {
    const big = skill('huge', 'x'.repeat(1024 * 1024));
    const s = await setup({ repos: { 'o/one': { refs: { main: SHA }, commits: { [SHA]: { 'skills/huge/SKILL.md': big } } } }, registries: { one: gh('one') } });
    const r = await s.call('get_skill', { skill: 'huge' });
    expect(r.isError).toBe(false);
    expect(r.data).not.toHaveProperty('body');
    expect(r.data.skillMd).toEqual({ kind: 'too_large', size: Buffer.byteLength(big), path: join(r.data.path, 'SKILL.md') });
    expect(r.data.warnings[0]).toMatch(/larger than 1 MB/);
  });

  it('get_skill with an ambiguous bare name returns isError with candidates', async () => {
    const s = await setup({
      repos: { 'o/one': { refs: { main: SHA }, commits: { [SHA]: { 'skills/a/x/SKILL.md': skill('x'), 'skills/b/x/SKILL.md': skill('x') } } } },
      registries: { one: gh('one') },
    });
    const r = await s.call('get_skill', { skill: 'x' });
    expect(r).toMatchObject({ isError: true, data: { error: 'ambiguous', candidates: ['a/x', 'b/x'] } });
    expect((await s.call('read_skill_file', { skill: 'x', path: 'SKILL.md' })).data.error).toBe('ambiguous');
  });

  it('read_skill_file refuses ../ with isError', async () => {
    const s = await setup(fixture());
    const r = await s.call('read_skill_file', { skill: 'alpha', path: '../dup/SKILL.md' });
    expect(r.isError).toBe(true);
    expect(r.data.error).toBe('refused');
    expect(typeof r.data.reason).toBe('string');
    expect((await s.call('read_skill_file', { skill: 'alpha', path: '/etc/passwd' })).isError).toBe(true);
  });

  it('get_skill does not create anything under .claude/skills or tool user dirs (AC-4)', async () => {
    const s = await setup(fixture());
    await s.call('get_skill', { skill: 'alpha' });
    await s.call('read_skill_file', { skill: 'alpha', path: 'ref/notes.md' });
    await expect(stat(join(s.project, '.claude'))).rejects.toThrow();
    await expect(stat(join(s.ctx.cwd, '.claude'))).rejects.toThrow();
    await expect(readdir(s.ctx.home)).rejects.toThrow();
  });

  it('install_skill installs into the project dir from roots, and list_installed reports it', async () => {
    const s = await setup(fixture());
    const r = await s.call('install_skill', { skill: 'alpha' });
    expect(r.isError).toBe(false);
    expect(r.data).toEqual({ dirs: [join(s.project, '.claude', 'skills', 'alpha')], tools: ['claude', 'opencode', 'copilot'] });
    expect(await readFile(join(s.project, '.claude', 'skills', 'alpha', 'SKILL.md'), 'utf8')).toContain('ALPHA BODY');
    const l = await s.call('list_installed', { scope: 'project' });
    expect(l.data.installed).toEqual([{
      name: 'alpha', scope: 'project', dir: join(s.project, '.claude', 'skills', 'alpha'),
      id: 'alpha', registry: 'one', via: ['one'], status: 'current',
    }]);
  });

  it('install_skill falls back to ctx.cwd without roots, and InstallError is isError', async () => {
    const s = await setup({ ...fixture(), roots: 'none' });
    await mkdir(s.ctx.cwd, { recursive: true });
    const r = await s.call('install_skill', { skill: 'alpha' });
    expect(r.data.dirs).toEqual([join(s.ctx.cwd, '.claude', 'skills', 'alpha')]);
    await mkdir(join(s.ctx.cwd, '.claude', 'skills', 'dup'), { recursive: true });
    const bad = await s.call('install_skill', { skill: 'dup' });
    expect(bad).toMatchObject({ isError: true, data: { error: 'unmanaged-folder' } });
  });

  it('a non-file root falls back to ctx.cwd', async () => {
    const s = await setup({ ...fixture(), roots: ['https://example.com/x'] });
    await mkdir(s.ctx.cwd, { recursive: true });
    const r = await s.call('install_skill', { skill: 'alpha' });
    expect(r.data.dirs).toEqual([join(s.ctx.cwd, '.claude', 'skills', 'alpha')]);
  });

  it('list_registries returns the engine result', async () => {
    const s = await setup(fixture());
    const r = await s.call('list_registries');
    expect(r.data.registries.map((x: { name: string }) => x.name)).toEqual(['one', 'two']);
    expect(r.data.registries[0]).toMatchObject({ sha: SHA, skillCount: 2 });
  });

  it('list_registries reports skill-id overrides as well as registry overrides (AC-6)', async () => {
    const f = fixture();
    f.repos['o/two']!.commits[SHA]!['skills/alpha/SKILL.md'] = skill('alpha', 'TWO');
    const s = await setup(f);
    const r = await s.call('list_registries');
    expect(r.data.overrides).toEqual([
      { kind: 'skill', key: 'alpha', replaced: { registry: 'one', via: ['one'] }, by: { registry: 'two', via: ['two'] } },
    ]);
  });

  it('inaccessible registry is named in problems; others still work (AC-2)', async () => {
    const f = fixture();
    const s = await setup({ repos: f.repos, registries: { ...f.registries, bad: gh('nope') } });
    const r = await s.call('search_skills', { query: 'alpha' });
    expect(r.data.results.length).toBeGreaterThan(0);
    expect(r.data.problems.some((p: { registry?: string }) => p.registry === 'bad')).toBe(true);
  });

  it('config problems surface as problems, not crashes', async () => {
    const s = await setup({});
    const r = await s.call('search_skills', { query: 'anything' });
    expect(r.isError).toBe(false);
    expect(r.data.results).toEqual([]);
    expect(r.data.problems.map((p: { code: string }) => p.code)).toContain('config/missing');
  });

  it('a roots handler that never answers times out and falls back to ctx.cwd', async () => {
    const s = await setup({ ...fixture(), hangRoots: true });
    await mkdir(s.ctx.cwd, { recursive: true });
    const r = await s.call('install_skill', { skill: 'alpha' });
    expect(r.data.dirs).toEqual([join(s.ctx.cwd, '.claude', 'skills', 'alpha')]);
  });

  it('an unexpected throw becomes isError internal', async () => {
    const engine = { catalog: async () => { throw new Error('boom'); }, registries: async () => ({}), config: async () => ({}) } as unknown as Engine;
    const s = await setup({ engine });
    const r = await s.call('search_skills', { query: 'x' });
    expect(r).toMatchObject({ isError: true, data: { error: 'internal', message: 'boom' } });
  });
});
