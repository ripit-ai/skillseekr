import { createHash } from 'node:crypto';
import { safeSegments } from '../sources/github.js';
import type { IncludeEntry } from '../types.js';

export const STAGING = '.staging';
export const OLD_PREFIX = '.old-';

/** Normalised URL (scheme/host case, default port, dot segments); the raw string when it doesn't parse. */
export const normUrl = (u: string): string => { try { return new URL(u).href; } catch { return u; } };

export const urlHash = (url: string): string => createHash('sha256').update(normUrl(url)).digest('hex').slice(0, 16);

export const githubFolder = (owner: string, repo: string, ref: string): string =>
  `github/${owner}/${repo}@${encodeURIComponent(ref)}`;

export const httpFolder = (url: string, skillName: string): string => `http/${urlHash(url)}/${skillName}`;

/** Library-relative file for a fetched include, or undefined when its path is unsafe. */
export function includeFile(e: IncludeEntry): string | undefined {
  if (e.type === 'http-registry') return `registries/http/${urlHash(e.url)}.jsonc`;
  const segs = safeSegments(e.path);
  return segs ? `registries/${githubFolder(e.owner, e.repo, e.ref)}/${segs.join('/')}` : undefined;
}
