// The security scan: reads a skill's files, classifies them, runs RULES line by line and applies the
// context-aware downgrade. Ported in structure from skillyard (MIT) src/scan.js @ 83ee690 (scanFiles).
// Pure pattern matching: no network, no AI, deterministic.
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseFrontmatter } from '../catalog/frontmatter.js';
import { MAX_FILE_BYTES, MAX_SCAN_BYTES, SNIFF_BYTES } from '../catalog/limits.js';
import { CHAR_CLASS_RULES, RULES, TOOL_KEYS, ruleMatch, toolGrants, type Rule } from './rules.js';
import { blockLines, downgradeReason, type FileKind } from './context.js';

export interface Finding { rule: string; severity: 'critical' | 'warning'; file: string; line: number; message: string; downgraded?: string /* reason */ }
export interface ScanResult { findings: Finding[]; critical: number; warning: number }

export const SCRIPT_EXT = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i;

export const UNSCANNABLE_RULE = 'integrity/unscannable-file';
const unscannable = (file: string): Finding =>
  ({ rule: UNSCANNABLE_RULE, severity: 'critical', file, line: 1, message: 'file is over 10 MB and was not scanned' });

/** Each rule sees at most this much of a line: the start, plus the end when the line is longer. */
const SLICE = 4096;
/** Short lines are joined into blocks of about this size and pre-tested once per rule. */
const BLOCK = 4096;

/** Scans in-memory files ({ path: posix relative path, content }). Pure. */
export function scanFiles(files: Array<{ path: string; content: Buffer }>): ScanResult {
  return result(files.flatMap((f) => scanFile(f.path, f.content)));
}

/**
 * Scans the listed files (posix paths relative to dir). Only regular files are read: a path that goes through
 * a symlink, leaves dir, or isn't a regular file is skipped. A file over 10 MB is reported, not read.
 */
export async function scanSkillDir(dir: string, files: string[]): Promise<ScanResult> {
  const findings: Finding[] = [];
  for (const rel of files) {
    const read = await readRegular(dir, rel);
    if (read === 'too-large') findings.push(unscannable(rel));
    else if (read) findings.push(...scanFile(rel, read));
  }
  return result(findings);
}

async function readRegular(dir: string, rel: string): Promise<Buffer | 'too-large' | undefined> {
  const parts = rel.split('/');
  if (rel === '' || rel.includes('\0') || rel.includes('\\') || isAbsolute(rel) || parts.some((p) => p === '' || p === '.' || p === '..')) return undefined;
  try {
    let cur = dir;
    for (const p of parts) {
      cur = join(cur, p);
      if ((await lstat(cur)).isSymbolicLink()) return undefined;
    }
    // O_NOFOLLOW closes the gap between the lstat and the open for the last component.
    const fh = await open(cur, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const st = await fh.stat();
      if (!st.isFile()) return undefined;
      if (st.size > MAX_SCAN_BYTES) return 'too-large';
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  } catch {
    return undefined;
  }
}

function result(findings: Finding[]): ScanResult {
  const rank = (f: Finding) => (f.severity === 'critical' ? 0 : 1);
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  findings.sort((a, b) => rank(a) - rank(b) || cmp(a.file, b.file) || a.line - b.line || cmp(a.rule, b.rule));
  const critical = findings.filter((f) => f.severity === 'critical').length;
  return { findings, critical, warning: findings.length - critical };
}

function scanFile(file: string, content: Buffer): Finding[] {
  if (content.length > MAX_SCAN_BYTES) return [unscannable(file)];
  if (content.subarray(0, SNIFF_BYTES).includes(0)) return [];
  let text = content.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  text = text.replace(/\r\n?/g, '\n');
  const kind: FileKind = SCRIPT_EXT.test(file) || (!/\.[^/]*$/.test(file) && text.startsWith('#!')) ? 'script' : 'text';
  return new FileScan(file, kind, text).run();
}

const applies = (rule: Rule, kind: FileKind) =>
  rule.target === 'all' || rule.target === kind;

/** Rule regexes with the `m` flag, for pre-testing blocks of joined lines. */
const multiline = new Map(RULES.map((r) => [r.id, new RegExp(r.re.source, r.re.flags.includes('m') ? r.re.flags : r.re.flags + 'm')]));

class FileScan {
  private readonly lines: string[];
  private readonly blocks: Set<number>;
  private readonly fmEnd: number; // index of the closing `---`, or -1 without frontmatter
  private readonly fmData: Record<string, unknown> | undefined;
  /** Lines a critical rule matched (downgraded or not): weak/* findings there are dropped. */
  private readonly strongLines = new Set<number>();
  private readonly chunks: Array<{ first: number; last: number; text: string } | { long: number }> = [];

  constructor(private readonly file: string, private readonly kind: FileKind, text: string) {
    this.lines = text.split('\n');
    this.blocks = blockLines(this.lines, kind, file);
    ({ end: this.fmEnd, data: this.fmData } = kind === 'text' && /\.md$/i.test(file) ? frontmatter(this.lines) : { end: -1, data: undefined });
    let first = 0;
    let size = 0;
    const flush = (upTo: number) => {
      if (upTo > first) this.chunks.push({ first, last: upTo - 1, text: this.lines.slice(first, upTo).join('\n') });
    };
    this.lines.forEach((l, i) => {
      if (l.length > SLICE) { flush(i); this.chunks.push({ long: i }); first = i + 1; size = 0; return; }
      if (size + l.length + 1 > BLOCK) { flush(i); first = i; size = 0; }
      size += l.length + 1;
    });
    flush(this.lines.length);
  }

  run(): Finding[] {
    const out: Finding[] = [];
    for (const rule of RULES) {
      if (rule.target === 'frontmatter') { if (this.fmData) out.push(...this.frontmatterRule(rule)); continue; }
      if (applies(rule, this.kind)) out.push(...this.lineRule(rule));
    }
    return out;
  }

  /** At most 3 findings per (rule, file) for a critical rule and 1 for a warning rule; real criticals first. */
  private lineRule(rule: Rule): Finding[] {
    const cap = rule.severity === 'critical' ? 3 : 1;
    const weak = rule.id.startsWith('weak/');
    const kept: Finding[] = [];
    const downgraded: Finding[] = [];
    for (const i of this.candidates(rule)) {
      if (weak && this.strongLines.has(i)) continue;
      const finding = this.matchLine(rule, i);
      if (!finding) continue;
      if (rule.severity === 'critical') this.strongLines.add(i);
      if (finding.downgraded === undefined) { if (kept.length < cap) kept.push(finding); }
      else if (downgraded.length < cap) downgraded.push(finding);
      if (weak && kept.length >= cap) break;
    }
    return [...kept, ...downgraded].slice(0, cap);
  }

  /** Lines that might match: every line of a block of joined lines that the rule matches anywhere in. */
  private *candidates(rule: Rule): Generator<number> {
    const pre = multiline.get(rule.id)!;
    for (const c of this.chunks) {
      if ('long' in c) yield c.long;
      else if (pre.test(c.text)) for (let i = c.first; i <= c.last; i++) yield i;
    }
  }

  private matchLine(rule: Rule, i: number): Finding | undefined {
    const line = this.lines[i]!;
    const whole = line.length <= SLICE || CHAR_CLASS_RULES.has(rule.id);
    for (const text of whole ? [line] : [line.slice(0, SLICE), line.slice(-SLICE)]) {
      const m = ruleMatch(rule, text, this.file);
      if (!m) continue;
      const reason = downgradeReason(rule, {
        kind: this.kind, text, index: m.index, length: m.length,
        inBlock: this.blocks.has(i), frontmatter: i > 0 && i < this.fmEnd,
      });
      const f: Finding = { rule: rule.id, severity: reason ? 'warning' : rule.severity, file: this.file, line: i + 1, message: rule.message };
      if (reason) f.downgraded = reason;
      return f;
    }
    return undefined;
  }

  /** Frontmatter rules test each granted tool and report the line of its key. */
  private frontmatterRule(rule: Rule): Finding[] {
    for (const key of TOOL_KEYS) {
      if (!toolGrants(this.fmData![key]).some((t) => rule.re.test(t))) continue;
      const at = this.lines.findIndex((l, i) => i > 0 && i < this.fmEnd && l.startsWith(key) && /^\s*:/.test(l.slice(key.length)));
      return [{ rule: rule.id, severity: rule.severity, file: this.file, line: at > 0 ? at + 1 : 1, message: rule.message }];
    }
    return [];
  }
}

/** The frontmatter block's closing line and parsed data, found the way parseFrontmatter finds them. */
function frontmatter(lines: string[]): { end: number; data: Record<string, unknown> | undefined } {
  if (lines[0]?.trimEnd() !== '---') return { end: -1, data: undefined };
  let end = -1;
  let size = 0;
  for (let i = 1; i < lines.length && size <= MAX_FILE_BYTES; i++) {
    if (lines[i]!.trimEnd() === '---') { end = i; break; }
    size += lines[i]!.length + 1;
  }
  if (end < 0) return { end: -1, data: undefined };
  const fm = parseFrontmatter(lines.slice(0, end + 1).join('\n'));
  return { end, data: fm.ok ? fm.data : undefined };
}
