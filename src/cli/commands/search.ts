import type { Command } from 'commander';
import { CliError, isJson, loadCatalog, overrodeText, printJson, table, viaText, type Cli } from '../output.js';

export function registerSearch(program: Command, cli: Cli): void {
  program.command('search <query...>').description('search the resolved catalog')
    .option('--limit <n>', 'maximum results', '10')
    .action(async (words: string[], opts: { limit: string }, cmd: Command) => {
      const limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new CliError(`--limit must be a positive integer`);
      const catalog = await loadCatalog(cli);
      const hits = catalog.search(words.join(' '), limit);
      if (isJson(cmd)) return printJson(cli.io, hits);
      if (hits.length === 0) return cli.io.out('no matching skills\n');
      cli.io.out(table(hits.map((h) => {
        const notes = h.overrode.map((o) => ` [${overrodeText(o)}]`).join('');
        const labels = (h.security.warnings > 0 ? ` [warnings: ${h.security.warnings}]` : '') + (h.security.allowedBy ? ` [allowed by ${h.security.allowedBy}]` : '');
        return [h.id, h.registry, viaText(h.via), h.description.replace(/\s+/g, ' ') + notes + labels];
      })));
    });
}
