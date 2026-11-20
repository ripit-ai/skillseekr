import { describe, it, expect } from 'vitest';
import { configPath, expandHome, libraryDir } from '../src/paths.js';
import type { Ctx } from '../src/context.js';

const mk = (env: Record<string, string | undefined>): Ctx =>
  ({ env, home: '/home/u', cwd: '/w', http: { get: async () => { throw new Error('unexpected http request'); } }, exec: async () => ({ code: 0, stdout: '', stderr: '' }), now: () => 0, githubApi: 'https://api.github.com' });

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

describe('expandHome', () => {
  it('expands ~ only at the start', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/x', '/h')).toBe('/h/x');
    expect(expandHome('/a/~/x', '/h')).toBe('/a/~/x');
  });
});

describe('libraryDir', () => {
  it('env wins over config', () => {
    expect(libraryDir(mk({ SKILLSEEKR_LIBRARY: '/e/lib' }), '/c/lib')).toBe('/e/lib');
  });
  it('config expands ~', () => {
    expect(libraryDir(mk({}), '~/x')).toBe('/home/u/x');
  });
  it('defaults to ~/.skillseekr/library', () => {
    expect(libraryDir(mk({}))).toBe('/home/u/.skillseekr/library');
  });
});
