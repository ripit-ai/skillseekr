import { readFile, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { parseFrontmatter } from './catalog/frontmatter.js';
import { parseRegistriesFile } from './config/load.js';
import type { Ctx } from './context.js';
import { defaultCacheDir } from './paths.js';
import { resolve } from './resolve/resolve.js';
import type { Config, Problem, RegistryEntry } from './types.js';

const err = (code: string, message: string, file?: string): Problem => ({ level: 'error', code, message, ...(file ? { file } : {}) });
const usesEnvAuth = (e: RegistryEntry) => e.auth.type === 'github_token' || e.auth.type === 'bearer' || e.auth.type === 'basic';

async function validateSkillDir(dir: string): Promise<Problem[]> {
  const file = join(dir, 'SKILL.md');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [err('skill/no-skill-md', `${dir} has no SKILL.md, so it is not a skill folder`, file)];
  }
  const fm = parseFrontmatter(text);
  if (!fm.ok) return [err('skill/missing-frontmatter', `${file}: no YAML frontmatter (a leading "---" block with name and description)`, file)];
  const problems: Problem[] = [];
  const name = typeof fm.data.name === 'string' ? fm.data.name.trim() : '';
  const folder = basename(dir);
  if (name === '') problems.push(err('skill/missing-name', `${file}: frontmatter has no "name"`, file));
  else if (name !== folder) problems.push(err('skill/name-mismatch', `${file}: frontmatter name "${name}" does not match the folder name "${folder}"`, file));
  if (typeof fm.data.description !== 'string' || fm.data.description.trim() === '') {
    problems.push(err('skill/missing-description', `${file}: frontmatter has no "description"`, file));
  }
  return problems;
}

/**
 * Validates a registries file as if it were included (untrusted): parse problems, entries whose env-var auth
 * would be skipped, and what resolving its includes reports (loops, depth, unreachable files, untrusted auth).
 * No environment variable is ever read: env-auth entries are reported and dropped before resolution.
 */
async function validateRegistriesFile(file: string, ctx: Ctx): Promise<Problem[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    return [err('validate/unreadable', `cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`, file)];
  }
  const parsed = parseRegistriesFile(text, { file, isLocalConfig: false });
  const problems: Problem[] = [...parsed.problems];
  const kept: Array<[string, RegistryEntry]> = [];
  for (const [name, entry] of parsed.registries) {
    if (usesEnvAuth(entry)) {
      problems.push({
        level: 'warning', code: 'auth/untrusted-env-auth', registry: name, via: [name], file,
        message: `registry "${name}" uses ${entry.auth.type} auth; when this file is included, only gh_cli or no auth is allowed, so the entry would be skipped`,
      });
    } else {
      kept.push([name, entry]);
    }
  }
  if (problems.some((p) => p.code === 'config/parse-error')) return problems;

  const config: Config = {
    path: file, exists: true, registries: kept, problems: [],
    cache: { enabled: true, ttlSeconds: 3600, dir: defaultCacheDir(ctx) },
  };
  // An empty env as a second guard: nothing resolved here may read the caller's environment.
  const res = await resolve(config, { force: false }, { ...ctx, env: {} });
  return [...problems, ...res.problems];
}

/** Validates a skill folder, or a registries `.json`/`.jsonc` file. */
export async function validatePath(p: string, ctx: Ctx): Promise<{ problems: Problem[] }> {
  let isDir: boolean;
  try {
    isDir = (await stat(p)).isDirectory();
  } catch {
    return { problems: [err('validate/not-found', `${p} does not exist`)] };
  }
  if (isDir) return { problems: await validateSkillDir(p) };
  const ext = extname(p).toLowerCase();
  if (ext === '.json' || ext === '.jsonc') return { problems: await validateRegistriesFile(p, ctx) };
  return { problems: [err('validate/unsupported', `${p}: expected a skill folder or a registries .json/.jsonc file`, p)] };
}
