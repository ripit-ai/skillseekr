import type { Command } from 'commander';
import { installedRows, installedTable } from './list.js';
import { isJson, loadCatalog, printJson, type Cli } from '../output.js';

export function registerOutdated(program: Command, cli: Cli): void {
  program.command('outdated').description('list installed skills that are not current')
    .option('--user', 'check the personal skill folders instead of the project')
    .action(async (opts: { user?: boolean }, cmd: Command) => {
      const catalog = await loadCatalog(cli);
      const rows = (await installedRows(cli, catalog, opts.user)).filter((r) => r.status !== 'current');
      if (isJson(cmd)) return printJson(cli.io, { outdated: rows, stale: catalog.stale });
      cli.io.out(rows.length ? installedTable(rows) : 'everything is up to date\n');
    });
}
