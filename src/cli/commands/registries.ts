import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { UnsafeWriteError, writeFileAtomic } from '../../atomicWrite.js';
import { addRegistry, removeRegistry } from '../../config/edit.js';
import { parseRegistriesFile } from '../../config/load.js';
import { configPath } from '../../paths.js';
import { CliError, blockingError, isJson, overrodeText, printJson, reportProblems, table, viaText, type Cli } from '../output.js';

const TYPES = ['github', 'http', 'github-registry', 'http-registry'] as const;
const AUTHS = ['none', 'gh_cli', 'github_token', 'bearer'] as const;

interface AddOpts {
  type?: string; owner?: string; repo?: string; ref?: string; skillsDir?: string; path?: string; url?: string;
  skillName?: string; description?: string; auth?: string; envVar?: string;
}

const FIELDS: Record<(typeof TYPES)[number], string[]> = {
  github: ['owner', 'repo', 'skills_dir', 'ref', 'description'],
  http: ['url', 'skill_name', 'description'],
  'github-registry': ['owner', 'repo', 'ref', 'path', 'description'],
  'http-registry': ['url', 'description'],
};

function buildEntry(o: AddOpts): Record<string, unknown> {
  if (!o.type || !(TYPES as readonly string[]).includes(o.type)) throw new CliError(`--type is required and must be one of: ${TYPES.join(', ')}`);
  const type = o.type as (typeof TYPES)[number];
  const values: Record<string, string | undefined> = {
    owner: o.owner, repo: o.repo, ref: o.ref, skills_dir: o.skillsDir, path: o.path, url: o.url,
    skill_name: o.skillName, description: o.description,
  };
  const entry: Record<string, unknown> = { type };
  for (const f of FIELDS[type]) if (values[f] !== undefined) entry[f] = values[f];
  if (o.auth !== undefined) {
    if (!(AUTHS as readonly string[]).includes(o.auth)) throw new CliError(`--auth must be one of: ${AUTHS.join(', ')}`);
    if (o.auth === 'github_token' || o.auth === 'bearer') {
      if (!o.envVar) throw new CliError(`--auth ${o.auth} needs --env-var <NAME>`);
      entry.auth = { type: o.auth, env_var: o.envVar };
    } else {
      entry.auth = { type: o.auth };
    }
  }
  return entry;
}

/** The shared atomic writer, with a refused (dangling symlink) target reported as a user error. */
export async function writeAtomic(file: string, data: string): Promise<void> {
  try {
    await writeFileAtomic(file, data);
  } catch (e) {
    if (e instanceof UnsafeWriteError) throw new CliError(e.message);
    throw e;
  }
}

export async function readConfigText(file: string, missing: string | undefined): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if (missing !== undefined && (e as NodeJS.ErrnoException).code === 'ENOENT') return missing;
    throw new CliError(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`, 2);
  }
}

/** Reads the local config for editing; refuses (exit 2) when it does not parse, so a broken file is never rewritten. */
export async function readEditable(file: string, missing: string): Promise<string> {
  const text = await readConfigText(file, missing);
  const bad = parseRegistriesFile(text, { file, isLocalConfig: true }).problems.filter((p) => p.code === 'config/parse-error');
  if (bad.length > 0) throw new CliError(`${file} does not parse; fix it before editing (${bad.map((p) => p.message).join('; ')})`, 2);
  return text;
}

/** Runs an edit helper, turning its errors into CliError. */
export function guardEdit<T>(file: string, fn: () => T): T {
  try { return fn(); } catch (e) { throw new CliError(`cannot edit ${file}: ${e instanceof Error ? e.message : String(e)}`); }
}

/** Re-checks the edited text, then writes it atomically. */
export async function writeEdited(file: string, next: string): Promise<void> {
  const bad = parseRegistriesFile(next, { file, isLocalConfig: true }).problems.filter((p) => p.code === 'config/parse-error');
  if (bad.length > 0) throw new CliError(`refusing to write ${file}: the edited config would not parse`);
  await writeAtomic(file, next);
}

function printRegistries(cli: Cli, r: Awaited<ReturnType<ReturnType<Cli['engine']>['registries']>>): void {
  const rows = [['NAME', 'TYPE', 'VIA', 'SKILLS', 'REF', 'SHA', 'NOTES']];
  for (const v of r.registries) {
    const notes = [v.stale ? 'stale' : '', ...(v.overrode ?? []).map((o) => overrodeText(o))].filter(Boolean).join('; ');
    rows.push([v.name, v.type, viaText(v.via), String(v.skillCount), v.ref ?? '-', v.sha ? v.sha.slice(0, 7) : '-', notes]);
  }
  cli.io.out(table(rows));
  for (const o of r.overrides) {
    cli.io.out(`override: ${o.kind} ${JSON.stringify(o.key)}: ${o.by.registry} (${viaText(o.by.via)}) replaces ${o.replaced.registry} (${viaText(o.replaced.via)})\n`);
  }
}

export function registerRegistries(program: Command, cli: Cli): void {
  const reg = program.command('registries').description('show the resolved registry list; add or remove personal registries')
    .action(async (_opts: unknown, cmd: Command) => {
      const r = await cli.engine().registries();
      reportProblems(cli.io, r.problems, r.registries.some((v) => v.stale));
      const blocked = await blockingError(cli, r.problems, r.registries.reduce((n, v) => n + v.skillCount, 0));
      if (isJson(cmd)) printJson(cli.io, r);
      else if (r.registries.length === 0) cli.io.out('no registries configured\n');
      else printRegistries(cli, r);
      if (blocked) throw blocked;
    });

  reg.command('add <name>').description("add a registry to the local config (keeps comments)")
    .option('--type <type>', TYPES.join(' | '))
    .option('--owner <owner>').option('--repo <repo>').option('--ref <ref>')
    .option('--skills-dir <dir>').option('--path <path>').option('--url <url>')
    .option('--skill-name <name>').option('--description <text>')
    .option('--auth <type>', AUTHS.join(' | ')).option('--env-var <NAME>', 'env var for github_token / bearer auth')
    .action(async (name: string, opts: AddOpts, cmd: Command) => {
      const entry = buildEntry(opts);
      const file = configPath(cli.ctx);
      const text = await readConfigText(file, '{ "registries": {} }\n');
      let next: string;
      try { next = addRegistry(text, name, entry); } catch (e) { throw new CliError(e instanceof Error ? e.message : String(e)); }
      const parsed = parseRegistriesFile(next, { file, isLocalConfig: true });
      const bad = parsed.problems.filter((p) => p.registry === name || p.code === 'config/parse-error');
      if (bad.length > 0 || !parsed.registries.some(([n]) => n === name)) {
        throw new CliError(`refusing to add "${name}": ${bad.length ? bad.map((p) => p.message).join('; ') : 'entry did not parse'}`);
      }
      await writeAtomic(file, next);
      if (isJson(cmd)) return printJson(cli.io, { added: name, file });
      cli.io.out(`added registry "${name}" to ${file}\n`);
    });

  reg.command('remove <name>').description('remove a registry from the local config (keeps comments)')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const file = configPath(cli.ctx);
      const text = await readConfigText(file, undefined);
      let next: string;
      try { next = removeRegistry(text, name); } catch (e) { throw new CliError(e instanceof Error ? e.message : String(e)); }
      await writeAtomic(file, next);
      if (isJson(cmd)) return printJson(cli.io, { removed: name, file });
      cli.io.out(`removed registry "${name}" from ${file}\n`);
    });
}
