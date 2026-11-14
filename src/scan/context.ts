// Ported from skillyard (MIT) src/scan.js @ 83ee690: fencedLines, looksBenign and DEFENSIVE_RE.
// Copyright (c) 2026 Skillyard contributors. See THIRD_PARTY_NOTICES.md.
// Decides when a critical match only quotes a pattern rather than using it. Each decision has one reason.
// Changes from upstream: every check is tied to where the match is. A block (fence, docstring, block comment)
// counts only once it is closed; comments follow each language's syntax; a quotation must enclose the match;
// a defensive phrase must come before it; a pattern must be inside a regex call's arguments; printing must
// not be redirected or piped anywhere; and "localhost" must be the only network target on the line.
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
  if (PY_FILE.test(file)) pyDocstrings(lines, add);
  lines.forEach((l, i) => { if (/^\s*#/.test(l)) add(i, WHOLE); });
  return spans;
}

const PY_DOC_OPEN = /^\s*(?:[\w.]+\s*(?::[^=\n]*)?=\s*)?[rRbBuUfF]{0,2}("""|''')/;

/** Docstrings: a triple quote that starts a statement (optionally after `name =`), up to its closing triple quote. */
function pyDocstrings(lines: string[], add: (i: number, s: Span) => void): void {
  const holders: Record<string, number[]> = { '"""': [], "'''": [] };
  lines.forEach((l, i) => { for (const q of ['"""', "'''"]) if (l.includes(q)) holders[q]!.push(i); });
  const next: Record<string, number> = { '"""': 0, "'''": 0 };
  for (let i = 0; i < lines.length; i++) {
    const m = PY_DOC_OPEN.exec(lines[i]!);
    if (!m) continue;
    const q = m[1]!;
    const from = m[0].length;
    const same = lines[i]!.indexOf(q, from);
    if (same >= 0) { add(i, [from, same]); continue; }
    const list = holders[q]!;
    while (next[q]! < list.length && list[next[q]!]! <= i) next[q]!++;
    const j = list[next[q]!];
    if (j === undefined) continue; // unclosed: not a docstring
    add(i, [from, Infinity]);
    for (let k = i + 1; k < j; k++) add(k, WHOLE);
    add(j, [0, lines[j]!.indexOf(q)]);
    i = j;
  }
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
      k++;
    }
    template = quote === '`';
    if (block) pending.push([i, block.line === i ? [block.at, Infinity] : WHOLE]);
  });
  // An unclosed block comment at the end of the file quotes nothing.
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
// flag it"). The phrase must come before the match: in the same sentence or the one just before it.
const DEFENSIVE_END = /\b(?:if|when)\s+(?:[\w-]+\s+){0,2}(?:says|contains|tries|asks)(?:\s+(?:you\s+)?to)?[\s:,"'“「(]*$/i;
const DEFENSIVE_ANY = /never\s+follow|not\s+(?:an?\s+)?instructions?|injection|data,?\s+not|绝不|flag\s+it/i;

function defensiveBefore(site: MatchSite): boolean {
  const prefix = site.text.slice(Math.max(0, site.index - 4096), site.index);
  const stops = [...prefix.matchAll(/[.!?。](?=\s|$)/g)].map((m) => m.index! + 1);
  const region = prefix.slice(stops.length >= 2 ? stops[stops.length - 2]! : 0);
  if (DEFENSIVE_END.test(region) || DEFENSIVE_ANY.test(region)) return true;
  // "Treat <match> as data."
  return /\btreat\b/i.test(region) && /^[^.!?]{0,30}?\bas\s+data\b/i.test(site.text.slice(site.index + site.length, site.index + site.length + 64));
}

const REGEX_CALL = /\bre\.(?:search|match|compile|findall|finditer|sub|fullmatch|split)\(|\bnew RegExp\(/g;

/** The match lies inside the argument list of the last regex call that starts before it. */
function insideRegexCall(site: MatchSite): boolean {
  let open = -1;
  for (const m of site.text.slice(0, site.index).matchAll(REGEX_CALL)) open = m.index! + m[0].length - 1;
  if (open < 0) return false;
  const close = closingParen(site.text, open);
  return close >= 0 && site.index + site.length <= close;
}

/** Index of the `)` that closes the `(` at `open`, skipping string literals; -1 if none on the line. */
function closingParen(text: string, open: number): number {
  let depth = 0;
  let quote: string | undefined;
  for (let k = open; k < text.length; k++) {
    const c = text[k]!;
    if (quote) { if (c === '\\') k++; else if (c === quote) quote = undefined; continue; }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k;
  }
  return -1;
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

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)]*/gi;
const LOCAL = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[^/?#@]*)?(?:[/?#]|$)/i;
const HOSTLIKE = /^(?:(?:[a-z0-9-]+\.)+[a-z]{2,}|\d{1,3}(?:\.\d{1,3}){3}|localhost|\[::1\])(?::\d+)?(?:[/?#]|$)/i;
const PROGRAM = /\.(?:py|js|mjs|cjs|ts|rb|pl)$/i;

/**
 * Every network target on the line is this machine, and there is at least one. Targets: URLs (no userinfo), and
 * host-like tokens: shell words, or string literals in program files. A trailing comment doesn't count.
 */
function localOnly(site: MatchSite): boolean {
  let s = site.text.replace(JS_FILE.test(site.file) ? /(^|\s)\/\/.*$/ : /(^|\s)#.*$/, '$1');
  const targets: boolean[] = [];
  for (const u of s.match(URL_RE) ?? []) {
    const authority = u.slice(u.indexOf('://') + 3).split(/[/?#]/, 1)[0]!;
    targets.push(!authority.includes('@') && LOCAL.test(authority));
  }
  s = s.replace(URL_RE, ' ');
  const tokens = PROGRAM.test(site.file)
    ? [...s.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)].map((m) => (m[1] ?? m[2] ?? m[3] ?? '').trim())
    : s.split(/[\s"'`=(),;{}[\]<>|&]+/);
  for (const t of tokens) if (HOSTLIKE.test(t)) targets.push(LOCAL.test(t));
  return targets.length > 0 && targets.every(Boolean);
}
