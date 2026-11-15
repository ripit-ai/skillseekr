import { readFile } from 'node:fs/promises';
import { parseTree, getNodeValue, printParseErrorCode, type Node, type ParseError } from 'jsonc-parser';
import { z } from 'zod';
import type { Auth, Config, Problem, RegistriesFile, RegistryEntry } from '../types.js';
import type { Ctx } from '../context.js';
import { parsePolicy } from '../policy/parse.js';
import { emptyPolicyBlock as emptyPolicy } from '../policy/types.js';
import { configPath, defaultCacheDir, expandHome } from '../paths.js';

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

const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  ttl_seconds: z.number().nonnegative().default(3600),
  dir: z.string().optional(),
});

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
  if (!root) return { file: { registries: [], problems, policy: emptyPolicy() } };
  const f = parseRegistries(root, problems, opts);
  const pol = parsePolicy(root, opts.file);
  f.problems.push(...pol.problems);
  f.policy = pol.policy;
  return { root, file: f };
}

function parseRegistries(root: Node, problems: Problem[], opts: { file: string; isLocalConfig: boolean }): RegistriesFile {
  const { file, isLocalConfig } = opts;
  if (root.type !== 'object') {
    return { registries: [], problems: [{ level: 'error', code: 'config/parse-error', file, message: `${file}: top level must be an object (offset ${root.offset})` }], policy: emptyPolicy() };
  }
  const regs = child(root, 'registries');
  const registries: Array<[string, RegistryEntry]> = [];
  const policy = emptyPolicy();
  if (!regs) return { registries, problems, policy };
  if (regs.type !== 'object') {
    problems.push({ level: 'error', code: 'config/invalid-entry', file, message: `${file}: "registries" must be an object` });
    return { registries, problems, policy };
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
  return { registries, problems, policy };
}

export async function loadConfig(ctx: Ctx): Promise<Config> {
  const path = configPath(ctx);
  const defaults = { enabled: true, ttlSeconds: 3600, dir: defaultCacheDir(ctx) };
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const missing = err.code === 'ENOENT' || err.code === 'ENOTDIR';
    return {
      path, exists: false, registries: [], policy: emptyPolicy(), cache: defaults,
      problems: [{
        level: 'error', code: missing ? 'config/missing' : 'config/unreadable', file: path,
        message: missing ? `Config file not found: ${path} (run \`skillseekr setup\`)` : `Cannot read config ${path}: ${err.message}`,
      }],
    };
  }
  const { root, file } = parseInternal(text, { file: path, isLocalConfig: true });
  const cache = { ...defaults };
  const cacheNode = root && root.type === 'object' ? child(root, 'cache') : undefined;
  if (cacheNode) {
    const c = cacheSchema.safeParse(getNodeValue(cacheNode));
    if (c.success) {
      cache.enabled = c.data.enabled;
      cache.ttlSeconds = c.data.ttl_seconds;
      if (c.data.dir) cache.dir = expandHome(c.data.dir, ctx.home);
    } else {
      file.problems.push({ level: 'error', code: 'config/invalid-entry', file: path, message: `${path}: invalid "cache" section (${c.error.issues.map((i) => i.message).join('; ')})` });
    }
  }
  return { path, exists: true, registries: file.registries, problems: file.problems, policy: file.policy, cache };
}
