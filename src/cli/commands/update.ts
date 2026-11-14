import type { Command } from 'commander';
import { updateInstalled } from '../../install/installer.js';
import { isJson, loadCatalog, printJson, table, type Cli } from '../output.js';

export function registerUpdate(program: Command, cli: Cli): void {
  program.command('update [name]').description('update installed skills from the catalog')
    .option('--force', 'also overwrite locally modified installs')
    .option('--user', 'update the personal skill folders instead of the project')
    .action(async (name: string | undefined, opts: { force?: boolean; user?: boolean }, cmd: Command) => {
      const catalog = await loadCatalog(cli);
      const results = await updateInstalled(catalog, cli.ctx, {
        ...(name !== undefined && { name }), force: opts.force === true,
        scope: opts.user ? 'user' : 'project', projectDir: cli.ctx.cwd,
      });
      if (isJson(cmd)) return printJson(cli.io, { results, stale: catalog.stale });
      if (results.length === 0) return cli.io.out(name ? `"${name}" is not installed\n` : 'no skills installed\n');
      cli.io.out(table(results.map((r) => [r.name, r.result, r.dir])));
      if (results.some((r) => r.result === 'skipped-modified')) cli.io.out("modified installs were skipped; use --force to overwrite them\n");
    });
}
