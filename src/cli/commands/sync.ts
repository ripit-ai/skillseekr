import type { Command } from 'commander';
import { errorProblems, isJson, loadCatalog, printJson, type Cli } from '../output.js';

export function registerSync(program: Command, cli: Cli): void {
  program.command('sync').description('re-check every registry now, ignoring the cache TTL')
    .action(async (_opts: unknown, cmd: Command) => {
      const catalog = await loadCatalog(cli, { force: true });
      const { registries } = await cli.engine().registries();
      const problems = errorProblems(catalog.problems);
      if (isJson(cmd)) return printJson(cli.io, { registries: registries.length, skills: catalog.skills.length, stale: catalog.stale, problems });
      cli.io.out(`synced ${registries.length} registries, ${catalog.skills.length} skills, ${problems.length} problems\n`);
    });
}
