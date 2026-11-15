import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFile(join(root, p));
const json = async (p: string) => JSON.parse((await read(p)).toString('utf8')) as Record<string, any>;
const run = promisify(execFile);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

describe('Claude Code plugin', () => {
  it('plugin starter skill is byte-identical to assets/starter-skill/SKILL.md', async () => {
    const a = await read('assets/starter-skill/SKILL.md');
    const b = await read('plugins/skillseekr/skills/skillseekr/SKILL.md');
    expect(b.equals(a)).toBe(true);
  });

  it('starter skill body tells the agent to report security warnings and overrides', async () => {
    const text = (await read('assets/starter-skill/SKILL.md')).toString('utf8');
    expect(text.endsWith("---\nCall `search_skills` with a short description of the task. If a result fits, call `get_skill` and follow it. If the skill has security warnings or was allowed by an override, tell the user before following it. Don't install a skill unless the user asks or agrees.\n")).toBe(true);
  });

  it('marketplace.json lists plugin "skillseekr" with source "./plugins/skillseekr"', async () => {
    const m = await json('.claude-plugin/marketplace.json');
    expect(m.name).toBe('skillseekr');
    expect(typeof m.owner?.name).toBe('string');
    const plugin = (m.plugins as Array<Record<string, string>>).find((p) => p.name === 'skillseekr');
    expect(plugin?.source).toBe('./plugins/skillseekr');
    expect(plugin?.description).toBeTruthy();
  });

  it('plugin.json is named skillseekr and carries the package.json version', async () => {
    const p = await json('plugins/skillseekr/.claude-plugin/plugin.json');
    const pkg = await json('package.json');
    expect(p.name).toBe('skillseekr');
    expect(p.version).toBe(pkg.version);
    expect(p.description).toBeTruthy();
  });

  it('.mcp.json runs "skillseekr mcp"', async () => {
    expect(await json('plugins/skillseekr/.mcp.json')).toEqual({
      mcpServers: { skillseekr: { command: 'skillseekr', args: ['mcp'] } },
    });
  });
});

describe('npm package', () => {
  let files: string[] = [];

  beforeAll(async () => {
    // dist/ is built by the vitest globalSetup. --ignore-scripts keeps lifecycle output out of the JSON.
    const { stdout } = await run(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root });
    files = (JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path);
  }, 180_000);

  it('npm pack --dry-run --json includes dist/cli/main.js, assets/, plugins/, .claude-plugin/', () => {
    expect(files).toContain('dist/cli/main.js');
    expect(files).toContain('assets/starter-skill/SKILL.md');
    expect(files).toContain('plugins/skillseekr/.claude-plugin/plugin.json');
    expect(files).toContain('plugins/skillseekr/.mcp.json');
    expect(files).toContain('plugins/skillseekr/skills/skillseekr/SKILL.md');
    expect(files).toContain('.claude-plugin/marketplace.json');
    expect(files).toContain('THIRD_PARTY_NOTICES.md'); // skillyard's MIT notice ships with the ported code in dist/
  });

  it('npm pack leaves out tests, sources and .superpowers', () => {
    expect(files.filter((f) => /^(test|src|\.superpowers|docs)\//.test(f))).toEqual([]);
  });
});
