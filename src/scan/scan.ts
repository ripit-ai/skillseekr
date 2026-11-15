// The security scan: reads a skill's files, classifies them, runs RULES line by line and applies the
// context-aware downgrade. Ported in structure from skillyard (MIT) src/scan.js @ 83ee690 (scanFiles).
// Pure pattern matching: no network, no AI, deterministic.
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, join, posix } from 'node:path';
import { parseFrontmatter } from '../catalog/frontmatter.js';
import { MAX_FILE_BYTES, MAX_SCAN_BYTES, SNIFF_BYTES } from '../catalog/limits.js';
import { RULES, TOOL_KEYS, ruleMatch, ruleMatches, ruleTest, toolGrants, type Rule } from './rules.js';
import { downgradeReason, quotedSpans, readsPatterns, type FileKind, type Span } from './context.js';

export interface Finding { rule: string; severity: 'critical' | 'warning'; file: string; line: number; message: string; downgraded?: string /* reason */ }
export interface ScanResult { findings: Finding[]; critical: number; warning: number }

export const SCRIPT_EXT = /\.(?:sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1)$/i;
/** Files that hold shell commands without a script extension. package.json is scanned whole for its `scripts`. */
const SCRIPT_NAME = /(?:^|\/)(?:[Mm]akefile|GNUmakefile|\.envrc|\.?[Jj]ustfile|package\.json)$/;
const SHELLISH = /\.(?:sh|bash|zsh)$|(?:^|\/)(?:[Mm]akefile|GNUmakefile|\.envrc|\.?[Jj]ustfile)$|(?:^|\/)[^./]+$/;
/** A file name without an extension (P2-R19): scanned as a script as well as text, unless it is a known document. */
const EXTENSIONLESS = /(?:^|\/)[^./]+$/;
const DOCUMENT_NAME = /(?:^|\/)(?:LICEN[CS]E|NOTICE|README|CHANGELOG|AUTHORS|COPYING)$/i;
/** Files that are binary by name (P2-R19 b). */
const BINARY_EXT = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|bz2|xz|7z|jar|woff2?|ttf|otf|mp3|mp4|mov|wav|ogg|wasm|so|dylib|dll|exe|class|pyc)$/i;
/** Magic numbers of binary formats: PNG, JPEG, GIF, PDF, ZIP (jar, docx), gzip, ELF, Mach-O (and fat), PE, RIFF (WebP, WAV), WASM. */
const BINARY_MAGIC: readonly Buffer[] = [
  [0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], 'GIF87a', 'GIF89a', '%PDF-', [0x50, 0x4b, 0x03, 0x04], [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08], [0x1f, 0x8b], [0x7f, 0x45, 0x4c, 0x46], [0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], 'MZ', 'RIFF', [0x00, 0x61, 0x73, 0x6d],
].map((m) => (typeof m === 'string' ? Buffer.from(m, 'latin1') : Buffer.from(m)));
const binaryByName = (file: string, content: Buffer) => BINARY_EXT.test(file) || BINARY_MAGIC.some((m) => content.subarray(0, m.length).equals(m));

/** A script language, by the extension the scanner gives a file run through that interpreter. */
type Lang = 'sh' | 'py' | 'js' | 'rb' | 'pl' | 'ps1';
const EXT_LANG: Record<string, Lang> = { sh: 'sh', bash: 'sh', zsh: 'sh', py: 'py', js: 'js', mjs: 'js', cjs: 'js', ts: 'js', rb: 'rb', pl: 'pl', ps1: 'ps1' };
function interpreterLang(cmd: string): Lang {
  const c = cmd.toLowerCase();
  if (c.startsWith('python')) return 'py';
  if (c === 'node' || c === 'deno' || c === 'bun') return 'js';
  if (c === 'ruby') return 'rb';
  if (c === 'perl') return 'pl';
  if (c === 'pwsh' || c === 'powershell') return 'ps1';
  return 'sh'; // sh, bash, zsh, dash, ksh, source, .
}
/** The language a script file is lexed as without any invocation: by extension, else by its `#!` line, else shell. */
function ownLang(file: string, text: string): Lang {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase();
  if (ext && EXT_LANG[ext]) return EXT_LANG[ext]!;
  const bang = /^\s*#!([^\n]*)/.exec(text)?.[1] ?? '';
  if (/python/.test(bang)) return 'py';
  if (/\b(?:node|deno|bun)\b/.test(bang)) return 'js';
  if (/\bruby/.test(bang)) return 'rb';
  if (/\bperl/.test(bang)) return 'pl';
  if (/\b(?:pwsh|powershell)/.test(bang)) return 'ps1';
  return 'sh';
}

/**
 * An interpreter run on a path (P2-R19 a): `bash scripts/setup`, `python3 -u ./tool.txt`, `. env`, `deno run x`,
 * also after `/bin/`, a quote, or a `$DIR/`, `${DIR}/` or `{baseDir}/` prefix. Linear: every repeat is bounded.
 */
const INVOKE = /(?:^|[\s;&|(`'"=/])((?:ba|z|da|k)?sh|source|\.|python(?:[23](?:\.\d{1,3})?)?|node|deno|bun|ruby|perl|pwsh|powershell)(?:\.exe)?[ \t]{1,64}(?:-{1,2}[a-z][\w-]{0,32}[ \t]{1,64}){0,4}(?:run[ \t]{1,64})?["']?(?:\$\{?\w{1,64}\}?\/|\{\w{1,64}\}\/)?([\w.@+/-]{1,512})/gi;

/** Collects the files of a skill that its text runs through an interpreter, and the languages it runs each one as. */
class Invocations {
  private readonly known: ReadonlySet<string>;
  readonly found = new Map<string, Set<Lang>>();

  constructor(files: Iterable<string>) { this.known = new Set(files); }

  /** Paths resolve against the skill root or the invoking file's folder; only files of the skill count. */
  add(file: string, content: Buffer): void {
    if (binaryByName(file, content)) return;
    let text: string;
    if (content[0] === 0xff && content[1] === 0xfe) text = content.subarray(2, content.length & ~1).toString('utf16le');
    else if (content[0] === 0xfe && content[1] === 0xff) text = Buffer.from(content.subarray(2, content.length & ~1)).swap16().toString('utf16le');
    else text = content.toString('utf8');
    const dir = posix.dirname(file);
    for (const m of text.replace(/\0/g, '').matchAll(INVOKE)) {
      const path = m[2]!.replace(/\.+$/, '');
      if (!path) continue;
      for (const p of [posix.normalize(path), posix.normalize(posix.join(dir, path))]) {
        if (!this.known.has(p)) continue;
        let langs = this.found.get(p);
        if (!langs) this.found.set(p, (langs = new Set()));
        langs.add(interpreterLang(m[1]!));
      }
    }
  }
}

/** All bytes scanned for one skill (P2-R17: 12 MB). Files past it (in path order) are reported, not scanned. */
export const SKILL_SCAN_BUDGET = 12 * 1024 * 1024;

export const UNSCANNABLE_RULE = 'integrity/unscannable-file';

/**
 * Text rules that can be downgraded look at every match on a line (Task 2 review): a quoted or defensive first match
 * must not hide a real second one. At most this many per line are judged; a line with more fails closed.
 */
const MAX_LINE_MATCHES = 16;
const everyMatch = (rule: Rule) => rule.target !== 'script' && rule.severity === 'critical' && !rule.neverDowngrade;
type Span2 = { index: number; length: number };
function* filter(it: Iterable<Span2>, keep: (m: Span2) => boolean): Generator<Span2> { for (const m of it) if (keep(m)) yield m; }
/** The first match judged critical; else the first (downgraded) one; past MAX_LINE_MATCHES, the extra match undowngraded. */
function firstReal(matches: Iterable<Span2>, at: (m: Span2) => Finding): Finding | undefined {
  let first: Finding | undefined;
  let n = 0;
  for (const m of matches) {
    const f = at(m);
    if (++n > MAX_LINE_MATCHES) return { rule: f.rule, severity: 'critical', file: f.file, line: f.line, message: f.message };
    if (f.downgraded === undefined) return f;
    first ??= f;
  }
  return first;
}
const unscannable = (file: string, message: string): Finding => ({ rule: UNSCANNABLE_RULE, severity: 'critical', file, line: 1, message });
const TOO_LARGE = 'file is over 10 MB and was not scanned';
const OVER_BUDGET = 'exceeds per-skill scan budget';
const TOO_COMPLEX = 'file could not be scanned (a pattern check exceeded its limits)';

/** Lines up to this long are joined into blocks of about this size and pre-tested once per rule. Every rule is
 * tested against whole logical lines: the regexes are linear-time (see rules.ts). */
const BLOCK = 4096;

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Scans in-memory files ({ path: posix relative path, content }) as one skill. Pure. */
export function scanFiles(files: Array<{ path: string; content: Buffer }>): ScanResult {
  const sorted = [...files].sort((a, b) => byCodeUnit(a.path, b.path));
  const calls = new Invocations(sorted.map((f) => f.path));
  for (const f of sorted) if (f.content.length <= MAX_SCAN_BYTES) calls.add(f.path, f.content);
  const skill = new SkillScan(calls.found);
  for (const f of sorted) skill.add(f.path, f.content);
  return skill.result();
}

/**
 * Scans the listed files (posix paths relative to dir) as one skill. Only regular files are read: a path that
 * goes through a symlink, leaves dir, or doesn't exist is skipped. A file over 10 MB, or one that can't be read,
 * is reported as unscannable. Every file is read first to find the files the skill runs through an interpreter
 * (P2-R19); contents within the scan budget are kept for the scan, the others are read again.
 */
export async function scanSkillDir(dir: string, files: string[]): Promise<ScanResult> {
  const reads: Array<{ rel: string; read: Read | undefined }> = [];
  const calls = new Invocations(files);
  let kept = 0;
  for (const rel of [...files].sort(byCodeUnit)) {
    const read = await readRegular(dir, rel);
    if (read === undefined) continue;
    if ('error' in read || read.size > MAX_SCAN_BYTES) { reads.push({ rel, read }); continue; }
    calls.add(rel, read.content);
    const keep = kept + read.size <= SKILL_SCAN_BUDGET;
    if (keep) kept += read.size;
    reads.push({ rel, read: keep ? read : undefined });
  }
  const skill = new SkillScan(calls.found);
  for (const { rel, read: first } of reads) {
    const read = first ?? (await readRegular(dir, rel));
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

type Pass = { kind: FileKind; lang: string; scriptOnly?: boolean };

class SkillScan {
  readonly findings: Finding[] = [];
  private used = 0;

  /** invoked: files the skill runs through an interpreter, with the languages it runs them as (P2-R19). */
  constructor(private readonly invoked: ReadonlyMap<string, ReadonlySet<Lang>> = new Map()) {}

  add(file: string, content: Buffer): void {
    if (content.length > MAX_SCAN_BYTES) { this.findings.push(unscannable(file, TOO_LARGE)); return; }
    const langs = [...(this.invoked.get(file) ?? [])];
    const named = SCRIPT_EXT.test(file) || SCRIPT_NAME.test(file);
    const bare = EXTENSIONLESS.test(file) && !DOCUMENT_NAME.test(file);
    const text = decode(file, content, named || bare || langs.length > 0);
    if (text === undefined) return;
    if (this.used + content.length > SKILL_SCAN_BUDGET) { this.findings.push(unscannable(file, OVER_BUDGET)); return; }
    this.used += content.length;
    const passes: Pass[] = [];
    if (named || /^\s*#!/.test(text)) {
      // A script; when the skill runs it through another language's interpreter, the script rules also run as that.
      passes.push({ kind: 'script', lang: file });
      const own = ownLang(file, text);
      for (const l of langs) if (l !== own) passes.push({ kind: 'script', lang: `${file}.${l}`, scriptOnly: true });
    } else if (bare || langs.length > 0) {
      // An extensionless or interpreter-run file: text rules as before, plus the script rules (P2-R19 a).
      passes.push({ kind: 'text', lang: file });
      if (langs.length === 0) passes.push({ kind: 'script', lang: file, scriptOnly: true });
      for (const l of langs) passes.push({ kind: 'script', lang: `${file}.${l}`, scriptOnly: true });
    } else passes.push({ kind: 'text', lang: file });
    const found = new Map<string, Finding>();
    for (const pass of passes) {
      let out: Finding[];
      try {
        out = new FileScan(file, pass.kind, text, pass.lang, pass.scriptOnly).run();
      } catch (e) {
        // Fail closed: a pattern that can't finish on this input (e.g. a regex stack overflow) must not hide it.
        if (!(e instanceof RangeError)) throw e;
        out = [unscannable(file, TOO_COMPLEX)];
      }
      for (const f of out) {
        const key = `${f.rule}\0${f.line}`;
        const had = found.get(key);
        if (!had || (had.severity === 'warning' && f.severity === 'critical')) found.set(key, f);
      }
    }
    this.findings.push(...found.values());
  }

  result(): ScanResult {
    const rank = (f: Finding) => (f.severity === 'critical' ? 0 : 1);
    this.findings.sort((a, b) => rank(a) - rank(b) || byCodeUnit(a.file, b.file) || a.line - b.line || byCodeUnit(a.rule, b.rule));
    const critical = this.findings.filter((f) => f.severity === 'critical').length;
    return { findings: this.findings, critical, warning: this.findings.length - critical };
  }
}

/**
 * The file's text, or undefined for a binary file. Markdown, scripts (script: classified as one by name or by
 * invocation) and files that start with `#!` are never treated as binary. Any other file is binary only when its
 * first line (within the first 8 KB) holds a NUL, or it starts with a binary format's magic number, or has a
 * binary format's extension (P2-R19 b). UTF-16 files (by BOM) are decoded. NULs are removed, a leading BOM is
 * dropped and line endings become `\n`.
 */
function decode(file: string, content: Buffer, script: boolean): string | undefined {
  let text: string;
  if (content[0] === 0xff && content[1] === 0xfe) text = content.subarray(2, content.length & ~1).toString('utf16le');
  else if (content[0] === 0xfe && content[1] === 0xff) text = Buffer.from(content.subarray(2, content.length & ~1)).swap16().toString('utf16le');
  else {
    const always = script || /\.md$/i.test(file) || /^(?:\xEF\xBB\xBF)?\s*#!/.test(content.subarray(0, 64).toString('latin1'));
    if (!always && (binaryFirstLine(content) || binaryByName(file, content))) return undefined;
    text = content.toString('utf8');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\0/g, '').replace(/\r\n?/g, '\n');
}

/** A NUL before the first newline, within the first 8 KB. */
function binaryFirstLine(content: Buffer): boolean {
  const head = content.subarray(0, SNIFF_BYTES);
  const nul = head.indexOf(0);
  if (nul < 0) return false;
  const nl = head.indexOf(0x0a);
  return nl < 0 || nul < nl;
}

const applies = (rule: Rule, kind: FileKind) => rule.target === 'all' || rule.target === kind;

/** Rule regexes with the `m` flag, for pre-testing blocks of joined lines. */
const multiline = new Map(RULES.map((r) => [r.id, new RegExp(r.re.source, r.re.flags.includes('m') ? r.re.flags : r.re.flags + 'm')]));

const HEREDOC_TO_SHELL = /(?:\b(?:ba|z|da|k)?sh|\bpython[23]?|\$\{?SHELL\}?)\s*<<(-?)\s*(["']?)([\w.-]+)\2/i;
/** Anything that can join physical lines into one logical line: a trailing backslash, pipe, && or ||, or a heredoc. */
const MAY_JOIN = /\\(?:\n|$)|(?:\|\|?|&&)[ \t]*(?:\n|$)|<</;
const FENCE = /^\s*(?:`{3,}|~{3,})/;
const NONE: readonly Span[] = [];

type Chunk = { first: number; last: number; text: string; lower: string } | { long: number };

/**
 * Scans one decoded file. Rules run over logical lines: one physical line, or (in scripts other than JS/TS) a
 * backslash-continued command, in shell-like files also a command continued by a trailing pipe, && or ||, and a
 * heredoc fed to a shell. A logical line is reported at its first physical line.
 */
class FileScan {
  private texts: string[] = [];
  /** Physical line of each logical line; undefined when they are the same. */
  private lineNo: number[] | undefined;
  /** Quoted spans of logical lines that are a single physical line. */
  private lspans: Map<number, readonly Span[]> = new Map();
  private readonly fmEnd: number; // physical index of the closing `---`, or -1 without frontmatter
  private readonly fmData: Record<string, unknown> | undefined;
  private readonly physical: string[];
  /** Logical lines a critical rule matched (downgraded or not): weak/* findings there are dropped. */
  private readonly strongLines = new Set<number>();
  private readonly stopped: Array<{ rule: Rule; after: number }> = [];
  private readonly chunks: Chunk[] = [];
  private readonly longLower = new Map<number, string>();
  /** Per needle, per chunk: 0 not yet searched, 1 absent, 2 present. */
  private readonly needleHits = new Map<string, Uint8Array>();
  private readonly readsPatterns: boolean;

  /**
   * lang: the path whose name decides how a script is lexed (comments, line joins, program-file rules); the file
   * itself, or the file with the extension of the interpreter the skill runs it through. scriptOnly: run only
   * `script` rules (the other rules already ran on this file in another pass).
   */
  constructor(private readonly file: string, private readonly kind: FileKind, text: string, private readonly lang: string = file, private readonly scriptOnly = false) {
    this.physical = text.split('\n');
    this.readsPatterns = kind === 'script' && readsPatterns(text);
    const spans = quotedSpans(this.physical, kind, lang);
    ({ end: this.fmEnd, data: this.fmData } = kind === 'text' && /\.md$/i.test(file) ? frontmatter(this.physical) : { end: -1, data: undefined });
    const joinable = kind === 'script' && !/\.(?:js|mjs|cjs|ts)$/i.test(lang);
    if (joinable && MAY_JOIN.test(text)) this.buildLogical(spans);
    else { this.texts = this.physical; this.lspans = spans; }
    this.buildChunks();
  }

  private buildLogical(spans: Map<number, Span[]>): void {
    const lines = this.physical;
    const shellish = SHELLISH.test(this.lang);
    const pipeJoin = shellish || /\.ps1$/i.test(this.lang);
    const backslash = (i: number) => trailingBackslashes(lines[i]!) % 2 === 1;
    const continued = (i: number) => !spans.has(i) && (backslash(i) || (pipeJoin && /(?:\|\|?|&&)[ \t]*$/.test(lines[i]!)));
    const lineNo: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      let j = i;
      const h = shellish && !spans.has(i) && lines[i]!.includes('<<') ? HEREDOC_TO_SHELL.exec(lines[i]!) : null;
      if (h) {
        // The body runs in a shell: join it (to the terminator, or to the end of the file) into one logical line.
        let end = i + 1;
        while (end < lines.length && (h[1] ? lines[end]!.replace(/^\t+/, '') : lines[end]) !== h[3]) end++;
        j = Math.min(end, lines.length - 1);
      } else {
        while (j < lines.length - 1 && continued(j)) j++;
      }
      const k = this.texts.length;
      if (j === i) {
        this.texts.push(lines[i]!);
        const sp = spans.get(i);
        if (sp) this.lspans.set(k, sp);
      } else {
        this.texts.push(lines.slice(i, j + 1).map((l, n) => (continued(i + n) && backslash(i + n) ? l.slice(0, -1) : l)).join(' '));
      }
      lineNo.push(i);
      i = j;
    }
    this.lineNo = lineNo;
  }

  private buildChunks(): void {
    // A chunk's text also holds the next short line, so that a phrase wrapped across the boundary is pre-tested.
    const texts = this.texts;
    let first = 0;
    let size = 0;
    const flush = (upTo: number) => {
      if (upTo <= first) return;
      const next = texts[upTo];
      const text = texts.slice(first, next !== undefined && next.length <= BLOCK ? upTo + 1 : upTo).join('\n');
      this.chunks.push({ first, last: upTo - 1, text, lower: text.toLowerCase() });
    };
    for (let i = 0; i < texts.length; i++) {
      const len = texts[i]!.length;
      if (len > BLOCK) { flush(i); this.chunks.push({ long: i }); first = i + 1; size = 0; continue; }
      if (size + len + 1 > BLOCK) { flush(i); first = i; size = 0; }
      size += len + 1;
    }
    flush(texts.length);
  }

  run(): Finding[] {
    const out: Finding[] = [];
    for (const rule of RULES) {
      if (this.scriptOnly && rule.target !== 'script') continue;
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
    const downgradable = rule.severity === 'critical' && !rule.neverDowngrade;
    for (const i of this.candidates(rule)) {
      // A line wholly inside a comment, docstring or fence: a weak signal there means nothing, and a critical
      // rule can only get another downgraded finding from it, which it doesn't need once it holds `cap`.
      if ((weak || (downgradable && downgraded.length >= cap)) && this.wholeQuoted(i)) continue;
      if (weak && this.strong(i)) continue;
      // A downgraded match on the line must not hide a real one that crosses into the next line.
      let finding = this.matchLine(rule, i);
      if (!finding || finding.downgraded !== undefined) {
        const pair = this.matchPair(rule, i);
        if (pair && (!finding || pair.downgraded === undefined)) finding = pair;
      }
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
    const text = this.texts[i]!;
    return this.stopped.some((s) => i > s.after && ruleTest(s.rule, text, this.lang));
  }

  /**
   * Lines that might match: every line of a block of joined lines that holds one of the rule's needles and that
   * the rule matches anywhere in. Long lines are always candidates when they hold a needle.
   */
  private *candidates(rule: Rule): Generator<number> {
    const pre = multiline.get(rule.id)!;
    const needles = rule.needles;
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const c = this.chunks[ci]!;
      const has = !needles || needles.some((n) => this.hasNeedle(n, ci));
      if ('long' in c) { if (has) yield c.long; }
      else if (has && pre.test(c.text)) for (let i = c.first; i <= c.last; i++) yield i;
    }
  }

  /** Whether chunk ci holds the needle. Rules share needles, so each (needle, chunk) is searched once. */
  private hasNeedle(n: string, ci: number): boolean {
    let seen = this.needleHits.get(n);
    if (!seen) { seen = new Uint8Array(this.chunks.length); this.needleHits.set(n, seen); }
    if (seen[ci] === 0) {
      const c = this.chunks[ci]!;
      let lower: string;
      if ('long' in c) {
        const cached = this.longLower.get(c.long);
        lower = cached ?? this.texts[c.long]!.toLowerCase();
        if (cached === undefined) this.longLower.set(c.long, lower);
      } else lower = c.lower;
      seen[ci] = lower.includes(n) ? 2 : 1;
    }
    return seen[ci] === 2;
  }

  private finding(rule: Rule, text: string, line: number, m: { index: number; length: number }, spans: readonly Span[], frontmatter: boolean): Finding {
    const reason = downgradeReason(rule, { kind: this.kind, file: this.lang, text, index: m.index, length: m.length, spans, frontmatter, readsPatterns: this.readsPatterns });
    const f: Finding = { rule: rule.id, severity: reason ? 'warning' : rule.severity, file: this.file, line: line + 1, message: rule.message };
    if (reason) f.downgraded = reason;
    return f;
  }

  private inFrontmatter = (line: number) => line > 0 && line < this.fmEnd;
  private line = (i: number) => this.lineNo?.[i] ?? i;
  private spansOf = (i: number) => this.lspans.get(i) ?? NONE;
  private wholeQuoted = (i: number) => this.spansOf(i).some(([s, e]) => s === 0 && e >= this.texts[i]!.length);

  private matchLine(rule: Rule, i: number): Finding | undefined {
    const text = this.texts[i]!;
    const at = (m: { index: number; length: number }) => this.finding(rule, text, this.line(i), m, this.spansOf(i), this.inFrontmatter(this.line(i)));
    if (!everyMatch(rule)) {
      const m = ruleMatch(rule, text, this.lang);
      return m ? at(m) : undefined;
    }
    return firstReal(ruleMatches(rule, text, MAX_LINE_MATCHES + 1), at);
  }

  /**
   * Instruction text wraps: a text rule also tests a line joined to the next one and reports a match that
   * crosses the join (at the first line). Both lines must be non-blank, short, and equally inside or outside a block.
   */
  private matchPair(rule: Rule, i: number): Finding | undefined {
    if (rule.target !== 'text') return undefined;
    const a = this.texts[i]!;
    const b = this.texts[i + 1];
    if (b === undefined || !a.trim() || !b.trim() || a.length > BLOCK || b.length > BLOCK || FENCE.test(a) || FENCE.test(b)) return undefined;
    const aBlock = this.spansOf(i).length > 0;
    if (aBlock !== this.spansOf(i + 1).length > 0) return undefined;
    const text = `${a} ${b}`;
    const fm = this.inFrontmatter(this.line(i)) && this.inFrontmatter(this.line(i + 1));
    const at = (m: { index: number; length: number }) => this.finding(rule, text, this.line(i), m, aBlock ? [[0, Infinity]] : [], fm);
    const crosses = (m: { index: number; length: number }) => m.index < a.length && m.index + m.length > a.length + 1;
    if (!everyMatch(rule)) {
      const m = ruleMatch(rule, text, this.lang);
      return m && crosses(m) ? at(m) : undefined;
    }
    return firstReal(filter(ruleMatches(rule, text, MAX_LINE_MATCHES + 1), crosses), at);
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
