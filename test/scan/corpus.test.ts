// Task 2: skillyard's good-vs-bad gallery (vendored at 83ee690) and the false-positive corpus. Budget: 0 blocks over
// test/fixtures/legit, evals/discovery/skills, the starter skill and skillyard good/.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSkills } from '../../src/catalog/discover.js';
import { RULES } from '../../src/scan/rules.js';
import { scanSkillDir, type ScanResult } from '../../src/scan/scan.js';
import { materializeSkillyard } from '../fixtures/rules/make-secrets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKILLYARD = join(root, 'test/fixtures/skillyard');
const BASE = new Map(RULES.map((r) => [r.id, r.severity]));

async function scanTree(tree: string): Promise<Map<string, ScanResult>> {
  const out = new Map<string, ScanResult>();
  for (const s of await discoverSkills(tree, '')) out.set(s.id, await scanSkillDir(s.dir, s.files));
  return out;
}
const criticals = (r: ScanResult) => r.findings.filter((f) => f.severity === 'critical');
/** Warnings from a critical-base rule must say why they were downgraded; warning-base rules are warnings anyway. */
const undowngraded = (r: ScanResult) => r.findings.filter((f) => f.severity === 'warning' && BASE.get(f.rule) !== 'warning' && !f.downgraded);
const gitBlobSha = (b: Buffer) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');

describe('skillyard examples', () => {
  it('the restored bad/billing-reports SKILL.md is byte-identical to upstream (git blob sha at 83ee690)', async () => {
    const dir = await materializeSkillyard(SKILLYARD);
    expect(gitBlobSha(await readFile(join(dir, 'bad/billing-reports/SKILL.md')))).toBe('f6390d0cde5edd4f7154269117ece85d7ddcba4a');
  });

  it('skillyard bad examples', async () => {
    const bad = await scanTree(join(await materializeSkillyard(SKILLYARD), 'bad'));
    for (const id of ['readme-polisher', 'strict-reviewer', 'lint-everything', 'billing-reports', 'env-doctor']) {
      expect(criticals(bad.get(id)!).length, id).toBeGreaterThanOrEqual(1);
    }
    const fast = bad.get('fast-refactor')!;
    expect(criticals(fast)).toEqual([]);
    expect(fast.findings).toContainEqual(expect.objectContaining({ rule: 'permission-bypass/skip-permissions', severity: 'warning' }));
    // quick-commits and engineering-handbook (brief); the other four are quality problems, not security ones.
    for (const id of ['quick-commits', 'engineering-handbook', 'notes-v2', 'schema-check', 'sql-helper', 'team-helper']) {
      expect(criticals(bad.get(id)!), id).toEqual([]);
    }
    // The upstream critical for each, so a rule that stops firing is noticed.
    const rules = (id: string) => criticals(bad.get(id)!).map((f) => f.rule);
    expect(rules('readme-polisher')).toContain('concealment/hide-from-user');
    expect(rules('strict-reviewer')).toContain('prompt-injection/override-instructions');
    expect(rules('lint-everything')).toContain('download-and-run/curl-pipe-shell');
    expect(rules('billing-reports')).toContain('secrets/ai-key');
    expect(rules('env-doctor')).toContain('exfiltration/env-to-network');
  });

  it('skillyard good examples produce zero criticals', async () => {
    const good = await scanTree(join(await materializeSkillyard(SKILLYARD), 'good'));
    expect([...good.keys()]).toEqual(['api-error-format', 'billing-reports', 'env-doctor', 'lint-everything', 'readme-polisher']);
    for (const [id, r] of good) {
      expect(criticals(r), id).toEqual([]);
      expect(undowngraded(r), id).toEqual([]);
    }
  });
});

describe('false-positive corpus', () => {
  const TREES = ['test/fixtures/legit', 'evals/discovery/skills', 'assets', 'plugins/skillseekr/skills'];

  it('false-positive corpus produces zero blocks', async () => {
    const all = new Map<string, ScanResult>();
    for (const t of TREES) for (const [id, r] of await scanTree(join(root, t))) all.set(`${t}/${id}`, r);
    expect(all.size).toBe(6 + 10 + 1 + 1);
    for (const [id, r] of all) {
      expect(criticals(r), id).toEqual([]);
      expect(undowngraded(r), id).toEqual([]);
    }
  });

  it('the legit corpus exercises every downgrade reason, and the emoji ZWJ sequence is not flagged', async () => {
    const legit = await scanTree(join(root, 'test/fixtures/legit'));
    const reasons = new Set([...legit.values()].flatMap((r) => r.findings.map((f) => f.downgraded)).filter(Boolean));
    expect([...reasons].sort()).toEqual([
      'in a comment, docstring or pattern', 'in a defensive sentence', 'in quotation marks',
      'inside an example block', 'only prints the command', 'target is localhost',
    ]);
    // Script-rule downgrades the brief's categories rely on, asserted per file (the per-file cap can hide them).
    const COMMENT = 'in a comment, docstring or pattern';
    const at = (id: string, file: string) => legit.get(id)!.findings.filter((f) => f.file === file).map((f) => [f.rule, f.line, f.severity, f.downgraded]);
    const lint = await readFile(join(root, 'test/fixtures/legit/install-lint/scripts/test_patterns.py'), 'utf8');
    const rxLines = lint.split('\n').flatMap((l, i) => (/re\.compile\(r"curl/.test(l) ? [i + 1] : []));
    expect(rxLines).toHaveLength(1);
    expect(at('install-lint', 'scripts/test_patterns.py')).toContainEqual(['download-and-run/curl-pipe-shell', rxLines[0], 'warning', COMMENT]);
    const hygiene = at('secret-hygiene-review', 'scripts/find_offenders.py');
    expect(hygiene).toContainEqual(['credential-read/home-credentials', 6, 'warning', COMMENT]); // docstring
    expect(hygiene).toContainEqual(['download-and-run/curl-pipe-shell', 8, 'warning', COMMENT]); // docstring
    expect(hygiene).toContainEqual(['download-and-run/curl-pipe-shell', 15, 'warning', COMMENT]); // # comment
    const standup = await readFile(join(root, 'test/fixtures/legit/team-standup/SKILL.md'), 'utf8');
    expect(standup).toContain('\u{1F469}\u{200D}\u{1F4BB}');
    expect(legit.get('team-standup')!.findings).toEqual([]);
  });
});
