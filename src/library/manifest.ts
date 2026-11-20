import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import type { DiscoveredSkill } from '../catalog/discover.js';
import type { IncludeEntry, Problem, SourceEntry } from '../types.js';
import type { Override } from '../resolve/resolve.js';

export const MANIFEST_VERSION = 1;

export interface ManifestSkill extends Omit<DiscoveredSkill, 'dir'> { dir: string /* relative to the library */ }
export interface SourceRecord {
  name: string; via: string[]; trusted: boolean; entry: SourceEntry; folder?: string; sha?: string;
  etag?: string; fetchedAt?: string; stale: boolean; skills: ManifestSkill[];
}
export interface IncludeRecord {
  name: string; via: string[]; entry: IncludeEntry; policy: boolean; stale: boolean;
  sha?: string; file?: string; textHash?: string; etag?: string; fetchedAt?: string;
}
export interface Manifest {
  version: 1; updatedAt: string; configHash: string;
  sources: SourceRecord[]; includes: IncludeRecord[]; overrides: Override[]; problems: Problem[];
}

export const manifestFile = (libDir: string): string => join(libDir, 'manifest.json');

const relPath = z.string().min(1).refine(
  (p) => !p.includes('\0') && !p.includes('\\') && !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.split('/').includes('..'),
  { message: 'must be a relative path without ".." segments' },
);
const auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('github_token'), env_var: z.string() }),
  z.object({ type: z.literal('gh_cli') }),
  z.object({ type: z.literal('bearer'), env_var: z.string() }),
  z.object({ type: z.literal('basic'), username_env_var: z.string(), password_env_var: z.string() }),
]);
const common = { auth, cache_enabled: z.boolean(), description: z.string().optional() };
const sourceEntry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('github'), owner: z.string(), repo: z.string(), skills_dir: z.string(), ref: z.string(), instructions: z.string().optional(), ...common }),
  z.object({ type: z.literal('http'), url: z.string(), skill_name: z.string(), instructions: z.string().optional(), ...common }),
]);
const includeEntry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('github-registry'), owner: z.string(), repo: z.string(), ref: z.string(), path: z.string(), policy: z.boolean(), ...common }),
  z.object({ type: z.literal('http-registry'), url: z.string(), policy: z.boolean(), ...common }),
]);
const problem = z.object({
  level: z.enum(['error', 'warning']), code: z.string(), message: z.string(),
  registry: z.string().optional(), via: z.array(z.string()).optional(), file: z.string().optional(),
});
const ref = z.object({ registry: z.string(), via: z.array(z.string()) });
const skill = z.object({
  id: z.string(), name: z.string(), description: z.string(), dir: relPath,
  files: z.array(z.string()), contentHash: z.string(), warnings: z.array(z.string()),
});
const manifestSchema = z.object({
  version: z.literal(MANIFEST_VERSION), updatedAt: z.string(), configHash: z.string(),
  sources: z.array(z.object({
    name: z.string(), via: z.array(z.string()), trusted: z.boolean(), entry: sourceEntry,
    folder: relPath.optional(), sha: z.string().optional(), etag: z.string().optional(),
    fetchedAt: z.string().optional(), stale: z.boolean(), skills: z.array(skill),
  })),
  includes: z.array(z.object({
    name: z.string(), via: z.array(z.string()), entry: includeEntry, policy: z.boolean(), stale: z.boolean(),
    sha: z.string().optional(), file: relPath.optional(), textHash: z.string().optional(),
    etag: z.string().optional(), fetchedAt: z.string().optional(),
  })),
  overrides: z.array(z.object({ kind: z.enum(['registry', 'skill']), key: z.string(), replaced: ref, by: ref })),
  problems: z.array(problem),
});

export async function readManifest(libDir: string): Promise<Manifest | undefined> {
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(await readFile(manifestFile(libDir), 'utf8')));
    return parsed.success ? (parsed.data as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

export async function writeManifest(libDir: string, m: Manifest): Promise<void> {
  const file = manifestFile(libDir);
  await mkdir(libDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, JSON.stringify(m, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
