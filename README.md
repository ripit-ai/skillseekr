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

What it changes, per tool. A tool is only touched when it is detected.

| Tool | MCP server registration | Starter skill |
|---|---|---|
| Claude Code | Preferred: `claude plugin marketplace add ripit-ai/skillseekr`, then `claude plugin install skillseekr@skillseekr --scope user`. Fallback if the plugin commands are missing or fail: `claude mcp add --scope user skillseekr -- skillseekr mcp` | Bundled in the plugin. Only with the `claude mcp add` fallback does setup copy it to `~/.claude/skills/skillseekr/` |
| OpenCode | `mcp.skillseekr` (`type: "local"`, `command: ["skillseekr", "mcp"]`) in `~/.config/opencode/opencode.json` (or `opencode.jsonc` if that is the file you have). Works with OpenCode v1 and v2 config; an existing entry in either shape counts as registered | `~/.config/opencode/skills/skillseekr/` |
| Copilot CLI | `mcpServers.skillseekr` in `~/.copilot/mcp-config.json` | `~/.copilot/skills/skillseekr/` |
| VS Code (Copilot) | `servers.skillseekr` in VS Code's user `mcp.json`. Local: `~/Library/Application Support/Code/User/mcp.json` (macOS), `%APPDATA%/Code/User/mcp.json` (Windows), `~/.config/Code/User/mcp.json` (Linux), only if that folder exists. Remote (VS Code Server): `~/.vscode-server/data/User/mcp.json`, only if `~/.vscode-server` exists | none |

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

**Include auth restriction.** A registries file reached through an include may use only `gh_cli` or no auth. Entries in it with `github_token`, `bearer` or `basic` are skipped and reported, and the variables they name are never read. Otherwise an included list could name `AWS_SECRET_ACCESS_KEY` and send it to a URL of its choosing. Those three auth types work only in your own local config.

### Cache, TTL and SHA pinning

- Cache folder: `cache.dir` (`~` expanded), else `$XDG_CACHE_HOME/skillseekr`, else `~/.cache/skillseekr`. Mode `0700`.
- A `ref` that is a commit SHA (7 to 40 hex characters) is immutable and never re-checked.
- Any other ref (branch or tag) and every `http` source is re-checked after `ttl_seconds` (default 3600). `skillseekr sync` ignores the TTL once.
- `cache.enabled: false`, or `cache_enabled: false` on one registry, means a TTL of 0: re-check on every load. Fetched trees are still stored, because skills are served from disk.
- Only the local config's `cache` section is used; a `cache` section in an included file is ignored.

To pin a registry for reproducible skills, set `ref` to a full commit SHA.

### Resolution: "last wins" and `via`

1. Entries are walked in file order. An include is replaced by the registries in its file, depth first.
2. The result is one flat list of `github` and `http` registries.
3. Two registries with the same name: the last one wins.
4. Skills are indexed per registry. A skill ID is its slash-separated path relative to `skills_dir` (for `http`, the `skill_name`). A nested skill folder inside another skill folder is not indexed separately.
5. Two skills with the same ID: the later registry wins. Same name at different paths are different skills.

Every override is recorded and shown by `registries`, `show`, `doctor` and the `list_registries` and `get_skill` tools. Every skill also carries `via`, the chain of entry names from your config down to its registry, for example `ripit-ai > data-team > data-skills`. Since later entries win, put personal registries after the org entry to override org skills, or before it to let the org win.

A bare skill name works wherever an ID does, if exactly one skill has that name. If several do, you get the list of IDs to choose from.

## CLI

`--json` (machine-readable output) and `--config <path>` work on every command.

| Command | What it does |
|---|---|
| `skillseekr setup [--tools <list>] [--yes] [--registry <owner/repo>] [--vscode-workspace <dir>]` | Config, MCP registration and starter skill for each tool found, then `doctor` |
| `skillseekr search <query...> [--limit <n>]` | Search the resolved catalog (default 10 results) |
| `skillseekr show <skill>` | Metadata, registry, `via`, overrides, file list and `SKILL.md` |
| `skillseekr install <skill> [--user]` | Copy a skill into `<project>/.claude/skills/` (default), or with `--user` into the personal skill folder of every detected tool |
| `skillseekr remove <name> [--user]` | Remove an installed skill. Only folders skillseekr installed |
| `skillseekr list [--user]` | Installed skills and whether each is current |
| `skillseekr outdated [--user]` | Installed skills that are not current |
| `skillseekr update [name] [--force] [--user]` | Update installs from the catalog. Locally edited installs are skipped unless `--force` |
| `skillseekr registries` | The resolved registry list, with overrides |
| `skillseekr registries add <name> --type <type> ...` | Add a registry to your config, keeping comments. Options: `--owner --repo --ref --skills-dir --path --url --skill-name --description --auth <none\|gh_cli\|github_token\|bearer> --env-var <NAME>` |
| `skillseekr registries remove <name>` | Remove a registry from your config, keeping comments |
| `skillseekr sync` | Re-check every registry now, ignoring the TTL |
| `skillseekr doctor` | Check the config, registries, auth, includes, overrides, tool registration and skill folders |
| `skillseekr validate [path]` | Check a skill folder or a registries `.json`/`.jsonc` file (default: current folder) |
| `skillseekr mcp` | Run the MCP server on stdio (the tools call this, not people) |

Installed skills carry a `.skillseekr.json` marker (`id`, `name`, `registry`, `via`, `ref`, `sha`, `contentHash`, `installedAt`). skillseekr never changes or deletes a skill folder without one.

Skills install by `name`, one folder deep, because tools only load skills one level down. If two different IDs would install under the same name in the same scope, the install is refused.

## MCP tools

Agents get exactly these tools from `skillseekr mcp`:

| Tool | Input | Use |
|---|---|---|
| `search_skills` | `query`, optional `limit` | Find skills (metadata only) |
| `get_skill` | `skill` (ID or unique name) | `SKILL.md` body, file list, cached folder path, registry, `via`, overrides. Installs nothing |
| `read_skill_file` | `skill`, `path` | A supporting file. `..`, absolute paths and symlinks are refused; large or binary files return metadata |
| `install_skill` | `skill`, optional `scope` (`project` or `user`) | Install, only when the user asks or agrees |
| `list_installed` | optional `scope` | Installed skills with status |
| `list_registries` | none | The resolved registries with `via`, SHA and overrides |

Agents cannot remove skills or edit registries; those stay with you, in the CLI.

## Offline and stale behaviour

If a registry can't be reached, skillseekr uses its last good cache and says so: results carry a `stale` flag and the CLI prints a warning. A registry that has never been fetched is reported by `doctor` and skipped; the others still load. A private repo with `gh` missing or logged out is reported by registry name, with a hint to run `gh auth login`.

With no config, or a broken one, the CLI and MCP server still start. `doctor` reports the problem with the file path, and MCP tools return an error result explaining it.

## Security notes

- Fetched content is untrusted data. skillseekr only downloads, extracts and indexes it. It never runs anything from a registry.
- Tarball entries and skill file paths are checked: nothing is written or read outside the cache or skill folder (`..`, absolute paths, symlinks and hard links are refused).
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

```sh
npm install
npm run build   # tsc -> dist/
npm test
npm run lint
```
