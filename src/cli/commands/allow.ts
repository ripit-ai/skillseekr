import type { Command } from 'commander';
import { parse } from 'jsonc-parser';
import { removeAllow, setAllow } from '../../config/edit.js';
import { configPath } from '../../paths.js';
import type { AllowEntry } from '../../policy/types.js';
import { CliError, findingLine, isJson, loadCatalog, lookupOrThrow, printJson, type Cli } from '../output.js';
import { today } from './block.js';
import { readConfigText, writeAtomic } from './registries.js';

interface AllowOpts { reason?: string; yes?: boolean; list?: boolean; prune?: boolean }

function listEntries(catalog: Awaited<ReturnType<typeof loadCatalog>>) {
  const rows: Array<{ id: string; label: string } & AllowEntry> = [];
  for (const s of catalog.policy.sources) {
    const label = s.source.kind === 'local' ? 'user' : s.source.name;
    for (const [id, e] of Object.entries(s.allow)) rows.push({ id, label, ...e });
  }
  return rows;
}

export function registerAllow(program: Command, cli: Cli): void {
  program.command('allow [id]').description('override a scanner block for one skill, tied to its exact content and rules (human only)')
    .option('--reason <text>', 'why the skill is allowed (required to write an entry)')
    .option('--yes', 'skip the typed confirmation')
    .option('--list', 'list all allow entries')
    .option('--prune', 'remove local entries whose content hash matches no current skill')
    .action(async (id: string | undefined, opts: AllowOpts, cmd: Command) => {
      if (opts.list && opts.prune) throw new CliError('--list and --prune cannot be combined');
      if (opts.list) {
        const rows = listEntries(await loadCatalog(cli));
        if (isJson(cmd)) return printJson(cli.io, rows);
        if (rows.length === 0) return cli.io.out('no allow entries\n');
        return cli.io.out(rows.map((r) => `${r.id}  ${r.label}  added ${r.added}  rules: ${r.rules.join(', ')}\n`).join(''));
      }
      if (opts.prune) {
        const catalog = await loadCatalog(cli);
        const file = configPath(cli.ctx);
        let text = await readConfigText(file, '{ "registries": {} }\n');
        const local = (parse(text, [], { allowTrailingComma: true }) as { allow?: Record<string, AllowEntry> } | undefined)?.allow ?? {};
        const removed: Array<{ id: string } & AllowEntry> = [];
        for (const [aid, e] of Object.entries(local)) {
          if (catalog.byId(aid)?.contentHash === e.content_hash) continue;
          text = removeAllow(text, aid);
          removed.push({ id: aid, ...e });
        }
        if (removed.length > 0) await writeAtomic(file, text);
        if (isJson(cmd)) return printJson(cli.io, removed);
        return cli.io.out(removed.length === 0 ? 'nothing to prune\n' : removed.map((r) => `removed allow entry for ${r.id}\n`).join(''));
      }

      if (id === undefined) throw new CliError('give a skill id, or use --list or --prune');
      if (opts.reason === undefined || opts.reason.trim() === '') throw new CliError('--reason <text> is required');
      const catalog = await loadCatalog(cli);
      const skill = lookupOrThrow(catalog, id);
      const sec = skill.security;
      if (sec.status === 'blocked' && sec.blockedBy?.kind === 'deny') throw new CliError('blocked by a deny entry; allow cannot lift it');
      if (sec.status !== 'blocked' || sec.blockedBy?.kind !== 'scan') throw new CliError(`${skill.id}: nothing to allow (not blocked by the scanner)`);
      const criticals = sec.findings.filter((f) => f.severity === 'critical');
      const rules = [...new Set(criticals.map((f) => f.rule))].sort();
      // Findings go to stderr under --json so stdout stays one JSON document.
      (isJson(cmd) ? cli.io.err : cli.io.out)(`${skill.id} is blocked by the scanner. Findings:\n${sec.findings.map((f) => `  [${f.severity}] ${findingLine(f)}\n`).join('')}`);
      if (!opts.yes) {
        if (!cli.io.prompt) throw new CliError('cannot ask for confirmation here; re-run with --yes');
        const answer = (await cli.io.prompt('Type the skill id to confirm: ')).trim();
        if (answer !== skill.id) throw new CliError('confirmation did not match; nothing was written');
      }
      const entry: AllowEntry = { content_hash: skill.contentHash, rules, reason: opts.reason, added: today(cli) };
      const file = configPath(cli.ctx);
      const text = await readConfigText(file, '{ "registries": {} }\n');
      await writeAtomic(file, setAllow(text, skill.id, entry));
      if (isJson(cmd)) return printJson(cli.io, { id: skill.id, ...entry });
      cli.io.out(`allowed ${skill.id} in ${file}\n`);
    });
}
