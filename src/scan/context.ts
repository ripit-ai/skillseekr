// Ported from skillyard (MIT) src/scan.js @ 83ee690: fencedLines, looksBenign and DEFENSIVE_RE.
// Copyright (c) 2026 Skillyard contributors. See THIRD_PARTY_NOTICES.md.
// Decides when a critical match only quotes a pattern rather than using it. Each decision has one reason.
// Changes from upstream: every check is tied to where the match is. A block (fence, docstring, block comment)
// counts only once it is closed; comments and strings follow each language's syntax (Python and JS/TS are
// lexed; Python docstrings must be bare, never assigned or f-strings); a quotation must enclose the match; a
// defensive phrase must come before it in the same sentence; a pattern must be a direct string argument of a
// regex call (Python, JS/TS only); printing must not be redirected or piped anywhere; and "localhost" needs a
// loopback URL and no other possible target on the line.
//
// Known limit (ruling P2-R15): the spec downgrades matches in script comments, docstrings and regex patterns, and
// a script can always read its own text back and run it (`exec(open(__file__).read()...)`, `eval "${X#*#}"` over a
// comment, `os.system(P.pattern)`). That self-extraction class can't be closed by pattern scanning; the deny list
// covers it. Cheap guards remove the downgrade where a file visibly reads such text back: `__doc__`, `getdoc`,
// `getattr`, `globals(`, `locals(`, `vars(`, `__dict__` disable Python docstring downgrades, and `.pattern` / `.source`
// disable regex-argument downgrades. What is never accepted is a lexer bug that makes executable code look like a
// comment, docstring or pattern; the lexers below are deliberately conservative and stop downgrading once a file
// holds a construct they can't follow (a multi-line string or heredoc in shell-like files, `/*` or a backtick in a
// JS code line, a multi-line f-string with braces in Python).
import type { Rule } from './rules.js';

export const REASONS = {
  example: 'inside an example block',
  quoted: 'in quotation marks',
  defensive: 'in a defensive sentence',
  comment: 'in a comment, docstring or pattern',
  prints: 'only prints the command',
  localhost: 'target is localhost',
} as const;
export type Reason = (typeof REASONS)[keyof typeof REASONS];

export type FileKind = 'text' | 'script';
/** A [start, end) range of a line that is quoted: inside a closed fence, docstring or comment. */
export type Span = readonly [number, number];

/** One rule match on one logical line. */
export interface MatchSite {
  kind: FileKind;
  file: string;
  /** The whole logical line. */
  text: string;
  /** Where the match starts in `text`, and how long it is. */
  index: number;
  length: number;
  /** Quoted ranges of this line (from quotedSpans). */
  spans: readonly Span[];
  /** The line is inside the file's YAML frontmatter. */
  frontmatter: boolean;
  /** Regex arguments can't downgrade in this file (see readsPatterns). */
  readsPatterns: boolean;
}

/**
 * Whether regex arguments can't downgrade in this script: it reads a compiled regex's text back (`P.pattern`,
 * `re.source`), so its patterns may be code; or it holds U+2028/U+2029, which end a JS line (N1) where this scan
 * sees none.
 */
export function readsPatterns(text: string): boolean {
  return /\.(?:pattern|source)\b|[\u2028\u2029]/.test(text);
}

const JS_FILE = /\.(?:js|mjs|cjs|ts)$/i;
const PY_FILE = /\.py$/i;
const WHOLE: Span = [0, Infinity];

/**
 * The quoted parts of each line. Text: lines inside a closed fenced block (a fence closes only with the same
 * character and at least the same length; an unclosed fence quotes nothing). Scripts (P2-R12): only whole-line
 * comments and true Python docstrings. A comment or string in the middle of a line never quotes anything.
 */
export function quotedSpans(lines: string[], kind: FileKind, file: string): Map<number, Span[]> {
  const spans = new Map<number, Span[]>();
  const add = (i: number, s: Span) => { const a = spans.get(i); if (a) a.push(s); else spans.set(i, [s]); };
  if (kind === 'text') {
    let open: { at: number; ch: string; len: number } | undefined;
    lines.forEach((l, i) => {
      const m = /^\s*(`{3,}|~{3,})/.exec(l);
      if (!m) return;
      const fence = m[1]!;
      if (!open) open = { at: i, ch: fence[0]!, len: fence.length };
      else if (fence[0] === open.ch && fence.length >= open.len) {
        for (let k = open.at + 1; k < i; k++) add(k, WHOLE);
        open = undefined;
      }
    });
    return spans;
  }
  const lang = scriptLang(lines, file);
  if (lang === 'js') jsLineComments(lines, add);
  else if (lang === 'py') pyCommentsAndDocstrings(lines, add);
  else if (lang === 'rbpl') rubyPerlComments(lines, add);
  else if (lang === 'ps1') powershellComments(lines, add);
  else shellComments(lines, file, add);
  return spans;
}

type Lang = 'js' | 'py' | 'rbpl' | 'ps1' | 'shell';
/** The script's language for comment lexing: by extension, else by the `#!` line; anything else is shell. */
function scriptLang(lines: string[], file: string): Lang {
  if (JS_FILE.test(file)) return 'js';
  if (PY_FILE.test(file)) return 'py';
  if (/\.(?:rb|pl)$/i.test(file)) return 'rbpl';
  if (/\.ps1$/i.test(file)) return 'ps1';
  const bang = lines[0]?.startsWith('#!') ? lines[0] : '';
  if (/python/.test(bang)) return 'py';
  if (/\b(?:node|deno|bun)\b/.test(bang)) return 'js';
  if (/\b(?:ruby|perl)/.test(bang)) return 'rbpl';
  if (/\b(?:pwsh|powershell)/.test(bang)) return 'ps1';
  return 'shell';
}

/** A `#` line that is a comment, unless it is the `#!` line. */
const hashLine = (l: string, i: number) => /^\s*#/.test(l) && !(i === 0 && l.startsWith('#!'));

type ShFrame = { k: 'sq' | 'ansi' | 'dq' | 'bq' | 'cmd' | 'param' | 'arith'; depth: number };
type Heredoc = { word: string; strip: boolean };
const HEREDOC_OP = /^<<(-?)[ \t]*\\?(["']?)([^\s'"<>|;&()]+)\2/;
const WORD_BREAK = ' \t;&|()<>';

/**
 * Shell (sh/bash/zsh, extensionless scripts, Makefile, justfile, .envrc) whole-line comments (P2-R12, round 5). A
 * per-line lexer carries its state across lines: '…' (no escapes), "…" and $'…' (with escapes), backticks, $( … ),
 * $(( … )) and (( … )), ${ … }, and heredoc bodies (`<<[-]WORD` up to the WORD line). A `#` line is a comment only
 * when the lexer is at top level at its start: not inside any of those, and not continued by a backslash. In a
 * Makefile a `define` (a multi-line value whose `#` lines are text) ends all downgrades.
 */
function shellComments(lines: string[], file: string, add: (i: number, s: Span) => void): void {
  const make = /(?:^|\/)(?:[Mm]akefile|GNUmakefile)$/.test(file);
  const stack: ShFrame[] = [];
  const queued: Heredoc[] = [];
  let body: Heredoc | undefined;
  let continued = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (body) {
      if ((body.strip ? l.replace(/^\t+/, '') : l) === body.word) body = queued.shift();
      continue;
    }
    if (make && /^\s*define\b/.test(l)) return;
    if (stack.length === 0 && !continued && /^\s*#/.test(l)) {
      if (hashLine(l, i)) add(i, WHOLE);
      continue;
    }
    continued = shellLine(l, stack, queued);
    if (queued.length) body = queued.shift();
  }
}

// The characters each shell context reacts to; the lexer jumps from one to the next.
const SH_STOP: Record<ShFrame['k'] | 'top', RegExp> = {
  top: /[\\#'"`$(<]/g, cmd: /[\\#'"`$(<)]/g, sq: /'/g, ansi: /[\\']/g, dq: /[\\"`$]/g, bq: /[\\`'"$]/g,
  param: /[\\'"`${}]/g, arith: /[\\'"`$()]/g,
};

/**
 * A frame that `$` at k opens (`$(`, `$((`, `${`; in command context also `$'`, `$"`), pushed, and the length it
 * takes; 0 if none.
 */
function shDollar(l: string, k: number, stack: ShFrame[], command: boolean): number {
  const d = l[k + 1];
  if (d === '(') {
    if (l[k + 2] === '(') { stack.push({ k: 'arith', depth: 0 }); return 3; }
    stack.push({ k: 'cmd', depth: 0 });
    return 2;
  }
  if (d === '{') { stack.push({ k: 'param', depth: 0 }); return 2; }
  if (command && d === "'") { stack.push({ k: 'ansi', depth: 0 }); return 2; }
  if (command && d === '"') { stack.push({ k: 'dq', depth: 0 }); return 2; }
  return 0;
}

const SH_OPEN: Record<string, ShFrame['k']> = { "'": 'sq', '"': 'dq', '`': 'bq' };

/** Lexes one shell line, updating the frame stack and queuing heredocs. Returns whether a backslash continues it. */
function shellLine(l: string, stack: ShFrame[], queued: Heredoc[]): boolean {
  const n = l.length;
  let k = 0;
  while (k < n) {
    const top = stack[stack.length - 1];
    const stop = SH_STOP[top ? top.k : 'top'];
    stop.lastIndex = k;
    const m = stop.exec(l);
    if (!m) return false;
    k = m.index;
    const c = m[0];
    if (!top || top.k === 'cmd') {
      if (c === '\\') { if (k === n - 1) return true; k += 2; continue; }
      if (c === '#') {
        if (k === 0 || WORD_BREAK.includes(l[k - 1]!)) return false; // a comment to the end of the line
        k++;
        continue;
      }
      if (c === '$') {
        const skip = shDollar(l, k, stack, true);
        k += skip || (l[k + 1] === '#' || l[k + 1] === '$' ? 2 : 1);
        continue;
      }
      if (c === '(') {
        if (l[k + 1] === '(') { stack.push({ k: 'arith', depth: 0 }); k += 2; continue; }
        if (top) top.depth++;
        k++;
        continue;
      }
      if (c === ')') { if (top!.depth === 0) stack.pop(); else top!.depth--; k++; continue; }
      if (c === '<') {
        if (l[k + 1] !== '<') { k++; continue; }
        if (l[k + 2] === '<') { k += 3; continue; }
        const h = HEREDOC_OP.exec(l.slice(k, k + 256));
        if (h) { queued.push({ word: h[3]!, strip: h[1] === '-' }); k += h[0].length; continue; }
        k += 2;
        continue;
      }
      stack.push({ k: SH_OPEN[c]!, depth: 0 });
      k++;
      continue;
    }
    if (c === '\\') { k += 2; continue; }
    switch (top.k) {
      case 'sq': case 'ansi':
        stack.pop();
        k++;
        continue;
      case 'dq':
        if (c === '"') { stack.pop(); k++; continue; }
        if (c === '`') { stack.push({ k: 'bq', depth: 0 }); k++; continue; }
        k += shDollar(l, k, stack, false) || 1;
        continue;
      case 'bq':
        if (c === '`') { stack.pop(); k++; continue; }
        if (c === '$') { k += shDollar(l, k, stack, false) || 1; continue; }
        stack.push({ k: SH_OPEN[c]!, depth: 0 });
        k++;
        continue;
      default: { // param `${…}` and arithmetic `$((…))` / `((…))`
        if (c === '$') { k += shDollar(l, k, stack, false) || 1; continue; }
        if (c in SH_OPEN) { stack.push({ k: SH_OPEN[c]!, depth: 0 }); k++; continue; }
        if (c === '{' || c === '(') top.depth++;
        else if (top.depth > 0) top.depth--;
        else if (top.k === 'param') stack.pop();
        else if (l[k + 1] === ')') { stack.pop(); k++; }
        k++;
        continue;
      }
    }
  }
  return false;
}

/** Ruby/Perl sections that the script can read back as text: `__END__` / `__DATA__` and the DATA handle. */
const RB_PL_DATA = /\b(?:__END__|__DATA__|DATA)\b/;
/** Perl quote-like operators (and Ruby calls of those names): a name followed by a delimiter. */
const PERL_QUOTE_OP = /^(?:q|qq|qw|qr|qx|m|s|tr|y)\s*[^\w\s,;=)}\]]/;

/**
 * Ruby and Perl whole-line comments. Their strings, regex literals and quote-like operators can't be lexed cheaply,
 * so `#` lines count only before the first line this lexer can't follow, and none count in a file with a DATA
 * section. A code line is followed only if, outside '…' and "…" (both with backslash escapes), it has no `/`, `%`,
 * backtick, `<<`, `?` before a quote, quote-like operator, or `#{`/`${`/`@{` inside "…", and no string is open at its
 * end. A line ending in a backslash continues into the next, which is then never a comment.
 */
function rubyPerlComments(lines: string[], add: (i: number, s: Span) => void): void {
  if (lines.some((l) => RB_PL_DATA.test(l))) return;
  let continued = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!continued && /^\s*#/.test(l)) { if (hashLine(l, i)) add(i, WHOLE); continue; }
    const r = rubyPerlLine(l);
    if (r === 'lost') return;
    continued = r === 'continued';
  }
}

function rubyPerlLine(l: string): 'ok' | 'continued' | 'lost' {
  for (let k = 0; k < l.length; k++) {
    const c = l[k]!;
    if (c === '#') return 'ok';
    if (c === '\\') { if (k === l.length - 1) return 'continued'; k++; continue; }
    if (c === '"' || c === "'") {
      let j = k + 1;
      for (; j < l.length && l[j] !== c; j++) {
        if (l[j] === '\\') j++;
        else if (c === '"' && (l[j] === '#' || l[j] === '$' || l[j] === '@') && l[j + 1] === '{') return 'lost';
      }
      if (j >= l.length) return 'lost';
      k = j;
      continue;
    }
    if (c === '/' || c === '%' || c === '`') return 'lost';
    if (c === '<' && l[k + 1] === '<') return 'lost';
    if (c === '?' && (l[k + 1] === '"' || l[k + 1] === "'")) return 'lost';
    if (/[a-z]/.test(c) && (k === 0 || !/[\w$@%:>.]/.test(l[k - 1]!)) && PERL_QUOTE_OP.test(l.slice(k, k + 8))) return 'lost';
  }
  return 'ok';
}

/**
 * PowerShell whole-line comments (N4). `#` lines count only before the first line this lexer can't follow: a `<#`
 * block comment opener outside a string, a here-string (`@"`/`@'`), a `$(` inside "…", or a string still open at the
 * end of a line ('…' has no escapes, "…" escapes with a backtick). A `#` line holding `#>` (a block comment's end)
 * is never a comment. A line ending in a backtick continues into the next, which is then never a comment.
 */
function powershellComments(lines: string[], add: (i: number, s: Span) => void): void {
  let continued = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.includes('<#')) return;
    if (!continued && /^\s*#/.test(l)) {
      if (l.includes('#>')) return;
      if (hashLine(l, i)) add(i, WHOLE);
      continue;
    }
    const r = powershellLine(l);
    if (r === 'lost') return;
    continued = r === 'continued';
  }
}

function powershellLine(l: string): 'ok' | 'continued' | 'lost' {
  for (let k = 0; k < l.length; k++) {
    const c = l[k]!;
    if (c === '#') return 'ok';
    if (c === '`') { if (k === l.length - 1) return 'continued'; k++; continue; }
    if (c === '@' && (l[k + 1] === '"' || l[k + 1] === "'")) return 'lost';
    if (c === "'") {
      const end = l.indexOf("'", k + 1);
      if (end < 0) return 'lost';
      k = end;
      continue;
    }
    if (c === '"') {
      let j = k + 1;
      for (; j < l.length && l[j] !== '"'; j++) {
        if (l[j] === '`') j++;
        else if (l[j] === '$' && l[j + 1] === '(') return 'lost';
      }
      if (j >= l.length) return 'lost';
      k = j;
    }
  }
  return 'ok';
}

/** Index of `q` (a quote or triple quote) in `l` at or after `k`, skipping backslash escapes; -1 if none. */
function closingQuote(l: string, k: number, q: string): number {
  for (; k < l.length; k++) {
    if (l[k] === '\\') k++;
    else if (l.startsWith(q, k)) return k;
  }
  return -1;
}

/**
 * JS/TS whole-line comments: a line that starts with `//`, a block comment whose first line starts with `/*`
 * (up to its closing `*\/`), and the lines inside it. Without a full JS lexer a template literal or a block comment
 * opened mid-line could hide such a line (`x = 1 /* note` then `// *\/ code`), so comments count only before the
 * first line of code that holds a backtick or `/*`, and never on a line after one ending in a backslash (string
 * continuation). An unclosed block comment quotes nothing.
 */
function jsLineComments(lines: string[], add: (i: number, s: Span) => void): void {
  // U+2028 and U+2029 end a JS line (a `//` comment, a string continuation) but not a line here (N1).
  if (lines.some((l) => /[\u2028\u2029]/.test(l))) return;
  let block: Array<[number, Span]> | undefined;
  let lost = false;
  lines.forEach((l, i) => {
    if (block) {
      const close = l.indexOf('*/');
      if (close < 0) { block.push([i, WHOLE]); return; }
      for (const [li, sp] of block) add(li, sp);
      add(i, [0, close + 2]);
      block = undefined;
      if (opensUnknown(l.slice(close + 2))) lost = true;
      return;
    }
    const at = l.length - l.trimStart().length;
    const eligible = !lost && !(i > 0 && /\\$/.test(lines[i - 1]!));
    if (eligible && l.startsWith('//', at)) { add(i, [at, Infinity]); return; }
    if (eligible && l.startsWith('/*', at)) {
      const close = l.indexOf('*/', at + 2);
      if (close >= 0) {
        add(i, [at, close + 2]);
        if (opensUnknown(l.slice(close + 2))) lost = true;
      } else block = [[i, [at, Infinity]]];
      return;
    }
    if (opensUnknown(l)) lost = true;
  });
}

/** JS code that may start a construct spanning lines that jsLineComments doesn't follow: a template or a block comment. */
const opensUnknown = (code: string) => code.includes('`') || code.includes('/*');

const PY_HEADER = /^\s*(?:async\s+)?(?:def|class)\b/;
const PY_DOC_OPENER = /^\s*[rRbBuU]{0,2}(?:"""|''')/;

/**
 * Python whole-line `#` comments and bare docstrings, from one pass that tracks strings (single-line, triple,
 * backslash-continued, f-strings with nested quotes in braces), bracket depth and line continuations. A bare
 * docstring is a closed, non-f triple-quoted string that is the first statement of the module or of a def/class
 * body: the first token of a statement line (not inside brackets, not after a backslash), with nothing after its
 * closing quote. A file that may read a docstring back (`__doc__`, `getdoc`, `getattr`, `globals(`, `locals(`,
 * `vars(`, `__dict__`) gets no docstring downgrades. A string prefix is the whole identifier run before the quote
 * (`if"x"` is the keyword `if` and a plain string). An f-string that spans lines and holds `{` (Python 3.12 allows
 * nested quotes of any kind in its braces, which this lexer can't follow) ends all downgrades from its first line on.
 */
function pyCommentsAndDocstrings(lines: string[], add: (i: number, s: Span) => void): void {
  const docsAllowed = !lines.some((l) => DOC_READ.test(l));
  let lost = false; // a multi-line f-string with braces: the lexer can no longer be trusted
  const put = (i: number, s: Span) => { if (!lost) add(i, s); };
  type Str = { q: string; f: boolean; multi?: boolean; doc: boolean; line: number; at: number; pending: Array<[number, Span]> };
  let str: Str | undefined;
  let depth = 0;
  let continued = false; // the previous line ended with a backslash outside a string
  let expectDoc = true; // at the start of the module, or right after a def/class header
  let header = false; // inside a def/class header (which may span lines)
  lines.forEach((l, i) => {
    const statementStart = !str && depth === 0 && !continued;
    const trimmed = l.trim();
    if (statementStart && trimmed.startsWith('#')) { if (!(i === 0 && l.startsWith('#!'))) put(i, WHOLE); return; }
    if (statementStart && trimmed === '') return;
    if (statementStart) {
      if (PY_HEADER.test(l)) header = true;
      if (!PY_DOC_OPENER.test(l)) expectDoc = false;
    }
    let k = 0;
    let lastCode = -1;
    while (k < l.length) {
      if (str) {
        const end = closeString(l, k, str);
        if (end < 0) {
          if (str.f && l.slice(str.line === i ? str.at : 0).includes('{')) lost = true;
          if (str.f) str.multi = true;
          if (str.q.length === 3) str.pending.push([i, str.line === i ? [str.at, Infinity] : WHOLE]);
          else if (!l.endsWith('\\')) str = undefined; // an unterminated one-line string ends with the line
          k = l.length;
          break;
        }
        if (str.multi && l.slice(0, end).includes('{')) lost = true;
        if (str.doc && docsAllowed && /^\s*(?:#.*)?$/.test(l.slice(end + str.q.length))) {
          for (const [li, sp] of str.pending) put(li, sp);
          put(i, [str.line === i ? str.at : 0, end]);
        }
        k = end + str.q.length;
        lastCode = k - 1;
        str = undefined;
        continue;
      }
      const c = l[k]!;
      if (c === '#') break;
      if (c === '"' || c === "'") {
        const q = l.startsWith(c.repeat(3), k) ? c.repeat(3) : c;
        const prefix = pyPrefix(l, k);
        const f = /[fFtT]/.test(prefix); // f-strings and t-strings (3.14) both interpolate
        const first = l.slice(0, k - prefix.length).trim() === '';
        str = { q, f, doc: q.length === 3 && !f && statementStart && first && expectDoc, line: i, at: k + q.length, pending: [] };
        expectDoc = false;
        k += q.length;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      if (c !== ' ' && c !== '\t' && c !== '\f' && c !== '\v') lastCode = k;
      k++;
    }
    continued = !str && lastCode >= 0 && l[lastCode] === '\\';
    if (!str && depth === 0 && !continued && header) {
      // The header ends here: a docstring may follow only if the line ends with its colon.
      header = false;
      expectDoc = l.slice(0, lastCode + 1).trimEnd().endsWith(':');
    }
  });
  // An unclosed triple-quoted string at the end of the file quotes nothing.
}

const DOC_READ = /__doc__|getdoc|getattr|\bglobals\(|\blocals\(|\bvars\(|__dict__/;

/** The string prefix before the quote at k: the whole identifier run before it, if that is 1–2 prefix letters. */
function pyPrefix(l: string, k: number): string {
  const run = /\w{0,3}$/.exec(l.slice(Math.max(0, k - 3), k))![0];
  return /^[rRbBuUfFtT]{1,2}$/.test(run) ? run : '';
}

/** Index of the current string's closing quote on this line, or -1. In f-strings, quotes inside braces are nested strings. */
function closeString(l: string, k: number, str: { q: string; f: boolean }): number {
  let braces = 0;
  for (; k < l.length; k++) {
    const c = l[k]!;
    if (c === '\\') { k++; continue; }
    if (str.f) {
      if (c === '{') { if (braces === 0 && l[k + 1] === '{') { k++; continue; } braces++; continue; }
      if (c === '}' && braces > 0) { braces--; continue; }
      if (braces > 0 && (c === '"' || c === "'")) {
        const end = closingQuote(l, k + 1, c);
        if (end < 0) return -1;
        k = end;
        continue;
      }
    }
    if (braces === 0 && l.startsWith(str.q, k)) return k;
  }
  return -1;
}

/** Why a critical match is only a warning, or undefined when it stays critical. */
export function downgradeReason(rule: Rule, site: MatchSite): Reason | undefined {
  if (rule.severity !== 'critical' || rule.neverDowngrade) return undefined;
  const inSpan = site.spans.some(([s, e]) => site.index >= s && site.index + site.length <= e);
  if (site.kind === 'text') {
    if (inSpan) return REASONS.example;
    if (enclosedInQuotes(site)) return REASONS.quoted;
    if (defensiveBefore(site)) return REASONS.defensive;
    return undefined;
  }
  if (inSpan || insideRegexCall(site)) return REASONS.comment;
  if (rule.id.startsWith('download-and-run/') && onlyPrints(site)) return REASONS.prints;
  if (rule.id.startsWith('exfiltration/') && localOnly(site)) return REASONS.localhost;
  return undefined;
}

const CLOSE: Record<string, string> = { '"': '"', '“': '”', '「': '」', "'": "'" };
const WORDISH = /[\p{L}\p{N}]/u;

/**
 * The match lies inside a quotation that opens before it and closes after it on the same line. Quotes: straight
 * double, curly double, corner brackets, and straight single quotes that aren't apostrophes inside a word. In
 * frontmatter, the quotes that wrap a YAML value are syntax, not quotation, and don't count.
 */
function enclosedInQuotes(site: MatchSite): boolean {
  const { text, index, length } = site;
  const skip = new Set<number>();
  if (site.frontmatter) {
    const m = /^(\s*[\w-]+\s*:\s*)(["'])/.exec(text);
    const end = text.trimEnd().length - 1;
    if (m && end > m[1]!.length && text[end] === m[2]) { skip.add(m[1]!.length); skip.add(end); }
  }
  const apostrophe = (k: number) => WORDISH.test(text[k - 1] ?? '') && WORDISH.test(text[k + 1] ?? '');
  let open: string | undefined;
  for (let k = 0; k < index; k++) {
    if (skip.has(k)) continue;
    const c = text[k]!;
    if (c === "'" && apostrophe(k)) continue;
    if (open === undefined) { if (c in CLOSE) open = c; }
    else if (c === CLOSE[open]) open = undefined;
  }
  if (open === undefined) return false;
  for (let k = index + length; k < text.length; k++) {
    if (skip.has(k)) continue;
    if (text[k] === CLOSE[open] && !(open === "'" && apostrophe(k))) return true;
  }
  return false;
}

// Real-world skills quote attacks to warn the agent about them ("if a page says 'ignore previous instructions',
// flag it"). The phrase must come before the match, in the same sentence.
const DEFENSIVE_END = /\b(?:if|when)\s+(?:[\w-]+\s+){0,2}(?:says|contains|tries|asks)(?:\s+(?:you\s+)?to)?[\s:,"'“「(]*$/i;
const DEFENSIVE_ANY = /never\s+follow|not\s+(?:an?\s+)?instructions?|injection|data,?\s+not|绝不|flag\s+it/i;

function defensiveBefore(site: MatchSite): boolean {
  const prefix = site.text.slice(Math.max(0, site.index - 4096), site.index);
  const stops = [...prefix.matchAll(/[.!?;。]/g)];
  const region = stops.length ? prefix.slice(stops[stops.length - 1]!.index! + 1) : prefix;
  if (DEFENSIVE_END.test(region) || DEFENSIVE_ANY.test(region)) return true;
  // "Treat <match> as data."
  return /\btreat\b/i.test(region) && /^[^.!?]{0,30}?\bas\s+data\b/i.test(site.text.slice(site.index + site.length, site.index + site.length + 64));
}

const PY_REGEX_CALL = /(?<![\w.])re\.(?:search|match|compile|findall|finditer|sub|subn|fullmatch|split|escape)\(/g;
const JS_REGEX_CALL = /(?<![\w$.])(?:new\s+)?RegExp\(/g;

/**
 * Python and JS/TS only: the match lies inside a string literal that is a direct argument of a regex call
 * (re.compile(…), re.escape(…), new RegExp(…)), not nested in another call or expression, and not interpolated.
 * Never in a file that reads a pattern's text back (`.pattern`, `.source`).
 */
function insideRegexCall(site: MatchSite): boolean {
  const py = PY_FILE.test(site.file);
  const calls = py ? PY_REGEX_CALL : JS_FILE.test(site.file) ? JS_REGEX_CALL : undefined;
  if (!calls || site.readsPatterns || !site.text.includes(py ? 're.' : 'RegExp(')) return false;
  const opens = [...site.text.slice(0, site.index).matchAll(calls)].slice(-8).map((m) => m.index! + m[0].length - 1);
  return opens.some((open) => directStringArgument(site.text, open, site.index, site.index + site.length, py));
}

/**
 * A string literal at bracket depth 1 of the call opened at `open` encloses [from, to). An interpolated or tagged
 * string anywhere in the arguments before the match (a Python f-string, a JS template holding `${`, a tagged
 * template) means no: its braces run code, and this scan can't follow nested quotes inside them.
 */
function directStringArgument(text: string, open: number, from: number, to: number, py: boolean): boolean {
  let depth = 0;
  for (let k = open; k < text.length && k < from; k++) {
    const c = text[k]!;
    if (c === '"' || c === "'" || c === '`') {
      if (py && (/[fFtT]/.test(pyPrefix(text, k)) || (/\w/.test(text[k - 1] ?? '') && pyPrefix(text, k) === ''))) return false;
      if (!py && c === '`' && /[\w$)\].]\s*$/.test(text.slice(Math.max(0, k - 64), k))) return false;
      const end = closingQuote(text, k + 1, c);
      if (end < 0) return false;
      if (c === '`' && text.slice(k, end).includes('${')) return false;
      if (depth === 1 && k < from && to <= end) return true;
      k = end;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return false;
  }
  return false;
}

const PRINT_CALL = /^[ \t]*(?:echo|printf|print|puts|console\.(?:log|error|info|warn)|Write-(?:Host|Output))[ \t]*(?:\([ \t]*)?[frbu]?(["'`])/i;
/** After the printed string: only a closing paren, a redirect to stderr, a semicolon and a comment. (No adjacent
 * unbounded whitespace runs: every context regex must stay linear on a 10 MB line.) */
const AFTER_PRINT = /^[ \t]*(?:\)[ \t]*)?(?:1?>&2[ \t]*)?(?:;[ \t]*)?(?:(?:#|\/\/).*)?$/;

/**
 * The line is a print statement whose first string argument holds the whole match, nothing runs after the
 * string (no pipe, second command or file redirect), and the string can't run code itself (no `$(`, `${`,
 * backticks, or f-string braces).
 */
function onlyPrints(site: MatchSite): boolean {
  const m = PRINT_CALL.exec(site.text);
  if (!m) return false;
  const quote = m[1]!;
  const start = m[0].length;
  const end = site.text.indexOf(quote, start);
  if (end < 0 || site.index < start || site.index + site.length > end) return false;
  const body = site.text.slice(start, end);
  if (/\$\(|\$\{|`/.test(body) || (/[fF]["'`]$/.test(m[0]) && body.includes('{'))) return false;
  return AFTER_PRINT.test(site.text.slice(end + 1));
}

const LOOPBACK_URL = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::(?:\d+|\$?\{\w+\}))?(?:[/?#][^\s'"`]*)?$/i;
const HOST_LIKE = /(?<![\w-])[\w-]+(?:\.[\w-]+){1,64}\.?/g;
const LOOPBACK = /^(?:127\.0\.0\.1|localhost)\.?$/i;
/** Dotted names that are the client and environment APIs on these lines, not hosts. */
const CODE_NAME = /^(?:os\.environ(?:\.get)?|os\.getenv|process\.env(?:\.[A-Z_][A-Z0-9_]*)?|(?:requests|httpx|axios)\.(?:post|put|patch|get|request)|urllib\.request(?:\.urlopen)?|json\.dumps|JSON\.stringify)$/;
const OTHER_ADDRESS = /\b\d{8,10}\b|\b0x[0-9a-f]{6,8}\b|\[(?!::1\])[0-9a-f.]{0,40}:[0-9a-f:.]{0,45}\]|\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/i;

/**
 * "Target is localhost" (P2-R13). Shell: the curl/wget command's every non-option argument is a literal loopback
 * URL, with no command substitution, no other command on the line, and no option that reroutes or adds targets
 * (-K/--config, --url, --connect-to, --resolve, -x/--proxy, wget -i/-e). Python/JS: every requests/httpx/urlopen/
 * fetch/axios call's first argument is a string-literal loopback URL, any `url=` is one too, and no proxy is set.
 * Either way, no other host-like name or address may appear anywhere on the line (comments included).
 */
function localOnly(site: MatchSite): boolean {
  const s = site.text;
  if (!(JS_FILE.test(site.file) || PY_FILE.test(site.file) ? programLocalOnly(s) : shellLocalOnly(s))) return false;
  if (OTHER_ADDRESS.test(s)) return false;
  for (const m of s.matchAll(HOST_LIKE)) if (!LOOPBACK.test(m[0]) && !CODE_NAME.test(m[0])) return false;
  return true;
}

// `fetch\w*` anywhere in a word: fetch, nodeFetch, $fetch, ofetch, fetchJSON (no `\w*` before it: that backtracks).
const CLIENT_CALL = /\b(?:(?:requests|httpx)\.\w+|urlopen|axios(?:\.\w+)?)\s*\(|fetch\w*\s*\(/gi;

/** Options that can send the request elsewhere, or arguments that can carry them unseen (`**kw`, `...opts`). */
const PROGRAM_REROUTE = /[pP][rR][oO][xX]|\*\*|\.\.\.|\b(?:dispatcher|agent|httpAgent|httpsAgent|transport|mounts|adapter|baseURL|base_url|socketPath|lookup|opener)\b/;

/** The only option keys (object keys, Python keyword arguments) a localhost call may set (N5). */
const OPTION_KEYS = new Set(['body', 'json', 'data', 'headers', 'method', 'timeout']);
const QUOTED_NAME = String.raw`(?:"[\w-]*"|'[\w-]*')`;
/** A read of the environment: `process.env.X`, `os.environ["X"]`, `os.getenv("X")`, `os.environ.get("X")`. */
const ENV_MEMBER = new RegExp(String.raw`^(?:(?:process\.env|os\.environ)(?:\.[A-Za-z_]\w*|\[\s*${QUOTED_NAME}\s*\])*|os\.(?:getenv|environ\.get)\(\s*${QUOTED_NAME}\s*\))$`);
const SIMPLE = /^(?:-?\d+(?:\.\d+)?|true|false|null|None|True|False)$/;
const ENTRY = /^(?:([A-Za-z_$][\w$]*)|"([\w -]*)"|'([\w -]*)')\s*:\s*([\s\S]+)$/;

/**
 * Python/JS (P2-R13, N5, N6): every client call's first argument is exactly a non-interpolated loopback string
 * literal (or, for a keyword-first call, its `url=` is). Every later argument is on an allow-list: a literal, an
 * environment read, `JSON.stringify`/`json.dumps`/`dict` of one, or an object/dict literal whose keys are plain
 * names (no computed `[k]`, shorthand or spread) from OPTION_KEYS with allow-listed values; Python keyword arguments
 * likewise. No `\u`/`\x` escape may appear on the line (they can spell a key), no option can reroute the request,
 * and every `url=`/`url:` is exactly a loopback literal.
 */
function programLocalOnly(s: string): boolean {
  // Interpolated strings: `${` here; f-/t-strings in the arguments make callArgs fail, and literalEnd (url=) refuses them.
  if (s.includes('${') || /\\[ux]/.test(s) || PROGRAM_REROUTE.test(s)) return false;
  const calls = [...s.matchAll(CLIENT_CALL)];
  // Each call's arguments are split by a scan to its closing paren; nested calls would make that quadratic.
  if (calls.length === 0 || calls.length > 16) return false;
  for (const m of calls) {
    const args = callArgs(s, m.index! + m[0].length);
    if (!args || args.length === 0) return false;
    const kw = args.map((a) => /^(\w+)\s*=(?!=)\s*([\s\S]*)$/.exec(a));
    if (kw[0] ? !kw.some((k) => k?.[1] === 'url') : !isLiteral(args[0]!, true)) return false;
    for (let n = kw[0] ? 0 : 1; n < args.length; n++) {
      const k = kw[n];
      if (k ? (k[1] === 'url' ? isLiteral(k[2]!, true) : OPTION_KEYS.has(k[1]!) && safeValue(k[2]!, 0)) : args[n] === '' || safeValue(args[n]!, 0, true)) continue;
      return false;
    }
  }
  return [...s.matchAll(/\burl\s*[=:]\s*/g)].every((m) => {
    const rest = s.slice(m.index! + m[0].length);
    const end = literalEnd(rest);
    return end > 0 && /^\s*(?:[,)}]|$)/.test(rest.slice(end)) && isLiteral(rest.slice(0, end), true);
  });
}

/** An allow-listed argument value. A top-level object literal is an options object (`options`): its keys must be OPTION_KEYS. */
function safeValue(v: string, depth: number, options = false): boolean {
  v = v.trim();
  if (isLiteral(v, false) || SIMPLE.test(v) || ENV_MEMBER.test(v)) return true;
  if (depth > 4) return false;
  if (v.startsWith('{')) return safeObject(v, options, depth + 1);
  const call = /^(?:JSON\.stringify|json\.dumps|dict)\(([\s\S]*)\)$/.exec(v);
  if (!call) return false;
  const inner = splitTop(call[1]!);
  return inner !== undefined && inner.length === 1 && (ENV_MEMBER.test(inner[0]!) || (inner[0]!.startsWith('{') && safeObject(inner[0]!, false, depth + 1)));
}

function safeObject(v: string, options: boolean, depth: number): boolean {
  if (!v.endsWith('}')) return false;
  const entries = splitTop(v.slice(1, -1));
  if (!entries) return false;
  return entries.every((e, n) => {
    if (e === '') return n === entries.length - 1; // a trailing comma
    const m = ENTRY.exec(e);
    if (!m) return false;
    if (options && !OPTION_KEYS.has(m[1] ?? m[2] ?? m[3]!)) return false;
    return safeValue(m[4]!, depth);
  });
}

/** `s` split (trimmed) at its top-level commas; undefined if a bracket or string is unbalanced. */
function splitTop(s: string): string[] | undefined {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let k = 0; k < s.length; k++) {
    const c = s[k]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = closingQuote(s, k + 1, c);
      if (end < 0) return undefined;
      k = end;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (--depth < 0) return undefined; }
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, k).trim()); start = k + 1; }
  }
  if (depth !== 0) return undefined;
  parts.push(s.slice(start).trim());
  return parts;
}

/**
 * The arguments (trimmed) of the call whose `(` ends just before `from`, split at its top-level commas; undefined if
 * unbalanced or if an argument holds a Python f- or t-string (interpolated).
 */
function callArgs(s: string, from: number): string[] | undefined {
  const args: string[] = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < s.length; k++) {
    const c = s[k]!;
    if (c === '"' || c === "'" || c === '`') {
      if (/[fFtT]/.test(pyPrefix(s, k))) return undefined;
      const end = closingQuote(s, k + 1, c);
      if (end < 0) return undefined;
      k = end;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) {
        if (c !== ')') return undefined;
        const last = s.slice(start, k).trim();
        if (last || args.length) args.push(last);
        return args.filter((a, n) => a !== '' || n < args.length - 1);
      }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(s.slice(start, k).trim()); start = k + 1; }
  }
  return undefined;
}

/** Length of the string literal (optional r/b/u prefix) at the start of `a`, or -1. */
function literalEnd(a: string): number {
  const m = /^[rRbBuU]{0,2}(["'`])/.exec(a);
  if (!m) return -1;
  const end = closingQuote(a, m[0].length, m[1]!);
  return end < 0 ? -1 : end + 1;
}

/** `a` is exactly one plain string literal (a loopback URL when `loopback`). */
function isLiteral(a: string, loopback: boolean): boolean {
  const end = literalEnd(a);
  if (end !== a.length) return false;
  const open = a.search(/["'`]/);
  return !loopback || LOOPBACK_URL.test(a.slice(open + 1, end - 1));
}

const SHELL_WRAPPERS = new Set(['sudo', 'doas', 'command', 'exec', 'time', 'nohup', 'builtin', 'env', 'nice', 'setsid']);
const DOWNLOADER = /^(?:.*\/)?(?:curl|wget)(?:\.exe)?$/;
/** Options whose value is the next word (curl and wget). Others are taken to have no value. */
const VALUE_OPTIONS = new Set(['-d', '--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '-H', '--header',
  '-F', '--form', '--form-string', '-u', '--user', '-X', '--request', '-o', '--output', '-A', '--user-agent', '-e', '--referer', '-b', '--cookie',
  '-c', '--cookie-jar', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-T', '--upload-file', '--retry', '--oauth2-bearer',
  '-O', '--output-document', '-a', '-t', '--tries', '-U', '-P', '--post-data', '--post-file', '--body-data', '--method', '--password']);
const CURL_SHORT_VALUES = 'dHFuXoAebcmwTO';
/** Options that read targets or settings from elsewhere, or reroute the request. */
const REROUTE = /^(?:-K|--config|--connect-to|--resolve|-x|--proxy|--preproxy|--socks\w*|-i|--input-file|--execute|-:|--next)$/;

function shellLocalOnly(s: string): boolean {
  if (/\$\(|`/.test(s)) return false;
  const words = shellWords(s);
  if (!words) return false;
  const start = words.findIndex((w) => DOWNLOADER.test(w.text));
  // Only known wrappers may come before the downloader: no `VAR=value` (http_proxy=…, CURL_HOME=…), no options.
  if (start < 0 || words.slice(0, start).some((w) => w.quoted || !SHELL_WRAPPERS.has(w.text))) return false;
  const wget = words[start]!.text.includes('wget');
  let targets = 0;
  for (let k = start + 1; k < words.length; k++) {
    const w = words[k]!;
    if (w.text.startsWith('-') && !w.quoted) {
      const [name, value] = [w.text.split('=')[0]!, w.text.includes('=') ? w.text.slice(w.text.indexOf('=') + 1) : undefined];
      if (name === '--url') {
        const v = value ?? words[++k]?.text;
        if (v === undefined || v.includes('$') || !LOOPBACK_URL.test(v)) return false;
        targets++;
        continue;
      }
      if (REROUTE.test(name) || (/^-[a-zA-Z]{2,}$/.test(name) && /[xK]/.test(name))) return false;
      if (wget && (name === '-e' || /^-e./.test(name))) return false; // wget -e runs a wgetrc command (proxies, more URLs)
      const takesValue = value === undefined && (VALUE_OPTIONS.has(name) || (/^-[a-zA-Z]{2,}$/.test(name) && CURL_SHORT_VALUES.includes(name[name.length - 1]!)));
      if (takesValue) k++;
      continue;
    }
    if (w.text.includes('$') || !LOOPBACK_URL.test(w.text)) return false;
    targets++;
  }
  return targets > 0;
}

/** Shell words with quotes removed; undefined if the line has an unquoted `;`, `&`, `|`, `<`, `>` or `#` comment. */
function shellWords(s: string): Array<{ text: string; quoted: boolean }> | undefined {
  const words: Array<{ text: string; quoted: boolean }> = [];
  let cur = '';
  let quoted = false;
  let inWord = false;
  let k = 0;
  while (k < s.length) {
    const c = s[k]!;
    if (c === '"' || c === "'") {
      const end = c === "'" ? s.indexOf("'", k + 1) : closingQuote(s, k + 1, '"');
      if (end < 0) return undefined;
      cur += s.slice(k + 1, end);
      quoted = inWord = true;
      k = end + 1;
    } else if (c === ' ' || c === '\t') {
      if (inWord) words.push({ text: cur, quoted });
      cur = ''; quoted = false; inWord = false;
      k++;
    } else if (c === ';' || c === '&' || c === '|' || c === '<' || c === '>' || (c === '#' && !inWord)) {
      return undefined;
    } else if (c === '\\') {
      cur += s[k + 1] ?? '';
      inWord = true;
      k += 2;
    } else {
      // Copy the run of ordinary characters in one slice.
      let e = k + 1;
      while (e < s.length && !' \t"\'\\;&|<>'.includes(s[e]!)) e++;
      cur += s.slice(k, e);
      inWord = true;
      k = e;
    }
  }
  if (inWord) words.push({ text: cur, quoted });
  return words;
}
