// Skill quality warnings and near-duplicate detection (Phase 2, Task 3). All findings are warnings.
import { lstat, open } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { tokenize } from '../catalog/search.js';
import { MAX_FILE_BYTES } from '../catalog/limits.js';
import { SKILL_SCAN_BUDGET, type Finding } from './scan.js';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'any', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'in', 'is', 'it', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'use', 'when', 'with', 'you', 'your',
]);

const TRIGGER = /\b(use (this |it )?(when|for|to|if)|when (the user|you|asked)|for (tasks|requests|work) (that|involving|about))\b/i;
const HIJACK = /\b(every|any|all) (task|request|question)s?\b|\balways use\b|\buse (this|it) (for|on) everything\b/i;
const BACKTICK_PATH = /^(references|scripts|templates|assets|examples)\/[\w./-]+$/;
const MIN_DESCRIPTION = 40;
const MIN_DISTINCT_TOKENS = 4;

const contentTokens = (text: string) => tokenize(text).filter((t) => !STOPWORDS.has(t));

function warn(rule: string, line: number, message: string): Finding {
  return { rule, severity: 'warning', file: 'SKILL.md', line, message };
}

/** The path a link target points at inside the skill, or undefined for URLs, anchors and absolute paths. */
function localTarget(raw: string): string | undefined {
  let t = raw.trim();
  if (t.startsWith('<') && t.endsWith('>')) t = t.slice(1, -1);
  t = t.replace(/[#?].*$/s, '');
  try { t = decodeURIComponent(t); } catch { /* keep the raw text */ }
  t = t.replace(/\\/g, '/');
  if (t === '' || /^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/')) return undefined;
  return t;
}

/** Whether the target resolves to a listed file. A path that leaves the skill is never found. */
function exists(target: string, files: Set<string>): boolean {
  const norm = posix.normalize(target.replace(/^(\.\/)+/, ''));
  if (norm === '..' || norm.startsWith('../')) return false;
  return files.has(norm);
}

function brokenReferences(skillMd: string, files: string[]): Finding[] {
  const known = new Set(files);
  const out: Finding[] = [];
  const lines = skillMd.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (end > 0) start = end + 1;
  }
  let fence: string | undefined;
  for (let i = start; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]!);
    if (fence !== undefined) {
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && /^\s*$/.test(lines[i]!.slice(open[0].length))) fence = undefined;
      continue;
    }
    if (open) { fence = open[1]; continue; }
    const seen = new Set<string>();
    const check = (raw: string) => {
      const target = localTarget(raw);
      if (target === undefined || seen.has(target)) return;
      seen.add(target);
      if (!exists(target, known)) out.push(warn('quality/broken-reference', i + 1, `SKILL.md refers to "${target}", which is not in the skill`));
    };
    for (const m of lines[i]!.matchAll(/\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g)) check(m[1]!);
    for (const m of lines[i]!.matchAll(/`([^`\n]+)`/g)) {
      for (const tok of m[1]!.split(/\s+/)) if (BACKTICK_PATH.test(tok)) check(tok);
    }
  }
  return out;
}

export async function qualityFindings(skill: { description: string; dir: string; files: string[] }, skillMd: string): Promise<Finding[]> {
  const out: Finding[] = [];
  const description = (skill.description ?? '').trim();
  if (description === '') {
    out.push(warn('quality/description-missing', 1, 'the skill has no description, so it will not be found or triggered'));
  } else {
    if (description.length < MIN_DESCRIPTION) out.push(warn('quality/description-short', 1, `description is under ${MIN_DESCRIPTION} characters`));
    if (!TRIGGER.test(description)) out.push(warn('quality/description-no-trigger', 1, 'description has no "use when..." trigger saying when to pick this skill'));
    if (HIJACK.test(description) || new Set(contentTokens(description)).size < MIN_DISTINCT_TOKENS) {
      out.push(warn('quality/description-hijack', 1, 'description is generic or claims every task, so the skill could crowd out others in search'));
    }
  }
  out.push(...brokenReferences(skillMd, skill.files));

  let total = 0;
  for (const rel of skill.files) {
    let size: number;
    try {
      const st = await lstat(join(skill.dir, ...rel.split('/')));
      if (!st.isFile()) continue;
      size = st.size;
    } catch { continue; }
    total += size;
    if (size > MAX_FILE_BYTES) out.push({ rule: 'quality/oversized-file', severity: 'warning', file: rel, line: 1, message: `file is ${(size / 1048576).toFixed(1)} MB, over the 1 MB limit` });
  }
  if (total > SKILL_SCAN_BUDGET) out.push(warn('quality/oversized-skill', 1, `skill is ${(total / 1048576).toFixed(1)} MB in total, over the ${SKILL_SCAN_BUDGET / 1048576} MB limit`));
  return out;
}

/** Pairs of skills whose descriptions have a token-set Jaccard similarity of at least 0.85. O(n^2), fine at catalog scale. */
export function nearDuplicates(skills: Array<{ id: string; description: string }>): Array<{ a: string; b: string; similarity: number }> {
  const sets = skills
    .map((s) => ({ id: s.id, tokens: new Set(contentTokens(s.description)) }))
    .filter((s) => s.tokens.size >= 5);
  const out: Array<{ a: string; b: string; similarity: number }> = [];
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const x = sets[i]!, y = sets[j]!;
      let inter = 0;
      for (const t of x.tokens) if (y.tokens.has(t)) inter++;
      const similarity = inter / (x.tokens.size + y.tokens.size - inter);
      if (similarity < 0.85) continue;
      const [a, b] = x.id <= y.id ? [x.id, y.id] : [y.id, x.id];
      out.push({ a, b, similarity });
    }
  }
  return out.sort((p, q) => (p.a < q.a ? -1 : p.a > q.a ? 1 : p.b < q.b ? -1 : p.b > q.b ? 1 : 0));
}

/** SKILL.md as text, at most MAX_FILE_BYTES of it; '' when it isn't a readable regular file. */
export async function readSkillMd(dir: string): Promise<string> {
  try {
    const file = join(dir, 'SKILL.md');
    if (!(await lstat(file)).isFile()) return '';
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
  } catch { return ''; }
}
