import type { Command } from 'commander';
import type { Catalog } from '../../catalog/catalog.js';
import { blockedReason } from '../../catalog/catalog.js';
import { listInstalled, statusOf } from '../../install/installer.js';
import { removeHint } from '../../install/security.js';
import { allowedText, isJson, loadCatalog, printJson, table, viaText, type Cli } from '../output.js';

export async function installedRows(cli: Cli, catalog: Catalog, user: boolean | undefined) {
  const items = await listInstalled(cli.ctx, { scope: user ? 'user' : 'project', projectDir: cli.ctx.cwd, catalog });
  return items.map((i) => ({
    name: i.name, id: i.marker.id, scope: i.scope, tool: i.tool ?? '-',
    status: i.security?.status === 'blocked' ? 'blocked' : statusOf(i, catalog),
    security: i.security?.status ?? 'clean',
    ...(i.security?.allowedBy && { allowedBy: i.security.allowedBy.label, allowedRules: i.security.allowedBy.rules }),
    registry: i.marker.registry, via: i.marker.via, dir: i.dir, item: i,
  }));
}

/** A blocked installed copy: why, and how to remove it, on stderr. */
export function reportBlockedCopies(cli: Cli, rows: Awaited<ReturnType<typeof installedRows>>): void {
  for (const r of rows) {
    if (r.item.security?.status === 'blocked') cli.io.err(`${r.name}: installed copy is blocked: ${blockedReason(r.item.security)}. ${removeHint(r.item)}\n`);
  }
}

const publicRow = ({ item: _item, ...rest }: Awaited<ReturnType<typeof installedRows>>[number]) => rest;
export const publicRows = (rows: Awaited<ReturnType<typeof installedRows>>) => rows.map(publicRow);

export const installedTable = (rows: Awaited<ReturnType<typeof installedRows>>): string =>
  table([['NAME', 'SCOPE', 'TOOL', 'STATUS', 'SECURITY', 'REGISTRY', 'VIA'], ...rows.map((r) => [r.name, r.scope, r.tool, r.status, securityText(r), r.registry, viaText(r.via)])]);

/** The SECURITY cell: the status, and for an allowed copy who allowed it and which rules (P2-5). */
const securityText = (r: { security: string; allowedBy?: string; allowedRules?: string[] }): string =>
  r.allowedBy !== undefined ? `${r.security} [${allowedText(r.allowedBy, r.allowedRules ?? [])}]` : r.security;

export function registerList(program: Command, cli: Cli): void {
  program.command('list').description('list installed skills and whether each is out of date')
    .option('--user', 'list the personal skill folders instead of the project')
    .action(async (opts: { user?: boolean }, cmd: Command) => {
      const catalog = await loadCatalog(cli);
      const rows = await installedRows(cli, catalog, opts.user);
      reportBlockedCopies(cli, rows);
      if (isJson(cmd)) return printJson(cli.io, { installed: publicRows(rows), stale: catalog.stale });
      cli.io.out(rows.length ? installedTable(rows) : 'no skills installed\n');
    });
}
