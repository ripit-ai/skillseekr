#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { defaultContext, type Ctx } from '../context.js';
import { createEngine, type Engine } from '../engine.js';
import { registerInstall } from './commands/install.js';
import { registerList } from './commands/list.js';
import { registerMcp } from './commands/mcp.js';
import { registerOutdated } from './commands/outdated.js';
import { registerRegistries } from './commands/registries.js';
import { registerRemove } from './commands/remove.js';
import { registerSearch } from './commands/search.js';
import { registerShow } from './commands/show.js';
import { registerSync } from './commands/sync.js';
import { registerUpdate } from './commands/update.js';
import { CliError, type Cli, type Io } from './output.js';

export type { Io } from './output.js';

/** Command registrars. Task 13 appends setup, doctor and validate here. */
export const commands: Array<(program: Command, cli: Cli) => void> = [
  registerSearch, registerShow, registerInstall, registerRemove, registerList, registerOutdated,
  registerUpdate, registerRegistries, registerSync, registerMcp,
];

function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const v = (JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function buildProgram(ctx: Ctx, io: Io): Command {
  let engine: Engine | undefined;
  const cli: Cli = { ctx, io, engine: () => (engine ??= createEngine(ctx)) };
  const program = new Command('skillseekr')
    .description('find, inspect and install skills from registries')
    .version(version())
    .option('--config <path>', 'config file (default: $SKILLSEEKR_CONFIG or ~/.config/skillseekr/config.jsonc)')
    .option('--json', 'machine-readable output')
    .showHelpAfterError()
    .exitOverride()
    .configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) });
  program.hook('preAction', (_this, action) => {
    const path = action.optsWithGlobals().config as string | undefined;
    // R1: set on the injected ctx only (a copy of env), never on process.env.
    if (path) { ctx.env = { ...ctx.env, SKILLSEEKR_CONFIG: resolve(ctx.cwd, path) }; engine = undefined; }
  });
  for (const register of commands) register(program, cli);
  // Subcommands inherit the output and exit behaviour.
  const apply = (c: Command) => {
    for (const sub of c.commands) { sub.exitOverride().configureOutput({ writeOut: (s) => io.out(s), writeErr: (s) => io.err(s) }); apply(sub); }
  };
  apply(program);
  return program;
}

const stdIo: Io = { out: (s) => { process.stdout.write(s); }, err: (s) => { process.stderr.write(s); } };

export async function main(argv: string[], deps: { ctx?: Ctx; io?: Io } = {}): Promise<number> {
  const io = deps.io ?? stdIo;
  const program = buildProgram(deps.ctx ?? defaultContext(), io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) return e.exitCode === 0 ? 0 : 1;
    if (e instanceof CliError) { io.err(`error: ${e.message}\n`); return e.code; }
    io.err(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
}

function isEntryPoint(): boolean {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = await main(process.argv.slice(2));
