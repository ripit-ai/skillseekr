import type { Command } from 'commander';
import type { Catalog } from '../catalog/catalog.js';
import type { Ctx } from '../context.js';
import type { Engine } from '../engine.js';
import type { Problem } from '../types.js';

export interface Io { out(s: string): void; err(s: string): void }

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

export const errorProblems = (ps: Problem[]): Problem[] => ps.filter((p) => p.level === 'error');

const problemLine = (p: Problem): string => `${p.registry ? `${p.registry}: ` : ''}${p.message.replace(/\s*\n\s*/g, ' ')}`;

/** Error-level problems (one line each) and the stale warning go to stderr, never stdout. */
export function reportProblems(io: Io, problems: Problem[], stale: boolean): void {
  for (const p of errorProblems(problems)) io.err(problemLine(p) + '\n');
  if (stale) io.err(STALE_WARNING + '\n');
}

/**
 * Reports problems and stale state on stderr, then throws exit 2 when nothing could be loaded because of
 * them: a config/* error with nothing loaded, or registries configured and every one of them failed.
 */
export function reportAndGuard(io: Io, problems: Problem[], stale: boolean, registryNames: string[], skillTotal: number): void {
  reportProblems(io, problems, stale);
  if (skillTotal > 0) return;
  const errs = errorProblems(problems);
  const configBroken = errs.some((p) => p.code.startsWith('config/'));
  const allFailed = registryNames.length > 0 && registryNames.every((n) => errs.some((p) => p.registry === n));
  if (configBroken || allFailed) {
    throw new CliError(allFailed && !configBroken
      ? `every configured registry failed to load (${registryNames.join(', ')}); see the problems above`
      : 'the configuration prevents loading any skills (see the problems above)', 2);
  }
}

/** Loads the catalog, reports problems, and throws exit 2 if nothing usable could be loaded. */
export async function loadCatalog(cli: Cli, opts: { force?: boolean } = {}): Promise<Catalog> {
  const catalog = await cli.engine().catalog(opts);
  const { registries } = await cli.engine().registries();
  reportAndGuard(cli.io, catalog.problems, catalog.stale, registries.map((r) => r.name), catalog.skills.length);
  return catalog;
}

export function lookupOrThrow(catalog: Catalog, idOrName: string) {
  const l = catalog.lookup(idOrName);
  if (l.kind === 'found') return l.skill;
  if (l.kind === 'ambiguous') throw new CliError(`"${idOrName}" is ambiguous; use one of these ids:\n${l.ids.map((i) => `  ${i}`).join('\n')}`);
  const hits = catalog.search(idOrName, 3).map((h) => h.id);
  throw new CliError(`skill "${idOrName}" not found${hits.length ? `; did you mean: ${hits.join(', ')}` : ''}`);
}
