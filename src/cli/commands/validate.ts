import { resolve } from 'node:path';
import type { Command } from 'commander';
import { validatePath } from '../../validate.js';
import { CliError, isJson, printJson, type Cli } from '../output.js';

export function registerValidate(program: Command, cli: Cli): void {
  program.command('validate [path]').description('check a skill folder or a registries .json/.jsonc file (default: the current folder)')
    .action(async (path: string | undefined, _opts: unknown, cmd: Command) => {
      const target = resolve(cli.ctx.cwd, path ?? '.');
      const { problems } = await validatePath(target, cli.ctx);
      const errors = problems.filter((p) => p.level === 'error');
      if (isJson(cmd)) printJson(cli.io, { path: target, problems });
      else if (problems.length === 0) cli.io.out(`${target}: valid\n`);
      else {
        cli.io.out(`${target}:\n`);
        for (const p of problems) cli.io.out(`  ${p.level} ${p.code}${p.registry ? ` [${p.registry}]` : ''}: ${p.message.replace(/\s*\n\s*/g, ' ')}\n`);
      }
      if (errors.length > 0) throw new CliError(`${errors.length} ${errors.length === 1 ? 'error' : 'errors'} in ${target}`);
    });
}
