import type { Command } from 'commander';
import { parse } from 'jsonc-parser';
import { addBlock, removeBlock } from '../../config/edit.js';
import { configPath } from '../../paths.js';
import type { BlockEntry } from '../../policy/types.js';
import { CliError, isJson, printJson, type Cli } from '../output.js';
import { readConfigText, writeAtomic } from './registries.js';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export const today = (cli: Cli): string => new Date(cli.ctx.now()).toISOString().slice(0, 10);

function matchOf(id: string | undefined, hash: string | undefined): { id: string } | { content_hash: string } {
  if ((id === undefined) === (hash === undefined)) throw new CliError('give either a skill id or --hash <sha256:…>, not both and not neither');
  if (hash !== undefined) {
    if (!HASH_RE.test(hash)) throw new CliError('--hash must be "sha256:" followed by 64 hex characters');
    return { content_hash: hash };
  }
  return { id: id! };
}

const describe = (m: { id: string } | { content_hash: string }): string => ('id' in m ? m.id : m.content_hash);

export function registerBlock(program: Command, cli: Cli): void {
  program.command('block [id]').description('deny a skill by id or content hash in the local config (nothing lifts a block but removing it)')
    .option('--hash <sha256:…>', 'block this exact content under any id')
    .requiredOption('--reason <text>', 'why it is blocked')
    .action(async (id: string | undefined, opts: { hash?: string; reason: string }, cmd: Command) => {
      const m = matchOf(id, opts.hash);
      if (opts.reason.trim() === '') throw new CliError('--reason must not be empty');
      const entry: BlockEntry = { ...m, reason: opts.reason, added: today(cli) };
      const file = configPath(cli.ctx);
      const text = await readConfigText(file, '{ "registries": {} }\n');
      let next: string;
      try { next = addBlock(text, entry); } catch (e) { throw new CliError(`${describe(m)}: ${e instanceof Error ? e.message : String(e)}`); }
      await writeAtomic(file, next);
      if (isJson(cmd)) return printJson(cli.io, entry);
      cli.io.out(`blocked ${describe(m)} in ${file}\n`);
    });

  program.command('unblock [id]').description('remove a local block entry (entries from a policy include cannot be removed here)')
    .option('--hash <sha256:…>', 'remove the entry for this content hash')
    .action(async (id: string | undefined, opts: { hash?: string }, cmd: Command) => {
      const m = matchOf(id, opts.hash);
      const file = configPath(cli.ctx);
      const text = await readConfigText(file, '{ "registries": {} }\n');
      let next: string | undefined;
      try { next = removeBlock(text, m); } catch { /* not in the local config: see the includes */ }
      if (next === undefined) {
        const catalog = await cli.engine().catalog();
        for (const s of catalog.policy.sources) {
          if (s.source.kind !== 'include') continue;
          if (s.block.some((e) => ('id' in m ? 'id' in e && e.id === m.id : 'content_hash' in e && e.content_hash === m.content_hash))) {
            throw new CliError(`${describe(m)} is blocked by ${s.source.name}; lift it in that registries file`);
          }
        }
        throw new CliError(`${describe(m)} is not blocked`);
      }
      const entry = readBlockEntry(text, m);
      await writeAtomic(file, next);
      if (isJson(cmd)) return printJson(cli.io, entry ?? m);
      cli.io.out(`unblocked ${describe(m)} in ${file}\n`);
    });
}

/** The entry about to be removed, so the command can report what it removed. */
function readBlockEntry(text: string, m: { id: string } | { content_hash: string }): unknown {
  const root = parse(text, [], { allowTrailingComma: true }) as { block?: Array<Record<string, unknown>> } | undefined;
  return root?.block?.find((e) => ('id' in m ? e.id === m.id : e.content_hash === m.content_hash));
}
