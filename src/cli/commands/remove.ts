import type { Command } from 'commander';
import { InstallError, removeInstalled } from '../../install/installer.js';
import { CliError, isJson, printJson, type Cli } from '../output.js';

export function registerRemove(program: Command, cli: Cli): void {
  program.command('remove <name>').description('remove an installed skill (only folders skillseekr installed)')
    .option('--user', 'remove from the personal skill folders')
    .action(async (name: string, opts: { user?: boolean }, cmd: Command) => {
      const scope = opts.user ? 'user' : 'project';
      try {
        const removed = await removeInstalled(name, scope, cli.ctx, { projectDir: cli.ctx.cwd });
        if (isJson(cmd)) return printJson(cli.io, { name, scope, removed });
        cli.io.out(removed.map((d) => `removed ${d}\n`).join(''));
      } catch (e) {
        if (e instanceof InstallError) throw new CliError(e.message);
        throw e;
      }
    });
}
