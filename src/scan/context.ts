// Ported from skillyard (MIT) src/scan.js @ 83ee690: fencedLines, looksBenign and DEFENSIVE_RE.
// Copyright (c) 2026 Skillyard contributors. See THIRD_PARTY_NOTICES.md.
// Decides when a critical match only quotes a pattern rather than using it. Each decision has one reason.
// Changes from upstream: every check is tied to where the match is. A block (fence, docstring, block comment)
// counts only once it is closed; comments and strings follow each language's syntax (Python and JS/TS are
// lexed; Python docstrings must be bare, never assigned or f-strings); a quotation must enclose the match; a
// defensive phrase must come before it in the same sentence; a pattern must be a direct string argument of a
// regex call (Python, JS/TS only); printing must not be redirected or piped anywhere; and "localhost" needs a
// loopback URL and no other possible target on the line.
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
}

const JS_FILE = /\.(?:js|mjs|cjs|ts)$/i;
const PY_FILE = /\.py$/i;
const WHOLE: Span = [0, Infinity];

/**
 * The quoted parts of each line. Text: lines inside a closed fenced block (a fence closes only with the same
 * character and at least the same length; an unclosed fence quotes nothing). Python: closed docstrings that
 * start a statement, and `#` comment lines. JS/TS: `//` and closed `/* … *\/` comments, outside strings. Other
 * scripts (shell, PowerShell, Ruby, Perl, Makefile): `#` comment lines.
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
  if (JS_FILE.test(file)) { jsComments(lines, add); return spans; }
  if (PY_FILE.test(file)) { pyStrings(lines, add); return spans; }
  lines.forEach((l, i) => { if (/^\s*#/.test(l)) add(i, WHOLE); });
  return spans;
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
 * One pass over a Python file's strings and comments. Quoted spans: `#` comments (to the end of the line) and
 * bare docstrings, meaning a closed triple-quoted string that is the first token of its line (a module, class or
 * function docstring). An assigned or argument triple-quoted string is code, and an f-string runs code: neither
 * is a docstring. String state carries across lines, so a closing triple quote is never taken for an opener.
 */
function pyStrings(lines: string[], add: (i: number, s: Span) => void): void {
  let triple: { q: string; doc: boolean; line: number; at: number } | undefined;
  const pending: Array<[number, Span]> = [];
  lines.forEach((l, i) => {
    let k = 0;
    while (k < l.length) {
      if (triple) {
        const end = closingQuote(l, k, triple.q);
        if (end < 0) {
          if (triple.doc) pending.push([i, triple.line === i ? [triple.at, Infinity] : WHOLE]);
          return;
        }
        if (triple.doc) {
          for (const [li, sp] of pending) add(li, sp);
          add(i, [triple.line === i ? triple.at : 0, end]);
        }
        pending.length = 0;
        k = end + 3;
        triple = undefined;
        continue;
      }
      const c = l[k]!;
      if (c === '#') { add(i, [k, Infinity]); return; }
      if (c !== '"' && c !== "'" && !'rRbBuUfF'.includes(c)) { k++; continue; }
      const m = /^([rRbBuUfF]{0,2})("""|\'\'\'|"|')/.exec(l.slice(k, k + 5));
      if (m && (k === 0 || !/\w/.test(l[k - 1]!))) {
        const prefix = m[1]!;
        const q = m[2]!;
        const body = k + prefix.length + q.length;
        if (q.length === 3) {
          triple = { q, line: i, at: body, doc: !/[fF]/.test(prefix) && l.slice(0, k).trim() === '' };
          k = body;
        } else {
          const end = closingQuote(l, body, q);
          k = end < 0 ? l.length : end + 1;
        }
        continue;
      }
      k++;
    }
  });
  // An unclosed triple-quoted string at the end of the file quotes nothing.
}

/** `//` and `/* … *\/` comments outside string literals. A comment opener needs a separator before it. */
function jsComments(lines: string[], add: (i: number, s: Span) => void): void {
  const opener = (l: string, k: number) => k === 0 || /[\s;{}(),=:[\]!&|?+*%<>~^-]/.test(l[k - 1]!);
  let block: { line: number; at: number } | undefined;
  let template = false;
  const pending: Array<[number, Span]> = [];
  lines.forEach((l, i) => {
    let quote: string | undefined = template ? '`' : undefined;
    let k = 0;
    while (k < l.length) {
      if (block) {
        if (l.startsWith('*/', k)) {
          if (block.line === i) add(i, [block.at, k + 2]);
          else { for (const [li, s] of pending) add(li, s); add(i, [0, k + 2]); }
          pending.length = 0;
          block = undefined;
          k += 2;
        } else k++;
        continue;
      }
      const c = l[k]!;
      if (quote) {
        if (c === '\\') k++;
        else if (c === quote) quote = undefined;
        k++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; k++; continue; }
      if (l.startsWith('//', k) && opener(l, k)) { add(i, [k, Infinity]); break; }
      if (l.startsWith('/*', k) && opener(l, k)) { block = { line: i, at: k }; k += 2; continue; }
      if (c === '/' && regexStart(l, k)) { k = regexEnd(l, k); continue; }
      k++;
    }
    template = quote === '`';
    if (block) pending.push([i, block.line === i ? [block.at, Infinity] : WHOLE]);
  });
  // An unclosed block comment at the end of the file quotes nothing.
}

/** A `/` starts a regex literal after an operator or opening bracket, at the start of a line, or after a keyword. */
function regexStart(l: string, k: number): boolean {
  const before = l.slice(0, k).trimEnd();
  return before === '' || /[(,=:[!&|?{};+\-*%<>~^]$/.test(before) || /\b(?:return|typeof|case|in|of|void|delete|throw|new|yield|await)$/.test(before);
}

/** The index just past a regex literal starting at `k` (its closing `/` and flags), or the end of the line. */
function regexEnd(l: string, k: number): number {
  let inClass = false;
  for (k++; k < l.length; k++) {
    const c = l[k]!;
    if (c === '\\') k++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      k++;
      while (k < l.length && /\w/.test(l[k]!)) k++;
      return k;
    }
  }
  return l.length;
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
  const stops = [...prefix.matchAll(/[.!?。](?=\s|$)/g)];
  const region = stops.length ? prefix.slice(stops[stops.length - 1]!.index! + 1) : prefix;
  if (DEFENSIVE_END.test(region) || DEFENSIVE_ANY.test(region)) return true;
  // "Treat <match> as data."
  return /\btreat\b/i.test(region) && /^[^.!?]{0,30}?\bas\s+data\b/i.test(site.text.slice(site.index + site.length, site.index + site.length + 64));
}

const PY_REGEX_CALL = /\bre\.(?:search|match|compile|findall|finditer|sub|subn|fullmatch|split|escape)\(/g;
const JS_REGEX_CALL = /\b(?:new\s+)?RegExp\(/g;

/**
 * Python and JS/TS only: the match lies inside a string literal that is a direct argument of a regex call
 * (re.compile(…), re.escape(…), new RegExp(…)), not nested in another call or expression.
 */
function insideRegexCall(site: MatchSite): boolean {
  const calls = PY_FILE.test(site.file) ? PY_REGEX_CALL : JS_FILE.test(site.file) ? JS_REGEX_CALL : undefined;
  if (!calls) return false;
  const opens = [...site.text.slice(0, site.index).matchAll(calls)].slice(-8).map((m) => m.index! + m[0].length - 1);
  return opens.some((open) => directStringArgument(site.text, open, site.index, site.index + site.length));
}

/** A string literal at bracket depth 1 of the call opened at `open` encloses [from, to). */
function directStringArgument(text: string, open: number, from: number, to: number): boolean {
  let depth = 0;
  for (let k = open; k < text.length && k < from; k++) {
    const c = text[k]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = closingQuote(text, k + 1, c);
      if (end < 0) return false;
      if (depth === 1 && k < from && to <= end) return true;
      k = end;
    } else if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && --depth === 0) return false;
  }
  return false;
}

const PRINT_CALL = /^\s*(?:echo|printf|print|puts|console\.(?:log|error|info|warn)|Write-(?:Host|Output))\s*\(?\s*[frbu]?(["'`])/i;
/** After the printed string: only a closing paren, a redirect to stderr, a semicolon and a comment. */
const AFTER_PRINT = /^\s*\)?\s*(?:1?>&2\s*)?;?\s*(?:#.*|\/\/.*)?$/;

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

const LOCAL_URL = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?![\w.-])/i;
const HOST_LIKE = /[\w-]+(?:\.[\w-]+)+\.?/g;
const LOOPBACK = /^(?:127\.0\.0\.1|localhost)\.?$/i;
/** Dotted names that are the client and environment APIs on these lines, not hosts. */
const CODE_NAME = /^(?:os\.environ(?:\.get)?|os\.getenv|process\.env(?:\.[A-Z_][A-Z0-9_]*)?|(?:requests|httpx|axios)\.(?:post|put|patch|get|request)|urllib\.request(?:\.urlopen)?|json\.dumps|JSON\.stringify)$/;
const OTHER_ADDRESS = /\b\d{8,10}\b|\b0x[0-9a-f]{6,8}\b|\[(?!::1\])[0-9a-f:.]*:[0-9a-f:.]*\]|\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/i;
const CLIENT_VAR_ARG = /\b(?:requests\.\w+|httpx\.\w+|axios(?:\.\w+)?|urlopen|\$?o?fetch\w*)\(\s*[A-Za-z_$][\w$.]*\s*[,)]/i;

/**
 * The only network target on the line is this machine: it has a loopback URL (http(s)://localhost, 127.0.0.1 or
 * [::1]) and nothing else that could be a target. No other host-like name anywhere on the line (comments
 * included), no IP literal other than loopback (dotted, decimal, hex or IPv6), no argument that is a bare
 * variable (`"$URL"` in a shell command, a variable as the first argument of requests/fetch/urlopen/axios).
 */
function localOnly(site: MatchSite): boolean {
  const s = site.text;
  if (!LOCAL_URL.test(s) || OTHER_ADDRESS.test(s) || CLIENT_VAR_ARG.test(s)) return false;
  for (const m of s.matchAll(HOST_LIKE)) if (!LOOPBACK.test(m[0]) && !CODE_NAME.test(m[0])) return false;
  if (!JS_FILE.test(site.file) && !PY_FILE.test(site.file)) {
    const words = s.split(/\s+/);
    for (let k = 0; k < words.length; k++) {
      if (/^["']?\$\{?\w+\}?["']?$/.test(words[k]!) && !(words[k - 1] ?? '').startsWith('-')) return false;
    }
  }
  return true;
}
