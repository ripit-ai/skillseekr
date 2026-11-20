import { describe, it, expect } from 'vitest';
import { githubFolder, httpFolder, includeFile, urlHash, STAGING, OLD_PREFIX } from '../../src/library/layout.js';
import type { GithubRegistryEntry, HttpRegistryEntry } from '../../src/types.js';

const base = { auth: { type: 'none' as const }, cache_enabled: true, policy: false };
const gh = (path: string): GithubRegistryEntry => ({ type: 'github-registry', owner: 'o', repo: 'r', ref: 'main', path, ...base });
const web = (url: string): HttpRegistryEntry => ({ type: 'http-registry', url, ...base });

describe('layout', () => {
  it('githubFolder encodes the ref', () => {
    expect(githubFolder('o', 'r', 'feature/x')).toBe('github/o/r@feature%2Fx');
    expect(githubFolder('o', 'r', 'main')).not.toBe(githubFolder('o', 'r', 'dev'));
  });
  it('includeFile rejects unsafe paths, names github and http files', () => {
    expect(includeFile(gh('../x'))).toBeUndefined();
    expect(includeFile(gh('a/b.jsonc'))).toBe('registries/github/o/r@main/a/b.jsonc');
    const f = includeFile(web('https://h/a'))!;
    expect(f).toMatch(/^registries\/http\/[0-9a-f]{16}\.jsonc$/);
  });
  it('httpFolder normalises the url', () => {
    expect(httpFolder('HTTP://Host/a', 's')).toBe(httpFolder('http://host/a', 's'));
    expect(httpFolder('http://host/a', 's')).toBe(`http/${urlHash('http://host/a')}/s`);
  });
  it('constants', () => {
    expect(STAGING).toBe('.staging');
    expect(OLD_PREFIX).toBe('.old-');
  });
});
