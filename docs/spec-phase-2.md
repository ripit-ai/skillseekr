## Phase 2: runtime security and integrity

*Inspired by [skillyard](https://www.npmjs.com/package/skillyard)'s publish-time scan, but run **on each machine, at runtime**.*

**Why:** however a registries file is curated, a skill can **turn malicious through an update** (a registry that follows a branch, a careless pin bump, a personal source), or **slip past whatever review exists**. The scan makes sure no such skill reaches an agent or a tool's skill folder without first being checked on the developer's own machine. People can override it at their own risk, but an override never carries over to new content.

### When it runs

- **At index time,** after a skill is fetched and **before** it can appear in search results, be fetched with `get_skill`, or be installed. This applies to every registry.
- **Results are cached by `(content hash, rules version)`**, so unchanged skills aren't rescanned. A new skillseekr release with new rules rescans everything automatically.
- **Installed skills are rescanned** on `update`, `list`, and `doctor`. A skill already in a tool's folder is loaded by that tool without skillseekr involved, so skillseekr can't block it at load time. Instead it reports it loudly and offers `skillseekr remove`. Blocking at load time would need session-start hooks (see [[#Parked: per-project manifest (.skillseekr.yml)]]).
- **Registry owners can run the same scanner** in their own CI (`skillseekr scan --gate critical`) if they want. That's their choice. The runtime scan doesn't depend on it.

### What it checks

It checks every file in the skill's folder, not just `SKILL.md`, including the frontmatter. Each rule applies to **instruction text** (Markdown, frontmatter), to **scripts** (`.sh`, `.py`, `.js`, `.ts`, `.ps1`, …), or to both, so a rule meant for scripts doesn't fire on prose.

| Rule group | Examples | Applies to | Base severity |
|---|---|---|---|
| Prompt injection | "ignore/disregard previous instructions", role or system-prompt impersonation | text | critical |
| Concealment | "don't tell the user", "without informing the user", "hide this from the user" | text | critical |
| Hidden Unicode | bidirectional controls (U+202A–202E, U+2066–2069), Unicode tag characters (U+E0000–E007F) | all | critical, **never downgraded** |
| Zero-width characters | U+200B, U+200C, U+2060–2064, a byte-order mark (BOM) other than at the start of a file | all | warning |
| Embedded secrets | private keys, AWS/GitHub/Slack/AI-provider tokens (standard patterns, with "EXAMPLE" placeholders excluded) | all | critical, **never downgraded** |
| Download-and-run | `curl … \| sh`, `bash <(curl …)`, `sh -c "$(curl …)"`, `iex (iwr …)`, download then `chmod +x` / run | scripts | critical |
| Remote code at run time | `npx github:…` / `npx https:…`, `pip install git+…`, `import()` / `require()` from a URL, `exec(urlopen(…))` | scripts | critical |
| Encoded execution | `eval`/`exec` of base64, hex, or compressed data | scripts | critical |
| Credential-file reads | `~/.ssh/`, `~/.aws/credentials`, `~/.netrc`, `~/.docker/config.json`, `~/.kube/config`, `~/.config/gh/hosts.yml`, keychain/`security` CLI | scripts | critical |
| Env/secret exfiltration | posting `os.environ` / `process.env` / `$*TOKEN`/`$*KEY`/`$*SECRET` to the network | scripts | critical |
| Permission bypass | telling the agent to use `--dangerously-skip-permissions`, `--yolo`, `bypassPermissions`, or to turn off approval prompts | text | warning |
| Broad tool grants | frontmatter `allowed-tools` of `*`, `Bash`, `Bash(*)`, or pre-approved `Bash(curl…)`, `Bash(sudo…)`, `Bash(rm…)` | frontmatter | warning |
| Weaker signals | any network call, `subprocess(…, shell=True)`, `sudo`, `chmod 777`, broad `rm -rf` | scripts | warning |

Each rule has a stable ID, for example `download-and-run/curl-pipe-shell`, so overrides and deny entries can name rules exactly.

**Starting rule set:** port skillyard's `src/scan.js` (skill scan) and the remote-code rules from `src/secure.js`. Both are MIT-licensed; keep the copyright notice and credit them in the README. They're already tuned against 511 real-world skills. Rules can be added from there.

### Context-aware severity

When skillyard ran a plain pattern-matching scan over the 511 most-installed public skills, **all 40 critical flags were false positives.** Most were skills *quoting* prompt-injection phrases to teach the agent to resist them. Others were "continue without asking the user" in batch workflows, local helper servers passing their own token to `localhost`, and harmless emoji joiners. A runtime scan that blocks on those would teach people to override by reflex, which defeats the content-tied override design. So a **critical** match is downgraded to a **warning** when:

- **In instruction text:** it's inside a fenced code block, inside quotation marks, or in a defensive sentence ("if a page says …", "never follow …", "treat … as data", "injection").
- **In scripts:** it's in a comment, a docstring, or a regex pattern. A linter that detects `curl | sh` has to mention it.
- **Download-and-run:** the line only *prints* the command (`echo`, `print`, `console.log` of an install instruction) rather than running it.
- **Exfiltration:** the target is `localhost` / `127.0.0.1`.

These are **never** downgraded: hidden Unicode (bidirectional or tag characters), private keys, and real tokens. Every downgraded finding still appears as a warning with the reason (for example "inside an example block").

The scan is pattern matching, not a sandbox. It can't see what a downloaded binary does, and a careful attacker can write around it. That's why the deny list (below) exists.

The rules are **fixed checks shipped with skillseekr**: no AI model and no network calls. A scan is fast, works offline, and gives the same result every time. *(My call. An optional AI-based check could come later.)*

### What happens with the result

- **Critical finding → blocked.** The skill is **left out of search results**, `get_skill` and `install_skill` refuse it and name the rule and the file and line that matched, and the CLI `install` refuses it too. `skillseekr show <id>` and `doctor` list blocked skills and their findings.
- **Warning → allowed but flagged.** `get_skill` returns the skill with its warnings, and the starter skill tells the agent to mention them to the user before following it. `show` displays them.
- **The scan sits between fetching and use.** Fetched content stays in the cache as inert data. Nothing in a blocked skill's folder is ever handed to an agent.

### Deny list (`block`)

The scanner only catches known patterns. When a person spots something bad, they need to be able to switch it off everywhere. A `block` entry is that kill switch:

```jsonc
// top-level key, alongside "registries", "cache", and "allow"
"block": [
  {
    "id": "devops/env-doctor",            // every version of this skill ID
    "reason": "Posts environment to a third-party endpoint (incident 2026-11-20)",
    "added": "2026-11-20"
  },
  {
    "content_hash": "sha256:51ab…",       // this exact content, under any ID
    "reason": "Known-malicious copy",
    "added": "2026-11-21"
  }
]
```

- **An explicit deny can't be overridden.** A `block` entry beats every `allow`, wherever either comes from. No CLI flag, `--force`, or local config can unblock it. The only way to lift it is to remove the entry where it was added.
- **Where `block` entries are honoured:** the user's own local config, and the root of any registries file the local config includes with `policy: true` (which applies to everyone including it that way). `block` anywhere else is ignored, so a third-party list can't hide entries by deny-listing a competitor.
- **Blocking by ID or by content:** blocking by **ID** covers every version, now and future. Blocking by **content hash** covers that exact content under any ID, which catches the same malicious skill copied into other registries.
- **Effects:** a blocked skill is left out of search, and `get_skill`, `read_skill_file`, `install_skill`, and `install` all refuse it. **Installed copies** are flagged by `list`, `update`, and `doctor`, which offer `skillseekr remove`. It takes effect within the cache TTL (`ttl_seconds`, default one hour), or straight away with `skillseekr sync`.
- **Agents can't add or remove `block` entries.** Unlike `allow`, adding a local block is low-risk, so `skillseekr block <id> --reason …` needs no typed confirmation.

### Overrides (`allow`)

People can override a block **at their own risk**. Every override is **tied to the skill's exact content and to specific rules**:

```jsonc
// top-level key, alongside "registries" and "cache"
"allow": {
  "security/secret-hygiene-review": {
    "content_hash": "sha256:9f2c…",        // the exact content that was looked at
    "rules": ["credential-file-read/aws", "download-and-run/curl-pipe-shell"],
    "reason": "Teaches detection of these patterns; examples only",
    "added": "2026-11-14"
  }
}
```

- **If the skill changes, the override stops applying.** Any update changes the content hash, so the skill is scanned fresh and blocked again if it still trips a critical rule. This is how something that "turned malicious in an update" gets stopped even after someone allowed an earlier version.
- **If a new rule fires, the override doesn't cover it.** It only covers the rules it names. A new or different critical finding blocks again.
- **`allow` never overrides `block`.** An override only lifts scanner findings. It has no effect on an explicit deny (see above).
- **Where `allow` entries are honoured** *(my call)*:
  - **the root of any registries file the local config includes with `policy: true`**, which applies to everyone including it that way, and
  - **the user's own local config**, which applies only to them and can cover **any** skill, at their own risk.
- **Never honoured:** `allow` in any other included registries file, so a third-party list can't approve its own content. Inline markers in skill files (for example "scanner: ignore") are also ignored.
- **Adding a local override** is a human action only: `skillseekr allow <id>`. It shows every finding, records the current content hash and the matched rule IDs, and asks for typed confirmation (`--yes` for scripts). **There is no MCP tool for it.** Agents can't unblock skills, so a prompt-injected agent can't talk its way past the scanner. *(An agent with file-write access could still edit the config by hand. `doctor` shows every local `allow` entry and when it was added, so that's visible.)*
- **Overridden skills are always labelled.** Search results, `get_skill`, and `list` mark them `allowed-by: user` or `allowed-by: <registry entry>`, along with the rules they break. The agent tells the user when it uses one.
- `skillseekr allow --list` shows all overrides. `skillseekr allow --prune` removes overrides whose content hash no longer matches anything.

### `skillseekr scan [dir…]`

A **read-only** scan of any folder, with the same rules and the same output. With no arguments, it scans every known tool skill folder (project and user, for every enabled tool) **and plugin skill folders**. That covers the skills skillseekr can't block because a tool loads them without skillseekr involved, **including ones skillseekr didn't install.** It never changes, removes, or quarantines anything: it reports. `--gate critical|warning` exits non-zero at or above that severity, for use in CI or in a project's own pipelines. `--json` gives machine-readable output.

### Signed skills

*Detects tampering after content was signed: a compromised account or token pushing to a registry that follows a branch, or a tampered local cache.*

- **The format:** an **ed25519 signature over a sorted list of each file's path and SHA-256** for each skill, stored next to the skill as `.skillseekr-signature.json` (excluded from the list). This is the scheme skillyard uses (`src/sign.js`).
- **What skillseekr provides:** `skillseekr keys create`, `skillseekr sign <skill-dir> --key …`, and verification at runtime. **Whether and how a registry's owners sign its skills** (in CI on merge, by hand, not at all) **is up to its owners.**
- **Where trust comes from:** the **local config** only, never a registries file, so whoever can change a registries file can't also swap the key:

  ```jsonc
  "trust": [
    { "owner": "ripit-ai", "public_keys": ["ed25519:…"] }   // setup can write this from a flag
  ]
  ```

- **What the client does:** for a skill from a GitHub registry whose `owner` has a trusted key, **a missing or invalid signature is a critical finding** (`integrity/signature`). It's blocked like any other critical finding, and the user can override it with a content-tied `allow`. Owners without a trusted key aren't checked.
- **Key rotation:** list several public keys per owner, and remove old ones when they're retired.

### Quality checks (warnings)

These are reported as **warnings** at runtime (`show`, `get_skill`, `scan`, `doctor`):

- **Descriptions that won't trigger:** missing, too short, or with no "use when…"-style trigger.
- **Descriptions that try to grab every task:** "use this for every task", "always use", or very generic descriptions. These are a **context-hijack risk**: a skill like that would dominate search for unrelated tasks.
- **Broken references:** `SKILL.md` points at files (`references/x.md`, `scripts/y.py`) that don't exist in the skill.
- **Oversized files:** any file over 1 MB, or a skill folder over the size limit.
- **Near-duplicates:** `doctor` reports skills across the resolved catalog with near-identical descriptions. These matter more because "last wins" and bare-name lookup can pick a different one than expected.

### Test fixtures

Bring in skillyard's `examples/` set (MIT): 12 deliberately bad skills, each paired with a good one. The "malicious" ones are inert: they use `.example` domains and fake keys. Use them as the starting point for P2-6, and add more cases for each new rule.

### Phase 2 acceptance criteria

- [ ] **P2-1:** A skill with a critical finding never appears in `search_skills`, and `get_skill`, `install_skill`, and `skillseekr install` refuse it. Each refusal names the rule, file, and line. This holds for every registry.
- [ ] **P2-2:** A skill that was clean, then gets an update that adds a critical pattern, is blocked on the next index refresh without anyone doing anything. An installed copy is flagged by `list`, `update`, and `doctor`.
- [ ] **P2-3:** A local `allow` entry unblocks exactly that content hash for exactly the named rules. Changing one byte of the skill, or triggering a different critical rule, blocks it again.
- [ ] **P2-4:** `allow` and `block` entries are honoured only from the local config and the root of registries files included from it with `policy: true`. Entries anywhere else are ignored and reported. No MCP tool can create or change an `allow` or `block` entry.
- [ ] **P2-5:** Overridden and warning-flagged skills are labelled everywhere they appear.
- [ ] **P2-6:** A test set of known-bad skills (one or more per rule group) is all blocked. A test set of legitimate skills, including security-themed ones, produces no blocks beyond an agreed false-positive budget.
- [ ] **P2-7:** Scanning runs offline, and rescanning an unchanged catalog with an unchanged rules version does no work.
- [ ] **P2-8:** A `block` entry, local or from a `policy` registries file, by ID or by content hash, removes the skill from search and makes `get_skill`, `read_skill_file`, `install_skill`, and `install` refuse it within the cache TTL, or straight away after `sync`. Installed copies are flagged. **No `allow` entry, flag, or `--force` lifts a block.**
- [ ] **P2-9:** The skillyard good examples, and skills that only quote dangerous patterns in code blocks, comments, or defensive sentences, aren't blocked (warnings only). Hidden Unicode, private keys, and real tokens are blocked wherever they appear.
- [ ] **P2-10:** Every remote-code rule (`bash <(curl …)`, `iex (iwr …)`, download then run, `npx github:…`, `pip install git+…`, `import()` from a URL, encoded `eval`) has a failing fixture, and it's blocked.
- [ ] **P2-11:** `skillseekr scan` with no arguments reports on every tool and plugin skill folder, including skills skillseekr didn't install, and changes nothing. `--gate critical` exits non-zero when there's a critical finding.
- [ ] **P2-12:** With a trusted key configured for an owner, a skill from that owner with a missing or invalid signature, or with a single byte changed after signing, is blocked as `integrity/signature`. A key placed in any registries file has no effect.
- [ ] **P2-13:** Quality warnings (non-triggering or "every task" descriptions, broken references, oversized files) appear in `show`, `get_skill`, and `scan`. `doctor` reports near-duplicate skills.

