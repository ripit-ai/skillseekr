import { resolve } from 'node:path';
import type { Command } from 'commander';
import { defaultScanTargets } from '../../scan/folders.js';
import { scanFolder, type ScannedSkill } from '../../scan/scanFolders.js';
import { CliError, findingLine, isJson, printJson, type Cli } from '../output.js';

export function registerScan(program: Command, cli: Cli): void {
  program.command('scan [dir...]')
    .description('scan skill folders for security and quality problems (default: project, tool and plugin skill folders)')
    .option('--gate <level>', 'exit 1 on any critical finding (critical) or any finding at all (warning)')
    .action(async (dirs: string[], opts: { gate?: string }, cmd: Command) => {
      if (opts.gate !== undefined && opts.gate !== 'critical' && opts.gate !== 'warning') throw new CliError('--gate must be "critical" or "warning"');
      const config = await cli.engine().config();
      const cacheDir = config.exists ? config.cache.dir : undefined;
      const targets = dirs.length > 0
        ? dirs.map((d) => ({ label: d, dir: resolve(cli.ctx.cwd, d) }))
        : await defaultScanTargets(cli.ctx, cli.ctx.cwd);
      const results: ScannedSkill[] = [];
      for (const t of targets) results.push(...await scanFolder(t.label, t.dir, cacheDir));
      if (isJson(cmd)) printJson(cli.io, results);
      else if (results.length === 0) cli.io.out('no skills found to scan\n');
      else {
        for (const r of results) {
          cli.io.out(`${r.status.toUpperCase()}  ${r.skill}  (${r.target})  ${r.dir}\n`);
          for (const f of r.findings) cli.io.out(`  [${f.severity}] ${findingLine(f)}\n`);
        }
      }
      const crit = results.filter((r) => r.status === 'critical').length;
      const any = results.filter((r) => r.status !== 'clean').length;
      if (opts.gate === 'critical' && crit > 0) throw new CliError(`${crit} ${crit === 1 ? 'skill has' : 'skills have'} critical findings`);
      if (opts.gate === 'warning' && any > 0) throw new CliError(`${any} ${any === 1 ? 'skill has' : 'skills have'} findings`);
    });
}
