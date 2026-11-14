import type { Command } from 'commander';
import { runStdio } from '../../mcp/server.js';
import type { Cli } from '../output.js';

export function registerMcp(program: Command, cli: Cli): void {
  program.command('mcp').description('run the MCP server on stdio')
    .action(async () => { await runStdio(cli.ctx); });
}
