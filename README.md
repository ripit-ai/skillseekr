# skillseekr

skillseekr lets coding agents (Claude Code, OpenCode, GitHub Copilot) find and use [Agent Skills](https://agentskills.io) from any number of skill registries. skillseekr keeps them in a local library that changes only when you run `skillseekr update`. You can do the same by hand with the `skillseekr` CLI.

It ships as a CLI plus a stdio MCP server (`skillseekr mcp`). Searching, reading and installing work from the library and never go online. Nothing is installed into a tool's skill folders until someone asks for it.

This README is for developers who install and use skillseekr, and for registry owners. The design is in [docs/spec.md](docs/spec.md).

## Install

Requires Node 22.12 or later.

```sh
npm i -g github:ripit-ai/skillseekr
# or, with Volta
volta install github:ripit-ai/skillseekr
```

Installing from GitHub runs the `prepare` script (`tsc`), so it builds `dist/` on your machine.

> **pnpm:** `pnpm add -g github:ripit-ai/skillseekr` refuses to run a git-hosted package's build script unless that exact tarball is listed in `allowBuilds`, and the entry changes with every commit. Use npm or Volta for the global install until the package is published to a registry.

> **npm name:** the package is not published to npm yet. The npm name `skillseekr` should be registered as a placeholder so nobody else takes it. Until then, install from GitHub as above.

## Set up your tools

```sh
skillseekr setup
```

`setup` finds the tools on your machine, shows exactly what it will change, asks `Apply these changes? [Y/n]`, and applies it. It then asks `Update the skill library now? [y/N] ` (see below) and runs `doctor`. Flags:

- `--yes`: apply without asking (needed when there is no terminal). It also counts as answering yes to the library update.
- `--tools <list>`: limit to some of `claude,opencode,copilot,vscode`. The default is every tool found.
- `--registry <owner/repo>`: the registries file a new config points at (default `ripit-ai/agent-skills`).
- `--vscode-workspace <dir>`: write `<dir>/.vscode/mcp.json` instead of VS Code's user `mcp.json` (see below).

What it changes, per tool. A tool is only touched when it is detected.

| Tool | MCP server registration | Starter skill |
|---|---|---|
| Claude Code | Preferred: `claude plugin marketplace add ripit-ai/skillseekr`, then `claude plugin install skillseekr@skillseekr --scope user`. Fallback if the plugin commands are missing or fail: `claude mcp add --scope user skillseekr -- skillseekr mcp` | Bundled in the plugin. Only with the `claude mcp add` fallback does setup copy it to `~/.claude/skills/skillseekr/` |
| OpenCode | `mcp.skillseekr` (`type: "local"`, `command: ["skillseekr", "mcp"]`, `enabled: true`) in `~/.config/opencode/opencode.json` (or `opencode.jsonc` if that is the file you have). Works with OpenCode v1 and v2 config; an existing entry in either shape counts as registered | `~/.config/opencode/skills/skillseekr/` |
| Copilot CLI | `mcpServers.skillseekr` in `~/.copilot/mcp-config.json` | `~/.copilot/skills/skillseekr/` |
| VS Code (Copilot) | `servers.skillseekr` in VS Code's user `mcp.json`. Local: `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%/Code/User/mcp.json` (Windows), `$XDG_CONFIG_HOME/Code/User/mcp.json` (Linux; `~/.config/Code/User/mcp.json` when `XDG_CONFIG_HOME` is unset), only if that folder exists. Remote (VS Code Server): `~/.vscode-server/data/User/mcp.json`, only if `~/.vscode-server` exists | none |

Plus, if there is no config yet, `~/.config/skillseekr/config.jsonc` with one entry for the default organizational registries file (mode `0600`).

**The library update.** After applying its changes, setup asks `Update the skill library now? [y/N] `. Only `y` or `yes` (any case) runs a full update, the same as `skillseekr update`. Enter or anything else skips it and prints `skipped; run 'skillseekr update' when you're ready`. With no terminal, the update is skipped unless you pass `--yes`. Setup prints the update's summary and install results. If a confirmed update is aborted (for example another update holds the lock), setup exits 1. A second run asks again.

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
  // Optional: where the skill library lives (default ~/.skillseekr/library).
  "library": { "dir": "~/.skillseekr/library" }
}
```

### Registry types

| Type | Fields | Meaning |
|---|---|---|
| `github` | `owner`, `repo`, `skills_dir` (`""` = repo root), `ref`, optional `description`, `instructions`, `auth` | A repo of skills. A folder is a skill if it directly contains `SKILL.md`; skills may be nested at any depth |
| `http` | `url` (direct link to a `SKILL.md`), `skill_name`, optional `description`, `instructions`, `auth` | A single skill |
| `github-registry` | `owner`, `repo`, `ref`, optional `path` (default `registries.jsonc`), `description`, `auth`, `policy` | A JSONC registries file in a repo, listing more registries |
| `http-registry` | `url` (direct link to the file), optional `description`, `auth`, `policy` | The same, at a URL |

`github` and `http` are the skills-mcp types, unchanged. (`cache_enabled` on an entry is still accepted for skills-mcp compatibility and ignored.) The two `*-registry` types are the includes. Includes nest up to 5 levels deep (the local config is level 0). Loops are skipped and reported.

`policy: true` is parsed and stored, and only counts on entries in your local config (it is ignored inside included files). In this release it has no effect yet: `allow`/`block` lists are a later phase.

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

A failed `gh auth token` is retried after 30 seconds, so an `update_skills` call from a running MCP server picks up a later `gh auth login` without a restart.

**Include auth restriction.** A registries file reached through an include may use only `gh_cli` or no auth. Entries in it with `github_token`, `bearer` or `basic` are skipped and reported, and the variables they name are never read. Otherwise an included list could name `AWS_SECRET_ACCESS_KEY` and send it to a URL of its choosing. Those three auth types work only in your own local config.

### Library

skillseekr keeps the skills it knows about in a local library. It changes only when you run `skillseekr update` (or confirm the update in `setup`, or an agent calls `update_skills` at your request). Every other command works from the library alone and makes no network request, except `validate`, which checks a registries file over the network and never touches the library.

- **Location:** `$SKILLSEEKR_LIBRARY`, else `library.dir` in your local config (`~` expanded), else `~/.skillseekr/library`, on every platform. Folders are mode `0700` and files `0600`. Files extracted from a registry's tarball keep the modes the tarball gives them, inside the `0700` library.
- **Layout:**

  ```text
  ~/.skillseekr/library/
    manifest.json                         written last by every update
    .lock                                 held while an update runs
    github/<owner>/<repo>@<ref>/          repo tree at the resolved commit
    registries/github/<owner>/<repo>@<ref>/<path>   included registries files
    registries/http/<hash>.jsonc
    http/<hash>/<skill_name>/SKILL.md     single-skill http sources
  ```

  `<ref>` is percent-encoded (`feature/x` becomes `feature%2Fx`), and `<hash>` is the first 16 hex characters of the SHA-256 of the URL. Two entries with the same owner, repo and ref share one folder.
- **The manifest** (`manifest.json`) is the catalog: the resolved registries and includes (with `via`), overrides, problems, `updatedAt`, a hash of the config the update used, and for each source its folder, resolved commit SHA (github) or ETag (http), `fetchedAt` and its skill index. Reads load it instead of walking the trees. It is written atomically. A missing or invalid manifest means the library is empty.
- **Updating** downloads everything into a staging folder first, then swaps each source in and writes the manifest last. A source that fails (network, auth, too large, bad archive) keeps its previous folder and manifest record, marked stale, and the failure is reported; the other sources still update. A source that has never succeeded is reported and has no skills. A failed manifest write rolls every swap back. A commit whose SHA is unchanged is not downloaded again. Only one update runs at a time (`.lock`); a lock left by a dead process is taken over.
- **Pruning is conservative.** Folders for registries that are no longer in the config are deleted only when the resolution had no error problems (config parsed, every entry valid, every include fetched). Otherwise a source that went missing is kept, marked stale, with a warning. If the config is missing or does not parse, `update` stops and changes nothing. A failed include fetch falls back to the library's previous copy of that registries file, marked stale.
- **Read-only by convention.** Hand edits to the library are replaced at the next update: a folder whose files no longer match the manifest is downloaded again, and `doctor` lists such folders. Reads serve what is on disk without re-checking it.
- **After a config change** (for example `registries add`), reads keep serving the library as it was and warn `the config changed since the last update; run 'skillseekr update' to apply it`. A running MCP server picks up a new manifest written by another process, but not config edits.
- **SHA pinning.** A `ref` that is a commit SHA (7 to 40 hex characters) never changes: it is downloaded once and not fetched again. A branch or tag is resolved to its current commit at each update. To pin a registry for reproducible skills, set `ref` to a full commit SHA.
- **The `cache` section is ignored.** It is no longer used and gives a `config/cache-ignored` warning (shown by `doctor`). New configs written by `setup` do not have one. `~/.cache/skillseekr` is not used or migrated.

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
| `skillseekr setup [--tools <list>] [--yes] [--registry <owner/repo>] [--vscode-workspace <dir>]` | Config, MCP registration and starter skill for each tool found, then `doctor` |
| `skillseekr search <query...> [--limit <n>]` | Search the resolved catalog (default 10 results). Each row shows ID, registry, `via`, description, and `[overrides <registry> (via …)]` when the skill replaced another |
| `skillseekr show <skill>` | Metadata, registry, `via`, overrides, file list and `SKILL.md` (a `SKILL.md` over 1 MB is shown as its size and path instead) |
| `skillseekr install <skill> [--user]` | Copy a skill into `<project>/.claude/skills/` (default), or with `--user` into the personal skill folder of every detected tool |
| `skillseekr remove <name> [--user]` | Remove an installed skill. Only folders skillseekr installed |
| `skillseekr list [--user]` | Installed skills with registry, `via`, and whether each is current |
| `skillseekr outdated [--user]` | Installed skills that are not current |
| `skillseekr update [name] [--force] [--no-installs]` | The one command that goes online. Pulls every registry into the library, then refreshes the installs (user and current project) that are behind. Prints `updated N registries: X skills added, Y changed, Z removed`, the change list, problems and the install table. `name` limits the install refresh to that skill; the pull is always global. Locally edited installs are skipped unless `--force`. `--no-installs` pulls only. An install whose ID is no longer in the catalog is reported as `missing-from-catalog`. Exit code 1 if any registry reported an error, the pull was aborted (lock held, config missing, library not writable) or an install failed; the rest still completes. `--json` prints `{ aborted, registries, skills, changes, installs, problems, stale }` |
| `skillseekr registries` | The resolved registry list, from the library (`--json` includes `fetchedAt`, the time of each registry's last successful fetch). NOTES shows `overrides <registry> (via …)` when a registry replaced another of the same name, and an `override:` line follows for every registry or skill override |
| `skillseekr registries add <name> --type <type> ...` | Add a registry to your config, keeping comments, and print `run 'skillseekr update' to apply`. Options: `--owner --repo --ref --skills-dir --path --url --skill-name --description --auth <none\|gh_cli\|github_token\|bearer> --env-var <NAME>` (`basic` auth is set by editing the config) |
| `skillseekr registries remove <name>` | Remove a registry from your config, keeping comments, and print the same hint |
| `skillseekr doctor` | Offline checks of the config, the library (path, last update, empty or edited folders, config changed, stale lock), registries, auth, includes, overrides, tool registration and skill folders |
| `skillseekr validate [path]` | Check a skill folder or a registries `.json`/`.jsonc` file (default: current folder) |
| `skillseekr mcp` | Run the MCP server on stdio (the tools call this, not people) |

Installed skills carry a `.skillseekr.json` marker (`id`, `name`, `registry`, `via`, `ref`, `sha`, `contentHash`, `installedAt`). skillseekr never changes or deletes a skill folder without one.

Skills install by `name`, one folder deep, because tools only load skills one level down. If two different IDs would install under the same name in the same scope, the install is refused.

## MCP tools

Agents get exactly these tools from `skillseekr mcp`:

| Tool | Input | Use |
|---|---|---|
| `search_skills` | `query`, optional `limit` | Find skills (metadata only) |
| `get_skill` | `skill` (ID or unique name) | `SKILL.md` body, file list, library folder path, registry, `via`, overrides. A `SKILL.md` over 1 MB comes back as `skillMd: {kind: "too_large", size, path}` instead of `body`. Installs nothing |
| `read_skill_file` | `skill`, `path` | A supporting file. `..`, absolute paths and symlinks are refused; large or binary files return metadata |
| `install_skill` | `skill`, optional `scope` (`project` or `user`) | Install, only when the user asks or agrees. Returns the install folders and the tools that will load it (all three for `project`) |
| `list_installed` | optional `scope` | Installed skills with `registry`, `via` and status |
| `list_registries` | none | The resolved registries with `via`, SHA, `fetchedAt` and what each replaced (`overrode`), plus every registry and skill override |
| `update_skills` | optional `skill` | Update the skill library and refresh installed skills, only when the user asks or agrees when offered. Returns what `update --json` returns. It never overwrites locally edited installs: when it skips some, the result includes a hint that the user can run `skillseekr update --force` |

Agents cannot remove skills, edit registries or force an update over local edits; those stay with you, in the CLI.

The server does not ask for consent before `update_skills`. The guard is the tool description, the server's instructions and your client's own tool-permission prompt. With no library yet, the other tools return a `library-empty` error (with any catalog error problems, such as a missing config) that tells the agent to ask you whether to update. After `update_skills` runs, the server serves the new library.

## Offline and stale behaviour

Reads never go online. `search`, `show`, `list`, `outdated`, `install`, `registries`, `doctor` and every MCP tool except `update_skills` work from the library, so they behave the same with the network off.

If the last update could not reach a registry, that registry keeps its previous copy: results carry a `stale` flag and the CLI prints a warning. A registry that has never been fetched is reported by `doctor` and has no skills; the others still load. A private repo with `gh` missing or logged out is reported by registry name, with a hint to run `gh auth login`.

With no library yet, reads fail with `the skill library is empty; run 'skillseekr update'`. With no config, or a broken one, the CLI and MCP server still start. `doctor` reports the problem with the file path, and MCP tools return an error result explaining it.

## Security notes

- Fetched content is untrusted data. skillseekr only downloads, extracts and indexes it. It never runs anything from a registry.
- Tarball entries and skill file paths are checked: nothing is written or read outside the library or skill folder (`..`, absolute paths, symlinks and hard links are refused).
- New content enters at one controlled point: `update`. Nothing else fetches registry content, so what an agent sees cannot change mid-session, and a later security check has a single place to run between "downloaded" and "live". Agents can request an update only through `update_skills`, which cannot overwrite your local edits.
- Auth types that name environment variables are honoured only in your local config. `gh_cli` tokens go only to the GitHub API host.
- skillseekr does not review or sign skills. Trust comes from how each registries file is curated; use `skillseekr show` and `registries` to see where a skill came from. A security scan and allow/block policy are planned for a later phase.

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

This repo uses pnpm (the version is pinned in `package.json` `packageManager`; `corepack enable` or Volta will pick it up).

```sh
pnpm install
pnpm run build   # tsc -> dist/
pnpm test
pnpm run lint
```
