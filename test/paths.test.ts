import { describe, it, expect } from 'vitest';
import { configPath, defaultCacheDir, expandHome } from '../src/paths.js';
import type { Ctx } from '../src/context.js';

const mk = (env: Record<string, string | undefined>): Ctx =>
  ({ env, home: '/home/u', cwd: '/w', http: {}, exec: async () => ({ code: 0, stdout: '', stderr: '' }), now: () => 0, githubApi: 'https://api.github.com' });

describe('configPath', () => {
  it('SKILLSEEKR_CONFIG wins', () => {
    expect(configPath(mk({ SKILLSEEKR_CONFIG: '/x/c.jsonc', XDG_CONFIG_HOME: '/xdg' }))).toBe('/x/c.jsonc');
  });
  it('then XDG_CONFIG_HOME', () => {
    expect(configPath(mk({ XDG_CONFIG_HOME: '/xdg' }))).toBe('/xdg/skillseekr/config.jsonc');
  });
  it('then ~/.config', () => {
    expect(configPath(mk({}))).toBe('/home/u/.config/skillseekr/config.jsonc');
  });
});

describe('defaultCacheDir / expandHome', () => {
  it('honours XDG_CACHE_HOME, else ~/.cache', () => {
    expect(defaultCacheDir(mk({ XDG_CACHE_HOME: '/xc' }))).toBe('/xc/skillseekr');
    expect(defaultCacheDir(mk({}))).toBe('/home/u/.cache/skillseekr');
  });
  it('expands ~ only at the start', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/x', '/h')).toBe('/h/x');
    expect(expandHome('/a/~/x', '/h')).toBe('/a/~/x');
  });
});
