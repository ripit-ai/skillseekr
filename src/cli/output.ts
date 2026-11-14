import type { Command } from 'commander';
import type { Catalog } from '../catalog/catalog.js';
import type { Ctx } from '../context.js';
import type { Engine } from '../engine.js';
import type { Problem } from '../types.js';

export interface Io {
  out(s: string): void; err(s: string): void;
  /** Asks one question and resolves with the answer line (setup's confirmation). Defaults to reading stdin. */
  prompt?(question: string): Promise<string>;
}

/** Everything a command needs. Task 13's commands register against the same shape. */
export interface Cli { ctx: Ctx; io: Io; engine(): Engine }

/** An expected failure: printed as `error: <message>` on stderr, exit code `code` (1 user error, 2 config/registry). */
export class CliError extends Error {
  constructor(message: string, public code: 1 | 2 = 1) { super(message); this.name = 'CliError'; }
}

export const STALE_WARNING = "warning: catalog may be stale (offline or failing sources); run 'skillseekr doctor'";

export const isJson = (cmd: Command): boolean => cmd.optsWithGlobals().json === true;

export function printJson(io: Io, data: unknown): void { io.out(JSON.stringify(data, null, 2) + '\n'); }

export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  return rows.map((r) => r.map((cell, c) => (c === r.length - 1 ? cell : cell.padEnd(widths[c]!))).join('  ').trimEnd()).join('\n') + '\n';
}

export const viaText = (via: string[]): string => via.join(' → ');

/** "overrides <registry> (via a → b)": what a skill or registry replaced. */
export const overrodeText = (o: { registry: string; via: string[] }): string => `overrides ${o.registry} (via ${viaText(o.via)})`;

export const errorProblems = (ps: Problem[]): Problem[] => ps.filter((p) => p.level === 'error');

const problemLine = (p: Problem): string => `${p.registry ? `${p.registry}: ` : ''}${p.message.replace(/\s*\n\s*/g, ' ')}`;

/** Error-level problems (one line each) and the stale warning go to stderr, never stdout. */
export function reportProblems(io: Io, problems: Problem[], stale: boolean): void {
  for (const p of errorProblems(problems)) io.err(problemLine(p) + '\n');
  if (stale) io.err(STALE_WARNING + '\n');
}

/**
 * The error to throw (exit 2) when nothing could be loaded: a config/* error with 0 skills, or every
 * top-level entry of the local config failed (an error problem naming it) with 0 skills.
 * Failed includes are dropped from resolution, so this works from the config's own entry names.
 */
export async function blockingError(cli: Cli, problems: Problem[], skillTotal: number): Promise<CliError | undefined> {
  if (skillTotal > 0) return undefined;
  const errs = errorProblems(problems);
  if (errs.some((p) => p.code.startsWith('config/'))) {
    return new CliError('the configuration prevents loading any skills (see the problems above)', 2);
  }
  const names = (await cli.engine().config()).registries.map(([n]) => n);
  if (names.length > 0 && names.every((n) => errs.some((p) => p.registry === n))) {
    return new CliError(`every configured registry failed to load (${names.join(', ')}); see the problems above`, 2);
  }
  return undefined;
}

/** Loads the catalog, reports problems, and throws exit 2 if nothing usable could be loaded. */
export async function loadCatalog(cli: Cli, opts: { force?: boolean } = {}): Promise<Catalog> {
  const catalog = await cli.engine().catalog(opts);
  reportProblems(cli.io, catalog.problems, catalog.stale);
  const blocked = await blockingError(cli, catalog.problems, catalog.skills.length);
  if (blocked) throw blocked;
  return catalog;
}

export function lookupOrThrow(catalog: Catalog, idOrName: string) {
  const l = catalog.lookup(idOrName);
  if (l.kind === 'found') return l.skill;
  if (l.kind === 'ambiguous') throw new CliError(`"${idOrName}" is ambiguous; use one of these ids:\n${l.ids.map((i) => `  ${i}`).join('\n')}`);
  const hits = catalog.search(idOrName, 3).map((h) => h.id);
  throw new CliError(`skill "${idOrName}" not found${hits.length ? `; did you mean: ${hits.join(', ')}` : ''}`);
}
