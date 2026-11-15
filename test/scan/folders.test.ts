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

  it('CLAUDE_CODE_PLUGIN_CACHE_DIR moves the plugins root', async () => {
    const home = await tmpDir();
    const root = join(home, 'elsewhere');
    await mkdir(join(root, 'cache', 'm', 'q', '2', 'skills'), { recursive: true });
    const t = await defaultScanTargets(await ctxFor(home, { CLAUDE_CODE_PLUGIN_CACHE_DIR: root }), home);
    expect(t.map((x) => x.label)).toEqual(['plugin q@2']);
  });
});
