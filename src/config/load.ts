import { readFile } from 'node:fs/promises';
import { parseTree, getNodeValue, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import type { Auth, Config, Problem, RegistriesFile, RegistryEntry } from '../types.js';
import type { Ctx } from '../context.js';
import { configPath, libraryDir, relativeLibraryValues } from '../paths.js';

const authSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('github_token'), env_var: z.string().min(1) }),
  z.object({ type: z.literal('gh_cli') }),
  z.object({ type: z.literal('bearer'), env_var: z.string().min(1) }),
  z.object({ type: z.literal('basic'), username_env_var: z.string().min(1), password_env_var: z.string().min(1) }),
]);
const authField = authSchema.default({ type: 'none' }) as z.ZodType<Auth>;
const common = { auth: authField, cache_enabled: z.boolean().default(true), description: z.string().optional() };

const entrySchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('github'), owner: z.string().min(1), repo: z.string().min(1),
    skills_dir: z.string(), ref: z.string().min(1), instructions: z.string().optional(), ...common,
  }),
  z.object({
    type: z.literal('http'), url: z.string().min(1), skill_name: z.string().min(1),
    instructions: z.string().optional(), ...common,
  }),
  z.object({
    type: z.literal('github-registry'), owner: z.string().min(1), repo: z.string().min(1),
    ref: z.string().min(1), path: z.string().min(1).default('registries.jsonc'),
    policy: z.boolean().default(false), ...common,
  }),
  z.object({
    type: z.literal('http-registry'), url: z.string().min(1), policy: z.boolean().default(false), ...common,
  }),
]);

const librarySchema = z.object({ dir: z.string().min(1).optional() });

function lineOf(text: string, offset: number): string {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const col = offset - before.lastIndexOf('\n');
  return `line ${line}, column ${col}`;
}

function parseRoot(text: string, file: string): { root?: Node; problems: Problem[] } {
  const errors: ParseError[] = [];
  const root = parseTree(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0 || !root) {
    const problems = errors.length
      ? errors.map((e): Problem => ({
        level: 'error', code: 'config/parse-error', file,
        message: `${file}: ${printParseErrorCode(e.error)} at offset ${e.offset} (${lineOf(text, e.offset)})`,
      }))
      : [{ level: 'error', code: 'config/parse-error', file, message: `${file}: empty file (offset 0)` } as Problem];
    return { problems };
  }
  return { root, problems: [] };
}

function child(obj: Node, key: string): Node | undefined {
  return obj.children?.find((p) => p.type === 'property' && p.children?.[0]?.value === key)?.children?.[1];
}

export function parseRegistriesFile(text: string, opts: { file: string; isLocalConfig: boolean }): RegistriesFile {
  return parseInternal(text, opts).file;
}

function parseInternal(text: string, opts: { file: string; isLocalConfig: boolean }): { root?: Node; file: RegistriesFile } {
  const { root, problems } = parseRoot(text, opts.file);
  if (!root) return { file: { registries: [], problems } };
  return { root, file: parseRegistries(root, problems, opts) };
}

function parseRegistries(root: Node, problems: Problem[], opts: { file: string; isLocalConfig: boolean }): RegistriesFile {
  const { file, isLocalConfig } = opts;
  if (root.type !== 'object') {
    return { registries: [], problems: [{ level: 'error', code: 'config/parse-error', file, message: `${file}: top level must be an object (offset ${root.offset})` }] };
  }
  const regs = child(root, 'registries');
  const registries: Array<[string, RegistryEntry]> = [];
  if (!regs) return { registries, problems };
  if (regs.type !== 'object') {
    problems.push({ level: 'error', code: 'config/invalid-entry', file, message: `${file}: "registries" must be an object` });
    return { registries, problems };
  }
  for (const prop of regs.children ?? []) {
    const name = String(prop.children?.[0]?.value);
    const valueNode = prop.children?.[1];
    const parsed = entrySchema.safeParse(valueNode ? getNodeValue(valueNode) : undefined);
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message)).join('; ');
      problems.push({
        level: 'error', code: 'config/invalid-entry', registry: name, file,
        message: `${file}: registry "${name}" is invalid (${detail})`,
      });
      continue;
    }
    const entry = parsed.data as RegistryEntry;
    if (!isLocalConfig && (entry.type === 'github-registry' || entry.type === 'http-registry')) entry.policy = false;
    registries.push([name, entry]);
  }
  return { registries, problems };
}

export async function loadConfig(ctx: Ctx): Promise<Config> {
  const path = configPath(ctx);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const missing = err.code === 'ENOENT' || err.code === 'ENOTDIR';
    return {
      path, exists: false, registries: [], libraryDir: libraryDir(ctx),
      problems: [{
        level: 'error', code: missing ? 'config/missing' : 'config/unreadable', file: path,
        message: missing ? `Config file not found: ${path} (run \`skillseekr setup\`)` : `Cannot read config ${path}: ${err.message}`,
      }, ...relativeLibraryProblems(ctx, path)],
    };
  }
  const { root, file } = parseInternal(text, { file: path, isLocalConfig: true });
  // The library replaced the cache: the section is still accepted, but has no effect.
  if (root && root.type === 'object' && child(root, 'cache')) {
    file.problems.push({ level: 'warning', code: 'config/cache-ignored', file: path, message: `${path}: the "cache" section no longer has any effect and can be removed; skills come from the library, which changes only on 'skillseekr update'` });
  }
  let configuredLib: string | undefined;
  const libNode = root && root.type === 'object' ? child(root, 'library') : undefined;
  if (libNode) {
    const l = librarySchema.safeParse(getNodeValue(libNode));
    if (l.success) configuredLib = l.data.dir;
    else file.problems.push({ level: 'error', code: 'config/invalid-entry', file: path, message: `${path}: invalid "library" section (${l.error.issues.map((i) => i.message).join('; ')})` });
  }
  file.problems.push(...relativeLibraryProblems(ctx, path, configuredLib));
  return { path, exists: true, registries: file.registries, problems: file.problems, libraryDir: libraryDir(ctx, configuredLib) };
}

/** A relative library path would land wherever the process happens to run: rejected, the default is used. */
const relativeLibraryProblems = (ctx: Ctx, path: string, configured?: string): Problem[] =>
  relativeLibraryValues(ctx, configured).map(({ from, value }) => ({
    level: 'error', code: 'config/invalid-entry', file: path,
    message: `${from} ${JSON.stringify(value)} is not an absolute path; using the default library ${libraryDir({ ...ctx, env: {} })}`,
  }));
