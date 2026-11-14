# skillseekr Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add runtime security and integrity to skillseekr. Every fetched skill is scanned on the user's machine before it can appear in search, be fetched, or be installed. Skills with critical findings are blocked. Local and `policy` deny lists (`block`) and content-tied overrides (`allow`) are honoured. Signed skills are verified against locally trusted keys. Quality warnings are reported. A read-only `skillseekr scan` covers every tool and plugin skill folder.

**Architecture:** There is a new pure `scan` module: rules, context-aware downgrading, quality checks, and a cache keyed by content hash and rules version. There is also a `sign` module (ed25519 manifest) and a `policy` module, which parses `allow`/`block`/`trust` and evaluates a skill's `Security` verdict. The engine runs `scan → verify signature → evaluate policy` per skill after discovery and attaches `security` to each `SkillRecord`. `Catalog`, the MCP tools, the installer and the CLI read that verdict. Nothing is ever executed from fetched content: scanning is regex matching over file text.

**Tech Stack:** As Phase 1: Node ≥ 20, TypeScript ESM strict, vitest, `@modelcontextprotocol/sdk`, `zod`, `commander`, `jsonc-parser`, `tar`, `yaml`. Signing uses `node:crypto` ed25519. No new runtime dependencies.

**Spec:** `docs/spec-phase-2.md` (the spec's "Phase 2: runtime security and integrity" section). It is read together with `docs/spec.md` (Phase 1). Where the plan and the spec disagree, the spec wins. Raise the conflict; don't silently pick one.

**Upstream for the port:** skillyard, MIT, `github.com/agentwik-labs/skillyard` at commit `83ee69064aaa5934bc92ecafc66cc4818dff0bbb`. Port `src/scan.js` (all rules plus the `fencedLines`/`looksBenign` downgrade logic), the `REMOTE_RULES` of `src/secure.js`, its frontmatter `allowed-tools` and `permissionMode` checks, the `src/sign.js` manifest scheme, and `examples/` (12 bad and 5 good skills, including their `LICENSE` copyright line). The npm release `skillyard@0.1.0` lacks `secure.js`, `sign.js` and `examples/`, so use the GitHub commit above. The Phase 1 rule "never copy code from afriemann/skills-mcp" still holds. skillyard's licence allows porting with the notice.

## Global Constraints

- Everything in Phase 1's Global Constraints still holds (`docs/plans/2026-11-14-skillseekr-phase-1.md`).
- The scan is **fixed rules shipped with skillseekr: no AI model, no network calls**. It is deterministic and works offline.
- Scan every file in the skill folder, including `SKILL.md` frontmatter. Skip binary files (a NUL byte in the first 8 KB). Text files up to **10 MB** are scanned. A regular file over 10 MB gives the critical finding `integrity/unscannable-file`.
- Rule targets are `text` (Markdown, frontmatter, every non-script text file), `script` (extensions `.sh .bash .zsh .py .js .mjs .cjs .ts .rb .pl .ps1`), `all`, or `frontmatter`. A `script` rule never fires on text, and a `text` rule never fires on scripts.
- **Never downgraded:** `hidden-unicode/*`, `secrets/*` (private keys and real tokens), `integrity/*`.
- A critical finding is downgraded to a warning, with a reason, when:
  - **Text:** it is inside a fenced code block (`"inside an example block"`), inside quotation marks (`"in quotation marks"`), or in a defensive sentence (`"in a defensive sentence"`).
  - **Scripts:** it is in a comment, a docstring or a regex pattern (`"in a comment, docstring or pattern"`).
  - **Download-and-run:** the line only prints the command (`"only prints the command"`).
  - **Exfiltration:** the target is localhost or 127.0.0.1 (`"target is localhost"`).
- Scan results are cached by `(contentHash, RULES_VERSION)` at `<cache>/scan/<RULES_VERSION>/<hex of contentHash>.json`, written atomically. `RULES_VERSION` is a string constant in `src/scan/rules.ts`, starting at `"1"`, and bumped whenever any rule or downgrade logic changes.
- **Critical → blocked.**
  - A blocked skill is left out of `search_skills` and CLI `search`.
  - `get_skill`, `read_skill_file`, `install_skill` and CLI `install` refuse it, naming the rule, file and line, or the deny entry and its reason.
  - `show` and `doctor` list blocked skills with their findings.
- **Warning → allowed but flagged.** Warnings are labelled everywhere the skill appears.
- `block` and `allow` are honoured **only** from the local config and from the root of a registries file included **directly from the local config with `policy: true`**. Entries anywhere else are ignored and reported (`policy/ignored-allow`, `policy/ignored-block`). `trust` is honoured **only** from the local config. `trust` anywhere else is ignored and reported (`policy/ignored-trust`).
- **`block` beats everything.** No `allow`, flag or `--force` lifts it. A block entry has exactly one of `id` (every version of that skill ID) or `content_hash` (that exact content under any ID), plus `reason` and `added`.
- **`allow`** is keyed by skill ID: `{ content_hash, rules: string[], reason, added }`. It applies only when `content_hash` equals the skill's current content hash **and** `rules` covers every critical rule ID found. Otherwise the skill stays blocked. `allowedBy` is `"user"` for local entries, or the include entry's name for a policy include.
- Inline markers in skill files (for example "scanner: ignore") are ignored.
- **No MCP tool creates or changes `allow`, `block` or `trust`.** The six Phase 1 MCP tools are still exactly six.
- Signature file: `.skillseekr-signature.json` = `{ alg: "ed25519", manifest: { <posix relPath>: <sha256 hex> }, sig: <base64> }`. It is signed over `Buffer.from(JSON.stringify(sortedPairs))`, where `sortedPairs` is `[[path, sha], …]` sorted by path. The manifest excludes `.skillseekr-signature.json` and `.skillseekr.json`. Public keys are written `ed25519:<base64url of the raw 32-byte key>` (the JWK `x`). Private keys are PKCS#8 PEM.
- A skill from a `github` registry whose `owner` (case-insensitive) has a trusted key gets the critical finding `integrity/signature` if its signature is missing, invalid, made with an untrusted key, or doesn't match the files. Only a content-tied `allow` can override it. Owners without a trusted key aren't checked.
- Last-wins dedupe (Phase 1) happens **before** security. A blocked winner still hides the skill it replaced. *(Decision. The spec doesn't say; falling back to an older copy would be a surprise.)*
- Credit skillyard in the README and in `THIRD_PARTY_NOTICES.md`, with its MIT copyright line. Keep a header comment in each ported file that names the upstream file and commit.

## Review Focus

1. **Legitimate security-teaching skills.** A skill that quotes injection phrases, `curl | sh`, or credential paths in code blocks, quotes, comments or defensive prose must produce warnings only, never a block. *Test owned by Task 2:* `false-positive corpus produces zero blocks` (budget: 0 blocks).
2. **Evasion through formatting.** CRLF line endings, uppercase variants, a pattern in the frontmatter `description`, and a UTF-8 BOM must not hide a critical pattern. A BOM at file start alone is fine; a BOM later in the file is a zero-width warning. *Test owned by Task 1:* `CRLF, case and frontmatter placement do not hide criticals`.
3. **Hostile scan input.** A 10 MB single-line file, a binary file, an 11 MB file, and lines built to backtrack must keep the scan bounded: each skill scans in under 2 s on the test machine, and nothing throws. *Test owned by Task 1:* `pathological input stays bounded`.
4. **Policy changes and agent tampering.** Adding a `block` to the local config takes effect on the next `engine.catalog()` without `sync`, using Phase 1's config-mtime reload. An `allow` written by hand with a wrong hash, or with too few rules, does not unblock. `doctor` lists every local `allow` with its `added` date. *Tests owned by Task 7 and Task 11.*
5. **Installed copies drift from the catalog.** An installed copy that was clean when installed, then matches a new `block` entry or has been edited to include a critical pattern, is flagged by `list`, `update` and `doctor`. `update` never installs blocked content. *Test owned by Task 9.*

---

## File Structure

```
THIRD_PARTY_NOTICES.md                  # skillyard MIT notice (Task 2)
src/scan/rules.ts      # RULES_VERSION, Rule table (Task 1)
src/scan/context.ts    # downgrade logic: quoted/fenced/defensive/comment/print/localhost (Task 1)
src/scan/scan.ts       # scanFiles/scanSkillDir → ScanResult (Task 1)
src/scan/quality.ts    # quality warnings + near-duplicate detection (Task 3)
src/scan/cache.ts      # (contentHash, RULES_VERSION) result cache (Task 7)
src/sign/sign.ts       # manifest, sign, verify, key create/format (Task 4)
src/policy/types.ts    # AllowEntry, BlockEntry, TrustEntry, Policy, Security (Task 5)
src/policy/parse.ts    # parse allow/block/trust from a JSONC root (Task 5)
src/policy/evaluate.ts # evaluate(skill, findings, policy) → Security (Task 6)
src/config/edit.ts     # + addBlock/removeBlock/setAllow/removeAllow/setTrust (Task 10)
src/engine.ts, src/catalog/catalog.ts   # security wiring (Task 7)
src/mcp/server.ts, assets/starter-skill/SKILL.md, plugins/... (Task 8)
src/install/installer.ts, src/install/security.ts (Task 9)
src/cli/commands/{allow,block,keys,sign,scan}.ts + edits to show/search/install/list/outdated/update (Tasks 4, 10, 11)
src/scan/folders.ts    # default scan targets incl. plugin skill folders (Task 11)
src/doctor.ts          # security/policy/quality checks (Task 11)
test/fixtures/skillyard/{bad,good}/…    # vendored examples (Task 2)
test/fixtures/rules/<rule-id>/{bad,quoted}/…  # per-rule fixtures (Task 1)
docs/acceptance-phase-2.md              # P2-1…P2-13 map (Task 12)
```

---

### Task 1: Rules and scanner core

**Files:**
- Create: `src/scan/rules.ts`, `src/scan/context.ts`, `src/scan/scan.ts`, `test/fixtures/rules/**`
- Test: `test/scan/scan.test.ts`, `test/scan/rules.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // rules.ts
  export const RULES_VERSION = '1';
  export type Target = 'text' | 'script' | 'all' | 'frontmatter';
  export interface Rule { id: string; severity: 'critical' | 'warning'; target: Target; re: RegExp; message: string; neverDowngrade?: boolean }
  export const RULES: readonly Rule[];
  // scan.ts
  export interface Finding { rule: string; severity: 'critical' | 'warning'; file: string; line: number; message: string; downgraded?: string /* reason */ }
  export interface ScanResult { findings: Finding[]; critical: number; warning: number }
  export function scanFiles(files: Array<{ path: string; content: Buffer }>): ScanResult;   // pure
  export function scanSkillDir(dir: string, files: string[]): Promise<ScanResult>;           // reads regular files only (lstat), applies the 10 MB rule
  export const SCRIPT_EXT: RegExp;
  ```
- Rule IDs. These are exact; the rest of the plan, the tests and the docs use them.

  | ID | Severity | Target | Source |
  |---|---|---|---|
  | `prompt-injection/override-instructions` | critical | text | skillyard `prompt-override` |
  | `prompt-injection/role-impersonation` | critical | text | new: a line-start `<|system|>`, `<|im_start|>system`, `[system]`, `system prompt:`, `### system`, or "you are now (in) (developer mode\|DAN\|jailbroken)" |
  | `concealment/hide-from-user` | critical | text | `conceal-from-user` |
  | `hidden-unicode/bidi-or-tag` | critical, never downgraded | all | `hidden-unicode` |
  | `zero-width/invisible-char` | warning | all | `zero-width`, but a BOM only counts if it is not at file offset 0 |
  | `secrets/private-key`, `secrets/aws-key`, `secrets/github-token`, `secrets/slack-token`, `secrets/ai-key` | critical, never downgraded | all | the matching skillyard rules (the AWS rule keeps the `EXAMPLE` exclusion) |
  | `download-and-run/curl-pipe-shell` | critical | script | `pipe-to-shell` |
  | `download-and-run/fetch-and-exec` | critical | script | secure.js `fetch-and-exec` shell and PowerShell forms (`bash <(curl`, `sh -c "$(curl`, `iex … iwr`) |
  | `download-and-run/download-then-run` | critical | script | secure.js `download-then-run` |
  | `remote-code/remote-package` | critical | script | secure.js `remote-package-run` (`npx github:`/`https:`/`git+`, `pip install git+`/URL) |
  | `remote-code/url-import` | critical | script | `dynamic-url-import` |
  | `remote-code/exec-url` | critical | script | the `(exec\|eval)(…urlopen\|requests.get\|fetch()` branch of `fetch-and-exec` |
  | `encoded-exec/eval-decoded` | critical | script | `encoded-exec` |
  | `credential-read/home-credentials` | critical | script | `credential-read` |
  | `credential-read/keychain` | critical | script | new: `security\s+find-(generic\|internet)-password`, `security\s+dump-keychain` |
  | `exfiltration/env-to-network` | critical | script | `env-exfil` |
  | `permission-bypass/skip-permissions` | warning | text | `auto-approve`, plus `bypassPermissions`, plus "turn off/disable (the) approval/permission prompts" |
  | `broad-tools/allowed-tools` | warning | frontmatter | secure.js frontmatter check: `allowed-tools`/`tools` containing `*`, `Bash`, `Bash(*)`, `Bash(curl…)`, `Bash(sudo…)`, `Bash(rm…)` |
  | `weak/network-call`, `weak/shell-true`, `weak/sudo`, `weak/broad-rm` | warning | script | `network-call`, `shell-true`, `sudo`, `destructive-rm` |
  | `weak/chmod-777` | warning | all | `chmod-777` |

- [ ] **Step 1: Build the per-rule fixtures.** For every rule ID above, create `test/fixtures/rules/<id with / → __>/bad/` as a minimal skill (`SKILL.md` with frontmatter plus the triggering file). For each critical rule that can be downgraded, also create `quoted/`, which carries the same pattern in a downgrading context. Use `.example` domains and fake keys built from obviously fake bodies that still match the regex. Store secret-shaped strings split across concatenation in a generator script, `test/fixtures/rules/make-secrets.ts`, which writes them at test time into a temp dir. That keeps real-looking tokens out of git and away from GitHub push protection.
- [ ] **Step 2: Write failing tests** (`rules.test.ts`): `every rule id has a bad fixture that yields exactly that rule at its base severity`; `every downgradable critical rule's quoted fixture yields a warning with the matching downgraded reason`; `never-downgrade rules stay critical inside code blocks, quotes and comments`; `rule ids are unique and match /^[a-z-]+\/[a-z0-9-]+$/`. In `scan.test.ts`:
  - `script rules never fire on .md and text rules never fire on .py`
  - `CRLF, case and frontmatter placement do not hide criticals`: a CRLF `.sh` with `CURL … | SH`, and a `description:` containing "Ignore previous instructions", are each critical.
  - `BOM at offset 0 is clean; BOM mid-file is zero-width warning`
  - `binary files are skipped; a regular file over 10 MB yields integrity/unscannable-file`
  - `symlinks in the skill dir are not followed or read`
  - `pathological input stays bounded`: a 10 MB single line of `curl ` repeats, and a line of 200k `a`s followed by `| sh`, each scan in < 2000 ms.
  - `findings are sorted critical first, then file, then line; at most 3 findings per (rule, file) for critical and 1 for warning`. This matches skillyard.
- [ ] **Step 3: Run** `npx vitest run test/scan`. Expected: FAIL (modules missing).
- [ ] **Step 4: Implement.** Port skillyard's regexes and its `fencedLines`/`looksBenign` logic into `rules.ts` and `context.ts`, with the header comment `Ported from skillyard (MIT) src/scan.js and src/secure.js @ 83ee690`.
  - Bound the regex work: test each rule against each line truncated to its first 4096 characters, and also against its last 4096 characters when the line is longer. Fix any rule that still backtracks badly until the bounded-input test passes.
  - Normalise line endings to `\n` before splitting.
  - Parse frontmatter with Phase 1's `parseFrontmatter`. Frontmatter lines are `text` plus `frontmatter` targets, with line numbers in the original file.
- [ ] **Step 5: Run.** Expected: PASS. Run `npm run lint` too.
- [ ] **Step 6: Commit** `feat: security scanner rules and context-aware severity`.

---

### Task 2: Vendored skillyard examples and false-positive corpus

**Files:**
- Create: `test/fixtures/skillyard/{bad,good}/**` (copied from upstream `examples/` at the pinned commit), `test/fixtures/skillyard/LICENSE`, `test/fixtures/legit/**`, `THIRD_PARTY_NOTICES.md`
- Modify: `README.md` (credits section)
- Test: `test/scan/corpus.test.ts`

**Interfaces:**
- Consumes: `scanSkillDir` (Task 1), `discoverSkills` (Phase 1).

- [ ] **Step 1: Vendor the fixtures.** Fetch with `gh api repos/agentwik-labs/skillyard/contents/<path>?ref=83ee690… -H "Accept: application/vnd.github.raw"` and copy. If a fixture contains a secret-shaped string that GitHub push protection or this repo's tooling would flag (`bad/billing-reports`), apply Task 1's generator approach. Note the substitution in `test/fixtures/skillyard/README.md`.
- [ ] **Step 2: Build the legit corpus** in `test/fixtures/legit/`. Include at least:
  - a prompt-injection-defence skill that quotes "ignore previous instructions" in a defensive sentence, in quotes, and in a fenced block;
  - a secret-hygiene review skill with credential paths and `curl | sh` in fenced blocks;
  - a Python linter script whose regexes and comments contain `curl … | sh`;
  - a local helper that posts `os.environ['SESSION']` to `http://127.0.0.1:…`;
  - a script that `echo`s an install command;
  - an emoji ZWJ sequence in prose.

  Also include the 10 skills in `evals/discovery/skills/` and the starter skill.
- [ ] **Step 3: Write failing tests:**
  - `skillyard bad examples`: `readme-polisher`, `strict-reviewer`, `lint-everything`, `billing-reports` and `env-doctor` each have ≥ 1 critical. `fast-refactor` has `permission-bypass/skip-permissions` as a warning and no critical. `quick-commits` and `engineering-handbook` have no critical.
  - `skillyard good examples produce zero criticals`.
  - `false-positive corpus produces zero blocks`: every skill in `test/fixtures/legit` and `evals/discovery/skills` has 0 criticals. Downgraded warnings are allowed, and each must carry a `downgraded` reason.
- [ ] **Step 4: Run.** Expected: FAIL until the fixtures and any rule tuning are in place. Tune rules only by changing context logic, never by deleting a rule. If tuning changes Task 1 behaviour, keep Task 1's tests green and bump nothing (still version `"1"` before release).
- [ ] **Step 5: Write `THIRD_PARTY_NOTICES.md`** with skillyard's full MIT licence text and copyright line, and the list of ported files and fixtures. Add a "Credits" section to the README that links to it.
- [ ] **Step 6: Commit** `test: skillyard examples and false-positive corpus for the scanner`.

---

### Task 3: Quality checks

**Files:**
- Create: `src/scan/quality.ts`
- Test: `test/scan/quality.test.ts`

**Interfaces:**
- Consumes: `Finding` (Task 1), `DiscoveredSkill` (Phase 1).
- Produces:
  ```ts
  export function qualityFindings(skill: { description: string; dir: string; files: string[] }, skillMd: string): Promise<Finding[]>; // all severity 'warning', rule ids below
  export function nearDuplicates(skills: Array<{ id: string; description: string }>): Array<{ a: string; b: string; similarity: number }>;
  ```
- Rule IDs, all warnings, file `SKILL.md`:
  - `quality/description-missing`: missing or empty.
  - `quality/description-short`: < 40 characters.
  - `quality/description-no-trigger`: no match for `/\b(use (this |it )?(when|for|to|if)|when (the user|you|asked)|for (tasks|requests|work) (that|involving|about))\b/i`.
  - `quality/description-hijack`: matches `/\b(every|any|all) (task|request|question)s?\b|\balways use\b|\buse (this|it) (for|on) everything\b/i`, or has fewer than 4 distinct non-stopword tokens.
  - `quality/broken-reference`: a relative path in SKILL.md body (Markdown link targets, plus backticked tokens matching `^(references|scripts|templates|assets|examples)/[\w./-]+$`) that is not in `files`. Report the line number.
  - `quality/oversized-file`: any file > 1 MB.
  - `quality/oversized-skill`: total > 20 MB.

- [ ] **Step 1: Write failing tests:**
  - skillyard `bad/notes-v2` gets `description-no-trigger`;
  - `bad/team-helper` gets `description-hijack`;
  - `bad/schema-check` gets `broken-reference` naming each missing path;
  - `good/*` get none of these;
  - a 1.5 MB file gets `oversized-file`;
  - `nearDuplicates` pairs two descriptions that differ by one word (similarity ≥ 0.85) and does not pair unrelated ones.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** `nearDuplicates` uses Jaccard similarity over lowercase token sets (the Phase 1 search tokenizer, without stopwords). It only considers descriptions with ≥ 5 tokens, pairs where similarity ≥ 0.85, and sorts by `a`, then `b`. It is O(n²), which is acceptable at catalog scale; add a comment saying so.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: skill quality warnings and near-duplicate detection`.

---

### Task 4: Signing

**Files:**
- Create: `src/sign/sign.ts`, `src/cli/commands/keys.ts`, `src/cli/commands/sign.ts`
- Modify: `src/cli/main.ts` (register commands)
- Test: `test/sign/sign.test.ts`, extend `test/cli/cli.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const SIGNATURE_FILE = '.skillseekr-signature.json';
  export interface SignatureDoc { alg: 'ed25519'; manifest: Record<string, string>; sig: string }
  export function createKeyPair(): { privateKeyPem: string; publicKey: string /* "ed25519:<b64url>" */ };
  export function buildManifest(files: Array<{ path: string; content: Buffer }>): Record<string, string>;
  export function signFiles(files: Array<{ path: string; content: Buffer }>, privateKeyPem: string): SignatureDoc;
  export function verifyFiles(files: Array<{ path: string; content: Buffer }>, doc: unknown, publicKeys: string[]): { ok: boolean; changed: string[]; error?: string };
  export function verifySkillDir(dir: string, files: string[], publicKeys: string[]): Promise<{ ok: boolean; changed: string[]; error?: string }>; // missing file → ok:false, error 'missing signature'
  ```
- CLI:
  - `skillseekr keys create --out <dir> [--force]` writes `skillseekr-private.pem` (mode 0600) and `skillseekr-public.txt`, and prints the public key string. It refuses to overwrite without `--force`.
  - `skillseekr sign <skill-dir> --key <private.pem>` writes `.skillseekr-signature.json`. It refuses (exit 1) if there is no `SKILL.md`.

- [ ] **Step 1: Write failing tests:**
  - sign then verify gives ok;
  - changing one byte gives `ok:false` with `changed` naming the file;
  - adding or removing a file is detected;
  - verifying with another key fails;
  - a malformed doc returns `error`;
  - one key out of several in `publicKeys` matching is enough (rotation);
  - the manifest excludes the signature file and `.skillseekr.json`;
  - the public key round-trips through the `ed25519:` string form;
  - CLI: `keys create` file modes, `--force`, and `sign` writes a doc that `verifySkillDir` accepts.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with `node:crypto`: `generateKeyPairSync('ed25519')`, `sign(null, …)`/`verify(null, …)`, and `createPublicKey({ key: { kty:'OKP', crv:'Ed25519', x }, format:'jwk' })`. Add the header comment `Scheme follows skillyard (MIT) src/sign.js @ 83ee690`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: ed25519 skill signing, keys and sign commands`.

---

### Task 5: Policy config parsing and honouring

**Files:**
- Create: `src/policy/types.ts`, `src/policy/parse.ts`
- Modify: `src/types.ts` (`RegistriesFile.policy`), `src/config/load.ts`, `src/resolve/resolve.ts`
- Test: `test/policy/parse.test.ts`, extend `test/resolve/resolve.test.ts`

**Interfaces:**
- Produces (`policy/types.ts`):
  ```ts
  export interface AllowEntry { content_hash: string; rules: string[]; reason: string; added: string }
  export type BlockEntry = { id: string; reason: string; added: string } | { content_hash: string; reason: string; added: string };
  export interface TrustEntry { owner: string; public_keys: string[] }
  export interface PolicyBlock { allow: Record<string, AllowEntry>; block: BlockEntry[]; trust: TrustEntry[] }
  export type PolicySource = { kind: 'local'; file: string } | { kind: 'include'; name: string; via: string[]; file: string };
  export interface Policy { sources: Array<{ source: PolicySource; allow: Record<string, AllowEntry>; block: BlockEntry[] }>; trust: TrustEntry[] }
  export const EMPTY_POLICY: Policy;
  ```
- Produces (`policy/parse.ts`): `parsePolicy(root: jsonc Node | undefined, file: string): { policy: PolicyBlock; problems: Problem[] }`. Invalid entries are skipped with `policy/invalid-entry` (error, `file`).
- Modifies:
  - `RegistriesFile` gains `policy: PolicyBlock`, filled for every file by `parseRegistriesFile`.
  - `Resolution` gains `policy: Policy`. The resolver builds it from the local config's `allow`/`block`/`trust`, plus `allow`/`block` from the root of each **depth-1** include whose local entry has `policy: true`.
  - Any `allow`/`block` in other included files, and any `trust` outside the local config, is dropped with a warning (`policy/ignored-allow`, `policy/ignored-block` or `policy/ignored-trust`) carrying `registry`, `via` and `file`.

- [ ] **Step 1: Write failing tests:**
  - parse valid and invalid entries. A block entry with both `id` and `content_hash`, or neither, is invalid. A `content_hash` not matching `/^sha256:[0-9a-f]{64}$/` is invalid. A trust key not matching `/^ed25519:[A-Za-z0-9_-]{43}$/` is invalid.
  - `local allow/block/trust are honoured`
  - `policy:true depth-1 include contributes allow and block with source {kind:'include', name}`
  - `allow/block in a non-policy include are ignored and reported`
  - `allow/block in a depth-2 include under a policy include are ignored and reported`
  - `trust in any included file is ignored and reported`
  - `policy:true in an included file has no effect` (Phase 1 behaviour kept)
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep parsing in `parse.ts`. `load.ts` and `resolve.ts` only call it and route the result.
- [ ] **Step 4: Run** `npx vitest run test/policy test/resolve test/config`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: parse allow/block/trust and honour them only from local and policy sources`.

---

### Task 6: Security verdict evaluation

**Files:**
- Create: `src/policy/evaluate.ts`
- Test: `test/policy/evaluate.test.ts`

**Interfaces:**
- Consumes: `Finding` (Task 1), `Policy` (Task 5).
- Produces:
  ```ts
  export type SecurityStatus = 'clean' | 'warned' | 'allowed' | 'blocked';
  export interface Security {
    status: SecurityStatus;
    findings: Finding[];                        // scan + quality + integrity, all of them
    blockedBy?: { kind: 'scan'; rules: string[] } | { kind: 'deny'; entry: BlockEntry; source: PolicySource };
    allowedBy?: { label: string /* 'user' | include name */; rules: string[]; added: string; reason: string };
    note?: string;                              // e.g. why a present allow entry didn't apply
  }
  export function evaluate(skill: { id: string; contentHash: string }, findings: Finding[], policy: Policy): Security;
  export const CLEAN: Security;
  ```
- The algorithm:
  1. If any block entry from any source matches `id === skill.id` or `content_hash === skill.contentHash`, the result is `blocked`/`deny`. Use the first match in source order: local first, then includes in resolution order.
  2. Let `crit` be the distinct critical rule IDs in `findings`. If `crit` is empty, the result is `warned` when there are any findings, otherwise `clean`.
  3. Otherwise, look for an allow entry for `skill.id` whose `content_hash === skill.contentHash` and whose `rules ⊇ crit`. Check local first, then includes. If one is found, the result is `allowed`.
  4. Otherwise the result is `blocked`/`scan`. If an allow entry existed but didn't match, set `note` to say which part failed: "content changed since allowed", or "allow entry does not cover <rules>".

- [ ] **Step 1: Write failing tests:**
  - P2-3: an allow entry with the right hash and rules lifts the block.
  - P2-3: the same entry with the hash differing by one character does not lift it, and `note` names the content change.
  - P2-3: a new critical rule not listed in `rules` keeps the skill blocked, and `note` names the missing rule.
  - P2-8: a deny by id beats a matching allow.
  - P2-8: a deny by content_hash matches under a different id.
  - `allowedBy.label` is `'user'` for a local entry and the include name for a policy entry.
  - warnings only give `warned`; no findings gives `clean`.
  - `integrity/signature` can be allowed like any other critical finding.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: security verdict from scan findings, block and allow`.

---

### Task 7: Scan cache and engine integration

**Files:**
- Create: `src/scan/cache.ts`
- Modify: `src/engine.ts`, `src/catalog/catalog.ts`
- Test: `test/scan/cache.test.ts`, extend `test/engine.test.ts`, `test/catalog/catalog.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // cache.ts
  export function cachedScan(cacheDir: string, contentHash: string, scan: () => Promise<ScanResult>): Promise<ScanResult>; // reads/writes <cache>/scan/<RULES_VERSION>/<hex>.json atomically; invalid JSON → rescan
  ```
- Modifies:
  - `SkillRecord` gains `security: Security`. `Catalog` construction defaults it to `CLEAN` when it is not supplied, so Phase 1 tests keep working.
  - `Catalog` gains `readonly policy: Policy`, passed as a new optional 5th constructor argument (default `EMPTY_POLICY`).
  - `search()` skips `blocked` skills. `SearchHit` gains `security: { status: SecurityStatus; allowedBy?: string; warnings: number }`.
  - New method `blocked(): SkillRecord[]`.
  - `lookup`/`byId` still find blocked skills, so callers can explain the refusal.
  - `readFile(skill, …)` returns `{ kind: 'refused', reason }` for a blocked skill.
- Engine: `EngineDeps` gains `scan?: typeof scanSkillDir` for spying. For each discovered skill, the engine does the following:
  - `findings = cachedScan(scanSkillDir) + qualityFindings`. Quality checks are cheap, so they aren't cached.
  - If the registry is `github` and `policy.trust` has keys for its owner, run `verifySkillDir`. On failure, append a critical `integrity/signature` finding naming the file `.skillseekr-signature.json`, with `changed` in the message.
  - `security = evaluate(...)`.
  - Index caching from Phase 1 stays as it is.

- [ ] **Step 1: Write failing tests:**
  - **P2-1:** with a fakeGithub registry where one skill contains `curl x | sh` in `scripts/a.sh`, that skill is absent from `catalog.search`. `lookup` finds it with `security.status === 'blocked'`, and the findings include the rule, file and line.
  - **P2-2:** with a branch ref, `v1` is clean. The repo then advances to `v2`, which adds a critical. After TTL expiry, `catalog()` shows the skill blocked, with no `sync` needed.
  - **P2-7:** `rescanning an unchanged catalog does no scan work`. A spy on `scan` sees 0 calls on the second `catalog({force:true})` with an unchanged sha. With `RULES_VERSION` stubbed to a new value via `vi.mock`, every skill is rescanned.
  - **P2-7:** `scanning never touches the network`. The fake http records no calls made during the scan phase. Assert the call count is the same as for a Phase 1 load.
  - **Review Focus 4:** `adding a local block takes effect on the next catalog() without sync`, via a config-file edit plus the Phase 1 mtime reload.
  - **P2-12:**
    - A trusted owner with a correctly signed skill loads clean.
    - Changing one byte after signing gives `integrity/signature`, blocked.
    - A missing signature file gives blocked.
    - A key placed in an included registries file has no effect, and the skill loads clean, because the owner isn't trusted.
  - A blocked winner still hides the skill it replaced, and the override is still recorded.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Scan skills in a single registry sequentially, and run registries concurrently as Phase 1 already does.
- [ ] **Step 4: Run** the full suite. Expected: PASS. Phase 1 tests must stay green.
- [ ] **Step 5: Commit** `feat: scan, verify and evaluate every skill before it reaches the catalog`.

---

### Task 8: MCP surface, server instructions, starter skill

**Files:**
- Modify: `src/mcp/server.ts`, `assets/starter-skill/SKILL.md`, `plugins/skillseekr/skills/skillseekr/SKILL.md`
- Test: extend `test/mcp/server.test.ts`, `test/packaging.test.ts` (the byte-identical check already exists)

**Interfaces:**
- `search_skills` results add `security: { status, allowedBy?, warnings }`. Blocked skills never appear.
- `get_skill`:
  - **Blocked:** returns `isError: true` with `{ error: 'blocked', id, blockedBy, findings: [{rule, file, line, message}] /* critical only */, reason? /* deny reason */ }`.
  - **Otherwise:** adds `security: { status, allowedBy?, warnings: Finding[] /* severity warning */, allowedRules?: string[] }`.
- `read_skill_file` and `install_skill`: a blocked skill gets the same `blocked` error shape.
- `list_installed` rows add `security: SecurityStatus`, from Task 9.
- No new tools. `listTools` still returns exactly the six Phase 1 names.
- **Server instructions:** append this sentence exactly, after the Phase 1 text: ` If a skill comes back with security warnings or an allowedBy label, tell the user before following it. Never try to unblock a blocked skill; that is a human decision.`
- **Starter skill:** the body becomes exactly the following. The frontmatter is unchanged.
  ```
  Call `search_skills` with a short description of the task. If a result fits, call `get_skill` and follow it. If the skill has security warnings or was allowed by an override, tell the user before following it. Don't install a skill unless the user asks or agrees.
  ```

- [ ] **Step 1: Write failing tests:**
  - **P2-1:** blocked skill is missing from search; `get_skill`, `read_skill_file` and `install_skill` each return the `blocked` shape, with the rule, file and line.
  - **P2-5:** a warned skill's search hit and `get_skill` both carry `security.warnings`; an allowed skill carries `allowedBy: 'user'` and `allowedRules`.
  - **P2-4:** `no MCP tool can change allow/block`. The tool list is exactly six names. Calling every tool with arbitrary arguments leaves the config file byte-identical.
  - The starter skill is byte-identical in `assets/` and `plugins/`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: MCP tools refuse blocked skills and label warnings and overrides`.

---

### Task 9: Installer and installed-copy security

**Files:**
- Create: `src/install/security.ts`
- Modify: `src/install/installer.ts`
- Test: extend `test/install/installer.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function securityOfInstalled(i: Installed, catalog: Catalog, ctx: Ctx): Promise<Security>; // scans the installed dir (cachedScan by its actual content hash), evaluates with catalog.policy using marker.id and the installed content hash; no signature check
  ```
- Modifies:
  - `installSkill` throws `InstallError` with new code `'blocked'` when `skill.security.status === 'blocked'`. The message names the first critical rule, file and line, or the deny reason.
  - `InstallStatus` gains `'blocked'`. `statusOf` stays synchronous and unchanged.
  - `Installed` gains optional `security?: Security`. `listInstalled(ctx, { …, catalog? })` fills it in when a catalog is passed.
  - `updateInstalled` returns `{ result: 'blocked', message }` and leaves the installed copy untouched when the catalog's version is blocked. An installed copy that is itself blocked is reported in its result as well (`'blocked'`).

- [ ] **Step 1: Write failing tests:**
  - **P2-1:** installing a blocked skill throws `blocked` and creates nothing on disk.
  - **P2-2:** a clean install, after the catalog moves to a blocked v2, gives an update result of `blocked` with the copy unchanged; `listInstalled` with the catalog shows `security.status === 'warned' | 'clean'` for the old copy.
  - **Review Focus 5:** a hand-edited installed copy that now contains `curl | sh` gives `securityOfInstalled` the result `blocked`.
  - **P2-8:** a block by content_hash of the installed copy gives `blocked`.
  - A folder with no marker is never scanned or touched.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: installer refuses blocked skills and flags blocked installed copies`.

---

### Task 10: CLI security surface: block, unblock, allow, and labels

**Files:**
- Create: `src/cli/commands/block.ts`, `src/cli/commands/allow.ts`
- Modify: `src/config/edit.ts`, `src/cli/commands/{show,search,install,list,outdated,update}.ts`, `src/cli/main.ts`
- Test: extend `test/config/edit.test.ts`, `test/cli/cli.test.ts`

**Interfaces:**
- `config/edit.ts` adds the following. Each keeps comments, as in Phase 1, and refuses to add a block entry that duplicates an existing one.
  ```ts
  addBlock(text: string, entry: BlockEntry): string;
  removeBlock(text: string, match: { id: string } | { content_hash: string }): string; // throws if absent
  setAllow(text: string, id: string, entry: AllowEntry): string;
  removeAllow(text: string, id: string): string;
  setTrust(text: string, owner: string, publicKeys: string[]): string;
  ```
- Commands. All config writes go through Phase 1's atomic, symlink-preserving writer.
  - `skillseekr block <id> --reason <text>` and `skillseekr block --hash <sha256:…> --reason <text>`. `added` is today's date from `ctx.now()`, formatted `YYYY-MM-DD`. No confirmation is asked.
  - `skillseekr unblock <id>` and `skillseekr unblock --hash <h>`. These remove only **local** entries. If the match comes from a policy include, exit 1 with a message naming that include: "lift it in <include>".
  - `skillseekr allow <id> --reason <text> [--yes]`:
    1. Load the catalog. Exit 1 if the skill isn't blocked by scan (`nothing to allow`).
    2. If the skill is blocked by a deny entry, exit 1 (`blocked by a deny entry; allow cannot lift it`).
    3. Print every finding.
    4. Ask `Type the skill id to confirm:` through `io.prompt`. A mismatch exits 1 with nothing written. `--yes` skips the prompt.
    5. Write `allow.<id> = { content_hash: current, rules: current critical rule ids, reason, added }`.
  - `skillseekr allow --list` prints every allow entry with its source label and `added`.
  - `skillseekr allow --prune` removes local entries whose `content_hash` matches no current catalog skill with that id, and prints what it removed.
- Labels:
  - `search` rows show `[warnings: N]` or `[allowed by <label>]`.
  - `show` prints a Security section (status, every finding with `file:line rule message (downgraded reason)`, `blockedBy`/`allowedBy`) and works for blocked skills.
  - `install` refuses a blocked skill with exit 1, printing the rule, file and line.
  - `list`, `outdated` and `update` show `blocked` and flag status. A blocked installed copy prints `remove it with: skillseekr remove <name>[ --user]` on stderr.

- [ ] **Step 1: Write failing tests:**
  - **P2-8:** `block` by id or by hash removes the skill from `search`, and `install` exits 1. `unblock` restores it. `unblock` on a policy-include entry exits 1, naming the include. No flag lifts a block: `install --force` is not a valid option, and `allow` on a deny-blocked skill exits 1.
  - **P2-3:** `allow --yes` then `search` shows the skill as `[allowed by user]`. A wrong typed confirmation writes nothing. `allow --prune` drops a stale entry.
  - **P2-5:** labels appear in `search`, `show` and `list`.
  - The edit helpers keep comments and are idempotent where it makes sense.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: block, unblock and allow commands; security labels in the CLI`.

---

### Task 11: `skillseekr scan` and doctor checks

**Files:**
- Create: `src/scan/folders.ts`, `src/cli/commands/scan.ts`
- Modify: `src/doctor.ts`, `src/cli/main.ts`, `src/validate.ts` (skill dirs also get scan and quality findings)
- Test: `test/scan/folders.test.ts`, extend `test/cli/cli.test.ts`, `test/doctor.test.ts`, `test/validate.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ScanTarget { label: string /* e.g. "claude user", "plugin superpowers" */; dir: string /* a skills root */ }
  export function defaultScanTargets(ctx: Ctx, projectDir: string): Promise<ScanTarget[]>; // existing dirs only
  ```
- Default targets:
  - project `.claude/skills`;
  - each tool's user skills dir from `TOOL_TARGETS`, for every tool, not only those present;
  - plugin skill folders.

  Step 1 verifies the plugin locations against current docs. The starting point is Claude Code `~/.claude/plugins/` (installed plugins live under `cache/<marketplace>/<plugin>/<version>/skills/`); walk to a depth of 6 for directories named `skills`. Record the doc URLs in the `folders.ts` header. If Copilot CLI or OpenCode document a plugin skill location, add it; otherwise note it in the report.
- `skillseekr scan [dir…] [--gate critical|warning] [--json]`:
  - Each `dir` is a skill folder (it contains `SKILL.md`) or a skills root (it is walked with Phase 1 `discoverSkills(dir, '')`).
  - The scan is read-only and never writes into scanned folders. It may use the scan cache under the cache dir.
  - Output is one block per skill: status, then findings.
  - `--gate critical` exits 1 if any critical finding exists. `--gate warning` exits 1 if any finding exists. With no gate, it exits 0.
  - Plain `scan` (no catalog policy) reports scanner and quality findings only. It does not apply allow or block, because folders outside the catalog have no policy identity. *(Decision.)*
- `doctor` adds these checks:
  - `security:blocked` (warn). Lists blocked catalog skills, with the first finding or the deny reason for each.
  - `security:installed:<name>` (fail). Shown for each installed copy that is blocked, with the remove hint.
  - `policy:allow` (warn). Lists every local `allow` entry with `added` and the rules it covers. It is shown whenever any local allow entry exists.
  - `policy:ignored` (warn). Any `policy/ignored-*` problem.
  - `quality:near-duplicates` (warn). Uses `nearDuplicates` over the catalog.
  - `trust:<owner>` (ok). Shows the key count.

- [ ] **Step 1: Verify plugin skill folder locations** (WebFetch the official docs). Record what you found.
- [ ] **Step 2: Write failing tests:**
  - **P2-11:** with a temp HOME containing a claude user skill, a copilot user skill, an unmarked skill that skillseekr didn't install, and a plugin skill under `~/.claude/plugins/cache/m/p/1.0.0/skills/x/`, bare `scan` reports all four, and the mtimes of every file under HOME are unchanged. `--gate critical` exits 1 when one of them has `curl | sh`, and exits 0 when none do. `--json` output parses.
  - **P2-13:** `show`, `get_skill` and `scan` show the quality warnings for `bad/notes-v2`; `doctor` reports near-duplicates.
  - doctor shows a local allow entry with its `added` date. A blocked installed copy is a `fail` check.
  - `validate <skill-dir>` with `curl | sh` reports an error problem with code `scan/<rule-id>`.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: scan command and security, policy and quality checks in doctor`.

---

### Task 12: Setup trust flag, docs, e2e, acceptance

**Files:**
- Modify: `src/setup/setup.ts`, `src/cli/commands/setup.ts`, `README.md`, `test/e2e/stdio.test.ts`
- Create: `docs/acceptance-phase-2.md`
- Test: extend `test/setup/setup.test.ts`, `test/e2e/stdio.test.ts`

**Interfaces:**
- `setup --trust <owner>=<ed25519:key>`:
  - The flag is repeatable.
  - Setup writes `trust` with `setTrust`, merging keys for the same owner without duplicates.
  - Re-running with the same flags changes nothing (AC-10 still holds).

- [ ] **Step 1: Write failing tests:**
  - `setup --trust` writes the trust entry, and a second run makes no changes.
  - **e2e:** over real stdio against the built binary, a fake registry with one clean skill and one `curl | sh` skill. `search_skills` returns only the clean skill, and `get_skill` on the bad one returns the `blocked` shape.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Update the README:
  - security model;
  - rule table with IDs;
  - downgrade rules;
  - `block`/`allow`/`trust` config, with where each is honoured;
  - new commands (`scan`, `block`, `unblock`, `allow`, `keys create`, `sign`, `setup --trust`);
  - labels in MCP results;
  - the "pattern matching, not a sandbox" caveat;
  - the Credits section from Task 2.

  Every command and flag in the README must exist in the code.
- [ ] **Step 4: Write `docs/acceptance-phase-2.md`.** It maps P2-1 to P2-13 to the exact test file and title, or gives a manual command with the expected result. P2-6 states the agreed false-positive budget (0 blocks over `test/fixtures/legit` plus `evals/discovery/skills` plus skillyard `good/`).
- [ ] **Step 5: Run** `npm run lint && npm test`. Expected: all PASS.
- [ ] **Step 6: Commit** `feat: setup --trust, Phase 2 docs, e2e and acceptance checklist`.

---

## Self-review notes (for the plan author; already applied)

- **Spec coverage:**
  - When it runs (index time, cache by hash and rules version, installed rescans): Tasks 7 and 9.
  - What it checks (every rule group in the spec table): Task 1. The table is complete; skillyard's `remote-code` rules are split into three IDs.
  - Context-aware severity and never-downgrade: Task 1, corpus in Task 2.
  - What happens with the result: Tasks 7, 8, 10 and 11.
  - `block`: Tasks 5, 6 and 10.
  - `allow` (typed confirmation, `--list`, `--prune`, no MCP tool, labels): Tasks 5, 6, 8 and 10.
  - `scan`: Task 11.
  - Signed skills (format, keys, sign, trust from local only, rotation): Tasks 4, 5, 7 and 12.
  - Quality checks: Tasks 3 and 11.
  - Fixtures: Task 2.
- **P2 acceptance mapping:**

  | Criterion | Tasks |
  |---|---|
  | P2-1 | 7, 8, 9, 10 |
  | P2-2 | 7, 9 |
  | P2-3 | 6, 10 |
  | P2-4 | 5, 8 |
  | P2-5 | 8, 10 |
  | P2-6 | 2 |
  | P2-7 | 7 |
  | P2-8 | 6, 9, 10 |
  | P2-9 | 1, 2 |
  | P2-10 | 1 |
  | P2-11 | 11 |
  | P2-12 | 4, 7 |
  | P2-13 | 3, 11 |

- **Decisions this plan made that the spec left open:**
  - The 10 MB scan limit gives `integrity/unscannable-file`.
  - Each line is regex-tested on its first and last 4096 characters only.
  - Last-wins applies before security.
  - The `allow` confirmation is typing the skill ID.
  - `allowedBy` labels.
  - Plain `scan` doesn't apply policy.
  - The public key string format.
  - Quality thresholds: 40 characters; near-duplicate similarity ≥ 0.85; 20 MB per skill.
  - The false-positive budget is 0.
  - The starter skill and server instruction wording.
  - Installed copies aren't signature-checked, because the marker has no owner.
