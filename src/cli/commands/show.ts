import type { Command } from 'commander';
import { isJson, loadCatalog, lookupOrThrow, printJson, viaText, type Cli } from '../output.js';

export function registerShow(program: Command, cli: Cli): void {
  program.command('show <skill>').description('show a skill by id or unique name')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const catalog = await loadCatalog(cli);
      const s = lookupOrThrow(catalog, name);
      const f = await catalog.readFile(s, 'SKILL.md');
      // Over 1 MB (or binary): metadata instead of the body.
      const meta = f.kind === 'too_large' || f.kind === 'binary' ? { kind: f.kind, size: f.size, path: f.path } : undefined;
      const body = f.kind === 'text' ? f.content : '';
      const overrides = catalog.overridesFor(s.id);
      if (isJson(cmd)) {
        return printJson(cli.io, {
          id: s.id, name: s.name, description: s.description, registry: s.registry, via: s.via,
          ref: s.ref, sha: s.sha, overrides, files: s.files, warnings: s.warnings,
          ...(meta ? { skillMd: meta } : { body }),
          stale: catalog.stale, problems: catalog.problems.filter((p) => p.level === 'error'),
        });
      }
      const out = [
        `id:          ${s.id}`, `name:        ${s.name}`, `description: ${s.description}`,
        `registry:    ${s.registry}`, `via:         ${viaText(s.via)}`,
      ];
      if (s.ref) out.push(`ref:         ${s.ref}`);
      if (s.sha) out.push(`sha:         ${s.sha}`);
      for (const o of overrides) out.push(`overrides:   ${o.replaced.registry} (${viaText(o.replaced.via)})`);
      for (const w of s.warnings) out.push(`warning:     ${w}`);
      out.push('', 'files:', ...s.files.map((x) => `  ${x}`), '');
      if (meta) out.push(`SKILL.md: ${meta.kind === 'binary' ? 'binary' : 'too large'} (${meta.size} bytes); read it at ${meta.path}`, '');
      else out.push('SKILL.md:', body.trimEnd(), '');
      cli.io.out(out.join('\n'));
    });
}
