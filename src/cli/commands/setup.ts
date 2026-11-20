import { resolve } from 'node:path';
import type { Command } from 'commander';
import { DEFAULT_REGISTRY, SETUP_TOOLS, setup, type Change, type SetupTool } from '../../setup/setup.js';
import { CliError, isJson, printJson, reportProblems, type Cli, type Io } from '../output.js';
import { printInstallResults, printUpdateSummary } from './update.js';
import { doctorFailure, printDoctor } from './doctor.js';

interface SetupOpts { tools?: string; yes?: boolean; registry?: string; vscodeWorkspace?: string }

function parseTools(list: string | undefined): SetupTool[] | undefined {
  if (list === undefined) return undefined;
  const tools = list.split(',').map((t) => t.trim()).filter(Boolean);
  const unknown = tools.filter((t) => !(SETUP_TOOLS as string[]).includes(t));
  if (unknown.length > 0 || tools.length === 0) {
    throw new CliError(`--tools takes a comma-separated list of ${SETUP_TOOLS.join(', ')}${unknown.length ? `; unknown: ${unknown.join(', ')}` : ''}`);
  }
  return tools as SetupTool[];
}

function changeLines(changes: Change[]): string {
  return changes.map((c) => {
    if (c.command) return `  $ ${c.command}\n`;
    let s = `  ${c.file}\n      ${c.before ?? '(none)'}\n    → ${c.after ?? '(none)'}\n`;
    if (c.backup) s += `      backup: ${c.backup}\n`;
    return s;
  }).join('');
}

/** With --json, stdout carries only the result, so the preview goes to stderr. */
const confirmWith = (io: Io, json: boolean) => async (planned: Change[]): Promise<boolean> => {
  const preview = `skillseekr setup will make these changes:\n${changeLines(planned)}`;
  if (json) io.err(preview); else io.out(preview);
  if (!io.prompt) throw new CliError('setup needs confirmation; re-run with --yes');
  const answer = (await io.prompt('Apply these changes? [Y/n] ')).trim();
  return answer === '' || /^y(es)?$/i.test(answer);
};

const confirmUpdateWith = (io: Io) => async (): Promise<boolean> => {
  if (!io.prompt) return false;
  return /^y(es)?$/i.test((await io.prompt('Update the skill library now? [y/N] ')).trim());
};

export function registerSetup(program: Command, cli: Cli): void {
  program.command('setup').description('write the config if missing, register the MCP server and starter skill with each tool found, then run doctor')
    .option('--tools <list>', `comma-separated: ${SETUP_TOOLS.join(',')} (default: every tool found)`)
    .option('--yes', 'apply without asking')
    .option('--registry <owner/repo>', `registries file for a new config (default: ${DEFAULT_REGISTRY})`)
    .option('--vscode-workspace <dir>', "write <dir>/.vscode/mcp.json instead of VS Code's user mcp.json")
    .action(async (opts: SetupOpts, cmd: Command) => {
      const tools = parseTools(opts.tools);
      let result;
      try {
        result = await setup(cli.ctx, {
          yes: opts.yes === true,
          ...(tools ? { tools } : {}),
          ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
          ...(opts.vscodeWorkspace !== undefined ? { vscodeWorkspace: resolve(cli.ctx.cwd, opts.vscodeWorkspace) } : {}),
          confirm: confirmWith(cli.io, isJson(cmd)),
          confirmUpdate: confirmUpdateWith(cli.io),
        });
      } catch (e) {
        if (e instanceof CliError) throw e;
        throw new CliError(e instanceof Error ? e.message : String(e));
      }
      if (result.aborted) throw new CliError('setup aborted; nothing was changed');
      if (isJson(cmd)) printJson(cli.io, result);
      else {
        cli.io.out(result.changes.length ? `changed:\n${changeLines(result.changes)}` : 'nothing to change\n');
        cli.io.out('\nlibrary:\n');
        const u = result.update;
        if ('skipped' in u) cli.io.out("skipped; run 'skillseekr update' when you're ready\n");
        else {
          if (!u.aborted) printUpdateSummary(cli.io, u);
          reportProblems(cli.io, u.problems, u.stale);
          printInstallResults(cli.io, u, { text: true, none: false });
        }
        cli.io.out('\ndoctor:\n');
        printDoctor(cli.io, result.doctor);
      }
      if (isJson(cmd) && !('skipped' in result.update)) printInstallResults(cli.io, result.update, { text: false, none: false });
      for (const e of result.errors) cli.io.err(`setup: ${e}\n`);
      const failure = doctorFailure(result.doctor);
      if (failure) throw failure;
      if (result.errors.length > 0) throw new CliError(`setup could not finish for ${result.errors.length} ${result.errors.length === 1 ? 'item' : 'items'} (see above)`);
    });
}
