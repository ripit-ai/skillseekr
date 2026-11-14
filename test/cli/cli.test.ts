import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { fsHooks } from '../../src/install/installer.js';
import { lstat, mkdir, readFile, readdir, stat, symlink, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { main } from '../../src/cli/main.js';
import type { Ctx } from '../../src/context.js';
import { fakeGithub, type FakeSpec } from '../helpers/fakeGithub.js';
import { tmpDir } from '../helpers/tmp.js';

const API = 'https://api.github.com';
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const skill = (name: string, body = `body ${name}`) => `---\nname: ${name}\ndescription: ${name} helps with ${name} tasks\n---\n${body}\n`;
const gh = (repo: string) => ({ type: 'github', owner: 'o', repo, skills_dir: 'skills', ref: 'main' });
const repos = (): FakeSpec => ({
  'o/one': { refs: { main: SHA }, commits: { [SHA]: { 'skills/alpha/SKILL.md': skill('alpha', 'ALPHA BODY'), 'skills/alpha/ref/n.md': 'n', 'skills/cat/dup/SKILL.md': skill('dup') } } },
  'o/two': { refs: { main: SHA }, commits: { [SHA]: { 'skills/other/dup/SKILL.md': skill('dup'), 'skills/alpha/SKILL.md': skill('alpha', 'TWO') } } },
});

async function setup(o: { registries?: Record<string, unknown>; repos?: FakeSpec; raw?: string } = {}) {
  const dir = await tmpDir();
  const github = fakeGithub(o.repos ?? repos());
  const path = join(dir, 'config.jsonc');
  if (o.raw !== undefined) await writeFile(path, o.raw);
  else if (o.registries) await writeFile(path, JSON.stringify({ cache: { dir: join(dir, 'cache') }, registries: o.registries }));
  const cwd = join(dir, 'project');
  await mkdir(cwd);
  await mkdir(join(dir, 'home'));
  const ctx: Ctx = {
    env: { SKILLSEEKR_CONFIG: path }, home: join(dir, 'home'), cwd, http: github.http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => 1_700_000_000_000, githubApi: API,
  };
  const out: string[] = []; const err: string[] = [];
  const run = async (...argv: string[]) => {
    out.length = 0; err.length = 0;
    const code = await main(argv, { ctx, io: { out: (s) => out.push(s), err: (s) => err.push(s) } });
    return { code, out: out.join(''), err: err.join('') };
  };
  return { run, ctx, github, dir, cwd, path };
}

describe('cli', () => {
  it('search prints id, registry, and description per hit; --json prints SearchHit[]', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    const r = await s.run('search', 'alpha');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^alpha\s+one\s+alpha helps with alpha tasks$/m);
    const j = await s.run('--json', 'search', 'alpha');
    const hits = JSON.parse(j.out);
    expect(hits[0]).toMatchObject({ id: 'alpha', registry: 'one', via: ['one'] });
  });

  it('show accepts id or unique name; ambiguous name exits 1 listing candidate ids', async () => {
    const s = await setup({ registries: { one: gh('one'), two: gh('two') } });
    const byId = await s.run('show', 'cat/dup');
    expect(byId.code).toBe(0);
    expect(byId.out).toContain('registry:    one');
    expect(byId.out).toContain('SKILL.md');
    const amb = await s.run('show', 'dup');
    expect(amb.code).toBe(1);
    expect(amb.err).toContain('cat/dup');
    expect(amb.err).toContain('other/dup');
    expect(amb.out).toBe('');
    const uniq = await setup({ registries: { one: gh('one') } });
    const r = await uniq.run('show', 'alpha');
    expect(r.out).toContain('ALPHA BODY');
    expect(r.out).toContain('ref/n.md');
  });

  it('show prints overrides when the skill replaced another', async () => {
    const s = await setup({ registries: { one: gh('one'), two: gh('two') } });
    const r = await s.run('show', 'alpha');
    expect(r.out).toContain('TWO');
    expect(r.out).toMatch(/overrides:\s+one \(one\)/);
    expect(r.out).toContain('via:         two');
  });

  it('install defaults to project scope; --user installs to present tools', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    const r = await s.run('install', 'alpha');
    expect(r.code).toBe(0);
    expect(await readdir(join(s.cwd, '.claude', 'skills', 'alpha'))).toContain('.skillseekr.json');
    const none = await s.run('install', '--user', 'alpha');
    expect(none.code).toBe(1);
    await mkdir(join(s.ctx.home, '.claude'));
    await mkdir(join(s.ctx.home, '.copilot'));
    const u = await s.run('install', 'alpha', '--user');
    expect(u.code).toBe(0);
    expect(await readdir(join(s.ctx.home, '.claude', 'skills', 'alpha'))).toContain('SKILL.md');
    expect(await readdir(join(s.ctx.home, '.copilot', 'skills', 'alpha'))).toContain('SKILL.md');
    const missing = await s.run('install', 'nope');
    expect(missing.code).toBe(1);
  });

  it('remove refuses unmarked folders (exit 1)', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    await mkdir(join(s.cwd, '.claude', 'skills', 'mine'), { recursive: true });
    const r = await s.run('remove', 'mine');
    expect(r.code).toBe(1);
    expect(r.err).toContain('not installed by skillseekr');
    expect((await s.run('remove', 'ghost')).code).toBe(1);
    await s.run('install', 'alpha');
    const ok = await s.run('remove', 'alpha');
    expect(ok.code).toBe(0);
    expect(await readdir(join(s.cwd, '.claude', 'skills'))).toEqual(['mine']);
  });

  it('list shows status per install; outdated lists only non-current', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    await s.run('install', 'alpha');
    await s.run('install', 'cat/dup');
    await writeFile(join(s.cwd, '.claude', 'skills', 'dup', 'extra.txt'), 'x');
    const l = await s.run('list');
    expect(l.out).toMatch(/^alpha\s+project\s+-\s+current\s+one$/m);
    expect(l.out).toMatch(/^dup\s+project\s+-\s+modified\s+one$/m);
    const o = await s.run('outdated');
    expect(o.out).toContain('dup');
    expect(o.out).not.toMatch(/^alpha/m);
    const oj = JSON.parse((await s.run('--json', 'outdated')).out);
    expect(oj.outdated.map((x: { name: string }) => x.name)).toEqual(['dup']);
  });

  it('update reports a failed item on stderr, still updates the rest, and exits 1', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    await s.run('install', 'alpha');
    await s.run('install', 'cat/dup');
    for (const n of ['alpha', 'dup']) await writeFile(join(s.cwd, '.claude', 'skills', n, 'SKILL.md'), 'local edit');
    const real = fsHooks.rename;
    const spy = vi.spyOn(fsHooks, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === join(s.cwd, '.claude', 'skills', 'alpha')) throw new Error('disk on fire');
      return real(from, to);
    });
    onTestFinished(() => spy.mockRestore());
    const r = await s.run('update', '--force');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^alpha\s+failed/m);
    expect(r.out).toMatch(/^dup\s+updated/m);
    expect(r.err).toContain('alpha: disk on fire');
    expect(await readFile(join(s.cwd, '.claude', 'skills', 'dup', 'SKILL.md'), 'utf8')).toContain('dup helps');
    const j = await s.run('--json', 'update', '--force');
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out).results.find((x: { name: string }) => x.name === 'alpha')).toMatchObject({ result: 'failed', message: 'disk on fire' });
  });

  it('update skips modified without --force', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    await s.run('install', 'alpha');
    const file = join(s.cwd, '.claude', 'skills', 'alpha', 'SKILL.md');
    await writeFile(file, 'local edit');
    const r = await s.run('update');
    expect(r.out).toMatch(/alpha\s+skipped-modified/);
    expect(await readFile(file, 'utf8')).toBe('local edit');
    const f = await s.run('update', 'alpha', '--force');
    expect(f.out).toMatch(/alpha\s+updated/);
    expect(await readFile(file, 'utf8')).toContain('ALPHA BODY');
  });

  it('registries prints the resolved list with via; add/remove edit the config keeping comments', async () => {
    const raw = `{\n  // keep me\n  "cache": { "dir": "CACHE" },\n  "registries": {\n    "one": { "type": "github", "owner": "o", "repo": "one", "skills_dir": "skills", "ref": "main" }\n  }\n}\n`;
    const s = await setup({ raw });
    await writeFile(s.path, raw.replace('CACHE', join(s.dir, 'cache')));
    const list = await s.run('registries');
    expect(list.code).toBe(0);
    expect(list.out).toMatch(/^one\s+github\s+one\s+2\s+main\s+aaaaaaa/m);

    const add = await s.run('registries', 'add', 'mine', '--type', 'github', '--owner', 'o', '--repo', 'two', '--ref', 'main', '--skills-dir', 'skills', '--auth', 'gh_cli');
    expect(add.code).toBe(0);
    const text = await readFile(s.path, 'utf8');
    expect(text).toContain('// keep me');
    expect(text).toContain('"mine"');
    expect(text).toContain('"gh_cli"');
    const j = JSON.parse((await s.run('--json', 'registries')).out);
    expect(j.registries.map((r: { name: string }) => r.name)).toEqual(['one', 'mine']);

    const reg = await s.run('registries', 'add', 'inc', '--type', 'github-registry', '--owner', 'o', '--repo', 'reg', '--ref', 'main');
    expect(reg.code).toBe(0);
    expect(await readFile(s.path, 'utf8')).toContain('"github-registry"');

    const bad = await s.run('registries', 'add', 'broken', '--type', 'github', '--owner', 'o');
    expect(bad.code).toBe(1);
    expect(await readFile(s.path, 'utf8')).not.toContain('broken');
    expect((await s.run('registries', 'add', 'mine', '--type', 'http-registry', '--url', 'https://x')).code).toBe(1);
    expect((await s.run('registries', 'add', 'b2', '--type', 'bearer-thing')).code).toBe(1);
    expect((await s.run('registries', 'add', 'b3', '--type', 'http-registry', '--url', 'https://x', '--auth', 'bearer')).code).toBe(1);

    expect((await s.run('registries', 'remove', 'mine')).code).toBe(0);
    const after = await readFile(s.path, 'utf8');
    expect(after).not.toContain('"mine"');
    expect(after).toContain('// keep me');
    expect((await s.run('registries', 'remove', 'mine')).code).toBe(1);
  });

  it('registries add creates the config file when missing', async () => {
    const s = await setup();
    const r = await s.run('registries', 'add', 'one', '--type', 'http', '--url', 'https://x/SKILL.md', '--skill-name', 'x');
    expect(r.code).toBe(0);
    expect(JSON.parse(await readFile(s.path, 'utf8')).registries.one).toMatchObject({ type: 'http', skill_name: 'x' });
  });

  it('sync forces a reload', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    await s.run('search', 'alpha');
    const before = s.github.calls.filter((c) => c.includes('/commits/')).length;
    const r = await s.run('sync');
    expect(r.code).toBe(0);
    expect(r.out).toBe('synced 1 registries, 2 skills, 0 problems\n');
    expect(s.github.calls.filter((c) => c.includes('/commits/')).length).toBeGreaterThan(before);
  });

  it('stale catalog prints a one-line warning to stderr', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    await s.run('sync');
    s.github.offline(true);
    const r = await s.run('sync');
    expect(r.code).toBe(0);
    expect(r.err.trim().split('\n')).toEqual(["warning: catalog may be stale (offline or failing sources); run 'skillseekr doctor'"]);
    const j = await s.run('--json', 'search', 'alpha');
    expect(() => JSON.parse(j.out)).not.toThrow();
  });

  it('a missing config exits 2 with the problem on stderr; one failing registry does not', async () => {
    const s = await setup();
    const r = await s.run('search', 'x');
    expect(r.code).toBe(2);
    expect(r.err).toContain('Config file not found');
    expect(r.out).toBe('');
    const t = await setup({ registries: { one: gh('one'), ghost: gh('ghost') } });
    const ok = await t.run('search', 'alpha');
    expect(ok.code).toBe(0);
    expect(ok.err).toMatch(/^ghost: /m);
  });

  it('--config sets SKILLSEEKR_CONFIG on the ctx without touching process.env', async () => {
    const s = await setup();
    const other = join(s.dir, 'other.jsonc');
    await writeFile(other, JSON.stringify({ cache: { dir: join(s.dir, 'cache') }, registries: { one: gh('one') } }));
    const before = process.env.SKILLSEEKR_CONFIG;
    const r = await s.run('--config', other, 'search', 'alpha');
    expect(r.code).toBe(0);
    expect(s.ctx.env.SKILLSEEKR_CONFIG).toBe(other);
    expect(process.env.SKILLSEEKR_CONFIG).toBe(before);
  });

  it('usage errors exit 1 and write nothing to the real streams', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    const r = await s.run('bogus');
    expect(r.code).toBe(1);
    expect(r.err).toContain('unknown command');
    expect((await s.run('--help')).code).toBe(0);
    expect((await s.run('search')).code).toBe(1);
  });

  it('every configured registry failing exits 2 and names the registry', async () => {
    const s = await setup({ registries: { ghost: gh('ghost') } });
    const r = await s.run('search', 'alpha');
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^ghost: /m);
    expect(r.err).toContain('ghost');
    expect(r.out).toBe('');
    expect((await s.run('registries')).code).toBe(2);
  });

  it('update <name> for a name that is not installed exits 1; missing-from-catalog hints on stderr', async () => {
    const s = await setup({ registries: { one: gh('one') } });
    expect((await s.run('update', 'ghost')).code).toBe(1);
    await s.run('install', 'cat/dup');
    const path = join(s.dir, 'config.jsonc');
    await writeFile(path, JSON.stringify({ cache: { dir: join(s.dir, 'cache') }, registries: { two: gh('two') } }));
    const r = await s.run('update', 'dup');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dup\s+missing-from-catalog/);
    expect(r.err).toContain('hint:');
  });

  it('registries add/remove follow a symlinked config and keep its mode', async () => {
    const s = await setup();
    const real = join(s.dir, 'real.jsonc');
    await writeFile(real, '{ "registries": {} }\n');
    await chmod(real, 0o640);
    const link = join(s.dir, 'link.jsonc');
    await symlink(real, link);
    s.ctx.env.SKILLSEEKR_CONFIG = link;
    expect((await s.run('registries', 'add', 'x', '--type', 'http-registry', '--url', 'https://x')).code).toBe(0);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).toContain('"x"');
    expect((await stat(real)).mode & 0o777).toBe(0o640);
    expect((await s.run('registries', 'remove', 'x')).code).toBe(0);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, 'utf8')).not.toContain('"x"');
  });

  it('a sole inaccessible github-registry include exits 2 and names it; registries still prints first', async () => {
    const s = await setup({ registries: { inc: { type: 'github-registry', owner: 'o', repo: 'ghost', ref: 'main' } } });
    const r = await s.run('search', 'alpha');
    expect(r.code).toBe(2);
    expect(r.err).toContain('inc');
    expect(r.out).toBe('');
    const j = await s.run('--json', 'registries');
    expect(j.code).toBe(2);
    expect(JSON.parse(j.out).problems.length).toBeGreaterThan(0);
  });

  it('registries add refuses a dangling symlink config', async () => {
    const s = await setup();
    const link = join(s.dir, 'dangling.jsonc');
    await symlink(join(s.dir, 'nowhere.jsonc'), link);
    s.ctx.env.SKILLSEEKR_CONFIG = link;
    const r = await s.run('registries', 'add', 'x', '--type', 'http-registry', '--url', 'https://x');
    expect(r.code).toBe(1);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
  });

  it('doctor prints checks and exits 1 when a check fails; --json prints the report', async () => {
    const s = await setup({ registries: { one: gh('one'), gone: gh('gone') } });
    const r = await s.run('doctor');
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^fail\s+registry:gone\s+.*gone/m);
    expect(r.out).toMatch(/^ok\s+registry:one/m);
    const j = await s.run('--json', 'doctor');
    expect(j.code).toBe(1);
    expect(JSON.parse(j.out).checks.some((c: { id: string }) => c.id === 'config')).toBe(true);
    const good = await setup({ registries: { one: gh('one') } });
    expect((await good.run('doctor')).code).toBe(0);
  });

  it('validate exits 1 on errors, 0 when valid, and defaults to the cwd', async () => {
    const s = await setup();
    const d = join(s.cwd, 'my-skill');
    await mkdir(d);
    await writeFile(join(d, 'SKILL.md'), '---\nname: wrong\ndescription: x\n---\n');
    const r = await s.run('validate', d);
    expect(r.code).toBe(1);
    expect(r.out).toContain('skill/name-mismatch');
    await writeFile(join(d, 'SKILL.md'), '---\nname: my-skill\ndescription: x\n---\n');
    expect((await s.run('validate', d)).code).toBe(0);
    s.ctx.cwd = d;
    const def = await s.run('validate');
    expect(def.code).toBe(0);
    expect(def.out).toContain(d);
  });

  it('setup asks once via the injected prompt; empty answer means yes; "n" aborts', async () => {
    const s = await setup();
    await mkdir(join(s.ctx.home, '.copilot'));
    s.ctx.env.SKILLSEEKR_CONFIG = join(s.dir, 'new-config.jsonc');
    const answers = ['n', ''];
    const asked: string[] = [];
    const out: string[] = []; const err: string[] = [];
    const io = { out: (x: string) => out.push(x), err: (x: string) => err.push(x), prompt: async (q: string) => { asked.push(q); return answers.shift()!; } };
    expect(await main(['setup', '--tools', 'copilot'], { ctx: s.ctx, io })).toBe(1);
    await expect(stat(join(s.ctx.home, '.copilot', 'mcp-config.json'))).rejects.toThrow();
    expect(out.join('')).toContain('mcp-config.json');
    out.length = 0;
    await main(['setup', '--tools', 'copilot'], { ctx: s.ctx, io });
    expect(asked).toHaveLength(2);
    expect(JSON.parse(await readFile(join(s.ctx.home, '.copilot', 'mcp-config.json'), 'utf8')).mcpServers.skillseekr.command).toBe('skillseekr');
    expect(out.join('')).toMatch(/doctor/i);
    const bad = await s.run('setup', '--tools', 'emacs', '--yes');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('emacs');
  });

  it('setup --json without --yes keeps stdout pure JSON; the preview goes to stderr', async () => {
    const s = await setup();
    await mkdir(join(s.ctx.home, '.copilot'));
    s.ctx.env.SKILLSEEKR_CONFIG = join(s.dir, 'json-config.jsonc');
    const out: string[] = []; const err: string[] = [];
    const io = { out: (x: string) => out.push(x), err: (x: string) => err.push(x), prompt: async () => '' };
    await main(['--json', 'setup', '--tools', 'copilot'], { ctx: s.ctx, io });
    const parsed = JSON.parse(out.join(''));
    expect(parsed.changes.some((c: { file?: string }) => c.file?.endsWith('mcp-config.json'))).toBe(true);
    expect(err.join('')).toContain('mcp-config.json');
  });
});
