# skillseekr

skillseekr lets coding agents (Claude Code, OpenCode, GitHub Copilot) find and fetch [Agent Skills](https://agentskills.io) on demand from any number of skill registries. You can do the same by hand with the `skillseekr` CLI.

It ships as a CLI plus a stdio MCP server (`skillseekr mcp`). Nothing is installed into a tool's skill folders until someone asks for it.

This README is for developers who install and use skillseekr, and for registry owners. The design is in [docs/spec.md](docs/spec.md).

## Install

Requires Node 20 or later.

```sh
npm i -g github:ripit-ai/skillseekr
# or, with Volta
volta install github:ripit-ai/skillseekr
```

Installing from GitHub runs the `prepare` script (`tsc`), so it builds `dist/` on your machine.

> **npm name:** the package is not published to npm yet. The npm name `skillseekr` should be registered as a placeholder so nobody else takes it. Until then, install from GitHub as above.

## Set up your tools

```sh
skillseekr setup
```

`setup` finds the tools on your machine, shows exactly what it will change, asks `Apply these changes? [Y/n]`, and applies it. It then runs `doctor`. Flags:

- `--yes`: apply without asking (needed when there is no terminal).
- `--tools <list>`: limit to some of `claude,opencode,copilot,vscode`. The default is every tool found.
- `--registry <owner/repo>`: the registries file a new config points at (default `ripit-ai/agent-skills`).
- `--vscode-workspace <dir>`: write `<dir>/.vscode/mcp.json` instead of VS Code's user `mcp.json` (see below).
- `--trust <owner>=<ed25519:key>`: add a trusted signing key for a registry owner to your local config (repeatable; see [Signed skills](#signed-skills)). A bad key exits 1 and writes nothing. Keys for the same owner are merged without duplicates, and running setup again with the same flags changes nothing.

What it changes, per tool. A tool is only touched when it is detected.

| Tool | MCP server registration | Starter skill |
|---|---|---|
| Claude Code | Preferred: `claude plugin marketplace add ripit-ai/skillseekr`, then `claude plugin install skillseekr@skillseekr --scope user`. Fallback if the plugin commands are missing or fail: `claude mcp add --scope user skillseekr -- skillseekr mcp` | Bundled in the plugin. Only with the `claude mcp add` fallback does setup copy it to `~/.claude/skills/skillseekr/` |
| OpenCode | `mcp.skillseekr` (`type: "local"`, `command: ["skillseekr", "mcp"]`, `enabled: true`) in `~/.config/opencode/opencode.json` (or `opencode.jsonc` if that is the file you have). Works with OpenCode v1 and v2 config; an existing entry in either shape counts as registered | `~/.config/opencode/skills/skillseekr/` |
| Copilot CLI | `mcpServers.skillseekr` in `~/.copilot/mcp-config.json` | `~/.copilot/skills/skillseekr/` |
| VS Code (Copilot) | `servers.skillseekr` in VS Code's user `mcp.json`. Local: `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%/Code/User/mcp.json` (Windows), `$XDG_CONFIG_HOME/Code/User/mcp.json` (Linux; `~/.config/Code/User/mcp.json` when `XDG_CONFIG_HOME` is unset), only if that folder exists. Remote (VS Code Server): `~/.vscode-server/data/User/mcp.json`, only if `~/.vscode-server` exists | none |

Plus, if there is no config yet, `~/.config/skillseekr/config.jsonc` with one entry for the default organizational registries file (mode `0600`).

Notes:

- **Idempotent.** A second run finds everything registered and reports `nothing to change`. It never overwrites an entry you edited or a disabled Claude plugin (`doctor` warns about a disabled plugin instead).
- Edits to JSON files keep your comments and other keys, and write a backup first (shown in the preview).
- The starter skill is only written to folders skillseekr owns. A folder with the same name but no skillseekr marker, or with local edits, is left alone.
- **VS Code remote path is unconfirmed.** VS Code documents remote user-level MCP config but not where it lives on disk. `~/.vscode-server/data/User/mcp.json` is inferred from VS Code Server's data folder layout. If your remote window doesn't pick it up, run `skillseekr setup --tools vscode --vscode-workspace <project>`, which writes `<project>/.vscode/mcp.json`, a file VS Code documents and reads in remote windows.

## Config

The config is JSONC (comments and trailing commas are fine), in the [skills-mcp](https://github.com/afriemann/skills-mcp) format, plus two registry types for including other registries files. Its location, on all platforms including macOS:

1. `$SKILLSEEKR_CONFIG`, else
2. `$XDG_CONFIG_HOME/skillseekr/config.jsonc`, else
3. `~/.config/skillseekr/config.jsonc`

Any command also takes `--config <path>` for one run.

```jsonc
{
  "registries": {
    "ripit-ai": {
      "type": "github-registry",
      "owner": "ripit-ai", "repo": "agent-skills", "ref": "main",
      "policy": true,
      "auth": { "type": "gh_cli" }
    },
    // Personal additions go below; they are resolved after the entry above.
    "my-skills": {
      "type": "github",
      "owner": "me", "repo": "skills", "skills_dir": "skills", "ref": "main"
    }
  },
  "cache": { "enabled": true, "ttl_seconds": 3600, "dir": "~/.cache/skillseekr" }
}
```

### Registry types

| Type | Fields | Meaning |
|---|---|---|
| `github` | `owner`, `repo`, `skills_dir` (`""` = repo root), `ref`, optional `description`, `instructions`, `auth`, `cache_enabled` | A repo of skills. A folder is a skill if it directly contains `SKILL.md`; skills may be nested at any depth |
| `http` | `url` (direct link to a `SKILL.md`), `skill_name`, optional `description`, `instructions`, `auth`, `cache_enabled` | A single skill |
| `github-registry` | `owner`, `repo`, `ref`, optional `path` (default `registries.jsonc`), `description`, `auth`, `policy`, `cache_enabled` | A JSONC registries file in a repo, listing more registries |
| `http-registry` | `url` (direct link to the file), optional `description`, `auth`, `policy`, `cache_enabled` | The same, at a URL |

`github` and `http` are the skills-mcp types, unchanged. The two `*-registry` types are the includes. Includes nest up to 5 levels deep (the local config is level 0). Loops are skipped and reported.

`policy: true` only counts on entries in your local config (it is ignored inside included files). A policy include's own top-level `block` and `allow` are honoured (see [Security](#security)).

### Auth

| `auth` | Meaning |
|---|---|
| omitted or `{ "type": "none" }` | no authentication |
| `{ "type": "gh_cli" }` | token from `gh auth token`, sent only to the GitHub API host |
| `{ "type": "github_token", "env_var": "NAME" }` | token read from the environment variable `NAME` |
| `{ "type": "bearer", "env_var": "NAME" }` | bearer token for HTTP sources, read from `NAME` |
| `{ "type": "basic", "username_env_var": "U", "password_env_var": "P" }` | basic auth from two variables |

`env_var` is the name of a variable, never the token.

`skillseekr registries add --auth` offers `none`, `gh_cli`, `github_token` and `bearer`. For `basic`, add the entry and then edit its `auth` in the config file by hand.

A failed `gh auth token` is retried after 30 seconds, so a running MCP server picks up a later `gh auth login` without a restart.

**Include auth restriction.** A registries file reached through an include may use only `gh_cli` or no auth. Entries in it with `github_token`, `bearer` or `basic` are skipped and reported, and the variables they name are never read. Otherwise an included list could name `AWS_SECRET_ACCESS_KEY` and send it to a URL of its choosing. Those three auth types work only in your own local config.

### Cache, TTL and SHA pinning

- Cache folder: `cache.dir` (`~` expanded), else `$XDG_CACHE_HOME/skillseekr`, else `~/.cache/skillseekr`. Mode `0700`.
- A `ref` that is a commit SHA (7 to 40 hex characters) is immutable and never re-checked.
- Any other ref (branch or tag) and every `http` source is re-checked after `ttl_seconds` (default 3600). `skillseekr sync` ignores the TTL once.
- A running MCP server reloads its catalog when the config file changes or when `skillseekr sync` runs in another process (sync rewrites `<cache dir>/state/generation`). A load that had errors (for example an unreachable registry) is retried after at most 60 seconds, whatever the TTL.
- `cache.enabled: false`, or `cache_enabled: false` on one registry, means a TTL of 0: re-check on every load. Fetched trees are still stored, because skills are served from disk.
- Only the local config's `cache` section is used; a `cache` section in an included file is ignored.

To pin a registry for reproducible skills, set `ref` to a full commit SHA.

### Resolution: "last wins" and `via`

1. Entries are walked in file order. An include is replaced by the registries in its file, depth first.
2. The result is one flat list of `github` and `http` registries.
3. Two registries with the same name: the last one wins.
4. Skills are indexed per registry. A skill ID is its slash-separated path relative to `skills_dir` (for `http`, the `skill_name`). A nested skill folder inside another skill folder is not indexed separately.
5. Two skills with the same ID: the later registry wins. Same name at different paths are different skills.

Every override is recorded. All of them (registry-name and skill-ID overrides) are shown by `registries`, `doctor` and the `list_registries` tool; a skill's own override (what it replaced) is shown by `search`, `show` and the `search_skills` and `get_skill` tools. Every skill also carries `via`, the chain of entry names from your config down to its registry, for example `ripit-ai → data-team → data-skills`, shown by `search`, `show`, `list`, `outdated` and the `search_skills`, `get_skill` and `list_installed` tools. Since later entries win, put personal registries after the org entry to override org skills, or before it to let the org win.

A bare skill name works wherever an ID does, if exactly one skill has that name. If several do, you get the list of IDs to choose from.

## CLI

`--config <path>` works on every command. `--json` (machine-readable output) works on every command except `mcp`, which speaks MCP on stdio.

| Command | What it does |
|---|---|
| `skillseekr setup [--tools <list>] [--yes] [--registry <owner/repo>] [--vscode-workspace <dir>] [--trust <owner>=<ed25519:key>]` | Config, MCP registration and starter skill for each tool found, then `doctor` |
| `skillseekr search <query...> [--limit <n>]` | Search the resolved catalog (default 10 results). Each row shows ID, registry, `via`, description, and `[overrides <registry> (via …)]` when the skill replaced another |
| `skillseekr show <skill>` | Metadata, registry, `via`, overrides, file list and `SKILL.md` (a `SKILL.md` over 1 MB is shown as its size and path instead) |
| `skillseekr install <skill> [--user]` | Copy a skill into `<project>/.claude/skills/` (default), or with `--user` into the personal skill folder of every detected tool |
| `skillseekr remove <name> [--user]` | Remove an installed skill. Only folders skillseekr installed |
| `skillseekr list [--user]` | Installed skills with registry, `via`, and whether each is current |
| `skillseekr outdated [--user]` | Installed skills that are not current |
| `skillseekr update [name] [--force] [--user]` | Update installs from the catalog. Locally edited installs are skipped unless `--force`. An install whose ID is no longer in the catalog (removed or moved to another path) is reported as `missing-from-catalog`. If one install fails, the rest still update; the failure is printed to stderr and the exit code is 1 |
| `skillseekr registries` | The resolved registry list. NOTES shows `overrides <registry> (via …)` when a registry replaced another of the same name, and an `override:` line follows for every registry or skill override |
| `skillseekr registries add <name> --type <type> ...` | Add a registry to your config, keeping comments. Options: `--owner --repo --ref --skills-dir --path --url --skill-name --description --auth <none\|gh_cli\|github_token\|bearer> --env-var <NAME>` (`basic` auth is set by editing the config) |
| `skillseekr registries remove <name>` | Remove a registry from your config, keeping comments |
| `skillseekr sync` | Re-check every registry now, ignoring the TTL |
| `skillseekr block [id] --reason <text> [--hash <sha256:…>]` | Deny a skill by ID, or one exact content hash under any ID, in your local config |
| `skillseekr unblock [id] [--hash <sha256:…>]` | Remove a local block entry |
| `skillseekr allow [id] [--reason <text>] [--yes] [--list] [--prune]` | Override a scanner block for one skill's exact content and rules. Needs a reason and a typed confirmation (`--yes` skips it). `--list` shows every entry, `--prune` drops local entries that match nothing |
| `skillseekr scan [dir...] [--gate critical\|warning]` | Read-only scan of folders (default: project, tool and plugin skill folders). `--gate` exits 1 on a critical finding (`critical`) or on any finding (`warning`) |
| `skillseekr keys create --out <dir> [--force]` | Create an ed25519 key pair (`skillseekr-private.pem`, `skillseekr-public.txt`) |
| `skillseekr sign <skill-dir> --key <pem>` | Write `.skillseekr-signature.json` into a skill folder |
| `skillseekr doctor` | Check the config, registries, auth, includes, overrides, tool registration and skill folders, plus blocked skills, local `allow` entries, near-duplicates, trust keys, policy problems and installed copies |
| `skillseekr validate [path]` | Check a skill folder or a registries `.json`/`.jsonc` file (default: current folder) |
| `skillseekr mcp` | Run the MCP server on stdio (the tools call this, not people) |

Installed skills carry a `.skillseekr.json` marker (`id`, `name`, `registry`, `via`, `ref`, `sha`, `contentHash`, `installedAt`). skillseekr never changes or deletes a skill folder without one.

Skills install by `name`, one folder deep, because tools only load skills one level down. If two different IDs would install under the same name in the same scope, the install is refused.

## MCP tools

Agents get exactly these tools from `skillseekr mcp`:

| Tool | Input | Use |
|---|---|---|
| `search_skills` | `query`, optional `limit` | Find skills (metadata only) |
| `get_skill` | `skill` (ID or unique name) | `SKILL.md` body, file list, cached folder path, registry, `via`, overrides. A `SKILL.md` over 1 MB comes back as `skillMd: {kind: "too_large", size, path}` instead of `body`. Installs nothing |
| `read_skill_file` | `skill`, `path` | A supporting file. `..`, absolute paths and symlinks are refused; large or binary files return metadata |
| `install_skill` | `skill`, optional `scope` (`project` or `user`) | Install, only when the user asks or agrees. Returns the install folders and the tools that will load it (all three for `project`) |
| `list_installed` | optional `scope` | Installed skills with `registry`, `via` and status |
| `list_registries` | none | The resolved registries with `via`, SHA and what each replaced (`overrode`), plus every registry and skill override |

Agents cannot remove skills, edit registries, or create or change `allow`, `block` or `trust`; those stay with you, in the CLI and the config file.

Security labels in results:

- `search_skills` hits and `get_skill` carry a `security` field: `status` (`clean`, `warned` or `allowed`), plus `allowedBy` (`user`, or the policy include's name) when an `allow` applies. `get_skill` also lists the `warnings` (and `allowedRules` for an allowed skill). `list_installed` reports the `security` status of each installed copy.
- A blocked skill is missing from `search_skills`. `get_skill`, `read_skill_file` and `install_skill` return an error result (`isError: true`) shaped like this:

```json
{
  "error": "blocked",
  "id": "devops/installer",
  "blockedBy": { "kind": "scan", "rules": ["download-and-run/curl-pipe-shell"] },
  "findings": [
    { "rule": "download-and-run/curl-pipe-shell", "file": "scripts/x.sh", "line": 1, "message": "downloads and runs remote code" }
  ]
}
```

  For a `block` entry, `blockedBy.kind` is `deny`, `findings` may be empty, and a `reason` field carries the entry's reason.

## Offline and stale behaviour

If a registry can't be reached, skillseekr uses its last good cache and says so: results carry a `stale` flag and the CLI prints a warning. A registry that has never been fetched is reported by `doctor` and skipped; the others still load. A private repo with `gh` missing or logged out is reported by registry name, with a hint to run `gh auth login`.

With no config, or a broken one, the CLI and MCP server still start. `doctor` reports the problem with the file path, and MCP tools return an error result explaining it.

## Security

skillseekr scans every skill on your machine, when it is indexed and before any agent or tool can use it. A skill that passes review today can turn bad through an update (a registry that follows a branch, a careless pin bump, a personal source), so the check runs at runtime, on each machine.

**Threat model.** Registry content is untrusted. The scan stops a skill that tries to hijack the agent (prompt injection, hiding actions from you), run downloaded code, read your credentials, or leak your environment. You can override it at your own risk, but an override never carries over to new content. It is not a sandbox (see [Known limits](#known-limits)).

**What is scanned.** Every file in the skill folder, including `SKILL.md` frontmatter. Binary files (a NUL byte in the first 8 KB) are skipped, except `SKILL.md`, Markdown and script files, which are always scanned. A regular file over 10 MB, a skill whose files together go over the 12 MB scan budget, or a file that cannot be read gives the critical finding `integrity/unscannable-file`. The rules are fixed checks shipped with skillseekr: no AI model and no network calls, so a scan is fast, offline and gives the same result every time. Results are cached by content hash and rules version in `<cache>/scan/<version>/`.

**What happens with the result.**

- A **critical** finding blocks the skill. It is left out of search, and `get_skill`, `read_skill_file`, `install_skill` and `skillseekr install` refuse it, naming the rule, file and line. `show` and `doctor` list blocked skills with their findings.
- A **warning** allows the skill but labels it everywhere it appears (`search`, `show`, `list`, `get_skill`). The starter skill tells the agent to mention warnings to you before following the skill.
- Installed copies are rescanned by `list`, `update` and `doctor`. A skill already in a tool's folder is loaded by that tool without skillseekr, so it can only be reported, with a hint to run `skillseekr remove`. `update` never installs blocked content.

### Rules

Targets: `text` is Markdown, frontmatter and every non-script text file; `script` is `.sh .bash .zsh .py .js .mjs .cjs .ts .rb .pl .ps1`, files starting with `#!`, `Makefile`, `.envrc`, `justfile` and `package.json`; `all` is both; `frontmatter` checks each tool in `allowed-tools` or `tools`. A `script` rule never fires on text, and a `text` rule never fires on scripts.

| Rule ID | Severity | Applies to |
|---|---|---|
| `prompt-injection/override-instructions` | critical | text |
| `prompt-injection/role-impersonation` | critical | text |
| `concealment/hide-from-user` | critical | text |
| `hidden-unicode/bidi-or-tag` (never downgraded) | critical | all |
| `zero-width/invisible-char` | warning | all |
| `secrets/private-key` (never downgraded) | critical | all |
| `secrets/aws-key` (never downgraded) | critical | all |
| `secrets/github-token` (never downgraded) | critical | all |
| `secrets/slack-token` (never downgraded) | critical | all |
| `secrets/ai-key` (never downgraded) | critical | all |
| `download-and-run/curl-pipe-shell` | critical | script |
| `download-and-run/fetch-and-exec` | critical | script |
| `download-and-run/download-then-run` | critical | script |
| `download-and-run/instructed` | warning | text |
| `remote-code/remote-package` | critical | script |
| `remote-code/url-import` | critical | script |
| `remote-code/exec-url` | critical | script |
| `encoded-exec/eval-decoded` | critical | script |
| `credential-read/home-credentials` | critical | script |
| `credential-read/keychain` | critical | script |
| `exfiltration/env-to-network` | critical | script |
| `permission-bypass/skip-permissions` | warning | text |
| `broad-tools/allowed-tools` | warning | frontmatter |
| `weak/network-call` | warning | script |
| `weak/shell-true` | warning | script |
| `weak/sudo` | warning | script |
| `weak/broad-rm` | warning | script |
| `weak/chmod-777` | warning | all |

Other finding IDs: `integrity/unscannable-file` and `integrity/signature` (both critical, never downgraded), and the quality warnings `quality/description-missing`, `quality/description-short`, `quality/description-no-trigger`, `quality/description-hijack`, `quality/broken-reference`, `quality/oversized-file` (over 1 MB) and `quality/oversized-skill` (over 12 MB in total). `doctor` also reports near-duplicate descriptions across the catalog. `download-and-run/instructed` is a warning, not a block: a skill that tells the agent to run `curl … | sh` is surfaced without blocking it.

A weak-signal warning is dropped when a stronger rule matched the same line. Rules are ported from [skillyard](https://github.com/agentwik-labs/skillyard) (see [Credits](#credits)).

### Downgrades

When skillyard scanned the 511 most-installed public skills, every critical flag from plain pattern matching was a false positive: skills quoting injection phrases to teach the agent to resist them. So a critical match becomes a **warning**, with a reason, in these contexts:

| Reason shown | When |
|---|---|
| `inside an example block` | text: inside a closed fenced code block (an unclosed fence at the end of the file does not count) |
| `in quotation marks` | text: the match sits inside a quotation that opens before it and closes after it on the same line |
| `in a defensive sentence` | text: a defensive phrase ("if a page says…", "never follow…", "treat … as data") earlier in the same sentence |
| `in a comment, docstring or pattern` | scripts: a whole-line comment, a bare Python docstring, or a string passed directly to a regex call (Python, JS, TS) |
| `only prints the command` | download-and-run: the line only prints the command (`echo`, `print`, `console.log`) and does not redirect or pipe it |
| `target is localhost` | exfiltration: the target is a literal `localhost` or `127.0.0.1` URL, with no other possible target on the line |

Never downgraded: `hidden-unicode/*`, `secrets/*` and `integrity/*`. Inline markers in skill files (such as "scanner: ignore") are ignored. A `SKILL.md` whose frontmatter is not strict YAML (for example an unquoted `: ` in the description) is still read, with a warning.

### Block, allow and trust

All three live in your local config, next to `registries`:

```jsonc
{
  "registries": { /* … */ },

  // Deny list. One of "id" (every version of that skill) or "content_hash" (that exact content, under any ID).
  "block": [
    { "id": "devops/env-doctor", "reason": "Posts environment to a third party", "added": "2026-11-20" },
    { "content_hash": "sha256:51ab…", "reason": "Known-malicious copy", "added": "2026-11-21" }
  ],

  // Overrides, keyed by skill ID, tied to the exact content and to the rules named.
  "allow": {
    "security/secret-hygiene-review": {
      "content_hash": "sha256:9f2c…",
      "rules": ["credential-read/home-credentials", "download-and-run/curl-pipe-shell"],
      "reason": "Teaches detection of these patterns; examples only",
      "added": "2026-11-14"
    }
  },

  // Trusted signing keys per registry owner.
  "trust": [
    { "owner": "ripit-ai", "public_keys": ["ed25519:…"] }
  ]
}
```

| Key | Honoured in | Ignored (and reported by `doctor`) in |
|---|---|---|
| `block` | your local config; the top level of a registries file included directly from it with `policy: true` | every other included file (`policy/ignored-block`) |
| `allow` | the same two places | every other included file (`policy/ignored-allow`) |
| `trust` | your local config only | every included file, policy or not (`policy/ignored-trust`) |

- **`block` beats everything.** No `allow`, flag or `--force` lifts it; remove the entry where it was added. A change to your local config takes effect on the next catalog load, without `sync`. A change in a policy include follows the cache TTL, or `skillseekr sync`. `skillseekr block <id> --reason …` needs no confirmation.
- **`allow` is tied to content.** It applies only when `content_hash` equals the skill's current hash and `rules` covers every critical rule found. After any update the skill is scanned fresh, and blocked again if it still trips a critical rule. `skillseekr allow <id>` shows every finding, then asks you to type the skill ID (`--yes` for scripts). Allowed skills are labelled `allowed by user` (or the include's name). `doctor` lists every local `allow` with its date.
- **No MCP tool creates, changes or removes `allow`, `block` or `trust`.** A prompt-injected agent cannot unblock a skill. (An agent with file-write access could edit the config by hand, which is why `doctor` lists the entries.)

### Signed skills

Signing detects tampering after content was signed, such as a compromised account pushing to a registry that follows a branch, or a tampered local cache. Whether and how a registry signs its skills is up to its owners.

```sh
skillseekr keys create --out ./keys          # prints the public key, ed25519:…
skillseekr sign ./skills/my-skill --key ./keys/skillseekr-private.pem
skillseekr setup --trust ripit-ai=ed25519:…  # on each machine that should check it
```

The signature is ed25519 over the sorted list of each file's path and SHA-256, stored as `.skillseekr-signature.json` in the skill folder (it and `.skillseekr.json` are not part of the list). For a skill from a `github` registry whose `owner` (case-insensitive) has a trusted key, a missing or invalid signature, a signature by another key, or a changed byte is the critical finding `integrity/signature`. Only a content-tied `allow` overrides it. Owners without a trusted key are not checked. To rotate, list several keys for the owner and remove the old one later.

### Commands

`block`, `unblock`, `allow`, `scan`, `keys create`, `sign` and `setup --trust` are in the [CLI table](#cli). Registry owners can run `skillseekr scan --gate critical` in their own CI; the runtime scan does not depend on it.

### Known limits

- **Pattern matching is not a sandbox.** The scan cannot see what a downloaded binary does, and a careful attacker can write around it. That is what `block` is for.
- **Self-extraction.** A script can read its own comment, docstring or pattern text back and run it (`exec(open(__file__).read())`, `os.system(P.pattern)`). Because scripts downgrade matches in comments, docstrings and patterns, this cannot be closed by pattern scanning. Cheap guards remove the downgrade where a file visibly reads such text back (`__doc__`, `getattr`, `globals(`, `.pattern`, `.source` and similar), and the scanner stops downgrading in a file that holds a construct it cannot follow. A lexer bug that disguises executable code as a comment is a defect.
- **A download and its run on two lines.** `curl -o x URL` on one line and `sh x` on the next are not linked. A command wrapped over lines with a trailing `\`, `|` or `&&` is joined and checked.
- **Long lines.** Rules run on whole logical lines in linear time, so a long line is not cut into windows. The defensive-sentence check looks back at most 4096 characters before a match, and a line with more than 16 matches of one text rule is treated as critical rather than judged.
- **The scan cache is a trust boundary.** A cached result is accepted by content hash and rules version, with a check that it belongs to that hash. Anyone who can write to the cache folder can plant a clean verdict. Keep it user-private (it is created with mode `0700`).
- **Installed copies are not signature-checked.** The install marker does not record the owner, so `list`, `update` and `doctor` rescan installed copies for scan findings and `block` entries only. Signatures are checked when a skill is indexed.

### Other safeguards

- Fetched content is untrusted data. skillseekr only downloads, extracts and indexes it. It never runs anything from a registry.
- Tarball entries and skill file paths are checked: nothing is written or read outside the cache or skill folder (`..`, absolute paths, symlinks and hard links are refused).
- Auth types that name environment variables are honoured only in your local config. `gh_cli` tokens go only to the GitHub API host.

## Claude Code plugin and marketplace

This repo is also a Claude Code plugin marketplace named `skillseekr`, holding one plugin, `skillseekr`, which bundles the MCP server (`skillseekr mcp`) and the starter skill. `setup` installs it for you; by hand:

```sh
claude plugin marketplace add ripit-ai/skillseekr
claude plugin install skillseekr@skillseekr
```

The plugin only runs the `skillseekr` command, so the CLI must be installed and on `PATH`. Files:

- `.claude-plugin/marketplace.json`: marketplace `name`, `owner`, `plugins[]` (`name`, `source`, `description`).
- `plugins/skillseekr/.claude-plugin/plugin.json`: plugin `name`, `version` (kept equal to `package.json`), `description`.
- `plugins/skillseekr/.mcp.json`: the `skillseekr` MCP server.
- `plugins/skillseekr/skills/skillseekr/SKILL.md`: the starter skill, a byte-identical copy of `assets/starter-skill/SKILL.md` (a test enforces this).

Schemas checked 2026-11-14 against https://code.claude.com/docs/en/plugin-marketplaces and https://code.claude.com/docs/en/plugins-reference. Run `claude plugin validate .` to check them.

## For registry owners

A registries file is a JSONC file with a `registries` object in the format above, included with `github-registry` or `http-registry`. Run `skillseekr validate <file-or-skill-folder>` in CI to check format, resolution, loops and the auth rules.

## Development

```sh
npm install
npm run build   # tsc -> dist/
npm test
npm run lint
```

## Credits

The security scan's rules and context checks are ported from [skillyard](https://github.com/agentwik-labs/skillyard) (MIT, Copyright (c) 2026 Skillyard contributors), and its good-vs-bad example skills are vendored as test fixtures. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for the licence text and the list of ported files and fixtures.
