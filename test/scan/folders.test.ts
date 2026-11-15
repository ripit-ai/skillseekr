import { describe, it, expect } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../../src/context.js';
import { defaultScanTargets } from '../../src/scan/folders.js';
import { tmpDir } from '../helpers/tmp.js';

async function ctxFor(home: string, env: Record<string, string> = {}): Promise<Ctx> {
  return { env, home, cwd: home, http: undefined as never, exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => 0, githubApi: '' };
}

describe('defaultScanTargets', () => {
  it('returns only existing folders: project, every tool, and plugin skill folders with labels', async () => {
    const home = await tmpDir();
    const project = join(home, 'proj');
    await mkdir(join(project, '.claude', 'skills'), { recursive: true });
    await mkdir(join(home, '.copilot', 'skills'), { recursive: true });
    await mkdir(join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0', 'skills', 'x'), { recursive: true });
    const t = await defaultScanTargets(await ctxFor(home), project);
    expect(t.map((x) => x.label)).toEqual(['project', 'copilot user', 'plugin p@1.0.0']);
    expect(t[2]!.dir).toBe(join(home, '.claude', 'plugins', 'cache', 'm', 'p', '1.0.0', 'skills'));
  });

  it('plugin walking is bounded: too deep, symlinked and non-skills folders are not found', async () => {
    const home = await tmpDir();
    const cache = join(home, '.claude', 'plugins', 'cache');
    await mkdir(join(cache, 'm', 'p', '1', 'a', 'b', 'c', 'skills'), { recursive: true }); // depth 8
    await mkdir(join(cache, 'm', 'p', '1', 'docs'), { recursive: true });
    const outside = join(home, 'outside', 'skills');
    await mkdir(outside, { recursive: true });
    await symlink(join(home, 'outside'), join(cache, 'm', 'link'));
    await writeFile(join(cache, 'm', 'file'), 'x');
    expect(await defaultScanTargets(await ctxFor(home), join(home, 'proj'))).toEqual([]);
  });

  it('the depth boundary is 6 and synced plugins are found', async () => {
    const home = await tmpDir();
    const base = join(home, '.claude', 'plugins');
    await mkdir(join(base, 'cache', 'a', 'b', 'c', 'd', 'skills'), { recursive: true }); // depth 6
    await mkdir(join(base, 'cache', 'a', 'b', 'c', 'd', 'e', 'skills'), { recursive: true }); // depth 7
    await mkdir(join(base, 'synced', 'sp', 'skills'), { recursive: true });
    const t = await defaultScanTargets(await ctxFor(home), join(home, 'proj'));
    expect(t.map((x) => x.dir)).toEqual([join(base, 'cache', 'a', 'b', 'c', 'd', 'skills'), join(base, 'synced', 'sp', 'skills')]);
  });

  it('plugin manifest skills (string or array) are targets; absolute, .. and symlinked paths are dropped; big manifests ignored', async () => {
    const home = await tmpDir();
    const plugins = join(home, '.claude', 'plugins', 'cache', 'm');
    const mk = async (name: string, manifest: string) => {
      const root = join(plugins, name, '1.0.0');
      await mkdir(join(root, '.claude-plugin'), { recursive: true });
      await writeFile(join(root, '.claude-plugin', 'plugin.json'), manifest);
      return root;
    };
    const one = await mk('one', JSON.stringify({ skills: './extra-skills/' }));
    await mkdir(join(one, 'extra-skills'));
    const two = await mk('two', JSON.stringify({ skills: ['./a', 'b/c', '../escape', '/abs', './link', './missing'] }));
    await mkdir(join(two, 'a'));
    await mkdir(join(two, 'b', 'c'), { recursive: true });
    await mkdir(join(home, 'secret'));
    await symlink(join(home, 'secret'), join(two, 'link'));
    await mkdir(join(plugins, 'escape'), { recursive: true });
    const big = await mk('big', JSON.stringify({ skills: './x', pad: 'y'.repeat(70 * 1024) }));
    await mkdir(join(big, 'x'));
    const dot = await mk('dot', JSON.stringify({ skills: '.' }));
    await writeFile(join(dot, 'SKILL.md'), '---\nname: dot\n---\n');
    const t = await defaultScanTargets(await ctxFor(home), join(home, 'proj'));
    expect(t.map((x) => [x.label, x.dir])).toEqual([
      ['plugin dot@1.0.0', dot],
      ['plugin one@1.0.0', join(one, 'extra-skills')],
      ['plugin two@1.0.0', join(two, 'a')],
      ['plugin two@1.0.0', join(two, 'b', 'c')],
    ]);
  });

  it('a relative or ~ CLAUDE_CODE_PLUGIN_CACHE_DIR is resolved', async () => {
    const home = await tmpDir();
    await mkdir(join(home, 'pl', 'cache', 'm', 'r', '3', 'skills'), { recursive: true });
    for (const v of ['~/pl', 'pl']) {
      const t = await defaultScanTargets(await ctxFor(home, { CLAUDE_CODE_PLUGIN_CACHE_DIR: v }), home);
      expect(t.map((x) => x.label)).toEqual(['plugin r@3']);
    }
  });

  it('CLAUDE_CODE_PLUGIN_CACHE_DIR moves the plugins root', async () => {
    const home = await tmpDir();
    const root = join(home, 'elsewhere');
    await mkdir(join(root, 'cache', 'm', 'q', '2', 'skills'), { recursive: true });
    const t = await defaultScanTargets(await ctxFor(home, { CLAUDE_CODE_PLUGIN_CACHE_DIR: root }), home);
    expect(t.map((x) => x.label)).toEqual(['plugin q@2']);
  });
});
