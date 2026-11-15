import { describe, it, expect } from 'vitest';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Ctx, Exec, ExecResult } from '../../src/context.js';
import { setup } from '../../src/setup/setup.js';
import { createKeyPair } from '../../src/sign/sign.js';
import { parse as parseJsonc } from 'jsonc-parser';
import { claudeRegistrar } from '../../src/setup/registrars/claude.js';
import { readJsonValue } from '../../src/setup/jsonMerge.js';
import { opencodeRegistrar } from '../../src/setup/registrars/opencode.js';
import { listInstalled } from '../../src/install/installer.js';
import { fakeGithub } from '../helpers/fakeGithub.js';
import { tmpDir } from '../helpers/tmp.js';

const SHA = 'c'.repeat(40);
const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'nope'): ExecResult => ({ code: 1, stdout: '', stderr });

/** A stateful stand-in for the `claude` binary. Never runs anything real. */
function fakeClaude(o: { binary?: boolean; plugin?: boolean; marketplaceFails?: boolean; pluginDisabled?: boolean } = {}) {
  const calls: string[] = [];
  const state = { plugin: o.pluginDisabled === true, mcp: false };
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd !== 'claude' || o.binary === false) return { code: 127, stdout: '', stderr: 'ENOENT' };
    const a = args.join(' ');
    if (a === '--version') return ok('2.1.300 (Claude Code)\n');
    if (a === 'plugin list --json') {
      if (!o.plugin) return bad("error: unknown command 'plugin'");
      return ok(JSON.stringify(state.plugin ? [{ id: 'skillseekr@skillseekr', version: '0.1.0', scope: 'user', enabled: !o.pluginDisabled, installPath: '/x' }] : []));
    }
    if (a === 'plugin marketplace add ripit-ai/skillseekr') return o.plugin && !o.marketplaceFails ? ok() : bad('Failed to clone marketplace repository');
    if (a === 'plugin install skillseekr@skillseekr --scope user') {
      if (!o.plugin) return bad("error: unknown command 'plugin'");
      state.plugin = true;
      return ok();
    }
    if (a === 'mcp get skillseekr') return state.mcp ? ok('skillseekr:\n  Scope: User\n') : bad('No MCP server found with name: skillseekr');
    if (a === 'mcp add --scope user skillseekr -- skillseekr mcp') { state.mcp = true; return ok(); }
    return bad(`unexpected: ${a}`);
  };
  return { exec, calls, state };
}

async function env(o: { tools?: string[]; claude?: ReturnType<typeof fakeClaude> } = {}) {
  const home = await tmpDir();
  const tools = o.tools ?? ['.claude', '.config/opencode', '.copilot', '.vscode-server'];
  for (const t of tools) await mkdir(join(home, t), { recursive: true });
  const github = fakeGithub({
    'ripit-ai/agent-skills': { refs: { main: SHA }, commits: { [SHA]: { 'registries.jsonc': '{ "registries": {} }' } } },
    'acme/skills': { refs: { main: SHA }, commits: { [SHA]: { 'registries.jsonc': '{ "registries": {} }' } } },
  });
  const claude = o.claude ?? fakeClaude({ plugin: true });
  const ctx: Ctx = {
    env: {}, home, cwd: join(home, 'project'), http: github.http, exec: claude.exec,
    now: () => 1_700_000_000_000, githubApi: 'https://api.github.com',
  };
  return { home, ctx, claude, configFile: join(home, '.config', 'skillseekr', 'config.jsonc') };
}

async function mtimes(root: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  async function walk(d: string) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (relative(root, p).startsWith('.cache')) continue;
        await walk(p);
      } else out[relative(root, p)] = (await stat(p)).mtimeMs;
    }
  }
  await walk(root);
  return out;
}

describe('setup', () => {
  it('setup writes the default config when missing and leaves an existing config untouched', async () => {
    const e = await env();
    const r = await setup(e.ctx, { yes: true });
    const text = await readFile(e.configFile, 'utf8');
    expect(text).toContain('"owner": "ripit-ai"');
    expect(text).toContain('"repo": "agent-skills"');
    expect(r.changes.some((c) => c.file === e.configFile)).toBe(true);

    const e2 = await env();
    await mkdir(join(e2.home, '.config', 'skillseekr'), { recursive: true });
    const mine = '// mine\n{ "registries": {} }\n';
    await writeFile(e2.configFile, mine);
    const r2 = await setup(e2.ctx, { yes: true });
    expect(await readFile(e2.configFile, 'utf8')).toBe(mine);
    expect(r2.changes.some((c) => c.file === e2.configFile)).toBe(false);
  });

  it('setup --registry acme/skills writes that owner/repo', async () => {
    const e = await env();
    await setup(e.ctx, { yes: true, registry: 'acme/skills' });
    const text = await readFile(e.configFile, 'utf8');
    expect(text).toContain('"owner": "acme"');
    expect(text).toContain('"repo": "skills"');
    await expect(setup(e.ctx, { yes: true, registry: 'not-a-repo' })).rejects.toThrow(/owner\/repo/);
  });

  it('setup registers only detected tools', async () => {
    const e = await env({ tools: ['.config/opencode'], claude: fakeClaude({ binary: false }) });
    const r = await setup(e.ctx, { yes: true });
    expect(await readJsonValue(join(e.home, '.config/opencode/opencode.json'), ['mcp', 'skillseekr']))
      .toEqual({ type: 'local', command: ['skillseekr', 'mcp'], enabled: true });
    expect(await readJsonValue(join(e.home, '.config/opencode/opencode.json'), ['mcp', 'servers'])).toBeUndefined();
    await expect(stat(join(e.home, '.copilot'))).rejects.toThrow();
    await expect(stat(join(e.home, '.vscode-server'))).rejects.toThrow();
    expect(r.changes.some((c) => c.command?.startsWith('claude'))).toBe(false);
    expect(e.claude.calls.filter((c) => c.startsWith('claude ') && c !== 'claude --version')).toEqual([]);
    expect(r.doctor.checks.map((c) => c.id)).toContain('mcp:opencode');
    expect(r.doctor.checks.map((c) => c.id)).not.toContain('mcp:copilot');

    // --tools narrows further, even when more tools are present.
    const e2 = await env();
    const r2 = await setup(e2.ctx, { yes: true, tools: ['copilot'] });
    expect(await readJsonValue(join(e2.home, '.copilot/mcp-config.json'), ['mcpServers', 'skillseekr']))
      .toEqual({ type: 'local', command: 'skillseekr', args: ['mcp'], tools: ['*'] });
    await expect(stat(join(e2.home, '.config/opencode/opencode.json'))).rejects.toThrow();
    expect(r2.changes.some((c) => c.command !== undefined)).toBe(false);
  });

  it('setup writes each tool config in its documented shape and keeps existing keys', async () => {
    const e = await env();
    await writeFile(join(e.home, '.copilot/mcp-config.json'), '{ "mcpServers": { "other": { "type": "local", "command": "x", "args": [], "tools": ["*"] } } }');
    await setup(e.ctx, { yes: true });
    expect(await readJsonValue(join(e.home, '.copilot/mcp-config.json'), ['mcpServers', 'other'])).toMatchObject({ command: 'x' });
    expect(await readJsonValue(join(e.home, '.vscode-server/data/User/mcp.json'), ['servers', 'skillseekr']))
      .toEqual({ type: 'stdio', command: 'skillseekr', args: ['mcp'] });
    const backups = (await readdir(join(e.home, '.copilot'))).filter((f) => f.startsWith('mcp-config.json.skillseekr-backup-'));
    expect(backups).toHaveLength(1);
  });

  it('setup --vscode-workspace writes <dir>/.vscode/mcp.json', async () => {
    const e = await env({ tools: [] , claude: fakeClaude({ binary: false }) });
    const ws = join(e.home, 'ws');
    await setup(e.ctx, { yes: true, vscodeWorkspace: ws });
    expect(await readJsonValue(join(ws, '.vscode/mcp.json'), ['servers', 'skillseekr']))
      .toEqual({ type: 'stdio', command: 'skillseekr', args: ['mcp'] });
  });

  it('setup twice changes nothing the second time', async () => {
    for (const plugin of [true, false]) {
      const e = await env({ claude: fakeClaude({ plugin }) });
      const first = await setup(e.ctx, { yes: true });
      expect(first.changes.length).toBeGreaterThan(0);
      const before = await mtimes(e.home);
      const second = await setup(e.ctx, { yes: true });
      expect(second.changes).toEqual([]);
      expect(await mtimes(e.home)).toEqual(before);
      expect(e.claude.calls.filter((c) => /plugin install|mcp add|marketplace add/.test(c))).toHaveLength(plugin ? 2 : 1);
    }
  });

  it('setup installs the starter skill into each present tool\'s user dir', async () => {
    // Fallback route: Claude gets the starter skill in ~/.claude/skills too.
    const e = await env({ claude: fakeClaude({ plugin: false }) });
    await setup(e.ctx, { yes: true });
    for (const d of ['.claude/skills', '.config/opencode/skills', '.copilot/skills']) {
      const md = await readFile(join(e.home, d, 'skillseekr', 'SKILL.md'), 'utf8');
      expect(md).toContain('name: skillseekr');
      const marker = JSON.parse(await readFile(join(e.home, d, 'skillseekr', '.skillseekr.json'), 'utf8'));
      expect(marker).toMatchObject({ id: 'skillseekr', name: 'skillseekr', registry: 'builtin' });
    }
    const listed = await listInstalled(e.ctx, { scope: 'user' });
    expect(listed.map((i) => i.tool).sort()).toEqual(['claude', 'copilot', 'opencode']);
    expect(listed.every((i) => !i.modified)).toBe(true);

    // R4: the plugin bundles the starter skill, so ~/.claude/skills gets none.
    const p = await env({ claude: fakeClaude({ plugin: true }) });
    await setup(p.ctx, { yes: true });
    await expect(stat(join(p.home, '.claude/skills/skillseekr'))).rejects.toThrow();
    await stat(join(p.home, '.copilot/skills/skillseekr/SKILL.md'));

    // An unmarked folder named skillseekr is never touched, and doctor warns.
    const u = await env({ tools: ['.copilot'], claude: fakeClaude({ binary: false }) });
    await mkdir(join(u.home, '.copilot/skills/skillseekr'), { recursive: true });
    await writeFile(join(u.home, '.copilot/skills/skillseekr/SKILL.md'), 'mine');
    const ru = await setup(u.ctx, { yes: true });
    expect(await readFile(join(u.home, '.copilot/skills/skillseekr/SKILL.md'), 'utf8')).toBe('mine');
    const w = ru.doctor.checks.find((c) => c.id === 'skills-dir:copilot');
    expect(w).toMatchObject({ status: 'warn' });
    expect(w!.message).toMatch(/marker/);
  });

  it('claude registrar uses plugin commands when available, falls back to mcp add', async () => {
    const e = await env({ claude: fakeClaude({ plugin: true }) });
    const reg = claudeRegistrar();
    expect(await reg.detect(e.ctx)).toBe(true);
    expect(await reg.isRegistered(e.ctx)).toBe(false);
    const changes = await reg.register(e.ctx, { yes: true });
    expect(changes.map((c) => c.command)).toEqual([
      'claude plugin marketplace add ripit-ai/skillseekr',
      'claude plugin install skillseekr@skillseekr --scope user',
    ]);
    expect(changes.map((c) => c.route)).toEqual(['plugin', 'plugin']);
    expect(e.claude.calls).not.toContain('claude mcp add --scope user skillseekr -- skillseekr mcp');
    expect(await reg.isRegistered(e.ctx)).toBe(true);
    expect(await reg.register(e.ctx, { yes: true })).toEqual([]);

    const f = await env({ claude: fakeClaude({ plugin: false }) });
    const changes2 = await reg.register(f.ctx, { yes: true });
    expect(changes2.map((c) => c.command)).toEqual(['claude mcp add --scope user skillseekr -- skillseekr mcp']);
    expect(changes2.map((c) => c.route)).toEqual(['mcp']);
    expect((await reg.register(f.ctx, { yes: true, dryRun: true }))).toEqual([]);
    const fd = await env({ claude: fakeClaude({ plugin: false }) });
    expect((await reg.register(fd.ctx, { yes: true, dryRun: true })).map((c) => c.route)).toEqual(['mcp']);
    expect(await reg.isRegistered(f.ctx)).toBe(true);

    // Plugin commands exist but the marketplace can't be added: fall back to mcp add.
    const m = await env({ claude: fakeClaude({ plugin: true, marketplaceFails: true }) });
    expect((await reg.register(m.ctx, { yes: true })).map((c) => c.command)).toEqual(['claude mcp add --scope user skillseekr -- skillseekr mcp']);
    expect(await reg.route(m.ctx)).toBe('mcp');

    const n = await env({ claude: fakeClaude({ binary: false }) });
    expect(await reg.detect(n.ctx)).toBe(false);
  });

  it('without --yes asks once; declining writes nothing', async () => {
    const e = await env();
    const asked: number[] = [];
    const r = await setup(e.ctx, { yes: false, confirm: async (changes) => { asked.push(changes.length); return false; } });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toBeGreaterThan(0);
    expect(r.aborted).toBe(true);
    expect(r.changes).toEqual([]);
    await expect(stat(e.configFile)).rejects.toThrow();
    expect(e.claude.calls.filter((c) => /install|add/.test(c))).toEqual([]);

    const r2 = await setup(e.ctx, { yes: false, confirm: async () => true });
    expect(r2.changes.length).toBeGreaterThan(0);
    // Nothing left to do: no question.
    const r3 = await setup(e.ctx, { yes: false, confirm: async () => { throw new Error('should not ask'); } });
    expect(r3.changes).toEqual([]);
  });

  it('setup reports an unreadable registry by name through doctor (AC-2)', async () => {
    const e = await env();
    const r = await setup(e.ctx, { yes: true, registry: 'acme/private' });
    const fail = r.doctor.checks.find((c) => c.status === 'fail');
    expect(fail?.id).toBe('registry:acme');
    expect(fail?.message).toContain('acme');
  });

  it('opencode: writes the v1-compatible mcp.skillseekr and accepts an existing entry in either shape', async () => {
    const reg = opencodeRegistrar();
    for (const existing of [
      { mcp: { servers: { skillseekr: { type: 'local', command: ['skillseekr', 'mcp'] } } } },
      { mcp: { skillseekr: { type: 'local', command: ['skillseekr', 'mcp'], enabled: true } } },
    ]) {
      const e = await env({ tools: ['.config/opencode'], claude: fakeClaude({ binary: false }) });
      const file = join(e.home, '.config/opencode/opencode.json');
      await writeFile(file, JSON.stringify(existing));
      const before = (await stat(file)).mtimeMs;
      expect(await reg.isRegistered(e.ctx)).toBe(true);
      expect(await reg.register(e.ctx, { yes: true })).toEqual([]);
      const r = await setup(e.ctx, { yes: true, tools: ['opencode'] });
      expect(r.changes.some((c) => c.file === file)).toBe(false);
      expect((await stat(file)).mtimeMs).toBe(before);
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(existing);
      expect(r.doctor.checks.find((c) => c.id === 'mcp:opencode')?.status).toBe('ok');
    }
  });

  it('a disabled Claude plugin counts as the plugin route: no reinstall, doctor warns', async () => {
    const e = await env({ claude: fakeClaude({ plugin: true, pluginDisabled: true }) });
    const reg = claudeRegistrar();
    expect(await reg.route(e.ctx)).toBe('plugin');
    expect(await reg.register(e.ctx, { yes: true })).toEqual([]);
    const r = await setup(e.ctx, { yes: true });
    expect(e.claude.calls.filter((c) => /plugin install|mcp add|marketplace add/.test(c))).toEqual([]);
    await expect(stat(join(e.home, '.claude/skills/skillseekr'))).rejects.toThrow();
    const c = r.doctor.checks.find((x) => x.id === 'mcp:claude');
    expect(c?.status).toBe('warn');
    expect(c?.message).toMatch(/disabled/);
    expect((await setup(e.ctx, { yes: true })).changes).toEqual([]);
  });

  it('a config that appears between plan and apply is left alone and setup continues', async () => {
    const e = await env();
    const theirs = '{ "registries": {} }\n';
    const r = await setup(e.ctx, {
      yes: false,
      confirm: async () => {
        await mkdir(join(e.home, '.config', 'skillseekr'), { recursive: true });
        await writeFile(e.configFile, theirs);
        return true;
      },
    });
    expect(await readFile(e.configFile, 'utf8')).toBe(theirs);
    expect(r.changes.some((c) => c.file === e.configFile)).toBe(false);
    expect(r.changes.some((c) => c.file?.endsWith('mcp-config.json'))).toBe(true);
    expect(r.doctor.checks.length).toBeGreaterThan(0);
  });

  it('setup --trust writes the trust entry with the default config, and a second run changes nothing', async () => {
    const e = await env();
    const a = createKeyPair().publicKey;
    const b = createKeyPair().publicKey;
    const trust = [`ripit-ai=${a}`, `acme=${b}`];
    const first = await setup(e.ctx, { yes: true, trust });
    const cfg = parseJsonc(await readFile(e.configFile, 'utf8')) as { registries: object; trust: Array<{ owner: string; public_keys: string[] }> };
    expect(Object.keys(cfg.registries)).toEqual(['ripit-ai']);
    expect(cfg.trust).toEqual([{ owner: 'ripit-ai', public_keys: [a] }, { owner: 'acme', public_keys: [b] }]);
    expect(first.changes.some((c) => c.file === e.configFile && c.after?.startsWith('trust:'))).toBe(true);
    const before = await readFile(e.configFile, 'utf8');
    const mtime = (await stat(e.configFile)).mtimeMs;
    const second = await setup(e.ctx, { yes: true, trust });
    expect(second.changes).toEqual([]);
    expect(await readFile(e.configFile, 'utf8')).toBe(before);
    expect((await stat(e.configFile)).mtimeMs).toBe(mtime);
  });

  it('setup --trust merges keys for the same owner without duplicates and keeps comments', async () => {
    const e = await env();
    const a = createKeyPair().publicKey;
    const b = createKeyPair().publicKey;
    await mkdir(join(e.home, '.config', 'skillseekr'), { recursive: true });
    await writeFile(e.configFile, `// mine\n{ "registries": {}, "trust": [{ "owner": "Acme", "public_keys": ["${a}"] }] }\n`);
    await setup(e.ctx, { yes: true, trust: [`acme=${a}`, `acme=${b}`] });
    const text = await readFile(e.configFile, 'utf8');
    expect(text.startsWith('// mine')).toBe(true);
    expect((parseJsonc(text) as { trust: unknown }).trust).toEqual([{ owner: 'acme', public_keys: [a, b] }]);
  });

  it('T12: setup --trust merges into a config that appeared between plan and apply, never over it', async () => {
    const e = await env();
    const k = createKeyPair().publicKey;
    const theirs = '// theirs\n{ "registries": { "mine": { "type": "github", "owner": "me", "repo": "r", "skills_dir": "s", "ref": "main" } } }\n';
    const r = await setup(e.ctx, {
      yes: false, trust: [`acme=${k}`],
      confirm: async () => {
        await mkdir(join(e.home, '.config', 'skillseekr'), { recursive: true });
        await writeFile(e.configFile, theirs);
        return true;
      },
    });
    const text = await readFile(e.configFile, 'utf8');
    expect(text.startsWith('// theirs')).toBe(true);
    const cfg = parseJsonc(text) as { registries: object; trust: unknown };
    expect(Object.keys(cfg.registries)).toEqual(['mine']);
    expect(cfg.trust).toEqual([{ owner: 'acme', public_keys: [k] }]);
    expect(r.errors).toEqual([]);
  });

  it('T12: setup --trust leaves an unparseable config that appeared alone and reports it', async () => {
    const e = await env();
    const k = createKeyPair().publicKey;
    const theirs = '{ "registries": { broken\n';
    const r = await setup(e.ctx, {
      yes: false, trust: [`acme=${k}`],
      confirm: async () => {
        await mkdir(join(e.home, '.config', 'skillseekr'), { recursive: true });
        await writeFile(e.configFile, theirs);
        return true;
      },
    });
    expect(await readFile(e.configFile, 'utf8')).toBe(theirs);
    expect(r.errors).toEqual([expect.stringContaining('trust was not added')]);
    expect(r.changes.some((c) => c.after?.startsWith('trust:'))).toBe(false);
  });

  it('setup --trust with a bad key or spec throws and writes nothing', async () => {
    const e = await env();
    await expect(setup(e.ctx, { yes: true, trust: ['acme=ed25519:not-a-key'] })).rejects.toThrow(/invalid public key/);
    await expect(setup(e.ctx, { yes: true, trust: ['no-equals'] })).rejects.toThrow(/--trust must be/);
    await expect(stat(e.configFile)).rejects.toThrow();
    expect(e.claude.calls.filter((c) => /install|add/.test(c))).toEqual([]);
  });
});
