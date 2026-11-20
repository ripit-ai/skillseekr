# Skill Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace on-demand fetching and the TTL cache with a local library at `~/.skillseekr/library` that only changes when someone runs `skillseekr update` (CLI), `update_skills` (MCP), or confirms the update prompt in `setup`.

**Architecture:** New `src/library/` module. It covers layout naming, `manifest.json`, the lock, the pull (stage → hook → swap → manifest → prune) and `runUpdate` (pull, then refresh installs). Sources become plain fetchers with no caching. The resolver takes an injected include loader. The engine stops fetching and builds the catalog from the manifest, reloading when the manifest file changes.

**Tech Stack:** TypeScript (ESM, Node ≥ 22.12), zod, tar, commander, `@modelcontextprotocol/sdk`, vitest. Package manager pnpm.

**Spec:** [docs/superpowers/specs/2026-11-19-skill-library-design.md](../specs/2026-11-19-skill-library-design.md). Read it before any task.

**Shell setup (every session):** `source ~/.nvm/nvm.sh && export PATH="$HOME/.local/share/pnpm:$PATH"`. Run `pnpm install` once (there is no `node_modules` yet). Verify with `pnpm test` and `pnpm run lint`.

## Global Constraints

- Library default: `~/.skillseekr/library` on every platform. Override order: `$SKILLSEEKR_LIBRARY`, then config `library.dir` (`~` expanded), then the default. Folders mode `0700`, files `0600`.
- The only code paths that may call `ctx.http`: `pullLibrary` (through `runUpdate`, which setup and `update_skills` also use) and `validate`.
- Setup prompt text exactly: `Update the skill library now? [y/N] `. Accept only `/^y(es)?$/i` after trim; `--yes` counts as yes; no `io.prompt` and no `--yes` means skip.
- MCP tool `update_skills` description exactly: `Update the skill library from the registries and refresh installed skills. Only call this when the user asks for an update or agrees when you offer one.` The server does not enforce consent: no elicitation.
- Problem codes added: `library/empty` (error), `library/config-changed` (warning), `config/cache-ignored` (warning), `library/lock-busy` (error), `library/rejected` (error), `library/write-failed` (error).
- Message texts: empty library: `the skill library is empty; run 'skillseekr update'`. Config changed: `the config changed since the last update; run 'skillseekr update' to apply it`. Setup skip: `skipped; run 'skillseekr update' when you're ready`. Registries add/remove hint: `run 'skillseekr update' to apply`.
- `cache` config section and per-entry `cache_enabled` are still parsed and ignored. Only the `cache` section produces a warning.
- Keep every existing security rule: tarball entry filtering, `invalidRepo`, `safeSegments`, the include env-auth restriction, and `gh_cli` tokens sent only to the API host.
- `assets/starter-skill/SKILL.md` and `plugins/skillseekr/skills/skillseekr/SKILL.md` stay byte-identical.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A config edited between updates** (a registry added or removed) changes nothing that reads see, makes no request, and every read reports `library/config-changed`. Test in Task 5.
2. **A ref with a slash, and two entries for the same repo on different refs** (`main` and `feature/x`) get separate folders (`r@main`, `r@feature%2Fx`) and both serve their skills. Test in Task 4.
3. **An MCP server running during an update in another process** serves the new skills on its next call without a restart. Test in Task 7 (manifest written by a separate `runUpdate`, then the old server's `search_skills`).
4. **`gh` logged out at update time** for a private repo: the source keeps its previous copy marked stale, and the error still carries the `gh auth login` hint. Test in Task 4.
5. **`~/.skillseekr` missing, or the library folder not writable:** `update` creates the folder with mode `0700`. An unwritable folder gives a `library/write-failed` problem naming the path, not a stack trace, and exits 1. Test in Task 4 (pull) and Task 6 (CLI exit code).

---

### Task 1: Library location, layout names, manifest, lock

**Files:**
- Modify: `src/paths.ts`, `src/config/load.ts`, `src/types.ts`
- Create: `src/library/layout.ts`, `src/library/manifest.ts`, `src/library/lock.ts`
- Test: `test/paths.test.ts`, `test/config/load.test.ts`, `test/library/layout.test.ts`, `test/library/manifest.test.ts`, `test/library/lock.test.ts`

**Interfaces:**
- Produces:
  - `libraryDir(ctx: Ctx, configured?: string): string` in `src/paths.ts`.
  - `Config.libraryDir: string` (absolute). Add it next to the existing `cache` for now; Task 5 removes `cache`. `loadConfig` parses an optional `library: { dir?: string }` section.
  - `src/library/layout.ts`:
    - `githubFolder(owner: string, repo: string, ref: string): string`, returning `github/<owner>/<repo>@<encodeURIComponent(ref)>`
    - `httpFolder(url: string, skillName: string): string`, returning `http/<urlHash>/<skillName>`
    - `includeFile(e: IncludeEntry): string | undefined`, returning `registries/github/<owner>/<repo>@<enc ref>/<path>` or `registries/http/<urlHash>.jsonc`, or `undefined` when the path fails a `safeSegments` check
    - `urlHash(url: string): string`: first 16 hex characters of the SHA-256 of the normalised URL (same normalisation as `normUrl` in resolve.ts; move `normUrl` here and import it there)
    - `STAGING = '.staging'`, `OLD_PREFIX = '.old-'`
  - `src/library/manifest.ts`:
    - `MANIFEST_VERSION = 1`
    - `interface ManifestSkill extends Omit<DiscoveredSkill, 'dir'> { dir: string /* relative to the library */ }`
    - `interface SourceRecord { name: string; via: string[]; trusted: boolean; entry: SourceEntry; folder?: string; sha?: string; etag?: string; fetchedAt?: string; stale: boolean; skills: ManifestSkill[] }`
    - `interface IncludeRecord { name: string; via: string[]; entry: IncludeEntry; policy: boolean; stale: boolean; sha?: string; file?: string; textHash?: string; etag?: string; fetchedAt?: string }`
    - `interface Manifest { version: 1; updatedAt: string; configHash: string; sources: SourceRecord[]; includes: IncludeRecord[]; overrides: Override[]; problems: Problem[] }`
    - `manifestFile(libDir: string): string`
    - `readManifest(libDir: string): Promise<Manifest | undefined>`: zod-validated; `undefined` when missing, unparsable or the wrong version. Validation must reject a skill `dir` or a `folder` that is absolute or contains `..`.
    - `writeManifest(libDir: string, m: Manifest): Promise<void>`: atomic (temp file then rename, mode `0600`)
  - `src/library/lock.ts`:
    - `lockHooks = { isAlive(pid: number): boolean }` (default `process.kill(pid, 0)`; `ESRCH` means not alive, `EPERM` means alive)
    - `class LockBusyError extends Error { constructor(public pid: number) }`
    - `acquireLock(libDir: string, ctx: Ctx): Promise<() => Promise<void>>`: creates `<libDir>/.lock` with `{pid, at}` using flag `wx`. A dead holder is taken over once; a live holder throws `LockBusyError`.
    - `readLock(libDir: string): Promise<{ pid: number; at: string; alive: boolean } | undefined>`

- [ ] **Step 1: Write the failing tests**
  - `libraryDir`: env wins over config, config `~/x` expands to home, default is `<home>/.skillseekr/library`.
  - `loadConfig`: `library.dir` is read; with no config file, `libraryDir` is still the default.
  - `githubFolder('o','r','feature/x')` is `github/o/r@feature%2Fx`. `githubFolder('o','r','main')` differs from `githubFolder('o','r','dev')`.
  - `includeFile` on a github-registry with `path: '../x'` is `undefined`. On an http-registry it ends `.jsonc` and has a 16-hex-character hash. `httpFolder` for the same URL with different spelling (`HTTP://Host/a` and `http://host/a`) is equal.
  - Manifest round-trip (`writeManifest`, then `readManifest`) is deep-equal. A `version: 2` file is `undefined`. A record with `folder: '../../etc'` is `undefined`. A missing file is `undefined`.
  - Lock: a second `acquireLock` while the first is held throws `LockBusyError`. With `lockHooks.isAlive = () => false`, a leftover lock is taken over. Release removes the file.
- [ ] **Step 2:** Run `pnpm vitest run test/paths.test.ts test/config/load.test.ts test/library`. Expect them to FAIL because the modules are missing.
- [ ] **Step 3:** Implement the interfaces above.
- [ ] **Step 4:** Run the same command, then `pnpm test && pnpm run lint`. Expect all to PASS.
- [ ] **Step 5:** Commit: `feat(library): location, layout names, manifest and lock`.

---

### Task 2: Plain fetchers in the sources

**Files:**
- Modify: `src/sources/github.ts`, `src/sources/http.ts`
- Test: `test/sources/github.test.ts`, `test/sources/http.test.ts` (add new `describe` blocks; old ones stay until Task 5)

**Interfaces:**
- Produces:
  - `fetchGithubTree(o: { owner: string; repo: string; ref: string; auth: Auth }, opts: { trusted: boolean; knownSha?: string }, intoDir: string, ctx: Ctx): Promise<{ sha: string; unchanged: boolean; problems: Problem[] } | { error: Problem }>`
    - Resolves the ref (a SHA ref is used as-is).
    - When the SHA equals `knownSha`, returns `unchanged: true` with no download.
    - Otherwise downloads the tarball and extracts it into `intoDir` (created by the function; must not exist beforehand) using `extractTarball`. On failure `intoDir` is removed.
  - `fetchGithubFile(o: { owner: string; repo: string; ref: string; path: string; auth: Auth }, opts: { trusted: boolean }, ctx: Ctx): Promise<{ sha: string; text: string; problems: Problem[] } | { error: Problem }>`
  - `fetchHttpBody(e: { url: string; auth: Auth }, opts: { trusted: boolean; etag?: string; maxBytes?: number }, ctx: Ctx): Promise<{ notModified: true; problems: Problem[] } | { notModified: false; body: Buffer; etag?: string; problems: Problem[] } | { error: Problem }>`. `maxBytes` defaults to `MAX_HTTP_BYTES`.
  - Export `invalidSkillName` from http.ts and `invalidRepo` from github.ts.
- These functions never read or write any cache and never fall back to stale copies; staleness becomes the pull's job. Reuse `getter`, `failureFor`, `invalidRepo`, `safeSegments` and lazy auth (R9/R10 messages unchanged). Factor the ref-resolution request out of `withSha` so both the old and new code paths use it.

- [ ] **Step 1: Write the failing tests** (use `fakeGithub` and `fakeHttp`)
  - `fetchGithubTree` with `knownSha` equal to the ref's SHA: `unchanged: true`, and `github.calls` holds only the `/commits/main` request.
  - Without `knownSha`: the files are under `intoDir`, and `sha` is the ref's SHA.
  - A SHA ref makes no `/commits/` request.
  - The existing hostile-tarball cases (`../evil`, absolute paths, symlinks, hard links, oversize) run against `fetchGithubTree`: nothing is written outside `intoDir`, and oversize returns `source/too-large` with `intoDir` removed.
  - A 404 with `gh_cli` auth gives `source/no-access`, and the message contains `gh auth login`.
  - `fetchHttpBody` with a matching ETag gives `notModified: true`. A changed body gives `notModified: false` with the new ETag. An oversize body gives `source/too-large`.
- [ ] **Step 2:** Run `pnpm vitest run test/sources`. Expect the new tests to FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm run lint`. Expect PASS.
- [ ] **Step 5:** Commit: `refactor(sources): fetchers without caching`.

---

### Task 3: Resolver takes an include loader

**Files:**
- Modify: `src/resolve/resolve.ts`, `src/engine.ts` (call site only), `src/validate.ts`
- Test: `test/resolve/resolve.test.ts`, `test/validate.test.ts`

**Interfaces:**
- Consumes: `fetchGithubFile` and `fetchHttpBody` (Task 2).
- Produces:
  - `type IncludeLoad = { text: string; sha?: string; stale: boolean; problems: Problem[] } | { error: Problem }`
  - `type IncludeLoader = (entry: IncludeEntry, trusted: boolean) => Promise<IncludeLoad>`
  - `resolve(config: Config, load: IncludeLoader): Promise<Resolution>`. The memo, loop, depth and trust logic are unchanged; the `fetchInclude` lambda is replaced by `load`.
  - `onlineIncludeLoader(ctx: Ctx): IncludeLoader`: fetches with `fetchGithubFile` / `fetchHttpBody`, with no persistence and `stale: false`.
- The engine keeps working in this task: it passes a loader wrapping today's `readGithubFile` / `fetchHttpText` (its current behaviour, moved). `validate` switches to `onlineIncludeLoader({ ...ctx, env: {} })`, and its fake `cache` config goes away.

- [ ] **Step 1: Write the failing tests**
  - Resolve with a stub loader: called once per include target for a diamond graph. A loader `{ error }` gives that problem on the include, and the rest still resolves.
  - `validate` on a registries file whose include is reachable creates no folder under `$HOME/.skillseekr` or the cache dir. Assert the temp home is still empty afterwards.
- [ ] **Step 2:** Run `pnpm vitest run test/resolve test/validate.test.ts`. Expect FAIL.
- [ ] **Step 3:** Implement. Convert existing resolve tests to pass a stub loader, or `onlineIncludeLoader` with the fakes.
- [ ] **Step 4:** Run `pnpm test && pnpm run lint`. Expect PASS.
- [ ] **Step 5:** Commit: `refactor(resolve): injected include loader; validate fetches without caching`.

---

### Task 4: The pull

**Files:**
- Create: `src/library/pull.ts`, `src/library/verify.ts`
- Test: `test/library/pull.test.ts`, `test/library/verify.test.ts`, `test/helpers/library.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `interface SkillChange { id: string; registry: string; change: 'added' | 'changed' | 'removed' }`
  - `interface StagedSource { name: string; folder: string; stagedDir: string }`
  - `pullHooks = { beforeSwap: async (_s: StagedSource[]): Promise<{ reject?: string[]; abort?: string }> => ({}) }`. This is the security hook. A rejected name behaves as a failed source with code `library/rejected`. `abort` makes the pull change nothing and returns `library/rejected`.
  - `interface PullResult { aborted: boolean; manifest?: Manifest; changes: SkillChange[]; problems: Problem[]; stale: boolean }`
  - `pullLibrary(ctx: Ctx, deps?: { discover?: typeof discoverSkills }): Promise<PullResult>`. It throws `LockBusyError` when the lock is held.
  - `verifyFolders(libDir: string, m: Manifest): Promise<string[]>`: folders whose skills' `contentHash` no longer match, or are missing, plus include files whose `textHash` doesn't match.
  - Test helper `pull(ctx: Ctx): Promise<PullResult>` in `test/helpers/library.ts`. It calls `pullLibrary` and fails the test if `aborted`.
- Algorithm, in order (spec "update: the pull"):
  1. `loadConfig`. If any `config/*` error has no `registry`, return `aborted: true`.
  2. `acquireLock`.
  3. Clean leftover `.staging` and `.old-*` folders.
  4. Resolve with a library loader. It fetches online. Each fetched text is staged at `includeFile(e)`. On a fetch error it falls back to the previous manifest record's file, if that file's `textHash` verifies, marked `stale` with a `source/stale` warning carrying the error message.
  5. Stage the sources. Pass `knownSha` / `etag` only when the previous record's folder passed `verifyFolders`.
  6. Discover skills in staged trees.
  7. `beforeSwap`.
  8. Swap all staged items.
  9. `writeManifest`.
  10. Delete the `.old-*` folders.
  11. Prune top-level `github/`, `http/` and `registries/` entries that no manifest record references, only if the resolution had no error-level problems. Otherwise carry the missing old source records into the manifest with `stale: true` and a warning.
  12. Release the lock in `finally`.
- `configHash` is the SHA-256 of the config file text. A write failure anywhere becomes a `library/write-failed` problem naming the path; nothing throws except `LockBusyError`.

- [ ] **Step 1: Write the failing tests**
  - First pull: `manifest.json` exists. The folder `github/o/r@main/skills/a/SKILL.md` exists. `changes` is `[{id:'a', registry:'r', change:'added'}]`. Library folder mode is `0o700`.
  - Second pull with an unchanged SHA: no `/tarball/` call (`github.calls`), and `changes` is `[]`.
  - New commit changing `a` and adding `b`: changes are `changed a`, `added b`. Removing `b` later gives `removed b`.
  - `main` and `feature/x` of the same repo: two folders, both sets of skills in the manifest (Review Focus 2).
  - `gh` logged out (fake exec exits 1) on a second pull of a private repo: the previous folder is kept, the record is `stale: true`, and the problem message contains `gh auth login` (Review Focus 4).
  - One of two sources failing: the other updates.
  - A source removed from the config is pruned. With an invalid second entry in the same config, nothing is pruned and the old record is carried over stale.
  - A missing config, or one that won't parse: `aborted: true`, and the library is byte-identical (compare a listing and the manifest text).
  - `pullHooks.beforeSwap` rejecting `r`: `r` keeps its previous copy, with a `library/rejected` problem. `abort`: nothing changes.
  - A hand-edited `SKILL.md` in the library: `verifyFolders` names its folder. The next pull re-downloads it although the SHA is unchanged, and the content matches upstream again.
  - A leftover `.staging/x` and `.old-y` from a crash are gone after a pull.
  - The library parent is unwritable (`chmod 0o500` on the parent, skipped when running as root): `library/write-failed` naming the path, and no throw (Review Focus 5).
  - A held lock: a concurrent `pullLibrary` rejects with `LockBusyError`.
- [ ] **Step 2:** Run `pnpm vitest run test/library`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm run lint`. Expect PASS.
- [ ] **Step 5:** Commit: `feat(library): pull registries into the library`.

---

### Task 5: Engine reads the library only; remove the cache

**Files:**
- Create: `src/library/catalog.ts`
- Modify: `src/engine.ts`, `src/config/load.ts`, `src/types.ts`, `src/install/installer.ts`, `src/resolve/resolve.ts` (drop `ttlFor`)
- Delete: `src/cache/state.ts`, `test/cache/state.test.ts`, and from sources the old `materializeGithub`, `readGithubFile`, `materializeHttpSkill`, `fetchHttpText` and their TTL/stale tests
- Test: `test/engine.test.ts` (rewrite), `test/install/installer.test.ts`, and every test that relied on implicit fetching (`test/cli/cli.test.ts`, `test/mcp/server.test.ts`, `test/doctor.test.ts`, `test/e2e/stdio.test.ts`, `test/evals/discovery.test.ts`, `test/setup/setup.test.ts`)

**Interfaces:**
- Consumes: `readManifest`, `manifestFile` (Task 1); `pull` helper (Task 4).
- Produces:
  - `catalogFromManifest(libDir: string, m: Manifest): { catalog: Catalog; views: RegistryView[]; includes: IncludeInfo[] }` in `src/library/catalog.ts`. Skill `dir` is made absolute as `join(libDir, rel)`. Built in the manifest's source order, so "last wins" and the skill overrides come out as today.
  - `Engine`:
    - `config(): Promise<Config>`
    - `catalog(): Promise<Catalog>` (no `force`)
    - `registries()` as today
    - `library(): Promise<{ dir: string; manifest?: Manifest }>`
  - `RegistryView.cacheAgeSeconds` is replaced by `fetchedAt?: string`.
  - Engine problems: the manifest's problems, plus `library/empty` when there is no manifest, plus `library/config-changed` when the SHA-256 of the current config text differs from `configHash`, plus config warnings.
  - Memo: valid while the stamp of `manifestFile` and of the config file are unchanged; no TTL, no generation file, no `ERROR_RETRY_MS`.
  - `Config.cache` and `CacheSettings` removed. A present `cache` section adds `config/cache-ignored` (warning, `file` set). `cache_enabled` still parses.
  - Installer: the marker's `contentHash` is `contentHash(tmp)` after copying and before writing the marker.
- The CLI's `sync` command and `loadCatalog({force})` still compile here only if they are left untouched. Delete `src/cli/commands/sync.ts`, its registration and its test in this task, and drop `force` from `loadCatalog`.

- [ ] **Step 1: Write the failing tests** (`test/engine.test.ts`, replacing the TTL, generation and retry tests)
  - After `pull`, the catalog has the expected IDs and `via`. `ctx.http` set to a stub that throws on any call works for `catalog()`, `registries()` and `config()`.
  - No library: `catalog()` has zero skills and a `library/empty` error; no request is made.
  - Config edited after the pull (registry added): the catalog is unchanged, `library/config-changed` is present, and no request is made (Review Focus 1).
  - A manifest rewritten by a second `pull` (new commit): the same engine instance returns the new skills on its next `catalog()`.
  - A config with a `cache` section: one `config/cache-ignored` warning.
  - Installer: after an install, the marker's `contentHash` equals `contentHash(<install dir>)`.
- [ ] **Step 2:** Run `pnpm vitest run test/engine.test.ts test/install`. Expect FAIL.
- [ ] **Step 3:** Implement. Then fix the other test files mechanically:
  - Configs use `library: { dir: join(dir, 'library') }` instead of `cache`.
  - Each `setup()` helper calls `await pull(ctx)` after writing the config.
  - Tests that asserted TTL, stale-cache or `sync` behaviour are deleted. Stale behaviour is now covered in Task 4.
- [ ] **Step 4:** Run `pnpm test && pnpm run lint`. Expect PASS, with no reference to `cache.dir`, `ttl`, `generation` or `sync` left in `src/` (`grep -rnE "ttl|generation|cache\.dir|sync" src` is empty).
- [ ] **Step 5:** Commit: `feat(engine): serve skills from the library only; drop the TTL cache and sync`.

---

### Task 6: `runUpdate` and the CLI

**Files:**
- Create: `src/library/update.ts`
- Modify: `src/cli/commands/update.ts`, `src/cli/output.ts`, `src/cli/commands/registries.ts`
- Test: `test/library/update.test.ts`, `test/cli/cli.test.ts`

**Interfaces:**
- Consumes: `pullLibrary` (Task 4), `catalogFromManifest` (Task 5), `updateInstalled` (installer, unchanged).
- Produces:
  - `interface UpdateOptions { name?: string; force: boolean; installs: boolean; projectDir: string }`
  - `interface UpdateReport { aborted: boolean; registries: number; skills: number; changes: SkillChange[]; installs: UpdateResult[]; problems: Problem[]; stale: boolean }`
  - `runUpdate(ctx: Ctx, opts: UpdateOptions): Promise<UpdateReport>`: pull, then (unless `installs: false` or `aborted`) `updateInstalled` with no `scope`, so both user and project are covered. `LockBusyError` becomes a `library/lock-busy` error problem with `aborted: true`.
  - CLI `update [name] [--force] [--no-installs]` (no `--user`):
    - Output: `updated N registries: X skills added, Y changed, Z removed`, then one line per change (`  + <id> (<registry>)`, `  ~ …`, `  - …`), then problems on stderr through `reportProblems`, then the install table as today.
    - `--json` prints the `UpdateReport`.
    - Exit 1 when any error problem or `failed` install occurred; `update <name>` that isn't installed still exits 1 with the existing message.
  - `blockingError` treats a `library/empty` problem with 0 skills as exit 2, with message `the skill library is empty; run 'skillseekr update'`.
  - `registries add` / `registries remove` print `run 'skillseekr update' to apply` after success.

- [ ] **Step 1: Write the failing tests**
  - `runUpdate` refreshes an outdated project install and an outdated user install in one call, and skips a modified one unless `force`.
  - `installs: false` leaves both installs untouched.
  - A held lock gives `aborted: true` with `library/lock-busy`.
  - CLI: `update` on an empty library prints `updated 1 registries: 1 skills added, 0 changed, 0 removed` and `  + a (r)`.
  - `search` before any update exits 2 with the empty-library message.
  - `update --json` parses as an `UpdateReport`.
  - With the library parent unwritable, `update` exits 1 and stderr names the path (Review Focus 5).
  - `registries add` prints the hint.
  - `update --user` is a usage error (exit 1).
  - `search`, `show`, `install`, `list`, `outdated`, `registries` and `doctor` against a pulled library, with `ctx.http` throwing on any call: all exit 0.
- [ ] **Step 2:** Run `pnpm vitest run test/library/update.test.ts test/cli`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm run lint`. Expect PASS.
- [ ] **Step 5:** Commit: `feat(cli): update pulls the library and refreshes installs`.

---

### Task 7: MCP `update_skills`

**Files:**
- Modify: `src/mcp/server.ts`
- Test: `test/mcp/server.test.ts`, `test/e2e/stdio.test.ts`

**Interfaces:**
- Consumes: `runUpdate` (Task 6).
- Produces:
  - Tool `update_skills`, input `{ skill?: string; force?: boolean }`, with the description from Global Constraints. It calls `runUpdate(ctx, { name: skill, force: force ?? false, installs: true, projectDir: await projectDir() })` and returns `ok(report)`, or `fail(report)` when `aborted`.
  - `INSTRUCTIONS` gets the sentence `Only call update_skills when the user asks for an update or agrees when you offer one.`
  - When the catalog has a `library/empty` problem, `search_skills`, `get_skill`, `read_skill_file`, `install_skill` and `list_installed` return `fail({ error: 'library-empty', message: "the skill library is empty; ask the user whether to update it (update_skills, or 'skillseekr update')" })`.
  - `get_skill`'s missing-`SKILL.md` message says `run 'skillseekr update'` instead of `sync`.

- [ ] **Step 1: Write the failing tests**
  - `listTools` includes `update_skills` with the exact description.
  - On an empty library, `search_skills` gives `isError` with `error: 'library-empty'`.
  - `update_skills` on an empty library returns `changes` holding `added a`, and the following `search_skills` finds `a`.
  - Review Focus 3: a server created first, then `runUpdate` called directly (not through the server) with a new commit, then the server's `search_skills` shows the new skill.
  - e2e stdio: the tool list contains `update_skills`.
- [ ] **Step 2:** Run `pnpm vitest run test/mcp test/e2e`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm run lint`. Expect PASS.
- [ ] **Step 5:** Commit: `feat(mcp): update_skills tool`.

---

### Task 8: setup prompt and doctor checks

**Files:**
- Modify: `src/setup/setup.ts`, `src/cli/commands/setup.ts`, `src/doctor.ts`, `src/cli/commands/doctor.ts` (if printing needs it)
- Test: `test/setup/setup.test.ts`, `test/doctor.test.ts`, `test/cli/cli.test.ts`

**Interfaces:**
- Consumes: `runUpdate` (Task 6), `readLock` (Task 1), `verifyFolders` (Task 4), `Engine.library()` (Task 5).
- Produces:
  - `SetupOptions.confirmUpdate?: () => Promise<boolean>`.
  - `SetupResult.update: UpdateReport | { skipped: true }`.
  - After applying, and before doctor, setup runs the update when `opts.yes` is set or `await opts.confirmUpdate?.()` is true; otherwise `{ skipped: true }`. Setup's update uses `installs: true`, `force: false`, `projectDir: ctx.cwd`.
  - This runs even when there were no changes to apply, and even on a second setup run.
  - The CLI's `confirmUpdate` prompts with the exact text from Global Constraints. When `io.prompt` is missing it returns false. A skip prints `skipped; run 'skillseekr update' when you're ready`; a run prints the update summary line from Task 6.
  - Doctor checks:
    - `library`: ok `<dir>: updated <updatedAt>, <n> skills`, or warn with the empty-library message.
    - `library:config`: warn when `library/config-changed`.
    - `library:lock`: warn `stale update lock from pid <pid>` when the lock is held by a dead pid.
    - `library:edited`: warn listing `verifyFolders` results.
    - `config:cache`: warn on `config/cache-ignored`.
  - None of these are `fail`, so an empty library never fails setup.

- [ ] **Step 1: Write the failing tests**
  - Setup with prompt answers `y`, `Y`, `yes` runs the update (the manifest exists afterwards). `''`, `n` and `whatever` skip it (no manifest, and the skip line is printed).
  - `--yes` runs it with no prompt.
  - `setup()` called with neither `yes` nor `confirmUpdate` gives `update: { skipped: true }`, and no request reaches the fake GitHub.
  - A second setup run with nothing to change still asks the update question.
  - Doctor on an empty library: `library` is warn, and no check is `fail` from library state. With a hand-edited file, `library:edited` lists its folder. With a dead-pid lock, `library:lock` is warn.
- [ ] **Step 2:** Run `pnpm vitest run test/setup test/doctor.test.ts test/cli`. Expect FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm run lint`. Expect PASS.
- [ ] **Step 5:** Commit: `feat(setup,doctor): confirmed library update in setup; library checks in doctor`.

---

### Task 9: Docs

**Files:**
- Modify: `README.md`, `docs/spec.md`, `docs/acceptance.md`, `assets/starter-skill/SKILL.md`, `plugins/skillseekr/skills/skillseekr/SKILL.md`

- [ ] **Step 1:** README:
  - Rewrite the intro ("fetch on demand" becomes "a local library updated only when you run update").
  - Replace "Cache, TTL and SHA pinning" with a "Library" section: location and overrides, layout, the manifest, partial failure, pruning rules, "read-only by convention; hand edits are replaced at the next update", SHA pinning, and that the `cache` section is ignored.
  - In the CLI table, remove `sync`, rewrite `update`, and add the hint on `registries add/remove`.
  - In the MCP table, add `update_skills`.
  - Document setup's update prompt.
  - In "Offline and stale behaviour", say that reads never go online.
  - Under Security notes, mention the controlled update point.
- [ ] **Step 2:** `docs/spec.md`: rewrite "Fetching and caching" and the MCP/CLI lists to match, and link the design doc. `docs/acceptance.md`: replace the TTL/sync items with library items mirroring the tests in Tasks 4–8.
- [ ] **Step 3:** Starter skill (both copies, byte-identical): add the line `If the catalog is empty or the user asks for newer skills, offer to call update_skills; only call it if they agree.`
- [ ] **Step 4:** Run `pnpm test`. Expect PASS (the packaging test enforces the identical copies). `grep -rn "sync\|ttl_seconds" README.md docs/spec.md` returns only the deprecation note for `cache`.
- [ ] **Step 5:** Commit: `docs: skill library and explicit updates`.
