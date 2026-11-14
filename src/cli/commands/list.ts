import type { Command } from 'commander';
import type { Catalog } from '../../catalog/catalog.js';
import { listInstalled, statusOf } from '../../install/installer.js';
import { isJson, loadCatalog, printJson, table, viaText, type Cli } from '../output.js';

export async function installedRows(cli: Cli, catalog: Catalog, user: boolean | undefined) {
  const items = await listInstalled(cli.ctx, { scope: user ? 'user' : 'project', projectDir: cli.ctx.cwd });
  return items.map((i) => ({
    name: i.name, id: i.marker.id, scope: i.scope, tool: i.tool ?? '-', status: statusOf(i, catalog),
    registry: i.marker.registry, via: i.marker.via, dir: i.dir,
  }));
}

export const installedTable = (rows: Awaited<ReturnType<typeof installedRows>>): string =>
  table([['NAME', 'SCOPE', 'TOOL', 'STATUS', 'REGISTRY', 'VIA'], ...rows.map((r) => [r.name, r.scope, r.tool, r.status, r.registry, viaText(r.via)])]);

export function registerList(program: Command, cli: Cli): void {
  program.command('list').description('list installed skills and whether each is out of date')
    .option('--user', 'list the personal skill folders instead of the project')
    .action(async (opts: { user?: boolean }, cmd: Command) => {
      const catalog = await loadCatalog(cli);
      const rows = await installedRows(cli, catalog, opts.user);
      if (isJson(cmd)) return printJson(cli.io, { installed: rows, stale: catalog.stale });
      cli.io.out(rows.length ? installedTable(rows) : 'no skills installed\n');
    });
}
