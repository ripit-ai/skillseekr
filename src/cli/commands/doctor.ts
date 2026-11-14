import type { Command } from 'commander';
import { doctor, type DoctorReport } from '../../doctor.js';
import { CliError, isJson, printJson, table, type Io } from '../output.js';
import type { Cli } from '../output.js';

export function printDoctor(io: Io, report: DoctorReport): void {
  io.out(table([['STATUS', 'CHECK', 'MESSAGE'], ...report.checks.map((c) => [c.status, c.id, c.message])]));
}

/** Exit 1 when any check failed. */
export function doctorFailure(report: DoctorReport): CliError | undefined {
  const failed = report.checks.filter((c) => c.status === 'fail');
  return failed.length ? new CliError(`${failed.length} doctor ${failed.length === 1 ? 'check' : 'checks'} failed: ${failed.map((c) => c.id).join(', ')}`) : undefined;
}

export function registerDoctor(program: Command, cli: Cli): void {
  program.command('doctor').description('check the config, registries, auth, includes, overrides, tool registration and skill folders')
    .action(async (_opts: unknown, cmd: Command) => {
      const report = await doctor(cli.engine(), cli.ctx);
      if (isJson(cmd)) printJson(cli.io, report);
      else printDoctor(cli.io, report);
      const failure = doctorFailure(report);
      if (failure) throw failure;
    });
}
