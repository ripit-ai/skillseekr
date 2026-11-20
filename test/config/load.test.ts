import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRegistriesFile, loadConfig } from '../../src/config/load.js';
import type { GithubEntry, GithubRegistryEntry, HttpEntry } from '../../src/types.js';
import type { Ctx } from '../../src/context.js';

const mkCtx = (env: Record<string, string | undefined>, home = '/home/u'): Ctx => ({
  env, home, cwd: '/w', http: { get: async () => { throw new Error('unexpected http request'); } }, exec: async () => ({ code: 0, stdout: '', stderr: '' }),
  now: () => 0, githubApi: 'https://api.github.com',
});
const opts = { file: 'f', isLocalConfig: true };

describe('parseRegistriesFile', () => {
  it('preserves file order, including digit-only keys', () => {
    const f = parseRegistriesFile(`{ "registries": { "b": {"type":"http","url":"https://x/SKILL.md","skill_name":"b"},
      "10": {"type":"http","url":"https://y/SKILL.md","skill_name":"ten"},
      "a": {"type":"http","url":"https://z/SKILL.md","skill_name":"a"}, } }`, opts);
    expect(f.registries.map(([n]) => n)).toEqual(['b', '10', 'a']);
  });

  it('accepts a skills-mcp format example config', () => {
    // Mirrors the documented skills-mcp config format (written by hand, not copied).
    const f = parseRegistriesFile(`{
      // skills-mcp style config
      "registries": {
        "team-skills": { "type": "github", "owner": "acme", "repo": "skills", "skills_dir": "skills", "ref": "main",
          "description": "Team skills" },
        "private-skills": { "type": "github", "owner": "acme", "repo": "private", "skills_dir": "", "ref": "v1.2.0",
          "auth": { "type": "github_token", "env_var": "GITHUB_TOKEN" } },
        "one-skill": { "type": "http", "url": "https://example.com/tdd/SKILL.md", "skill_name": "tdd" }
      }
    }`, opts);
    expect(f.registries).toHaveLength(3);
    expect(f.problems.filter((p) => p.level === 'error')).toEqual([]);
    const [a, b, c] = f.registries.map(([, e]) => e);
    expect((a as GithubEntry).auth).toEqual({ type: 'none' });
    expect(a.cache_enabled).toBe(true);
    expect((b as GithubEntry).auth).toEqual({ type: 'github_token', env_var: 'GITHUB_TOKEN' });
    expect((c as HttpEntry).auth).toEqual({ type: 'none' });
    expect(c.cache_enabled).toBe(true);
  });

  it('defaults github auth to none and cache_enabled to true', () => {
    const f = parseRegistriesFile(`{"registries":{"g":{"type":"github","owner":"o","repo":"r","skills_dir":"s","ref":"main"}}}`, opts);
    const e = f.registries[0][1] as GithubEntry;
    expect(e.auth).toEqual({ type: 'none' });
    expect(e.cache_enabled).toBe(true);
  });

  it('defaults github-registry path to registries.jsonc and policy to false', () => {
    const f = parseRegistriesFile(`{"registries":{"x":{"type":"github-registry","owner":"o","repo":"r","ref":"main"}}}`, opts);
    const e = f.registries[0][1] as GithubRegistryEntry;
    expect(e.path).toBe('registries.jsonc');
    expect(e.policy).toBe(false);
  });

  it('honours policy:true in the local config', () => {
    const f = parseRegistriesFile(`{"registries":{"x":{"type":"github-registry","owner":"o","repo":"r","ref":"main","policy":true}}}`, opts);
    expect((f.registries[0][1] as GithubRegistryEntry).policy).toBe(true);
  });

  it('ignores policy:true when not the local config', () => {
    const f = parseRegistriesFile(`{"registries":{"x":{"type":"github-registry","owner":"o","repo":"r","ref":"main","policy":true}}}`, { file: 'inc', isLocalConfig: false });
    expect((f.registries[0][1] as GithubRegistryEntry).policy).toBe(false);
  });

  it('reports an unknown type as an error problem naming the entry and file, and skips it', () => {
    const f = parseRegistriesFile(`{"registries":{"bad":{"type":"ftp"},"ok":{"type":"http","url":"https://x/SKILL.md","skill_name":"ok"}}}`, { file: '/c.jsonc', isLocalConfig: true });
    expect(f.registries.map(([n]) => n)).toEqual(['ok']);
    expect(f.problems).toContainEqual(expect.objectContaining({ level: 'error', code: 'config/invalid-entry', registry: 'bad', file: '/c.jsonc' }));
  });

  it('reports a non-object entry as invalid', () => {
    const f = parseRegistriesFile(`{"registries":{"bad":42}}`, opts);
    expect(f.registries).toEqual([]);
    expect(f.problems).toContainEqual(expect.objectContaining({ code: 'config/invalid-entry', registry: 'bad' }));
  });

  it('reports a JSONC syntax error with file and offset, returning no registries', () => {
    const f = parseRegistriesFile(`{"registries": {"a": }`, { file: '/bad.jsonc', isLocalConfig: true });
    expect(f.registries).toEqual([]);
    expect(f.problems[0]).toMatchObject({ level: 'error', code: 'config/parse-error', file: '/bad.jsonc' });
    expect(f.problems[0].message).toMatch(/offset \d+/);
  });

  it('handles empty registries and a missing registries key', () => {
    expect(parseRegistriesFile(`{"registries":{}}`, opts)).toEqual({ registries: [], problems: [] });
    expect(parseRegistriesFile(`{}`, opts).registries).toEqual([]);
  });
});

describe('loadConfig', () => {
  it('on a missing file returns exists:false, no registries, and no throw', async () => {
    const cfg = await loadConfig(mkCtx({ SKILLSEEKR_CONFIG: '/nonexistent/c.jsonc' }));
    expect(cfg.exists).toBe(false);
    expect(cfg.registries).toEqual([]);
    expect(cfg.problems).toContainEqual({ level: 'error', code: 'config/missing', message: expect.any(String), file: '/nonexistent/c.jsonc' });
  });

  it('cache.dir "~/x" expands to home/x', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ss-'));
    const p = join(d, 'c.jsonc');
    writeFileSync(p, `{"registries":{},"cache":{"enabled":false,"ttl_seconds":10,"dir":"~/x"}}`);
    const cfg = await loadConfig(mkCtx({ SKILLSEEKR_CONFIG: p }, '/home/me'));
    expect(cfg.exists).toBe(true);
    expect(cfg.cache).toEqual({ enabled: false, ttlSeconds: 10, dir: '/home/me/x' });
  });

  it('default cache dir honours XDG_CACHE_HOME and defaults enabled/ttl', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ss-'));
    const p = join(d, 'c.jsonc');
    writeFileSync(p, `{"registries":{}}`);
    const cfg = await loadConfig(mkCtx({ SKILLSEEKR_CONFIG: p, XDG_CACHE_HOME: '/xc' }));
    expect(cfg.cache).toEqual({ enabled: true, ttlSeconds: 3600, dir: '/xc/skillseekr' });
  });

  it('reports a parse error in an existing file', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ss-'));
    const p = join(d, 'c.jsonc');
    writeFileSync(p, `{ nope`);
    const cfg = await loadConfig(mkCtx({ SKILLSEEKR_CONFIG: p }));
    expect(cfg.exists).toBe(true);
    expect(cfg.problems[0]).toMatchObject({ code: 'config/parse-error', file: p });
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '  \n\t \n'],
    ['comments-only', '// nothing here yet\n/* still nothing */\n'],
  ])('%s config file yields a parse-error problem with the file path, no throw', async (_n, content) => {
    const d = mkdtempSync(join(tmpdir(), 'ss-'));
    const p = join(d, 'c.jsonc');
    writeFileSync(p, content);
    const cfg = await loadConfig(mkCtx({ SKILLSEEKR_CONFIG: p }));
    expect(cfg.exists).toBe(true);
    expect(cfg.registries).toEqual([]);
    expect(cfg.problems).toHaveLength(1);
    expect(cfg.problems[0]).toMatchObject({ level: 'error', code: 'config/parse-error', file: p });
    expect(cfg.problems[0].message).toContain(p);
  });

  it('parses a config file with a BOM', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ss-'));
    const p = join(d, 'c.jsonc');
    writeFileSync(p, '\uFEFF{"registries":{"a":{"type":"http","url":"https://x/SKILL.md","skill_name":"a"}}}');
    const cfg = await loadConfig(mkCtx({ SKILLSEEKR_CONFIG: p }));
    expect(cfg.problems).toEqual([]);
    expect(cfg.registries.map(([n]) => n)).toEqual(['a']);
  });

  it('parses a config file with CRLF line endings and comments', async () => {
    const d = mkdtempSync(join(tmpdir(), 'ss-'));
    const p = join(d, 'c.jsonc');
    writeFileSync(p, '{\r\n // c\r\n "registries": {\r\n  "a": {"type":"http","url":"https://x/SKILL.md","skill_name":"a"},\r\n }\r\n}\r\n');
    const cfg = await loadConfig(mkCtx({ SKILLSEEKR_CONFIG: p }));
    expect(cfg.problems).toEqual([]);
    expect(cfg.registries.map(([n]) => n)).toEqual(['a']);
  });
});

describe('loadConfig library.dir', () => {
  const withConfig = (text?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'skillseekr-lib-'));
    const p = join(dir, 'c.jsonc');
    if (text !== undefined) writeFileSync(p, text);
    return p;
  };
  it('reads library.dir, expanding ~', async () => {
    const p = withConfig('{ "library": { "dir": "~/mylib" }, "registries": {} }');
    expect((await loadConfig(mkCtx({ SKILLSEEKR_CONFIG: p }))).libraryDir).toBe('/home/u/mylib');
  });
  it('defaults with no config file', async () => {
    const p = withConfig();
    expect((await loadConfig(mkCtx({ SKILLSEEKR_CONFIG: p }))).libraryDir).toBe('/home/u/.skillseekr/library');
  });
});
