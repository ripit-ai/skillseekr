import type { Command } from 'commander';
import { InstallError, installSkill } from '../../install/installer.js';
import { CliError, isJson, loadCatalog, lookupOrThrow, printJson, type Cli } from '../output.js';

export function registerInstall(program: Command, cli: Cli): void {
  program.command('install <skill>').description('install a skill (project scope by default)')
    .option('--user', 'install into the personal skill folder of every detected tool')
    .action(async (name: string, opts: { user?: boolean }, cmd: Command) => {
      const catalog = await loadCatalog(cli);
      const skill = lookupOrThrow(catalog, name);
      const scope = opts.user ? 'user' : 'project';
      try {
        const r = await installSkill(skill, scope, cli.ctx, { projectDir: cli.ctx.cwd });
        if (r.dirs.length === 0) throw new CliError('no supported tools detected in your home folder; nothing was installed');
        if (isJson(cmd)) return printJson(cli.io, { id: skill.id, name: skill.name, scope, ...r });
        cli.io.out(r.dirs.map((d) => `installed ${skill.id} -> ${d}\n`).join(''));
      } catch (e) {
        if (e instanceof InstallError) throw new CliError(e.message);
        throw e;
      }
    });
}
