import { describe, it, expect } from 'vitest';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../src/context.js';
import { validatePath } from '../src/validate.js';
import { fakeGithub } from './helpers/fakeGithub.js';
import { tmpDir } from './helpers/tmp.js';

const SHA = 'e'.repeat(40);

async function env() {
  const dir = await tmpDir();
  const github = fakeGithub({
    'o/a': { refs: { main: SHA }, commits: { [SHA]: { 'registries.jsonc': JSON.stringify({ registries: {
      back: { type: 'github-registry', owner: 'o', repo: 'b', ref: 'main' },
      tok: { type: 'github', owner: 'o', repo: 'x', skills_dir: 's', ref: 'main', auth: { type: 'github_token', env_var: 'SECRET_IN_INCLUDE' } },
    } }) } } },
    'o/b': { refs: { main: SHA }, commits: { [SHA]: { 'registries.jsonc': JSON.stringify({ registries: {
      again: { type: 'github-registry', owner: 'o', repo: 'a', ref: 'main' },
    } }) } } },
  });
  const read: string[] = [];
  const envObj = new Proxy({} as Record<string, string | undefined>, {
    get: (_t, k) => { read.push(String(k)); return undefined; },
  });
  const ctx: Ctx = {
    env: envObj, home: dir, cwd: dir, http: github.http,
    exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => 1_700_000_000_000, githubApi: 'https://api.github.com',
  };
  return { dir, ctx, read };
}

async function skillDir(root: string, folder: string, md: string | undefined) {
  const d = join(root, folder);
  await mkdir(d, { recursive: true });
  if (md !== undefined) await writeFile(join(d, 'SKILL.md'), md);
  return d;
}

describe('validatePath', () => {
  it('validate on a skill dir flags missing name/description and a name/folder mismatch; on a registries file reports parse errors, loops, and untrusted env-var auth in includes', async () => {
    const e = await env();
    const codes = async (p: string) => (await validatePath(p, e.ctx)).problems.map((x) => `${x.level}:${x.code}`);

    expect(await codes(await skillDir(e.dir, 'good', '---\nname: good\ndescription: does good things\n---\nbody\n'))).toEqual([]);
    expect(await codes(await skillDir(e.dir, 'noname', '---\ndescription: d\n---\n'))).toEqual(['error:skill/missing-name']);
    expect(await codes(await skillDir(e.dir, 'nodesc', '---\nname: nodesc\n---\n'))).toEqual(['error:skill/missing-description']);
    expect(await codes(await skillDir(e.dir, 'folder', '---\nname: other\ndescription: d\n---\n'))).toEqual(['error:skill/name-mismatch']);
    expect(await codes(await skillDir(e.dir, 'nofm', 'just text\n'))).toEqual(['error:skill/missing-frontmatter']);
    expect(await codes(await skillDir(e.dir, 'empty', undefined))).toEqual(['error:skill/no-skill-md']);

    const bad = join(e.dir, 'bad.jsonc');
    await writeFile(bad, '{ "registries": { "x": ');
    const badProblems = (await validatePath(bad, e.ctx)).problems;
    expect(badProblems[0]).toMatchObject({ level: 'error', code: 'config/parse-error' });
    expect(badProblems[0]!.message).toContain(bad);

    const reg = join(e.dir, 'registries.jsonc');
    await writeFile(reg, JSON.stringify({ registries: {
      start: { type: 'github-registry', owner: 'o', repo: 'a', ref: 'main' },
      top: { type: 'http', url: 'https://x/SKILL.md', skill_name: 'x', auth: { type: 'bearer', env_var: 'TOP_SECRET' } },
    } }));
    const r = (await validatePath(reg, e.ctx)).problems;
    const codesR = r.map((x) => x.code);
    expect(codesR).toContain('resolve/include-loop');
    expect(r.filter((x) => x.code === 'auth/untrusted-env-auth').map((x) => x.registry).sort()).toEqual(['tok', 'top']);
    expect(e.read).not.toContain('SECRET_IN_INCLUDE');
    expect(e.read).not.toContain('TOP_SECRET');
  });

  it('reports a missing path and an unsupported file type', async () => {
    const e = await env();
    expect((await validatePath(join(e.dir, 'nope'), e.ctx)).problems[0]).toMatchObject({ level: 'error', code: 'validate/not-found' });
    const txt = join(e.dir, 'x.txt');
    await writeFile(txt, 'x');
    expect((await validatePath(txt, e.ctx)).problems[0]).toMatchObject({ level: 'error', code: 'validate/unsupported' });
  });

  it('validating a registries file with a reachable include creates nothing under the home or cache dirs', async () => {
    const e = await env();
    const home = join(e.dir, 'home');
    await mkdir(home);
    const reg = join(e.dir, 'ok.jsonc');
    await writeFile(reg, JSON.stringify({ registries: { start: { type: 'github-registry', owner: 'o', repo: 'b', ref: 'main' } } }));
    const r = (await validatePath(reg, { ...e.ctx, home })).problems;
    expect(r.map((x) => x.code)).toContain('resolve/include-loop');
    expect(await readdir(home)).toEqual([]);
    expect((await readdir(e.dir)).sort()).toEqual(['home', 'ok.jsonc']);
  });
});
