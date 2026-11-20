import { describe, it, expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../../src/context.js';
import { installSkill } from '../../src/install/installer.js';
import { catalogFromManifest } from '../../src/library/catalog.js';
import { acquireLock } from '../../src/library/lock.js';
import { readManifest } from '../../src/library/manifest.js';
import { runUpdate } from '../../src/library/update.js';
import { fakeGithub, type FakeSpec } from '../helpers/fakeGithub.js';
import { tmpDir } from '../helpers/tmp.js';
import { pull } from '../helpers/library.js';

const SHA1 = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const skill = (name: string, body: string) => `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}\n`;
const files = (v: string) => ({ 'skills/p/SKILL.md': skill('p', `p ${v}`), 'skills/u/SKILL.md': skill('u', `u ${v}`) });

async function setup() {
  const dir = await tmpDir();
  const repos: FakeSpec = { 'o/r': { refs: { main: SHA1 }, commits: { [SHA1]: files('v1'), [SHA2]: files('v2') } } };
  const github = fakeGithub(repos);
  const lib = join(dir, 'lib');
  const path = join(dir, 'config.jsonc');
  await writeFile(path, JSON.stringify({ registries: { r: { type: 'github', owner: 'o', repo: 'r', skills_dir: 'skills', ref: 'main' } } }));
  const cwd = join(dir, 'project'); const home = join(dir, 'home');
  await mkdir(cwd); await mkdir(join(home, '.claude'), { recursive: true });
  const ctx: Ctx = {
    env: { SKILLSEEKR_CONFIG: path, SKILLSEEKR_LIBRARY: lib }, home, cwd, http: github.http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => 1_700_000_000_000, githubApi: 'https://api.github.com',
  };
  await pull(ctx);
  const { catalog } = catalogFromManifest(lib, (await readManifest(lib))!);
  await installSkill(catalog.byId('p')!, 'project', ctx, { projectDir: cwd });
  await installSkill(catalog.byId('u')!, 'user', ctx);
  const projFile = join(cwd, '.claude', 'skills', 'p', 'SKILL.md');
  const userFile = join(home, '.claude', 'skills', 'u', 'SKILL.md');
  return { ctx, repos, lib, cwd, projFile, userFile, bump: () => { repos['o/r']!.refs.main = SHA2; } };
}

describe('runUpdate', () => {
  it('refreshes outdated project and user installs in one call; skips a modified one unless forced', async () => {
    const s = await setup();
    s.bump();
    await writeFile(s.userFile, 'local edit');
    const r = await runUpdate(s.ctx, { force: false, installs: true, projectDir: s.cwd });
    expect(r.aborted).toBe(false);
    expect(r).toMatchObject({ registries: 1, skills: 2 });
    expect(r.changes.map((c) => c.change)).toEqual(['changed', 'changed']);
    expect(r.installs.map((i) => [i.name, i.result]).sort()).toEqual([['p', 'updated'], ['u', 'skipped-modified']]);
    expect(await readFile(s.projFile, 'utf8')).toContain('p v2');
    expect(await readFile(s.userFile, 'utf8')).toBe('local edit');
    const f = await runUpdate(s.ctx, { force: true, installs: true, projectDir: s.cwd });
    expect(f.installs.find((i) => i.name === 'u')?.result).toBe('updated');
    expect(await readFile(s.userFile, 'utf8')).toContain('u v2');
  });

  it('installs: false leaves both installs untouched', async () => {
    const s = await setup();
    s.bump();
    const r = await runUpdate(s.ctx, { force: true, installs: false, projectDir: s.cwd });
    expect(r.installs).toEqual([]);
    expect(r.skills).toBe(2);
    expect(await readFile(s.projFile, 'utf8')).toContain('p v1');
    expect(await readFile(s.userFile, 'utf8')).toContain('u v1');
  });

  it('a held lock aborts with library/lock-busy', async () => {
    const s = await setup();
    const release = await acquireLock(s.lib, s.ctx);
    try {
      const r = await runUpdate(s.ctx, { force: false, installs: true, projectDir: s.cwd });
      expect(r.aborted).toBe(true);
      expect(r.problems.map((p) => [p.level, p.code])).toEqual([['error', 'library/lock-busy']]);
      expect(r.installs).toEqual([]);
    } finally { await release(); }
  });
});
