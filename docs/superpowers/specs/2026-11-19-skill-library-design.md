# Skill library: explicit, controlled updates

Date: 2026-11-19. Status: draft for approval.

## Intent

Today skillseekr fetches on demand. Any command or MCP call can go to the network: a branch ref is re-checked once its TTL (default 1 hour) runs out, a load that had errors is retried within 60 seconds, and `sync` forces a re-fetch. As a result, the skills an agent sees can change at any moment, including in the middle of a session.

The owner wants skills to change **only at known, controlled times**. Later security work (scanning, policy, approval) will depend on this: a point where new content enters is a point where it can be checked.

So skillseekr will pull skill files into a local **library**, `~/.skillseekr/library`, and refresh it only when someone explicitly runs an update:

- a person, with `skillseekr update`;
- an agent, with a new MCP tool, when the user asks.

Between updates every read (search, show, get_skill, read_skill_file, install, list, doctor) works from the library alone and makes no network requests. `install` still copies skills from the library into each tool's skill folder.

## Goals

- One explicit step that updates everything: `update` pulls every registry into the library, then refreshes installed copies that are behind.
- No implicit network access by any other command or by the MCP server.
- A library a person can browse: one folder per source, named after where it came from.
- A clear place where a later security check can go, between "downloaded" and "live".
- Partial failure is safe. A source that fails to update keeps its previous copy, and the failure is reported.
- `update` reports what changed (skills added, changed and removed), so an update is something you can review.

## Non-goals

- The security check itself (scanning, allow/block policy, approval). This design only leaves room for it.
- Rolling back a whole update, or keeping snapshot history (the snapshot approach, below, was not chosen).
- Scheduled or automatic updates.
- Migrating the old cache. `~/.cache/skillseekr` is simply no longer used.

## Anti-goals (failure even if it works)

- Any path other than `update` (or setup's confirmed update) that fetches registry content: a TTL, a retry-on-error, a lazy fetch for a missing file.
- An agent updating without the user asking. Prevented by the tool description and the client's permission prompt, not by the server (see the MCP tool section).
- A failed or interrupted update leaving a source half-written, or deleting a good copy.

## Constraints

- Node 22.12+, TypeScript, existing project layout and conventions (atomic writes, `Problem` objects, `Ctx` injection for tests).
- All existing security rules stay: tarball entry checks, the include auth restriction, `gh_cli` tokens only sent to the GitHub API host, no running of fetched content.
- Owner/repo/ref/path/URL values can come from untrusted registries files. They must never be able to form a path outside the library.
- The config format stays skills-mcp compatible: `cache_enabled` on entries is still accepted.

## Approaches

1. **One folder per source, replaced in place (chosen).** Each source has one current tree in the library. `update` downloads into a temporary folder, swaps it in, and writes `manifest.json` last. Simple and easy to browse, and a per-source security check fits right before each swap.
2. **A full snapshot per update.** `library/snapshots/<time>/` plus a `current` pointer. This would allow rolling back a whole update and approving a whole snapshot, but costs more disk, needs pruning, and the pointer is awkward to browse (especially on Windows). Not chosen; if whole-update rollback ever matters, it can be built on top of approach 1.
3. **Keep the SHA-keyed cache and turn off the TTL.** The smallest change, but the layout is not browsable, old trees pile up, and it isn't really a library. Not chosen.

The owner picked approach 1, and option A for the scope of `update` (pull and refresh installs in one step, rather than separate pull and upgrade commands).

## Decided by the owner

- The library lives at `~/.skillseekr/library`.
- `skillseekr update` pulls every registry into the library, then refreshes installed copies that are behind. Locally modified installs are skipped unless `--force`. `sync` is removed.
- An MCP tool lets an agent request the same update.
- `setup` performs an update, but first asks `Update the skill library now? [y/N]`. Only an explicit `y` (or `yes`, any case) proceeds; Enter or anything else skips it.
- `install` keeps copying from the library into the tools' skill folders.

## Design

### Library location

- Default: `~/.skillseekr/library`, on every platform (no XDG lookup; this is a deliberate, visible location).
- Override: `$SKILLSEEKR_LIBRARY`, else `library.dir` in the local config (`~` expanded). *(Builder's call: needed for tests and for people who keep their home directory small.)*
- Created with mode `0700`.

### Layout

```text
~/.skillseekr/library/
  manifest.json                         written last by every update
  .lock                                 held while an update runs
  github/<owner>/<repo>@<ref>/          repo tree at the resolved commit (tarball, top folder stripped)
  registries/github/<owner>/<repo>@<ref>/<path>   included registries files
  registries/http/<hash>.jsonc
  http/<hash>/<skill_name>/SKILL.md     single-skill http sources
```

- `<ref>` is percent-encoded with `encodeURIComponent`, so `feature/x` becomes `feature%2Fx`. Owner and repo already pass `NAME_RE`. `<hash>` is the first 16 hex characters of the SHA-256 of the normalised URL.
- A github source used by two entries with the same owner/repo/ref is stored once.
- Folders not referenced by the new manifest are deleted at the end of a successful update (pruning).

### manifest.json

The manifest is the catalog. Reads load it instead of resolving the config over the network. It holds:

- `version` (schema number), `updatedAt`, and `configHash` (SHA-256 of the config file text the update resolved).
- The resolution result: resolved registries in order (name, entry, via, trusted), includes (name, via, entry, sha), overrides and problems.
- For each source: its library folder (relative), the resolved `sha` (github), the ETag (http), `fetchedAt`, and the discovered skills index (the same data as today's `index/` files: id, name, description, files, contentHash, warnings). Storing the index means a read never has to walk the trees.
- The previous good state of any source that failed this time, carried over with `stale: true` and the error.

It is written atomically (temporary file, then rename). Readers validate it with a schema. A missing or invalid manifest means "library empty".

### `update`: the pull

1. Take `.lock`: an exclusive create with the pid and time. If the lock is held by a live process, fail with "an update is already running". A lock left by a dead process (pid not alive) is taken over.
2. Load the config and resolve it, fetching include files over the network (the resolver code as today, but it reads from and writes to the library instead of the cache, and has no TTL).
3. **Stage.** Nothing live changes during this step.
   - For each github source: resolve the ref to a commit SHA (a SHA ref skips this). If the SHA equals the manifest's SHA, the folder exists, and its contents still match the manifest's contentHashes, keep it. Otherwise download the tarball and extract it into `.staging/<random>/…`, with all of today's extraction checks.
   - For each http source: GET with `If-None-Match`. On 304 keep the copy; on 200 write it into staging.
   - Discover skills in every staged tree.
4. **Security hook (later work):** a no-op point here, after everything is staged and before anything goes live. A check can reject individual sources (each then behaves like a failed source) or the whole update.
5. **Swap.** Move every staged source into place one after another (rename the current folder to `.old-<random>`, rename the staged one in), write the manifest, then delete the `.old-*` folders. This keeps the window in which a reader can see new files under the old manifest to a few renames. *(Builder's call, prompted by the review: staging everything first closes the mid-update window and gives the later security check one clear place to act.)*
6. A source that fails (network, auth, too large, bad archive) keeps its previous folder and manifest record, marked stale with the problem. A source that has never succeeded is reported as missing and has no skills.
7. **Prune, conservatively.** Folders for sources that are no longer in the resolution are deleted only when the resolution had **no error-level problems**. That means the config parsed, every entry was valid, and every include was fetched and parsed. Otherwise a source that went missing is carried over from the old manifest, marked stale, with a problem explaining why. If the local config is missing or fails to parse, update stops before staging and changes nothing. A failed include fetch resolves from the library's previous copy of that registries file (marked stale), as the cache does today. *(Builder's call: a typo in the config or a network blip must never wipe the library.)*
8. Release the lock, and remove any leftover `.staging` or `.old-*` folders from an interrupted run.
9. Compute the change list against the previous manifest: skill IDs added, changed (contentHash differs) and removed, each with its registry.

**Hand edits to the library.** The library is for browsing, not editing. A kept folder whose files no longer match the manifest's contentHashes is re-downloaded by the next update (step 3). `doctor` reports such folders. The README says the library is read-only by convention. Reads serve what is on disk without re-hashing. *(Builder's call: update stays the only way content gets in, and reads stay cheap.)*

**Install markers.** The installer computes the marker's `contentHash` from the files it actually copied, not from the catalog record, so an install can never record a hash that doesn't match its files.

The pull fetches only what the local config's resolution reaches. `registries add/remove` keep editing the config only and print `run 'skillseekr update' to apply`.

### `update`: refreshing installs

After the pull, run today's `updateInstalled` against the new catalog for **both** user scope and the current project (the cwd for the CLI; the first MCP root for the tool), so one update brings everything in line. *(Builder's call: today `update` takes one scope at a time. Covering both fits "one controlled step". `--user` is dropped from `update`.)*

- `update [name]` still pulls every registry (resolution is global), but limits the install refresh to that skill.
- `--force` overwrites locally modified installs, as today.
- `--no-installs` pulls only. *(Builder's call: lets a person, or a later approval flow, pull without touching installs. Cheap to add.)*

Output: a summary line (`updated N registries: X skills added, Y changed, Z removed`), the change list, problems, then the install table as today. `--json` returns `{ registries, changes, installs, problems, stale }`. Exit code 1 if any source or install failed. The rest still completes.

### Reads: offline only

- The engine builds the catalog from `manifest.json` and never calls `resolve` or any source fetcher. The TTL, the `ERROR_RETRY_MS` retry, the generation file and the `force` option are removed.
- A long-running MCP server reloads when the manifest changes (stamp: mtime, size and inode, as the config stamp is today). It no longer reloads on config edits; a config edit takes effect at the next update.
- Library empty or missing: reads return an error problem: `the skill library is empty; run 'skillseekr update'`. The MCP tools return an error result telling the agent to ask the user whether to update.
- Config changed since the last update (`configHash` differs): a warning problem, `the config changed since the last update; run 'skillseekr update' to apply it`. It is shown by `doctor`, `registries`, and in CLI warnings.
- Stale sources, meaning the last update failed for them, keep today's `stale` flag and warnings.
- `cacheAgeSeconds` in registry views becomes `fetchedAt` (ISO time of the last successful fetch).

### MCP tool `update_skills`

- Input: optional `skill` (limits the install refresh, like `update [name]`). There is **no `force` input** *(changed after a security review: an agent must not be able to overwrite the user's local edits to installs)*. The tool never forces; when it skips locally edited installs, its result includes a `hint` that the user can run `skillseekr update --force`.
- Description: "Update the skill library from the registries and refresh installed skills. Only call this when the user asks for an update or agrees when you offer one." The server `INSTRUCTIONS` gain the same rule.
- Runs the same code as the CLI command, using the project folder from MCP roots. It returns the same JSON as `update --json`. After it runs, the server's own catalog reloads from the new manifest.
- Consent is **not enforced by the server** (owner's decision). The guard is the tool description, `INSTRUCTIONS`, and each client's own tool-permission prompt. There is no MCP elicitation step.
- Agents still cannot remove skills or edit registries.

### setup

After applying its changes and before `doctor`, setup asks `Update the skill library now? [y/N]`.

- An explicit `y` or `yes` runs a full update. Anything else, including Enter, skips it and prints `skipped; run 'skillseekr update' when you're ready`.
- `--yes` counts as answering y. *(Builder's call; the owner may change it. Without it, setup with no terminal could never fill the library.)*
- With no terminal and no `--yes`, the update is skipped with that note.
- A second setup run asks again. Answering no is harmless.

### Config changes

- New: `library: { dir }`, optional.
- `cache` section: accepted and ignored. `doctor` shows a warning that it no longer has any effect. `cache_enabled` on entries: accepted and ignored (skills-mcp compatibility), with no warning.
- SHA-pinned refs still matter: a pinned source downloads once and never changes.

### Other commands

- `sync`: removed. *(Builder's call: removed outright rather than kept as an alias, since `update` now does more than `sync` did and an alias would hide that.)*
- `validate`: still resolves includes over the network, since checking a registries file is an explicit act. It uses a throwaway temporary folder and never touches the library. *(Builder's call.)*
- `doctor`: reports the library path, `updatedAt`, empty-library and config-changed states, stale sources, the ignored `cache` section, and a lock left by a dead process.
- `show`, `get_skill`: `path` points into the library.
- The installer is unchanged, apart from the source folders now living in the library. Markers keep `sha` and `contentHash`.

### Docs

Update README (config, cache section → library section, CLI table, MCP tools table, offline behaviour), `docs/spec.md` (fetching and caching section), `docs/acceptance.md`, and the starter skill if it mentions `sync` or on-demand fetching. Keep the plugin copy of the starter skill byte-identical.

## Tests the builder should cover

- No command except `update`, setup's confirmed update and `validate` performs an HTTP request (a fake `ctx.http` that fails the test on any call).
- An update with one failing source keeps that source's previous folder and skills, and still updates the others.
- An update interrupted during staging leaves the live library untouched. One interrupted during the swap is repaired by the next update (contentHash mismatch, then re-download), and its leftovers are cleaned up.
- Pruning removes folders for registries cleanly dropped from the config, and removes nothing when the resolution had errors (invalid entry, failed include). A missing or unparsable config makes update change nothing.
- A hand-edited library folder is reported by doctor and replaced by the next update.
- An unchanged commit SHA causes no tarball download.
- The change list (added, changed, removed) is correct.
- A running MCP server picks up a manifest written by another process.
- Setup's prompt: `y` proceeds, Enter and `n` skip, `--yes` proceeds, no terminal skips.
- The lock: a second concurrent update fails cleanly, and a stale lock is taken over.
- Path safety of library folder names with hostile refs, owners and URLs.

## Left to the builder

- Exact JSON shapes of the manifest and of the `update` result, within the content listed above.
- Wording of the messages, apart from the setup prompt.
- How to split the resolver and the sources so the same code fetches into the library (update) or into a temporary folder (validate).
- Whether to keep the discovered index inside the manifest or in per-source files next to it, as long as reads never walk the trees.
