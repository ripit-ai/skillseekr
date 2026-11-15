// Ported from skillyard (MIT) src/scan.js and src/secure.js @ 83ee690
// Copyright (c) 2026 Skillyard contributors. See THIRD_PARTY_NOTICES.md.
// Changes from upstream: stable group/name IDs; new rules (role impersonation, keychain reads, broad frontmatter
// tool grants as a line-free check, download-and-run instructions in prose); wider coverage of shells, PowerShell,
// home-directory forms and secret variables; case-insensitive shell commands; and linear-time regex shapes.

/** Bump whenever any rule or downgrade decision changes: cached scan results are keyed by it. */
export const RULES_VERSION = '2';

/**
 * Where a rule applies. `text`: Markdown, frontmatter and every other non-script text file. `script`: see
 * scan.ts `isScript` (script extensions, a `#!` first line, Makefile, .envrc, justfile, package.json). `all`:
 * both. `frontmatter`: each tool named by `allowed-tools`/`tools` in a Markdown file's frontmatter (the regex
 * is tested against one tool at a time).
 */
export type Target = 'text' | 'script' | 'all' | 'frontmatter';

export interface Rule {
  id: string;
  severity: 'critical' | 'warning';
  target: Target;
  /**
   * Tested against one whole logical line. Never global or sticky. Lookarounds
   * and negated classes must not cross a newline: the scanner pre-tests blocks of joined lines with the `m` flag.
   * A named group starting with `hit`, when present, is the reported match; it must end where the match ends.
   * Must run in linear time: see the shapes below.
   */
  re: RegExp;
  message: string;
  neverDowngrade?: boolean;
  /**
   * Lowercase literals of which every match contains at least one. The scanner skips the regex for a block of
   * lines that holds none of them. Omitted for rules whose regex is a single character class.
   */
  needles?: readonly string[];
}

const re = (source: string, flags = '') => new RegExp(source, flags);
const any = (...alternatives: string[]) => alternatives.join('|');

// Repeated groups are bounded ({0,64} and smaller): V8 keeps a backtrack entry per iteration, so an unbounded
// group repeated over a 10 MB line overflows its stack. (scan.ts also fails closed if a regex throws.)
//
// Linear-time shapes. Upstream's `A[^\n]*B` rescans the rest of the line from every A, which is quadratic on a
// line full of A. `^(?=(?<pre>[^\n]*?)A)\k<pre>(?<hit>A…B)` pins the first A instead: if B doesn't follow the
// first A, it follows no later one either. `(?:^|\))(?=(?<pre>[^)\n]*?)A)…` does the same per segment when B
// must stay inside a segment. Each group name may appear once per regex, hence the suffixes.
//
// Lookarounds never cross a newline (they use `[^\S\n]`, not `\s`): the scanner pre-tests blocks of joined lines,
// and a negative lookahead that saw the next line could hide a match (rules.test.ts walks every source for this).
/** `\s` outside character classes becomes `[^\S\n]`. (A negated class with `\s` already excludes the newline.) */
function lineLocal(src: string): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      const e = src.slice(i, i + 2);
      out += e === '\\s' && !inClass ? String.raw`[^\S\n]` : e;
      i++;
    } else {
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      out += c;
    }
  }
  return out;
}
const firstThen = (n: string, a: string, rest: string) => `^(?=(?<pre${n}>[^\\n]*?)${lineLocal(a)})\\k<pre${n}>(?<hit${n}>${a}${rest})`;
const H = String.raw`[^\S\n]`; // horizontal whitespace, for lookarounds

/**
 * The source with every ASCII letter made caseless (`a` → `[aA]`, `[a-z]` → `[a-zA-Z]`), like the `i` flag, except
 * the CAPS placeholder, which `build` then replaces with the case-sensitive ALL-CAPS class. Escapes (`\s`, `\x60`,
 * `\k<name>`) and group names are copied unchanged.
 */
function caseless(src: string): string {
  let out = '';
  let inClass = false;
  const other = (c: string) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase());
  const letter = (c: string | undefined) => c !== undefined && /[A-Za-z]/.test(c);
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    const keep = [CAPS, ROOT_OPT].find((p) => src.startsWith(p, i));
    if (keep) { out += keep; i += keep.length - 1; continue; }
    if (c === '\\') {
      const m = /^\\(?:k<\w+>|x[0-9a-fA-F]{2}|u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|[pP]\{[^}]*\}|c[A-Za-z]|[\s\S])/.exec(src.slice(i, i + 16))!;
      out += m[0];
      i += m[0].length - 1;
    } else if (!inClass && src.startsWith('(?<', i) && /\w/.test(src[i + 3] ?? '')) {
      const end = src.indexOf('>', i);
      out += src.slice(i, end + 1);
      i = end;
    } else if (inClass) {
      if (c === ']') { inClass = false; out += c; }
      else if (letter(c) && src[i + 1] === '-' && letter(src[i + 2])) { out += `${c}-${src[i + 2]}${other(c)}-${other(src[i + 2]!)}`; i += 2; }
      else out += letter(c) ? c + other(c) : c;
    } else if (c === '[') { inClass = true; out += c; }
    else out += letter(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c;
  }
  return out;
}
/** A rule regex. `ci` makes it case-insensitive everywhere except the ALL-CAPS class. */
const build = (source: string, ci: boolean) => new RegExp((ci ? caseless(source) : source).split(CAPS).join(CAPS_SRC).split(ROOT_OPT).join(ROOT_OPT_SRC));

const DL = String.raw`\b(?:curl|wget)(?:\.exe)?\b`;
/** A pipe (`|` or `|&`, not `||`). */
const PIPE_SIGN = String.raw`(?<!\|)\|(?!\|)&?`;
const PIPE = String.raw`${PIPE_SIGN}\s*`;
/**
 * P2-R14: the words of a pipe segment before the interpreter may only be wrappers, options (`-x`, `--x`, `--x=y`,
 * a bare `--`, optionally followed by one value such as `-u root`), env assignments (`X=y`), numbers or durations
 * (`60`, `5s`), and ALL-CAPS values (`KILL`, `L`). ALL-CAPS is case-sensitive (`grep`, `tar` are not values), so
 * the regexes that use it are built without the `i` flag (see `caseless`), and it excludes the wrapper names, which
 * match in any case: each word fits exactly one class, so a failing match backtracks linearly.
 */
const WRAPPER_NAMES = ['sudo', 'doas', 'env', 'time', 'command', 'exec', 'timeout', 'nice', 'nohup', 'stdbuf', 'ionice', 'setsid', 'xargs', 'builtin', 'busybox'];
const WRAPPER = String.raw`(?:${WRAPPER_NAMES.join('|')})`;
/** Placeholder for the case-sensitive ALL-CAPS class: `caseless` leaves it alone and `build` fills it in. */
const CAPS = '\u0000CAPS\u0000';
const CAPS_SRC = String.raw`(?!(?:${WRAPPER_NAMES.join('|').toUpperCase()})(?:[^\S\n]|$))[A-Z][A-Z0-9_]*`;
const PLAIN = String.raw`(?:${WRAPPER}|\d+(?:\.\d+)?[smhd]?|${CAPS}|[A-Za-z_]\w*=\S*)`;
const OPTION = String.raw`(?:--?[^\s=-][^\s=]*(?:=\S*)?|--(?=${H}|$))`;
const VALUE = String.raw`(?!${PLAIN}(?:${H}|$))[^\s-]\S*`;
const RUNNER_WORD = String.raw`(?:${PLAIN}|${OPTION}(?:\s+${VALUE})?)`;
const RUNNER = String.raw`(?:${RUNNER_WORD}\s+){0,64}`;
const INTERP = String.raw`(?:(?:ba|z|da|k)?sh|python[23]?|node|perl|ruby)`;
/**
 * P2-R11a: code given on the interpreter's command line (-c/-e/-p) runs the piped download only if it executes
 * something: exec, eval, compile, system, subprocess, spawn, popen, source, interact, repl, fileinput, runpy, `$(cat`,
 * a backtick `cat`, a shell word, /dev/stdin or /dev/fd/0, or a leading `. ` (source). Plain stdin parsing
 * (json.load(sys.stdin), print(…)) is data. `-m` is data.
 */
const RUNS_INPUT = String.raw`(?:exec|eval|compile|system|subprocess|spawn|popen|source|interact|repl|fileinput|runpy|\/dev\/(?:stdin|fd\/0)|\$\(\s*cat\b|\x60\s*cat\b|\b(?:ba|z|da|k)?sh\b|["'\s;&(]\.${H})`;
/**
 * A shell run as root with no command reads its commands from stdin (N7): `sudo`/`doas` followed only by options,
 * one of them a lower-case `s` or `i` ending its option word (`-s`, `-i`, `-Es`, `-is`), or followed by a combined
 * `u USER` (`-iu root`, `-su root`; P2-R16), or `--shell`/`--login`, up to the end of the segment. Before and after
 * it, `-u USER`, `--user USER` and `--user=USER` may carry their value. `sudo cpio -idmv` or `sudo docker load -i x`
 * is not one.
 */
const ROOT_OPT = '\u0000ROOT\u0000';
const USER_VALUE = String.raw`[^\s|;&)-]\S*`;
const ROOT_OPT_SRC = String.raw`-[A-Za-z]*[si](?:[A-Za-z]*u\s+${USER_VALUE})?`;
const SUDO_OPTION = String.raw`(?:-u\s+${USER_VALUE}|--user(?:=\S+|\s+${USER_VALUE})|-[A-Za-z]+|--[a-z-]+)`;
const ROOT_SHELL = String.raw`(?:sudo|doas)(?:\s+${SUDO_OPTION}){0,8}?\s+(?:${ROOT_OPT}|--shell|--login)(?:\s+${SUDO_OPTION}){0,8}${H}*(?=$|[|;&)])`;
/**
 * What a download can be piped into to run it: an interpreter (or su), after wrappers, by name or by any path,
 * optionally quoted; a root shell; or `xargs … sh -c` (the input becomes the code, whatever the -c code is). It
 * follows PIPE_SIGN directly: the leading lookahead fails a segment with no interpreter name in one pass, and it
 * runs once per pipe, before the whitespace after the pipe (a lookahead after `\s*` would rescan per space). A pipe
 * that ends its line also passes, so the block pre-test still finds a command wrapped onto the next line. More than
 * 64 wrapper words in a row hits the bound and fails closed (matches).
 */
const SHELL = String.raw`(?=[^|\n]*?(?:sh|python|node|perl|ruby|su|doas)|${H}*$)\s*(?:tee\b[^|\n]*?>\(\s*)?(?:${RUNNER}(?:${ROOT_SHELL}|["']?(?:[^\s/|"']*(?:\/[^\s/|"']+){0,32}\/)?(?:(?<=\bxargs\b[^|\n]{0,1024})(?:ba|z|da|k)?sh${H}+-\w*c\b|${INTERP}${H}+-\w*[cep]\b[^|\n]*?${RUNS_INPUT}|(?:ba|z|da|k)?sh\b(?!${H}+-c\b)|python[23]?\b(?!${H}+-[cm]\b)|node\b(?!${H}+-[ep]\b)|perl\b(?!${H}+-\w*e)|ruby\b(?!${H}+-e\b)|su\b(?!${H}+-c\b)|\$\{?SHELL\b))|(?:${RUNNER_WORD}\s+){65})`;
const PS_DL = String.raw`\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod|curl(?:\.exe)?|wget(?:\.exe)?)\b`;
const IEX = String.raw`\b(?:iex|Invoke-Expression)\b`;
const SUBST = String.raw`["']?(?:\$\(|\x60)\s*${DL}`; // "$(curl" or `curl

const pipeToShell = (n: string) => firstThen(n, DL, String.raw`[^\n]*?${PIPE_SIGN}${SHELL}`);
const substitution = any(
  String.raw`(?:\b${INTERP}|\bsource|(?:^|[\s;&|])\.)\s+<\(\s*${DL}`, // bash <(curl …), python3 <(curl …), . <(curl …)
  String.raw`(?:\beval|\b(?:ba|z|da|k)?sh\s+-c|\bpython[23]?\s+-c|\$\{?SHELL\}?\s+-c)\s*${SUBST}`, // eval "$(curl …)"
  String.raw`(?:\b(?:ba|z|da|k)?sh|\$\{?SHELL\}?)\s*<<<\s*${SUBST}`, // bash <<< "$(curl …)"
);
const iexFirst = (n: string) => firstThen(n, IEX, String.raw`[^\n]*(?:DownloadString|DownloadFile|${PS_DL})`);
const downloadToIex = (n: string) => firstThen(n, PS_DL, String.raw`[^\n]*?${PIPE}${IEX}`);
/** The output of a download: `-o FILE`, `-sSLo FILE`, `--output[=]FILE`, `-O`, or a `> FILE` redirect. */
const OUTPUT = String.raw`(?:\s(?:-[a-z]{0,8}o\b|--output(?:-document)?\b)\s*=?\s*[^\s;&|]|\s>\s*[^\s;&|>])`;
const HEREDOC = String.raw`(?:\b(?:ba|z|da|k)?sh|\bpython[23]?|\$\{?SHELL\}?)\s*<<-?\s*["']?[\w.-]+`;

const HOME = String.raw`(?:~|\$HOME|\$\{HOME\}|\$env:(?:HOME|USERPROFILE)|%USERPROFILE%|expanduser\(|homedir\(\)|Path\.home\(\)|os\.environ(?:\.get\(|\[)\s*["']HOME|getenv\(\s*["']HOME|\/Users\/[^\/\s]+\/|\/home\/[^\/\s]+\/|\/root\/)`;
const SEP = String.raw`(?:\/|["'\x60]\s*[,/+]\s*["'\x60])`; // `/`, or the gap between path parts given as separate strings
const CRED = String.raw`(?:\.ssh(?:\/|["'\x60]\s*[,)/+\]])|\.aws${SEP}credentials|\.netrc\b|\.docker${SEP}config\.json|\.kube${SEP}config\b|\.config${SEP}gh${SEP}hosts)`;
const ENV = String.raw`(?:os\.environ|os\.getenv\(\s*["'][A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD)|process\.env|\$\{?[A-Za-z_]*(?:TOKEN|KEY|SECRET|PASSWORD)\b)`;
const SENDER = String.raw`(?:requests\.(?:post|put|patch)|httpx\.(?:post|put|patch)|axios\.(?:post|put|patch)|urlopen|fetch)`;
const EXEC_CALL = String.raw`(?:\b(?:exec|eval)|\bnew\s+Function)\s*\(`;
const DECODE = String.raw`\bbase64\s+(?:-d|-D|--decode)\b`;

// Shell commands are matched case-insensitively: macOS file systems run `CURL` as `curl`.
export const RULES: readonly Rule[] = [
  // Prompt injection and concealment (instruction text).
  { id: 'prompt-injection/override-instructions', needles: ['ignore', 'disregard', 'forget'], severity: 'critical', target: 'text', message: "tries to override the agent's instructions",
    re: /\b(?:ignore|disregard|forget)\s+(?:(?:all|any)\s+)?(?:of\s+)?(?:(?:the|your|my|these|those|its)\s+)?(?:previous|prior|earlier|above|preceding|system)\s+(?:instructions?|prompts?|rules|directions)\b/i },
  { id: 'prompt-injection/role-impersonation', needles: ['system', 'you'], severity: 'critical', target: 'text', message: 'impersonates a system prompt or a jailbroken mode',
    re: /^\s*(?:>\s*){0,16}(?:<\|system\|>|<\|im_start\|>\s*system\b|\[system\]|system\s+prompt\s*:|#{1,6}\s*system(?:\s+(?:prompt|message))?\b[\s:]*$)|\byou\s+are\s+now\s+(?:in\s+)?(?:developer\s+mode|DAN\b|jailbroken)/i },
  { id: 'concealment/hide-from-user', needles: ['user'], severity: 'critical', target: 'text', message: 'asks the agent to hide actions from the user',
    re: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|let)\s+the\s+user\s+(?:that\s+you|about\b|know)\b|\b(?:do\s+not|don't|never)\s+(?:tell|inform)\s+the\s+user\s*(?:[.!,;]|$)|\bwithout\s+(?:telling|informing|notifying)\s+the\s+user\b|\b(?:hide|conceal|keep)\s+(?:this|it|these\s+\w+)\s+(?:secret\s+)?from\s+the\s+user\b/i },

  // Invisible characters and secrets (everywhere).
  { id: 'hidden-unicode/bidi-or-tag', severity: 'critical', target: 'all', neverDowngrade: true, message: 'bidi-control or Unicode tag characters (can hide instructions)',
    re: /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{E0000}-\u{E007F}]/u },
  // A BOM at file offset 0 is removed before scanning, so any BOM left is mid-file. U+200D (emoji joiner) is fine.
  { id: 'zero-width/invisible-char', severity: 'warning', target: 'all', message: 'zero-width characters',
    re: /[\u{200B}\u{200C}\u{2060}-\u{2064}\u{FEFF}]/u },
  { id: 'secrets/private-key', needles: ['private key'], severity: 'critical', target: 'all', neverDowngrade: true, message: 'embedded private key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  // Keys with "EXAMPLE" in their 16 characters are documentation placeholders (AWS's own docs use them).
  { id: 'secrets/aws-key', needles: ['akia', 'asia'], severity: 'critical', target: 'all', neverDowngrade: true, message: 'AWS access key id',
    re: /\b(?:AKIA|ASIA)(?![A-Z0-9]{0,9}EXAMPLE)[A-Z0-9]{16}\b/ },
  { id: 'secrets/github-token', needles: ['ghp_', 'gho_', 'ghs_', 'ghu_', 'github_pat_'], severity: 'critical', target: 'all', neverDowngrade: true, message: 'GitHub token',
    re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{30,255}\b/ },
  { id: 'secrets/slack-token', needles: ['xox'], severity: 'critical', target: 'all', neverDowngrade: true, message: 'Slack token',
    re: /\bxox[abpr]-[A-Za-z0-9-]{20,255}\b/ },
  { id: 'secrets/ai-key', needles: ['sk-'], severity: 'critical', target: 'all', neverDowngrade: true, message: 'AI provider API key',
    re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,512}\b/ },

  // Download-and-run and remote code (scripts).
  { id: 'download-and-run/curl-pipe-shell', needles: ['curl', 'wget'], severity: 'critical', target: 'script', message: 'downloads and runs remote code',
    re: build(pipeToShell(''), true) },
  { id: 'download-and-run/fetch-and-exec', needles: ['<(', '$(', '`', 'iex', 'invoke-expression', '<<'], severity: 'critical', target: 'script', message: 'executes a script fetched from the internet at run time',
    re: re(any(substitution, iexFirst(''), downloadToIex('2'), firstThen('3', HEREDOC, String.raw`[^\n]*?${DL}`)), 'i') },
  // Upstream: curl …(-o|-O|--output)\s*\S+…(&&|;)…(sh|python|node|chmod +x|./x): the same steps in order,
  // each pinned to its first occurrence after the previous one. A `>` redirect also counts as the output.
  { id: 'download-and-run/download-then-run', needles: ['curl', 'wget'], severity: 'critical', target: 'script', message: 'downloads a file and runs it without verification',
    re: re(String.raw`^(?=(?<a>[^\n]*?)${DL})\k<a>(?<hit>(?=(?<b>[^\n]*?)${lineLocal(OUTPUT)})\k<b>(?=(?<c>[^\n]*?)(?:&&|;))\k<c>[^\n]*?(?:\b(?:ba|z|da|k)?sh\b|\bpython[23]?\b|\bnode\b|\bperl\b|\bruby\b|\bsource\b|\bchmod\s+\+x|\.\/\S|(?:&&|;)\s*(?:sudo\s+)?\/\S))`, 'i') },
  { id: 'remote-code/remote-package', needles: ['npx', 'uvx', 'pip'], severity: 'critical', target: 'script', message: 'installs or runs code from a URL or git ref',
    re: re(any(String.raw`\bnpx\s+(?:(?:-y|--yes|-p|--package=?)\s*){0,16}(?:https?:|git\+|github:)`, String.raw`\buvx\s+(?:--from(?:=|\s+))?(?:git\+|https?:)`,
      String.raw`\bpipx\s+(?:run|install)\s+(?:--spec(?:=|\s+))?(?:git\+|https?:)`, firstThen('', String.raw`\bpip[23]?\s+install\b`, String.raw`[^\n]*?(?:git\+|https?:\/\/)`)), 'i') },
  { id: 'remote-code/url-import', needles: ['import(', 'require('], severity: 'critical', target: 'script', message: 'imports code from a URL at run time',
    re: re(any(String.raw`\b(?:import|require)\(\s*['"\x60]https?:`, firstThen('', String.raw`['"\x60]https?:\/\/`, String.raw`[^\n]*?\b(?:import|require)\(\s*[A-Za-z_$]`)), 'i') },
  { id: 'remote-code/exec-url', needles: ['exec', 'eval', 'function'], severity: 'critical', target: 'script', message: 'executes code fetched from a URL',
    re: re(String.raw`(?:^|\))(?=(?<pre>[^)\n]*?)${lineLocal(EXEC_CALL)})\k<pre>(?<hit>${EXEC_CALL}[^)\n]*(?:urlopen|requests\.get|httpx\.get|urllib\.request|fetch\())`, 'i') },
  { id: 'encoded-exec/eval-decoded', needles: ['eval', 'exec', 'base64'], severity: 'critical', target: 'script', message: 'executes encoded or compressed code',
    re: build(any(String.raw`\b(?:eval|exec)\s*\(\s*(?:[\w.]*\.)?(?:b64decode|b32decode|b16decode|a85decode|b85decode|decodebytes|decodestring|unhexlify|fromhex|decompress|atob|base64|codecs\.decode|Buffer\.from)`,
      firstThen('', DECODE, String.raw`[^\n]*?${PIPE_SIGN}${SHELL}`), firstThen('2', String.raw`\beval\b`, String.raw`[^\n]*?${DECODE}`)), false) },

  // Credentials and exfiltration (scripts).
  { id: 'credential-read/home-credentials', needles: ['.ssh', '.aws', '.netrc', '.docker', '.kube', '.config'], severity: 'critical', target: 'script', message: 'reads credential files',
    re: re(firstThen('', HOME, String.raw`[^\n]*?${CRED}`), 'i') },
  { id: 'credential-read/keychain', needles: ['security'], severity: 'critical', target: 'script', message: 'reads secrets from the macOS keychain',
    re: /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain)\b/i },
  // Upstream: (requests.post|urlopen|fetch|curl\s[^\n]*-d)[^\n]*(env). Here any curl/wget that carries a secret
  // variable (body, header or URL), env piped to the network, and getenv of a secret. Outside shell files,
  // `$…TOKEN` doesn't count (see ruleMatch).
  { id: 'exfiltration/env-to-network', needles: ['env', '$'], severity: 'critical', target: 'script', message: 'sends environment secrets over the network',
    re: re(any(firstThen('', SENDER, String.raw`[^\n]*${ENV}`), firstThen('2', DL, String.raw`[^\n]*?${ENV}`),
      firstThen('3', String.raw`\b(?:env|printenv)\b\s*${PIPE}`, String.raw`[^\n]*?\b(?:curl|wget|nc|ncat)\b`)), 'i') },

  // Instruction text that tells the agent to download and run code. A warning, not a block: the spec scopes
  // download-and-run blocking to scripts, but a skill telling the agent to run `curl … | sh` should be visible.
  { id: 'download-and-run/instructed', needles: ['curl', 'wget', 'iex', 'invoke-expression', '<(', '$(', '`'], severity: 'warning', target: 'text', message: 'tells the agent to download and run remote code',
    re: build(any(pipeToShell(''), substitution, iexFirst('2'), downloadToIex('3')), true) },

  // Permission bypass (instruction text) and broad tool grants (frontmatter).
  { id: 'permission-bypass/skip-permissions', needles: ['--dangerously', '--yolo', 'bypasspermissions', 'prompt'], severity: 'warning', target: 'text', message: 'tells the agent to bypass permission prompts',
    re: /--dangerously-skip-permissions|--yolo\b|--dangerously-bypass-approvals|\bbypassPermissions\b|\b(?:turn\s+off|disable)\s+(?:the\s+|all\s+)?(?:approval|permission)\s+prompts?\b/i },
  { id: 'broad-tools/allowed-tools', severity: 'warning', target: 'frontmatter', message: 'frontmatter grants every tool, unrestricted Bash, or pre-approved commands that fetch or run code',
    re: /^(?:\*|Bash(?:\((?:\*|\*:\*)?\))?|Bash\((?:curl|wget|bash|sh|zsh|eval|ssh|sudo|rm)\b.*)$/ },

  // Weaker signals. They come last: a weak finding on a line that a critical rule matched is dropped.
  { id: 'weak/network-call', needles: ['requests.', 'urllib', 'http.client', 'fetch(', 'axios', 'curl', 'wget', 'socket.socket'], severity: 'warning', target: 'script', message: 'makes network calls',
    re: /\b(?:requests\.(?:get|post|put|delete)|urllib\.request|http\.client|fetch\(|axios|curl\s|wget\s|socket\.socket)/i },
  { id: 'weak/shell-true', needles: ['shell'], severity: 'warning', target: 'script', message: 'subprocess with shell=True',
    re: /(?:^|\))(?=(?<pre>[^)\n]*?)subprocess\.[a-z_]+\()\k<pre>(?<hit>subprocess\.[a-z_]+\([^)\n]*shell\s*=\s*True)/ },
  { id: 'weak/sudo', needles: ['sudo'], severity: 'warning', target: 'script', message: 'uses sudo',
    re: /(?:^|\s)sudo\s/i },
  { id: 'weak/broad-rm', needles: ['rm'], severity: 'warning', target: 'script', message: 'recursive delete of a broad path',
    re: /\brm\s+-[a-z]{0,10}r[a-z]{0,10}\s+(?:\/(?:\s|$)|~\/?(?:\s|$)|\$HOME\/?(?:\s|$)|\*)/i },
  { id: 'weak/chmod-777', needles: ['chmod'], severity: 'warning', target: 'all', message: 'world-writable permissions',
    re: /chmod\s+(?:-R\s+)?777\b/ },
];

const PROGRAM_FILE = /\.(?:py|js|mjs|cjs|ts)$/i;
const ENV_OBJECT = /os\.environ|os\.getenv|process\.env/;

/**
 * Tests one rule against one line window and returns the reported span. Adds the one condition a regex can't
 * express cheaply: in program files, a `${…TOKEN}` is usually a template literal holding the script's own
 * credential, so env exfiltration there needs `os.environ` / `os.getenv` / `process.env`.
 */
export function ruleMatch(rule: Rule, text: string, file: string): { index: number; length: number } | null {
  const m = rule.re.exec(text);
  if (!m) return null;
  if (rule.id === 'exfiltration/env-to-network' && PROGRAM_FILE.test(file) && !ENV_OBJECT.test(text)) return null;
  let hit: string | undefined;
  if (m.groups) for (const k in m.groups) if (k.startsWith('hit') && m.groups[k] !== undefined) { hit = m.groups[k]; break; }
  return hit === undefined ? { index: m.index, length: m[0].length } : { index: m.index + m[0].length - hit.length, length: hit.length };
}

/** A global copy of each rule's regex, for walking every match on a line (RULES themselves stay stateless). */
const GLOBAL_RE = new Map<string, RegExp>();

/**
 * Every match of a text rule on one line, in order, as ruleMatch would report each (Task 2 review: a downgraded
 * first match must not hide a later one). Stops after `limit` matches; the caller treats more as fail-closed.
 */
export function* ruleMatches(rule: Rule, text: string, limit: number): Generator<{ index: number; length: number }> {
  let g = GLOBAL_RE.get(rule.id);
  if (!g) { g = new RegExp(rule.re.source, rule.re.flags.replace(/[gy]/g, '') + 'g'); GLOBAL_RE.set(rule.id, g); }
  let lastIndex = 0;
  for (let n = 0; n < limit; n++) {
    g.lastIndex = lastIndex;
    const m = g.exec(text);
    if (!m) return;
    lastIndex = m.index + Math.max(m[0].length, 1);
    let hit: string | undefined;
    if (m.groups) for (const k in m.groups) if (k.startsWith('hit') && m.groups[k] !== undefined) { hit = m.groups[k]; break; }
    yield hit === undefined ? { index: m.index, length: m[0].length } : { index: m.index + m[0].length - hit.length, length: hit.length };
  }
}

/** Whether ruleMatch would match, without building the match (for the weak-signal check). */
export function ruleTest(rule: Rule, text: string, file: string): boolean {
  if (!rule.re.test(text)) return false;
  return !(rule.id === 'exfiltration/env-to-network' && PROGRAM_FILE.test(file) && !ENV_OBJECT.test(text));
}

/** Frontmatter keys whose tools the `frontmatter` rules check. */
export const TOOL_KEYS = ['allowed-tools', 'tools'] as const;

/** The tools a frontmatter value grants: a YAML list, or a comma- or space-separated string (upstream's split). */
export function toolGrants(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string' ? value.replace(/[[\]"']/g, '').split(/,|\s(?=[A-Z*])/) : [];
  return items.map((t) => t.trim().slice(0, 4096)).filter(Boolean);
}
