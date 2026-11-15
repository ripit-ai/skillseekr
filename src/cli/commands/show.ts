import type { Command } from 'commander';
import { blockedReason } from '../../catalog/catalog.js';
import { findingLine, isJson, loadCatalog, lookupOrThrow, printJson, viaText, type Cli } from '../output.js';

export function registerShow(program: Command, cli: Cli): void {
  program.command('show <skill>').description('show a skill by id or unique name')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const catalog = await loadCatalog(cli);
      const s = lookupOrThrow(catalog, name);
      const f = await catalog.readFile(s, 'SKILL.md');
      // Over 1 MB (or binary): metadata instead of the body.
      const meta = f.kind === 'too_large' || f.kind === 'binary' ? { kind: f.kind, size: f.size, path: f.path } : undefined;
      const sec = s.security;
      const body = f.kind === 'text' ? f.content : '';
      const overrides = catalog.overridesFor(s.id);
      if (isJson(cmd)) {
        return printJson(cli.io, {
          id: s.id, name: s.name, description: s.description, registry: s.registry, via: s.via,
          ref: s.ref, sha: s.sha, overrides, files: s.files, warnings: s.warnings, security: sec, quality: s.quality,
          ...(meta ? { skillMd: meta } : sec.status === 'blocked' ? {} : { body }),
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
      out.push('Security:', `  status: ${sec.status}`);
      if (sec.blockedBy) out.push(`  blocked by: ${blockedReason(sec)}`);
      if (sec.allowedBy) out.push(`  allowed by: ${sec.allowedBy.label} (added ${sec.allowedBy.added}; rules: ${sec.allowedBy.rules.join(', ')}; reason: ${sec.allowedBy.reason})`);
      if (sec.note) out.push(`  note: ${sec.note}`);
      for (const x of sec.findings) out.push(`  [${x.severity}] ${findingLine(x)}`);
      if (s.quality.length > 0) out.push('', 'Quality:', ...s.quality.map((x) => `  ${findingLine(x)}`));
      out.push('');
      if (sec.status === 'blocked') out.push('SKILL.md: not shown (the skill is blocked)', '');
      else if (meta) out.push(`SKILL.md: ${meta.kind === 'binary' ? 'binary' : 'too large'} (${meta.size} bytes); read it at ${meta.path}`, '');
      else out.push('SKILL.md:', body.trimEnd(), '');
      cli.io.out(out.join('\n'));
    });
}
