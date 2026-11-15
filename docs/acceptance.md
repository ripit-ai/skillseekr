# Phase 1 acceptance checklist

For whoever signs off Phase 1. Each criterion from [spec.md](spec.md) ("Acceptance criteria (Phase 1)") is either covered by an automated test, named by file and test title, or has a manual step with the exact command and what you should see.

Run the automated part first:

```sh
pnpm run lint && pnpm test
```

Expected: no type errors, every test file passes, no warnings in the output. `test/e2e/stdio.test.ts` runs the built `dist/cli/main.js` (it builds first if `dist/` is missing).

Test file paths are relative to the repo root. "Manual" steps need a machine with the four tools installed and access to the default registries file (`ripit-ai/agent-skills`).

| AC | Covered by | Sign-off |
|---|---|---|
| AC-1 | Manual (below), plus the e2e test for the server itself | Manual |
| AC-2 | Automated | Test |
| AC-3 | Eval harness (below) | Manual |
| AC-4 | Automated | Test |
| AC-4b | Automated | Test |
| AC-5 | Automated | Test |
| AC-6 | Automated | Test |
| AC-7 | Automated | Test |
| AC-8 | Automated | Test |
| AC-8b | Automated | Test |
| AC-9 | Automated for the mechanics, manual for "each tool picks it up" | Both |
| AC-10 | Automated | Test |
| AC-11 | Automated | Test |

## AC-1: all four tools can call `search_skills` and `get_skill` after `setup`

Automated, partial. `test/e2e/stdio.test.ts` > "search → get → read_skill_file → install (project) over real stdio and real HTTP" proves the built server answers `search_skills`, `get_skill`, `read_skill_file` and `install_skill` over stdio. `test/setup/setup.test.ts` covers what `setup` writes for each tool. Whether each real tool then loads the server is manual:

1. `skillseekr setup` and answer `Y`. Expected: the preview lists a change per detected tool, then `doctor` runs with no errors.
2. For each tool, start a session in an empty folder and ask: `List the tools you have from the skillseekr MCP server, then call search_skills with the query "pdf".`
   - Claude Code: `claude -p 'Call the skillseekr search_skills tool with query "pdf" and show the raw result.' --allowedTools mcp__skillseekr`
   - OpenCode: `opencode run 'Call the skillseekr search_skills tool with query "pdf" and show the raw result.'`
   - Copilot CLI: `copilot -p 'Call the skillseekr search_skills tool with query "pdf" and show the raw result.' --allow-all-tools`
   - Copilot in VS Code: open Copilot Chat in agent mode, check that `skillseekr` appears under Tools, and run the same request.
3. Expected in every tool: a JSON result with a `results` array and `stale: false`. Then ask it to `get_skill` for the first result: you get the SKILL.md body, `registry` and `via`.

### Manual check: VS Code remote path (unconfirmed by code)

`setup` writes `~/.vscode-server/data/User/mcp.json` for a remote window, a path inferred from VS Code Server's data layout, not documented.

1. In a VS Code window connected to a remote (SSH, WSL, container or this VM), run `skillseekr setup --tools vscode --yes` in the remote shell.
2. Run `cat ~/.vscode-server/data/User/mcp.json`. Expected: a `servers.skillseekr` entry running `skillseekr mcp`.
3. Reload the window, open Copilot Chat in agent mode, open the tools picker. Expected: `skillseekr` is listed and `search_skills` runs.
4. If it is not listed, run the fallback: `skillseekr setup --tools vscode --vscode-workspace <project-dir> --yes`, then `cat <project-dir>/.vscode/mcp.json` (expected: a `servers.skillseekr` entry), reload and repeat step 3. Record which of the two paths worked; if only the fallback does, the README note and the default path need changing.
5. Automated part: `test/setup/setup.test.ts` > "setup --vscode-workspace writes <dir>/.vscode/mcp.json".

### Manual check: Copilot in VS Code reads `~/.copilot/skills`

`setup` copies the starter skill to `~/.copilot/skills/skillseekr/`, which Copilot CLI documents. Whether Copilot in VS Code also reads it is unverified.

1. `ls ~/.copilot/skills/skillseekr/` shows `SKILL.md` and `.skillseekr.json`.
2. In VS Code Copilot Chat (agent mode), ask: `Which skills do you have available? Do you have one that tells you to search the organization's catalog?`
3. Expected if it reads the folder: the answer names `skillseekr` and describes searching the catalog. If it does not, the MCP server's own `instructions` still direct the model to `search_skills`, so AC-1 can still pass, but the starter skill needs another route for VS Code (for example the project install `.claude/skills/`, or a `.github/skills/` copy). Record the result.

## AC-2: unreadable registries file gives a clear error naming it; other registries work

- `test/setup/setup.test.ts` > "setup reports an unreadable registry by name through doctor (AC-2)"
- `test/mcp/server.test.ts` > "inaccessible registry is named in problems; others still work (AC-2)"
- `test/resolve/resolve.test.ts` > "inaccessible registry is reported by name and others still load"
- `test/doctor.test.ts` > "doctor reports config parse, each registry's access (fail names the registry), include loops, overrides (warn), unauthenticated GitHub sources (warn: rate limits), MCP registration per detected tool, and skill folder paths"
- `test/cli/cli.test.ts` > "a sole inaccessible github-registry include exits 2 and names it; registries still prints first"
- Recovery in a long-running server: `test/auth.test.ts` > "gh_cli does not keep a failure: after 30s it asks gh again and picks up a new login"; `test/engine.test.ts` > "a load with an error-level problem is retried after 60s even when the TTL is longer"

## AC-3: an agent finds and uses a relevant skill without being told its name

Manual, by eval harness. See the header of `evals/discovery/run.mjs` for the full wiring. Short version:

1. Manual: check the set is consistent (offline, free) with `node evals/discovery/run.mjs --dry-run`. Expected: `ok: 10 prompts, 10 skills, every expectedId exists`. `pnpm test` runs only the `validatePrompts` function, not the `--dry-run` command: `test/evals/discovery.test.ts` > "prompts.json is valid: 10 prompts, every expectedId is a skill, none names its skill".
2. Publish `evals/discovery/skills` where the registry file points (ripit-ai/skillseekr, `main`, or edit `evals/discovery/registry/registries.jsonc` for your fork). Write an eval-only config that includes `evals/discovery/registry/registries.jsonc` via a `github-registry` entry, and run `skillseekr setup` so every tool has the server.
3. For each tool, using that config (default models, no other skills installed):

   ```sh
   export SKILLSEEKR_CONFIG=/path/to/eval-config.jsonc
   node evals/discovery/run.mjs --tool claude
   node evals/discovery/run.mjs --tool opencode
   node evals/discovery/run.mjs --tool copilot
   ```

4. Expected per tool: ten `PASS`/`FAIL` lines and a final line such as `claude: 9/10 (pass mark 8/10) PASS`. A prompt passes when the log shows a `search_skills` call and a `get_skill` result whose `id` is the expected skill. AC-3 passes when all three tools reach 8 or more.
5. The OpenCode and Copilot event formats are only partly documented. If a tool scores 0/10 with `searched=false` on every line, run one prompt by hand with the same flags, look at the JSON, and fix the parser in `run.mjs` before reading the score as a failure. The parsers are unit tested against sample events in `test/evals/discovery.test.ts`, which are not captured output.
6. If a tool is below 8, look at `skillseekr search` for the failing prompt's wording (`skillseekr search "<prompt words>"`): if the right skill is not near the top, the ranking needs work (spec: "Left to the builder").

## AC-4: `get_skill` writes nothing into any tool's skill folder

- `test/mcp/server.test.ts` > "get_skill does not create anything under .claude/skills or tool user dirs (AC-4)"

## AC-4b: `read_skill_file` reads inside the skill folder and refuses outside

- `test/mcp/server.test.ts` > "search → get → read_skill_file round trip on the fixture catalog"
- `test/mcp/server.test.ts` > "read_skill_file refuses ../ with isError"
- `test/catalog/catalog.test.ts` > "returns text for a contained file", "refuses hostile paths", "refuses a symlinked file and a symlinked parent dir"
- `test/e2e/stdio.test.ts` > the stdio round trip, including `read_skill_file`

## AC-5: a skills-mcp config means the same thing

- `test/config/load.test.ts` > "accepts a skills-mcp format example config"
- `test/resolve/resolve.test.ts` > "a skills-mcp-only config (github + http) resolves to the same entries, in order, with via = [name]"
- `test/auth.test.ts` > "github_token reads the named env var and sends "Authorization: Bearer <value>"", "bearer sends Bearer and basic encodes user:pass as base64"
- Cache and ref behaviour: `test/sources/github.test.ts` > "force re-checks a branch ref regardless of ttl" and the TTL/SHA tests in the same file; `test/sources/http.test.ts` > "uses the same caching: TTL, ETag 304, stale fallback"

## AC-6: includes, last wins, IDs, bare names, loops, overrides shown

- Depth-first expansion, last wins, loops: `test/resolve/resolve.test.ts` > "loop is detected and reported, not infinite", "loop identity ignores owner/repo case and URL spelling"
- Skill ID collisions: `test/catalog/catalog.test.ts` > "skill id collision: later registry wins, override recorded with both registries and vias", "registry overrides come first, then skill overrides"
- Bare names: `test/catalog/catalog.test.ts` > "duplicate bare name is ambiguous with sorted ids"; `test/mcp/server.test.ts` > "get_skill with an ambiguous bare name returns isError with candidates"
- Overrides visible: `test/catalog/search.test.ts` > "overrode names the replaced registry and via"; `test/engine.test.ts` > "registries() lists each source with via, sha, stale, skillCount, and overrides" (registry and skill overrides, and each registry's `overrode`); `test/mcp/server.test.ts` > "list_registries reports skill-id overrides as well as registry overrides (AC-6)"; `test/doctor.test.ts` (overrides warn); `test/cli/cli.test.ts` > "show prints overrides when the skill replaced another", "search rows show via and note what a hit overrode (AC-6, AC-7)", "registries prints registry and skill overrides (AC-6)"
- Skill IDs match skills-mcp: `test/catalog/discover.test.ts` (ID, nesting and pruning tests)

## AC-7: `registry` and `via` everywhere a skill appears

- `test/mcp/server.test.ts` > "search → get → read_skill_file round trip on the fixture catalog" (`registry`, `via` on search and get results)
- `test/catalog/catalog.test.ts` > "skill id collision: later registry wins, override recorded with both registries and vias"
- `test/cli/cli.test.ts` > "search rows show via and note what a hit overrode (AC-6, AC-7)", "list shows status per install; outdated lists only non-current" (`VIA` column and `via` in `--json`), "show prints overrides when the skill replaced another"
- `test/mcp/server.test.ts` > "install_skill installs into the project dir from roots, and list_installed reports it" (`via` on `list_installed`)
- Manual spot check: `skillseekr search <word>`, `skillseekr list` and `skillseekr show <skill>` print the registry and `via`.

## AC-8: `policy: true` counts only in the local config

- `test/config/load.test.ts` > "honours policy:true in the local config", "ignores policy:true when not the local config"
- `test/resolve/resolve.test.ts` > "cache in included file is ignored; policy only set for depth-1 includes from local config"

## AC-8b: included files cannot use `github_token`, `bearer` or `basic`

- `test/resolve/resolve.test.ts` > "included entry with github_token is skipped with auth/untrusted-env-auth and its env var never read"
- `test/validate.test.ts` > "validate on a skill dir flags missing name/description and a name/folder mismatch; on a registries file reports parse errors, loops, and untrusted env-var auth in includes"

## AC-9: project installs, `remove`/`list`/`outdated`/`update`, local edits, unmarked folders

Automated:
- Marker and copy: `test/install/installer.test.ts` > "project install copies the skill folder with a .skillseekr.json marker"; `test/e2e/stdio.test.ts` asserts `<project>/.claude/skills/pdf-forms/.skillseekr.json` through the built server.
- Scopes and commands: `test/cli/cli.test.ts` > "install defaults to project scope; --user installs to present tools", "list shows status per install; outdated lists only non-current", "remove refuses unmarked folders (exit 1)"
- `update` and local edits: `test/install/installer.test.ts` > "skips modified installs unless force", "updates outdated, reports current and missing-from-catalog, filters by name", "updates in the same user tool dir"; `test/cli/cli.test.ts` > "update skips modified without --force"
- An installed ID that moved in the catalog, and per-item failures: `test/install/installer.test.ts` > "statusOf: an installed id that moved in the catalog is missing-from-catalog, not outdated", "an installed id that moved in the catalog is missing-from-catalog and the loop does not throw", "one failing item is reported as failed with a message and the rest still update"; `test/cli/cli.test.ts` > "update reports a failed item on stderr, still updates the rest, and exits 1"
- Unmarked folders untouched: `test/install/installer.test.ts` > "refuses when the folder exists without a marker, leaving it untouched"; `test/install/installer.test.ts` removeInstalled tests

Manual, that each tool loads a project install:

1. In a scratch git repo: `skillseekr install <skill-id>`. Expected: `.claude/skills/<name>/SKILL.md` and `.claude/skills/<name>/.skillseekr.json` exist (`cat` the marker: `id`, `registry`, `via`, `sha`, `contentHash`).
2. Claude Code: `claude -p 'Which skills are available in this project? List their names.'`. Expected: `<name>` is listed.
3. OpenCode: `opencode run 'Which skills are available in this project? List their names.'`. Expected: `<name>` is listed (OpenCode reads `.claude/skills/`).
4. Copilot CLI: `copilot -p 'Which skills are available in this project? List their names.' --allow-all-tools`. Expected: `<name>` is listed.
5. Edit the installed `SKILL.md`, run `skillseekr update <name>`. Expected: skipped as modified. `skillseekr update <name> --force` replaces it. `skillseekr remove <name>` removes it, and a hand-made folder next to it is untouched.

If a tool does not list the skill, record which tool and its version: that breaks the "all three tools" claim for `.claude/skills/`.

## AC-10: `setup --yes` twice changes nothing the second time

- `test/setup/setup.test.ts` > "setup twice changes nothing the second time"
- Manual: run `skillseekr setup --yes` twice. The second run prints `nothing to change`.

## AC-11: offline search and fetch work from cache, flagged stale

- `test/engine.test.ts` > "offline after a successful load → catalog.stale === true and skills still present"
- `test/sources/github.test.ts` > "offline with a previous resolution returns the cached tree with stale: true and a warning problem"; `test/sources/http.test.ts` > "serves stale from the cache when offline, embedding the error"
- `test/cli/cli.test.ts` > "stale catalog prints a one-line warning to stderr"
- Manual: run `skillseekr sync` online, disconnect the network, run `skillseekr search pdf` and `skillseekr show <skill>`. Expected: results appear and stderr says `warning: catalog may be stale (offline or failing sources)`. Through MCP, `search_skills` results carry `"stale": true`.

## Also covered: a long-running MCP server stays current

Not an acceptance criterion, but the MCP server runs for a whole tool session:

- `test/engine.test.ts` > "a config file edit reloads the memo even before the TTL", "a sync (forced load) in another process reloads this engine; the syncing engine keeps its own result", "a load with an error-level problem is retried after 60s even when the TTL is longer", "concurrent callers after an expiry share one reload"
- `test/auth.test.ts` > "gh_cli does not keep a failure: after 30s it asks gh again and picks up a new login"
- Large `SKILL.md`: `test/mcp/server.test.ts` > "get_skill returns metadata instead of the body for a SKILL.md over 1 MB"; `test/cli/cli.test.ts` > "show prints metadata instead of a SKILL.md over 1 MB"; `test/catalog/discover.test.ts` > "a SKILL.md over 1 MB is indexed by folder name without parsing frontmatter, with a warning"
