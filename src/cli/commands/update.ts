import type { Command } from 'commander';
import { runUpdate, type UpdateReport } from '../../library/update.js';
import { CliError, errorProblems, isJson, printJson, reportProblems, table, type Cli, type Io } from '../output.js';

const MARK = { added: '+', changed: '~', removed: '-' } as const;

/** The summary line and the per-skill change list of a finished (not aborted) update. */
export function printUpdateSummary(io: Io, report: UpdateReport): void {
  const n = (c: string) => report.changes.filter((x) => x.change === c).length;
  io.out(`updated ${report.registries} registries: ${n('added')} skills added, ${n('changed')} changed, ${n('removed')} removed\n`);
  for (const c of report.changes) io.out(`  ${MARK[c.change]} ${c.id} (${c.registry})\n`);
}

/** Install results: the table and hints (text mode only), failures and the missing-from-catalog hint (stderr, always). */
export function printInstallResults(io: Io, report: UpdateReport, o: { text: boolean; none: boolean }): void {
  const { installs } = report;
  if (o.text) {
    if (installs.length > 0) {
      io.out(table(installs.map((r) => [r.name, r.result, r.dir])));
      if (installs.some((r) => r.result === 'skipped-modified')) io.out('modified installs were skipped; use --force to overwrite them\n');
    } else if (o.none) io.out('no skills installed\n');
  }
  for (const f of installs.filter((r) => r.result === 'failed')) io.err(`${f.name}: ${f.message} (${f.dir})\n`);
  if (installs.some((r) => r.result === 'missing-from-catalog')) {
    io.err("hint: some installed skills are no longer in the catalog (registry removed, renamed or failing); check 'skillseekr registries'\n");
  }
}

export function registerUpdate(program: Command, cli: Cli): void {
  program.command('update [name]').description('pull the skill library from the registries and refresh installed skills')
    .option('--force', 'also overwrite locally modified installs')
    .option('--no-installs', 'update the library only; leave installed skills alone')
    .action(async (name: string | undefined, opts: { force?: boolean; installs?: boolean }, cmd: Command) => {
      const report = await runUpdate(cli.ctx, {
        ...(name !== undefined && { name }), force: opts.force === true, installs: opts.installs !== false, projectDir: cli.ctx.cwd,
      });
      const { installs } = report;
      const failed = installs.filter((r) => r.result === 'failed');
      if (isJson(cmd)) printJson(cli.io, report);
      else {
        if (!report.aborted) printUpdateSummary(cli.io, report);
        reportProblems(cli.io, report.problems, report.stale);
      }
      printInstallResults(cli.io, report, { text: !isJson(cmd), none: !report.aborted && opts.installs !== false && name === undefined });
      if (!report.aborted && name !== undefined && opts.installs !== false && installs.length === 0) throw new CliError(`"${name}" is not installed`);
      if (report.aborted || errorProblems(report.problems).length > 0) throw new CliError('the library update reported errors (see above)');
      if (failed.length > 0) throw new CliError(`${failed.length} skill(s) failed to update`);
    });
}
