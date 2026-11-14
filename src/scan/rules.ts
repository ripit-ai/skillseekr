// Ported from skillyard (MIT) src/scan.js and src/secure.js @ 83ee690
// Copyright (c) 2026 Skillyard contributors. See THIRD_PARTY_NOTICES.md.
// Changes from upstream: stable group/name IDs, three new rules (role impersonation, keychain reads,
// broad frontmatter tool grants as a line-free check), case-insensitive matching of shell commands, and
// bounded or non-overlapping quantifiers so that no rule backtracks badly on a 4096-character line.

/** Bump whenever any rule or downgrade decision changes: cached scan results are keyed by it. */
export const RULES_VERSION = '1';

/**
 * Where a rule applies. `text`: Markdown, frontmatter and every other non-script text file. `script`: files
 * that SCRIPT_EXT matches, or extensionless files with a shebang. `all`: both. `frontmatter`: each tool named
 * by `allowed-tools`/`tools` in a Markdown file's frontmatter (the regex is tested against one tool at a time).
 */
export type Target = 'text' | 'script' | 'all' | 'frontmatter';

export interface Rule {
  id: string;
  severity: 'critical' | 'warning';
  target: Target;
  /**
   * Tested against one line (at most 4096 characters of it). Never global or sticky. Lookarounds and
   * negated classes must not cross a newline: the scanner pre-tests blocks of joined lines with the `m` flag.
   * A named group `hit` (or `hit2`), when present, is the reported match; it must end where the match ends.
   */
  re: RegExp;
  message: string;
  neverDowngrade?: boolean;
}

// Shell commands are matched case-insensitively: macOS file systems run `CURL` as `curl`.
export const RULES: readonly Rule[] = [
  // Prompt injection and concealment (instruction text).
  { id: 'prompt-injection/override-instructions', severity: 'critical', target: 'text', message: "tries to override the agent's instructions",
    re: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+)?(?:previous|prior|earlier|above|system)\s+(?:instructions|prompts?|rules)\b/i },
  { id: 'prompt-injection/role-impersonation', severity: 'critical', target: 'text', message: 'impersonates a system prompt or a jailbroken mode',
    re: /^\s*(?:<\|system\|>|<\|im_start\|>\s*system\b|\[system\]|system\s+prompt\s*:|###\s*system\b[\s:]*$)|\byou\s+are\s+now\s+(?:in\s+)?(?:developer\s+mode|DAN\b|jailbroken)/i },
  { id: 'concealment/hide-from-user', severity: 'critical', target: 'text', message: 'asks the agent to hide actions from the user',
    re: /\b(?:do\s+not|don't|never)\s+(?:tell|inform|let)\s+the\s+user\s+(?:that\s+you|about\b|know)\b|\b(?:do\s+not|don't|never)\s+(?:tell|inform)\s+the\s+user\s*(?:[.!,;]|$)|\bwithout\s+(?:telling|informing|notifying)\s+the\s+user\b|\b(?:hide|conceal|keep)\s+(?:this|it|these\s+\w+)\s+(?:secret\s+)?from\s+the\s+user\b/i },

  // Invisible characters and secrets (everywhere).
  { id: 'hidden-unicode/bidi-or-tag', severity: 'critical', target: 'all', neverDowngrade: true, message: 'bidi-control or Unicode tag characters (can hide instructions)',
    re: /[\u{202A}-\u{202E}\u{2066}-\u{2069}\u{E0000}-\u{E007F}]/u },
  // A BOM at file offset 0 is removed before scanning, so any BOM left is mid-file. U+200D (emoji joiner) is fine.
  { id: 'zero-width/invisible-char', severity: 'warning', target: 'all', message: 'zero-width characters',
    re: /[\u{200B}\u{200C}\u{2060}-\u{2064}\u{FEFF}]/u },
  { id: 'secrets/private-key', severity: 'critical', target: 'all', neverDowngrade: true, message: 'embedded private key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { id: 'secrets/aws-key', severity: 'critical', target: 'all', neverDowngrade: true, message: 'AWS access key id',
    re: /\b(?:AKIA|ASIA)(?![A-Z0-9]{0,9}EXAMPLE)[A-Z0-9]{16}\b/ },
  { id: 'secrets/github-token', severity: 'critical', target: 'all', neverDowngrade: true, message: 'GitHub token',
    re: /\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{30,}\b/ },
  { id: 'secrets/slack-token', severity: 'critical', target: 'all', neverDowngrade: true, message: 'Slack token',
    re: /\bxox[abpr]-[A-Za-z0-9-]{20,}\b/ },
  { id: 'secrets/ai-key', severity: 'critical', target: 'all', neverDowngrade: true, message: 'AI provider API key',
    re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/ },

  // Download-and-run and remote code (scripts).
  // Linear-time shapes. Upstream's `A[^\n]*B` rescans the rest of the line from every A, which is quadratic on a
  // line full of A. Here `^(?=(?<pre>[^\n]*?)A)\k<pre>(?<hit>A…B)` pins the first A (if B doesn't follow the
  // first A, it follows no later one either), and `(?:^|\|)(?=(?<pre>[^|\n]*?)A)…` does the same per segment
  // when B must stay inside a segment. `hit` is the part that is reported.
  { id: 'download-and-run/curl-pipe-shell', severity: 'critical', target: 'script', message: 'downloads and runs remote code',
    re: /(?:^|\|)(?=(?<pre>[^|\n]*?)\b(?:curl|wget)\b)\k<pre>(?<hit>\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b)/i },
  { id: 'download-and-run/fetch-and-exec', severity: 'critical', target: 'script', message: 'executes a script fetched from the internet at run time',
    re: /(?:\b(?:ba|z)?sh|\bsource|\.)\s+<\(\s*(?:curl|wget)\b|(?:\beval|\b(?:ba|z)?sh\s+-c|\bpython3?\s+-c)\s*[\"']?\$\(\s*(?:curl|wget)\b|^(?=(?<pre>[^\n]*?)\b(?:iex|Invoke-Expression)\b)\k<pre>(?<hit>\b(?:iex|Invoke-Expression)\b[^\n]*(?:DownloadString|\bInvoke-WebRequest\b|\biwr\b|\bInvoke-RestMethod\b|\birm\b))/i },
  // Upstream: curl …[^\n]*(-o|-O|--output)\s*\S+[^\n]*(&&|;)[^\n]*(sh|python|node|chmod +x|./x): the same
  // four steps in order, each pinned to its first occurrence after the previous one.
  { id: 'download-and-run/download-then-run', severity: 'critical', target: 'script', message: 'downloads a file and runs it without verification',
    re: /^(?=(?<a>[^\n]*?)\b(?:curl|wget)\b)\k<a>(?<hit>(?=(?<b>[^\n]*?)\s(?:-[a-z]{0,8}o\b|--output(?:-document)?\b)\s*=?\s*[^\s;&|])\k<b>(?=(?<c>[^\n]*?)(?:&&|;))\k<c>[^\n]*?(?:\b(?:ba|z)?sh\b|\bpython3?\b|\bnode\b|\bchmod\s+\+x|\.\/\S))/i },
  { id: 'remote-code/remote-package', severity: 'critical', target: 'script', message: 'installs or runs code from a URL or git ref',
    re: /\bnpx\s+(?:-y\s+|--yes\s+)?(?:https?:|git\+|github:)|^(?=(?<pre>[^\n]*?)\bpip3?\s+install\b)\k<pre>(?<hit>\bpip3?\s+install\b[^\n]*(?:git\+|https?:\/\/))/i },
  { id: 'remote-code/url-import', severity: 'critical', target: 'script', message: 'imports code from a URL at run time',
    re: /\b(?:import|require)\(\s*['"`]https?:/ },
  { id: 'remote-code/exec-url', severity: 'critical', target: 'script', message: 'executes code fetched from a URL',
    re: /(?:^|\))(?=(?<pre>[^)\n]*?)\b(?:exec|eval)\s*\()\k<pre>(?<hit>\b(?:exec|eval)\s*\([^)\n]*(?:urlopen|requests\.get|fetch\())/i },
  { id: 'encoded-exec/eval-decoded', severity: 'critical', target: 'script', message: 'executes encoded or compressed code',
    re: /\b(?:eval|exec)\s*\(\s*(?:base64|atob|bytes\.fromhex|codecs\.decode|zlib\.decompress|Buffer\.from)/ },

  // Credentials and exfiltration (scripts).
  { id: 'credential-read/home-credentials', severity: 'critical', target: 'script', message: 'reads credential files',
    re: /(?=\.ssh\/|\.aws\/credentials|\.netrc|\.docker\/config\.json|\.kube\/config|\.config\/gh\/hosts)(?<=(?:~|\$HOME\b|\$\{HOME\}|expanduser\([^)\n]{0,40}\)|homedir\(\)|Path\.home\(\))[^\n]{0,40})(?:\.ssh\/|\.aws\/credentials|\.netrc|\.docker\/config\.json|\.kube\/config|\.config\/gh\/hosts)/i },
  { id: 'credential-read/keychain', severity: 'critical', target: 'script', message: 'reads secrets from the macOS keychain',
    re: /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain)\b/i },
  // Upstream: (requests.post|urlopen|fetch|curl\s[^\n]*-d)[^\n]*(env). `$…TOKEN` only counts in shell files
  // (see ruleMatch).
  { id: 'exfiltration/env-to-network', severity: 'critical', target: 'script', message: 'sends environment secrets over the network',
    re: /^(?=(?<pre>[^\n]*?)(?:\brequests\.(?:post|put)|\burlopen|\bfetch\b))\k<pre>(?<hit>(?:\brequests\.(?:post|put)|\burlopen|\bfetch\b)[^\n]*(?:os\.environ|process\.env|\$\{?[A-Z_]*(?:TOKEN|KEY|SECRET)\b))|^(?=(?<pre2>[^\n]*?)\bcurl\s)\k<pre2>(?<hit2>\bcurl(?=(?<d>[^\n]*?)\s(?:-d|--data(?:-\w+)?|-F|--form)\b)\k<d>[^\n]*?(?:os\.environ|process\.env|\$\{?[A-Z_]*(?:TOKEN|KEY|SECRET)\b))/ },

  // Permission bypass (instruction text) and broad tool grants (frontmatter).
  { id: 'permission-bypass/skip-permissions', severity: 'warning', target: 'text', message: 'tells the agent to bypass permission prompts',
    re: /--dangerously-skip-permissions|--yolo\b|--dangerously-bypass-approvals|\bbypassPermissions\b|\b(?:turn\s+off|disable)\s+(?:the\s+|all\s+)?(?:approval|permission)\s+prompts?\b/i },
  { id: 'broad-tools/allowed-tools', severity: 'warning', target: 'frontmatter', message: 'frontmatter grants every tool, unrestricted Bash, or pre-approved curl, sudo or rm',
    re: /^(?:\*|Bash(?:\((?:\*|\*:\*)?\))?|Bash\((?:curl|sudo|rm)\b.*)$/ },

  // Weaker signals. They come last: a weak finding on a line that already has a stronger one is dropped.
  { id: 'weak/network-call', severity: 'warning', target: 'script', message: 'makes network calls',
    re: /\b(?:requests\.(?:get|post|put|delete)|urllib\.request|http\.client|fetch\(|axios|curl\s|wget\s|socket\.socket)/i },
  { id: 'weak/shell-true', severity: 'warning', target: 'script', message: 'subprocess with shell=True',
    re: /(?:^|\))(?=(?<pre>[^)\n]*?)subprocess\.[a-z_]+\()\k<pre>(?<hit>subprocess\.[a-z_]+\([^)\n]*shell\s*=\s*True)/ },
  { id: 'weak/sudo', severity: 'warning', target: 'script', message: 'uses sudo',
    re: /(?:^|\s)sudo\s/i },
  { id: 'weak/broad-rm', severity: 'warning', target: 'script', message: 'recursive delete of a broad path',
    re: /\brm\s+-[a-z]{0,10}r[a-z]{0,10}\s+(?:\/(?:\s|$)|~\/?(?:\s|$)|\$HOME\/?(?:\s|$)|\*)/i },
  { id: 'weak/chmod-777', severity: 'warning', target: 'all', message: 'world-writable permissions',
    re: /chmod\s+(?:-R\s+)?777\b/ },
];

/** Rules whose regex is a single character class: linear on any input, so they are tested on whole lines. */
export const CHAR_CLASS_RULES: ReadonlySet<string> = new Set(['hidden-unicode/bidi-or-tag', 'zero-width/invisible-char']);

const SHELL_FILE = /\.(?:sh|bash|zsh)$/i;
const ENV_OBJECT = /os\.environ|process\.env/;

/**
 * Tests one rule against one line slice and returns the reported span. Adds the one condition a regex can't express cheaply: outside shell
 * files, a `${…TOKEN}` is usually a template literal holding the script's own credential, so env exfiltration
 * there needs `os.environ` / `process.env` (upstream reported those cases as warnings).
 */
export function ruleMatch(rule: Rule, text: string, file: string): { index: number; length: number } | null {
  const m = rule.re.exec(text);
  if (!m) return null;
  if (rule.id === 'exfiltration/env-to-network' && !SHELL_FILE.test(file) && !ENV_OBJECT.test(text)) return null;
  const hit = m.groups?.['hit'] ?? m.groups?.['hit2'];
  return hit === undefined ? { index: m.index, length: m[0].length } : { index: m.index + m[0].length - hit.length, length: hit.length };
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
