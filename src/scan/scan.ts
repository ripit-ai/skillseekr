// The security scan: reads a skill's files, classifies them, runs RULES line by line and applies the
// context-aware downgrade. Ported in structure from skillyard (MIT) src/scan.js @ 83ee690 (scanFiles).
// Pure pattern matching: no network, no AI, deterministic.
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseFrontmatter } from '../catalog/frontmatter.js';
import { MAX_FILE_BYTES, MAX_SCAN_BYTES, SNIFF_BYTES } from '../catalog/limits.js';
import { CHAR_CLASS_RULES, RULES, TOOL_KEYS, ruleMatch, toolGrants, type Rule } from './rules.js';
import { downgradeReason, quotedSpans, type FileKind, type Span } from './context.js';

export interface Finding { rule: string; severity: 'critical' | 'warning'; file: string; line: number; message: string; downgraded?: string /* reason */ }
export interface ScanResult { findings: Finding[]; critical: number; warning: number }

export const SCRIPT_EXT = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i;
/** Files that hold shell commands without a script extension. package.json is scanned whole for its `scripts`. */
const SCRIPT_NAME = /(?:^|\/)(?:[Mm]akefile|GNUmakefile|\.envrc|\.?[Jj]ustfile|package\.json)$/;
const SHELLISH = /\.(?:sh|bash|zsh)$|(?:^|\/)(?:[Mm]akefile|GNUmakefile|\.envrc|\.?[Jj]ustfile)$|(?:^|\/)[^./]+$/;

/** All bytes scanned for one skill. Files past it (in path order) are reported, not scanned. */
export const SKILL_SCAN_BUDGET = 20 * 1024 * 1024;

export const UNSCANNABLE_RULE = 'integrity/unscannable-file';
const unscannable = (file: string, message: string): Finding => ({ rule: UNSCANNABLE_RULE, severity: 'critical', file, line: 1, message });
const TOO_LARGE = 'file is over 10 MB and was not scanned';
const OVER_BUDGET = 'exceeds per-skill scan budget';

/** Rules see a long line in overlapping windows: a match up to OVERLAP characters long is always inside one. */
const WINDOW = 4096;
const OVERLAP = 512;
/** Short lines are joined into blocks of about this size and pre-tested once per rule. */
const BLOCK = 4096;

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Scans in-memory files ({ path: posix relative path, content }) as one skill. Pure. */
export function scanFiles(files: Array<{ path: string; content: Buffer }>): ScanResult {
  const skill = new SkillScan();
  for (const f of [...files].sort((a, b) => byCodeUnit(a.path, b.path))) skill.add(f.path, f.content);
  return skill.result();
}

/**
 * Scans the listed files (posix paths relative to dir) as one skill. Only regular files are read: a path that
 * goes through a symlink, leaves dir, or doesn't exist is skipped. A file over 10 MB, or one that can't be read,
 * is reported as unscannable.
 */
export async function scanSkillDir(dir: string, files: string[]): Promise<ScanResult> {
  const skill = new SkillScan();
  for (const rel of [...files].sort(byCodeUnit)) {
    const read = await readRegular(dir, rel);
    if (read === undefined) continue;
    if ('error' in read) skill.findings.push(unscannable(rel, `file could not be read (${read.error})`));
    else if (read.size > MAX_SCAN_BYTES) skill.findings.push(unscannable(rel, TOO_LARGE));
    else skill.add(rel, read.content);
  }
  return skill.result();
}

type Read = { size: number; content: Buffer } | { error: string };

async function readRegular(dir: string, rel: string): Promise<Read | undefined> {
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
      if (st.size > MAX_SCAN_BYTES) return { size: st.size, content: Buffer.alloc(0) };
      const buf = Buffer.alloc(st.size);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return { size: bytesRead, content: buf.subarray(0, bytesRead) };
    } finally {
      await fh.close();
    }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? 'error';
    return code === 'ENOENT' || code === 'ENOTDIR' ? undefined : { error: code };
  }
}

class SkillScan {
  readonly findings: Finding[] = [];
  private used = 0;

  add(file: string, content: Buffer): void {
    if (content.length > MAX_SCAN_BYTES) { this.findings.push(unscannable(file, TOO_LARGE)); return; }
    const text = decode(file, content);
    if (text === undefined) return;
    if (this.used + content.length > SKILL_SCAN_BUDGET) { this.findings.push(unscannable(file, OVER_BUDGET)); return; }
    this.used += content.length;
    const kind: FileKind = SCRIPT_EXT.test(file) || SCRIPT_NAME.test(file) || /^\s*#!/.test(text) ? 'script' : 'text';
    this.findings.push(...new FileScan(file, kind, text).run());
  }

  result(): ScanResult {
    const rank = (f: Finding) => (f.severity === 'critical' ? 0 : 1);
    this.findings.sort((a, b) => rank(a) - rank(b) || byCodeUnit(a.file, b.file) || a.line - b.line || byCodeUnit(a.rule, b.rule));
    const critical = this.findings.filter((f) => f.severity === 'critical').length;
    return { findings: this.findings, critical, warning: this.findings.length - critical };
  }
}

/**
 * The file's text, or undefined for a binary file (a NUL in the first 8 KB). Markdown, scripts and files that
 * start with `#!` are never treated as binary; UTF-16 files (by BOM) are decoded. NULs are removed, a leading
 * BOM is dropped and line endings become `\n`.
 */
function decode(file: string, content: Buffer): string | undefined {
  let text: string;
  if (content[0] === 0xff && content[1] === 0xfe) text = content.subarray(2, content.length & ~1).toString('utf16le');
  else if (content[0] === 0xfe && content[1] === 0xff) text = Buffer.from(content.subarray(2, content.length & ~1)).swap16().toString('utf16le');
  else {
    const always = /\.md$/i.test(file) || SCRIPT_EXT.test(file) || SCRIPT_NAME.test(file) || /^(?:\xEF\xBB\xBF)?\s*#!/.test(content.subarray(0, 64).toString('latin1'));
    if (!always && content.subarray(0, SNIFF_BYTES).includes(0)) return undefined;
    text = content.toString('utf8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\0/g, '').replace(/\r\n?/g, '\n');
}

const applies = (rule: Rule, kind: FileKind) => rule.target === 'all' || rule.target === kind;

/** Rule regexes with the `m` flag, for pre-testing blocks of joined lines. */
const multiline = new Map(RULES.map((r) => [r.id, new RegExp(r.re.source, r.re.flags.includes('m') ? r.re.flags : r.re.flags + 'm')]));

/** A logical line: one physical line, or (in shell-like scripts) a backslash-continued command or a heredoc fed to a shell. */
interface Logical { text: string; line: number; spans: readonly Span[] }

const HEREDOC_TO_SHELL = /(?:\b(?:ba|z|da|k)?sh|\bpython[23]?|\$\{?SHELL\}?)\s*<<(-?)\s*(["']?)([\w.-]+)\2/i;

class FileScan {
  private readonly logical: Logical[] = [];
  private readonly fmEnd: number; // physical index of the closing `---`, or -1 without frontmatter
  private readonly fmData: Record<string, unknown> | undefined;
  private readonly physical: string[];
  /** Logical lines a critical rule matched (downgraded or not): weak/* findings there are dropped. */
  private readonly strongLines = new Set<number>();
  private readonly stopped: Array<{ rule: Rule; after: number }> = [];
  private readonly chunks: Array<{ first: number; last: number; text: string } | { long: number }> = [];

  constructor(private readonly file: string, private readonly kind: FileKind, text: string) {
    this.physical = text.split('\n');
    const spans = quotedSpans(this.physical, kind, file);
    ({ end: this.fmEnd, data: this.fmData } = kind === 'text' && /\.md$/i.test(file) ? frontmatter(this.physical) : { end: -1, data: undefined });
    this.buildLogical(spans);
    this.buildChunks();
  }

  private buildLogical(spans: Map<number, Span[]>): void {
    const lines = this.physical;
    const shellish = this.kind === 'script' && SHELLISH.test(this.file);
    const joinable = this.kind === 'script' && !/\.(?:js|mjs|cjs|ts)$/i.test(this.file);
    const continued = (i: number) => joinable && !spans.has(i) && trailingBackslashes(lines[i]!) % 2 === 1;
    for (let i = 0; i < lines.length; i++) {
      let j = i;
      const h = shellish && !spans.has(i) ? HEREDOC_TO_SHELL.exec(lines[i]!) : null;
      if (h) {
        // The body runs in a shell: join it (to the terminator, or to the end of the file) into one logical line.
        let end = i + 1;
        while (end < lines.length && (h[1] ? lines[end]!.replace(/^\t+/, '') : lines[end]) !== h[3]) end++;
        j = Math.min(end, lines.length - 1);
      } else {
        while (j < lines.length - 1 && continued(j)) j++;
      }
      const text = j === i ? lines[i]! : lines.slice(i, j + 1).map((l, k) => (continued(i + k) ? l.slice(0, -1) : l)).join(' ');
      this.logical.push({ text, line: i, spans: j > i ? [] : spans.get(i) ?? [] });
      i = j;
    }
  }

  private buildChunks(): void {
    // A chunk's text also holds the next short line, so that a phrase wrapped across the boundary is pre-tested.
    let first = 0;
    let size = 0;
    const flush = (upTo: number) => {
      if (upTo <= first) return;
      const next = this.logical[upTo];
      const extra = next && next.text.length <= WINDOW ? [next.text] : [];
      this.chunks.push({ first, last: upTo - 1, text: [...this.logical.slice(first, upTo).map((l) => l.text), ...extra].join('\n') });
    };
    this.logical.forEach((l, i) => {
      if (l.text.length > WINDOW) { flush(i); this.chunks.push({ long: i }); first = i + 1; size = 0; return; }
      if (size + l.text.length + 1 > BLOCK) { flush(i); first = i; size = 0; }
      size += l.text.length + 1;
    });
    flush(this.logical.length);
  }

  run(): Finding[] {
    const out: Finding[] = [];
    for (const rule of RULES) {
      if (rule.target === 'frontmatter') { if (this.fmData) out.push(...this.frontmatterRule(rule)); continue; }
      if (applies(rule, this.kind)) out.push(...this.lineRule(rule));
    }
    return out;
  }

  /**
   * At most 3 findings per (rule, file) for a critical rule and 1 for a warning rule; real criticals first. A
   * rule stops once it has its cap of real criticals (or of warnings); later lines it never looked at are
   * checked lazily when a weak rule needs to know whether a critical rule matches there.
   */
  private lineRule(rule: Rule): Finding[] {
    const cap = rule.severity === 'critical' ? 3 : 1;
    const weak = rule.id.startsWith('weak/');
    const kept: Finding[] = [];
    const downgraded: Finding[] = [];
    for (const i of this.candidates(rule)) {
      if (weak && this.strong(i)) continue;
      const finding = this.matchLine(rule, i) ?? this.matchPair(rule, i);
      if (!finding) continue;
      if (rule.severity === 'critical') this.strongLines.add(i);
      if (finding.downgraded === undefined) kept.push(finding);
      else if (downgraded.length < cap) downgraded.push(finding);
      if (kept.length >= cap) {
        if (rule.severity === 'critical') this.stopped.push({ rule, after: i });
        break;
      }
    }
    return [...kept, ...downgraded].slice(0, cap);
  }

  /** A critical rule matched logical line i (as recorded, or by asking the rules that stopped before i). */
  private strong(i: number): boolean {
    if (this.strongLines.has(i)) return true;
    const text = this.logical[i]!.text;
    return this.stopped.some((s) => i > s.after && this.find(s.rule, text) !== null);
  }

  /** Lines that might match: every line of a block of joined lines that the rule matches anywhere in. */
  private *candidates(rule: Rule): Generator<number> {
    const pre = multiline.get(rule.id)!;
    for (const c of this.chunks) {
      if ('long' in c) yield c.long;
      else if (pre.test(c.text)) for (let i = c.first; i <= c.last; i++) yield i;
    }
  }

  private find(rule: Rule, text: string): { index: number; length: number } | null {
    if (text.length <= WINDOW || CHAR_CLASS_RULES.has(rule.id)) return ruleMatch(rule, text, this.file);
    for (let s = 0; ; s += WINDOW - OVERLAP) {
      const m = ruleMatch(rule, text.slice(s, s + WINDOW), this.file);
      if (m) return { index: s + m.index, length: m.length };
      if (s + WINDOW >= text.length) return null;
    }
  }

  private finding(rule: Rule, text: string, line: number, m: { index: number; length: number }, spans: readonly Span[], frontmatter: boolean): Finding {
    const reason = downgradeReason(rule, { kind: this.kind, file: this.file, text, index: m.index, length: m.length, spans, frontmatter });
    const f: Finding = { rule: rule.id, severity: reason ? 'warning' : rule.severity, file: this.file, line: line + 1, message: rule.message };
    if (reason) f.downgraded = reason;
    return f;
  }

  private inFrontmatter = (line: number) => line > 0 && line < this.fmEnd;

  private matchLine(rule: Rule, i: number): Finding | undefined {
    const l = this.logical[i]!;
    const m = this.find(rule, l.text);
    return m ? this.finding(rule, l.text, l.line, m, l.spans, this.inFrontmatter(l.line)) : undefined;
  }

  /**
   * Instruction text wraps: a text rule also tests a line joined to the next one and reports a match that
   * crosses the join (at the first line). Both lines must be non-blank, short, and equally inside or outside a block.
   */
  private matchPair(rule: Rule, i: number): Finding | undefined {
    if (rule.target !== 'text') return undefined;
    const a = this.logical[i]!;
    const b = this.logical[i + 1];
    if (!b || !a.text.trim() || !b.text.trim() || a.text.length > WINDOW || b.text.length > WINDOW) return undefined;
    if (/^\s*(?:`{3,}|~{3,})/.test(a.text) || /^\s*(?:`{3,}|~{3,})/.test(b.text)) return undefined;
    const aBlock = a.spans.length > 0;
    if (aBlock !== b.spans.length > 0) return undefined;
    const text = `${a.text} ${b.text}`;
    const m = ruleMatch(rule, text, this.file);
    if (!m || m.index >= a.text.length || m.index + m.length <= a.text.length + 1) return undefined;
    const fm = this.inFrontmatter(a.line) && this.inFrontmatter(b.line);
    return this.finding(rule, text, a.line, m, aBlock ? [[0, Infinity]] : [], fm);
  }

  /** Frontmatter rules test each granted tool and report the line of its key. */
  private frontmatterRule(rule: Rule): Finding[] {
    for (const key of TOOL_KEYS) {
      if (!toolGrants(this.fmData![key]).some((t) => rule.re.test(t))) continue;
      const at = this.physical.findIndex((l, i) => i > 0 && i < this.fmEnd && l.startsWith(key) && /^\s*:/.test(l.slice(key.length)));
      return [{ rule: rule.id, severity: rule.severity, file: this.file, line: at > 0 ? at + 1 : 1, message: rule.message }];
    }
    return [];
  }
}

function trailingBackslashes(l: string): number {
  let n = 0;
  while (n < l.length && l[l.length - 1 - n] === '\\') n++;
  return n;
}

/** The frontmatter block's closing line and parsed data. The block is parsed only if it is at most 1 MB. */
function frontmatter(lines: string[]): { end: number; data: Record<string, unknown> | undefined } {
  if (lines[0]?.trimEnd() !== '---') return { end: -1, data: undefined };
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return { end: -1, data: undefined };
  let size = 0;
  for (let i = 0; i <= end; i++) size += lines[i]!.length + 1;
  if (size > MAX_FILE_BYTES) return { end, data: undefined };
  const fm = parseFrontmatter(lines.slice(0, end + 1).join('\n'));
  return { end, data: fm.ok ? fm.data : undefined };
}
