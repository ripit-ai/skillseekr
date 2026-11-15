import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverSkills } from '../../src/catalog/discover.js';
import { nearDuplicates, qualityFindings } from '../../src/scan/quality.js';
import { SKILL_SCAN_BUDGET } from '../../src/scan/scan.js';
import { materializeSkillyard } from '../fixtures/rules/make-secrets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function quality(tree: string, id: string) {
  const s = (await discoverSkills(tree, '')).find((x) => x.id === id)!;
  expect(s, id).toBeDefined();
  const md = await readFile(join(s.dir, 'SKILL.md'), 'utf8');
  // Phase 1's strict YAML parse drops good/env-doctor's description (an unquoted ": " in the value), so read the line directly.
  const description = s.description || (/^description:\s*(.*)$/m.exec(md)?.[1] ?? '');
  return qualityFindings({ description, dir: s.dir, files: s.files }, md);
}
const rules = (f: Array<{ rule: string }>) => f.map((x) => x.rule);

describe('qualityFindings on skillyard', () => {
  it('bad/notes-v2 gets description-no-trigger', async () => {
    const dir = await materializeSkillyard(join(root, 'test/fixtures/skillyard'));
    expect(rules(await quality(dir, 'bad/notes-v2'))).toContain('quality/description-no-trigger');
  });
  it('bad/team-helper gets description-hijack', async () => {
    const dir = await materializeSkillyard(join(root, 'test/fixtures/skillyard'));
    expect(rules(await quality(dir, 'bad/team-helper'))).toContain('quality/description-hijack');
  });
  it('bad/schema-check gets broken-reference naming each missing path, with line numbers', async () => {
    const dir = await materializeSkillyard(join(root, 'test/fixtures/skillyard'));
    const f = (await quality(dir, 'bad/schema-check')).filter((x) => x.rule === 'quality/broken-reference');
    expect(f.some((x) => x.message.includes('scripts/validate.py') && x.line > 0)).toBe(true);
    expect(f.some((x) => x.message.includes('references/schemas.md') && x.line > 0)).toBe(true);
  });
  it('good/* get no quality findings', async () => {
    const dir = await materializeSkillyard(join(root, 'test/fixtures/skillyard'));
    for (const id of ['api-error-format', 'billing-reports', 'env-doctor', 'lint-everything', 'readme-polisher']) {
      expect(await quality(dir, `good/${id}`), id).toEqual([]);
    }
  });
});

describe('qualityFindings rules', () => {
  const desc = 'Formats release notes from merged pull requests. Use when asked to draft a changelog.';
  async function tmp(files: Record<string, string | Buffer>) {
    const dir = await mkdtemp(join(tmpdir(), 'quality-'));
    for (const [p, c] of Object.entries(files)) {
      await mkdir(dirname(join(dir, p)), { recursive: true });
      await writeFile(join(dir, p), c);
    }
    return { dir, files: Object.keys(files) };
  }

  it('flags missing and short descriptions', async () => {
    const { dir, files } = await tmp({ 'SKILL.md': '# x' });
    expect(rules(await qualityFindings({ description: '  ', dir, files }, '# x'))).toEqual(['quality/description-missing']);
    expect(rules(await qualityFindings({ description: 'Use when testing.', dir, files }, '# x'))).toContain('quality/description-short');
  });

  it('flags hijack phrases and generic descriptions, not specific ones', async () => {
    const { dir, files } = await tmp({ 'SKILL.md': '# x' });
    const r = async (d: string) => rules(await qualityFindings({ description: d, dir, files }, '# x'));
    expect(await r('Helps with any request. Use when you need help with things.')).toContain('quality/description-hijack');
    expect(await r('Always use this skill first. Use when starting work on projects.')).toContain('quality/description-hijack');
    expect(await r(desc)).toEqual([]);
  });

  it('checks references: links and backticked paths, ignoring URLs, anchors, absolute paths; fragments stripped; .. is broken', async () => {
    const md = [
      '---', 'name: x', '---',
      '[ok](references/a.md#top) [url](https://e.example/x.md) [mail](mailto:a@b.example) [anchor](#sec) [abs](/etc/passwd)',
      '[q](references/a.md?raw=1) [gone](references/gone.md) [up](../outside.md)',
      'Run `scripts/run.sh` or `scripts/missing.sh`; `notes/other.txt` is not checked.',
    ].join('\n');
    const { dir, files } = await tmp({ 'SKILL.md': md, 'references/a.md': 'a', 'scripts/run.sh': 'x' });
    const f = (await qualityFindings({ description: desc, dir, files }, md)).filter((x) => x.rule === 'quality/broken-reference');
    expect(f.map((x) => [x.line, x.message.match(/"([^"]+)"/)![1]])).toEqual([
      [5, 'references/gone.md'], [5, '../outside.md'], [6, 'scripts/missing.sh'],
    ]);
  });

  it('flags a 1.5 MB file as oversized-file', async () => {
    const { dir, files } = await tmp({ 'SKILL.md': '# x', 'assets/big.txt': Buffer.alloc(1.5 * 1024 * 1024, 97) });
    const f = await qualityFindings({ description: desc, dir, files }, '# x');
    expect(f.filter((x) => x.rule === 'quality/oversized-file').map((x) => x.file)).toEqual(['assets/big.txt']);
    expect(rules(f)).not.toContain('quality/oversized-skill');
  });

  it('flags a skill over the scan budget as oversized-skill', async () => {
    const chunk = Buffer.alloc(900 * 1024, 97);
    const names = Array.from({ length: Math.ceil(SKILL_SCAN_BUDGET / chunk.length) + 1 }, (_, i) => `assets/f${i}.txt`);
    const { dir, files } = await tmp({ 'SKILL.md': '# x', ...Object.fromEntries(names.map((n) => [n, chunk])) });
    const f = await qualityFindings({ description: desc, dir, files }, '# x');
    expect(rules(f)).toContain('quality/oversized-skill');
    expect(rules(f)).not.toContain('quality/oversized-file');
  });
});

describe('nearDuplicates', () => {
  const base = 'Formats release notes from merged pull requests into changelog entries for the whole team each sprint';
  it('pairs descriptions that differ by one word, sorted, and not unrelated ones', () => {
    const r = nearDuplicates([
      { id: 'z', description: base },
      { id: 'a', description: base.replace('team', 'squad') },
      { id: 'm', description: 'Diagnoses broken development environments: missing tools, wrong versions, bad PATH' },
      { id: 'short', description: 'release notes' },
    ]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ a: 'a', b: 'z' });
    expect(r[0]!.similarity).toBeGreaterThanOrEqual(0.85);
  });
  it('ignores descriptions with fewer than 5 tokens', () => {
    expect(nearDuplicates([{ id: 'a', description: 'release notes tool' }, { id: 'b', description: 'release notes tool' }])).toEqual([]);
  });
});
