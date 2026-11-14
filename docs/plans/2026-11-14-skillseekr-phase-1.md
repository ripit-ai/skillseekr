# skillseekr Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build skillseekr Phase 1: a Node/TypeScript CLI and stdio MCP server that resolves a skills-mcp-format registries config (plus `github-registry` / `http-registry` includes), fetches and caches skills from GitHub and HTTP, and lets Claude Code, OpenCode, and Copilot agents search, fetch, read, and install skills on demand.

**Architecture:** There is one package, `skillseekr`. The pipeline is: a config loader, then a resolver (expand includes, hoist, dedupe), then fetchers (GitHub tarball / HTTP with a TTL cache), then skill discovery, then an in-memory catalog with BM25 search. An `Engine` facade ties these together, and both the MCP server and the CLI sit on top of it. All I/O (HTTP, subprocess, clock, home dir, env) is injected through a `Ctx` object, so every test runs offline against fakes.

**Tech Stack:** Node ≥ 20, TypeScript (ESM, `strict`), vitest, `@modelcontextprotocol/sdk` (stdio server), `zod`, `commander`, `jsonc-parser`, `tar`, `yaml`.

**Spec:** `docs/spec.md` in the repo, a copy of the approved spec *Private Agent Skills Repository* (Phase 1 sections only; Phase 2 and "Parked" are out of scope). Read it before starting. Where the plan and the spec disagree, the spec wins. Raise the conflict; don't silently pick one.

**Repo:** `github.com/ripit-ai/skillseekr` (public, currently empty, default branch `main`). Before Task 1, commit the spec to `docs/spec.md` and this plan to `docs/plans/2026-11-14-skillseekr-phase-1.md`.

## Global Constraints

- Package name, bin name, MCP server name, plugin name: `skillseekr`. Repo: `ripit-ai/skillseekr`.
- `"engines": { "node": ">=20" }`. ESM only (`"type": "module"`). TypeScript `strict: true`. Build output in `dist/`. The bin entry is `dist/cli/main.js` with a `#!/usr/bin/env node` shebang.
- Installing from GitHub must work: `npm i -g github:ripit-ai/skillseekr`. That means a `prepare` script that runs `tsc`, with `dist/` gitignored.
- Config file: `$SKILLSEEKR_CONFIG`, else `$XDG_CONFIG_HOME/skillseekr/config.jsonc`, else `~/.config/skillseekr/config.jsonc`. This applies on **all** platforms, macOS included (unlike skills-mcp).
- Cache dir: `config.cache.dir` (with `~` expanded), else `$XDG_CACHE_HOME/skillseekr`, else `~/.cache/skillseekr`. Created with mode `0700`.
- Config format is skills-mcp's, unchanged. Registry fields: `github` → `owner, repo, skills_dir, ref, auth?, cache_enabled?, description?, instructions?`. `http` → `url, skill_name, auth?, cache_enabled?, description?, instructions?`. Auth types: `none` (default), `github_token{env_var}`, `gh_cli`, `bearer{env_var}`, `basic{username_env_var, password_env_var}`. Cache: `enabled` (default `true`), `ttl_seconds` (default `3600`), `dir`.
- New types: `github-registry` → `owner, repo, ref, path? (default "registries.jsonc"), auth?, description?, policy?, cache_enabled?`. `http-registry` → `url, auth?, description?, policy?, cache_enabled?`.
- A ref is a commit SHA (immutable, never re-checked) iff it matches `/^[0-9a-f]{7,40}$/`. Otherwise it's re-checked after `ttl_seconds`. `cache.enabled: false` or `cache_enabled: false` means a TTL of 0 for that registry: re-check on every load. Fetched trees are still stored, because files must be served from disk.
- Include depth limit: **5** (the local config is depth 0). Include loops are detected, skipped, and reported.
- In included registries files, only `gh_cli` or no auth is allowed. Entries using `github_token`, `bearer`, or `basic` are skipped and reported, and the env var they name is **never read**. `gh_cli` tokens are only sent to the GitHub API host.
- `policy: true` is honoured only on entries in the local config, and is ignored in included files. In Phase 1 it's parsed and stored only (no `allow`/`block` yet).
- Skill ID = slash-separated path of the skill folder relative to `skills_dir`. A folder is a skill iff it directly contains `SKILL.md`. A `SKILL.md` directly at `skills_dir` itself is not a skill. A skill folder nested inside another skill folder is pruned, and the shallowest one wins. For an `http` registry, the ID = `skill_name`.
- "Last wins" applies to both registry names (after hoisting) and skill IDs. Every override is recorded as `{kind, key, replaced: {registry, via}, by: {registry, via}}`.
- `via` = the array of entry names from the local config down to the registry, e.g. `["ripit-ai", "data-team", "data-skills"]`.
- Install marker file: `.skillseekr.json` = `{id, name, registry, via, ref, sha, contentHash, installedAt}`. skillseekr never modifies or deletes a folder that has no marker.
- Content hash: `"sha256:" + hex(sha256(lines))`, where `lines` = for each file in the skill folder sorted by relative POSIX path (excluding `.skillseekr.json`): `relPath + "\0" + hex(sha256(fileBytes)) + "\n"`.
- Agents (MCP) can't remove skills or edit registries. The MCP tools are exactly: `search_skills`, `get_skill`, `read_skill_file`, `install_skill`, `list_installed`, `list_registries`.
- Never copy code from afriemann/skills-mcp. It has no license. Re-implement from its documented behaviour.
- Never run anything from fetched content. Fetching, extracting, and indexing are pure file operations.

## Review Focus

1. **Concurrent processes sharing the cache.** Up to three tools' MCP servers and a CLI may fetch the same registry at the same moment. Expected: no corrupted or half-extracted trees, and both callers succeed. *Test owned by Task 4:* `concurrent materialize of the same sha yields one complete tree`.
2. **Hostile archive or file paths.** Tarball entries with `../`, absolute paths, symlinks, or hard links, and `read_skill_file` given `..`, an absolute path, or a symlink. Expected: nothing is written or read outside the skill or cache folder. *Tests owned by Task 4 (extraction) and Task 8 (`readFile`).*
3. **`gh` missing or logged out, against a private repo.** Expected: a clear problem that names the registry and says access failed, with a hint to run `gh auth login`. Other registries still load. *Test owned by Task 6:* `inaccessible registry is reported by name and others still load`.
4. **Malformed skills.** A `SKILL.md` without frontmatter, a `name` that differs from the folder name, CRLF line endings, a UTF-8 BOM, or a missing description. Expected: never crashes. CRLF and BOM parse fine. Missing frontmatter means the skill is indexed with `name` = folder basename and a warning. A name mismatch is indexed with a warning. *Tests owned by Task 7.*
5. **First run or broken config.** No config file (before `setup`), empty `registries`, trailing commas or comments, an unknown `type`, a non-object entry. Expected: the CLI and MCP server still start, `doctor` reports the problem with the file path, and the MCP tools return an error result explaining it (no crash). *Tests owned by Task 1 and Task 10.*

---

## File Structure

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, README.md
.github/workflows/ci.yml
.claude-plugin/marketplace.json                 # Claude Code marketplace (Task 14)
plugins/skillseekr/.claude-plugin/plugin.json   # Claude Code plugin (Task 14)
plugins/skillseekr/.mcp.json
plugins/skillseekr/skills/skillseekr/SKILL.md   # identical to assets/starter-skill/SKILL.md
assets/starter-skill/SKILL.md                   # source of truth for the starter skill (Task 13)
src/
  types.ts            # shared types (Task 1)
  context.ts          # Ctx: env, home, http, exec, now, githubApi (Task 1)
  paths.ts            # config/cache path resolution (Task 1)
  config/load.ts      # JSONC → ordered Config / RegistriesFile (Task 1)
  config/edit.ts      # comment-preserving edits (Task 2)
  auth.ts             # auth → headers (Task 3)
  net/http.ts         # Http interface + fetch impl (Task 4)
  cache/state.ts      # ref/etag freshness records, atomic writes (Task 4)
  sources/github.ts   # resolve ref, tarball → tree, read file at ref (Task 4)
  sources/http.ts     # SKILL.md / registries file over HTTP (Task 5)
  resolve/resolve.ts  # expand → hoist → dedupe (Task 6)
  catalog/frontmatter.ts, catalog/discover.ts, catalog/hash.ts (Task 7)
  catalog/catalog.ts, catalog/search.ts (Task 8)
  install/targets.ts, install/installer.ts (Task 9)
  engine.ts           # Engine facade (Task 10)
  mcp/server.ts       # MCP tools (Task 11)
  cli/main.ts, cli/commands/*.ts (Task 12, 13)
  setup/registrars/*.ts, setup/setup.ts, setup/jsonMerge.ts, doctor.ts, validate.ts (Task 13)
test/
  helpers/fakeGithub.ts, helpers/fakeHttp.ts, helpers/tmp.ts (Task 4/5)
  fixtures/skills/…   # sample skill trees (Task 7)
  e2e/…               # Task 15
evals/discovery/…     # Task 15
```

---

### Task 1: Scaffold, shared types, paths, and config loading

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.github/workflows/ci.yml`, `src/types.ts`, `src/context.ts`, `src/paths.ts`, `src/config/load.ts`
- Test: `test/config/load.test.ts`, `test/paths.test.ts`

**Interfaces:**
- Produces (`src/types.ts`):
  ```ts
  export type Auth =
    | { type: 'none' } | { type: 'github_token'; env_var: string } | { type: 'gh_cli' }
    | { type: 'bearer'; env_var: string } | { type: 'basic'; username_env_var: string; password_env_var: string };
  export interface GithubEntry { type: 'github'; owner: string; repo: string; skills_dir: string; ref: string; auth: Auth; cache_enabled: boolean; description?: string; instructions?: string }
  export interface HttpEntry { type: 'http'; url: string; skill_name: string; auth: Auth; cache_enabled: boolean; description?: string; instructions?: string }
  export interface GithubRegistryEntry { type: 'github-registry'; owner: string; repo: string; ref: string; path: string; auth: Auth; cache_enabled: boolean; policy: boolean; description?: string }
  export interface HttpRegistryEntry { type: 'http-registry'; url: string; auth: Auth; cache_enabled: boolean; policy: boolean; description?: string }
  export type SourceEntry = GithubEntry | HttpEntry;
  export type IncludeEntry = GithubRegistryEntry | HttpRegistryEntry;
  export type RegistryEntry = SourceEntry | IncludeEntry;
  export interface Problem { level: 'error' | 'warning'; code: string; message: string; registry?: string; via?: string[]; file?: string }
  export interface RegistriesFile { registries: Array<[name: string, entry: RegistryEntry]>; problems: Problem[] }
  export interface CacheSettings { enabled: boolean; ttlSeconds: number; dir: string /* absolute */ }
  export interface Config extends RegistriesFile { path: string; exists: boolean; cache: CacheSettings }
  ```
- Produces (`src/context.ts`):
  ```ts
  export interface ExecResult { code: number; stdout: string; stderr: string }
  export type Exec = (cmd: string, args: string[], opts?: { timeoutMs?: number; input?: string }) => Promise<ExecResult>;
  export interface Ctx { env: Record<string, string | undefined>; home: string; cwd: string; http: Http; exec: Exec; now: () => number; githubApi: string /* default "https://api.github.com", override env SKILLSEEKR_GITHUB_API */ }
  export function defaultContext(): Ctx;
  ```
  (`Http` comes from Task 4. In this task, declare `export interface Http {}` as a placeholder in `src/net/http.ts`, and Task 4 fills it in.)
- Produces (`src/paths.ts`): `configPath(ctx: Ctx): string`, `defaultCacheDir(ctx: Ctx): string`, `expandHome(p: string, home: string): string`.
- Produces (`src/config/load.ts`): `parseRegistriesFile(text: string, opts: { file: string; isLocalConfig: boolean }): RegistriesFile`, `loadConfig(ctx: Ctx): Promise<Config>`.

- [ ] **Step 1: Scaffold the package.** Set up `package.json` (name, `type: module`, `bin.skillseekr`, scripts `build: tsc`, `prepare: tsc`, `test: vitest run`, `lint: tsc --noEmit`; `files: ["dist","assets","plugins",".claude-plugin"]`), a `tsconfig.json` (`module`/`moduleResolution: NodeNext`, `target: ES2022`, `strict`, `outDir: dist`, `rootDir: src`), and a CI workflow that runs `npm ci && npm run lint && npm test` on Node 20 and 22. Install the dependencies listed under Tech Stack.

- [ ] **Step 2: Write failing tests** in `test/config/load.test.ts`:

  ```ts
  it('preserves file order, including digit-only keys', () => {
    const f = parseRegistriesFile(`{ "registries": { "b": {"type":"http","url":"https://x/SKILL.md","skill_name":"b"},
      "10": {"type":"http","url":"https://y/SKILL.md","skill_name":"ten"},
      "a": {"type":"http","url":"https://z/SKILL.md","skill_name":"a"}, } }`, { file: 'f', isLocalConfig: true });
    expect(f.registries.map(([n]) => n)).toEqual(['b', '10', 'a']);
  });
  it('accepts the verbatim skills-mcp example config', () => { /* paste the README example from spec §Registry types; expect 3 entries, no error problems, defaults auth none / cache_enabled true */ });
  it('defaults github auth to none and cache_enabled to true', ...);
  it('defaults github-registry path to registries.jsonc and policy to false', ...);
  it('ignores policy:true when not the local config', () => {
    const f = parseRegistriesFile(`{"registries":{"x":{"type":"github-registry","owner":"o","repo":"r","ref":"main","policy":true}}}`, { file: 'inc', isLocalConfig: false });
    expect((f.registries[0][1] as GithubRegistryEntry).policy).toBe(false);
  });
  it('reports an unknown type as an error problem naming the entry and file, and skips it', () => {
    const f = parseRegistriesFile(`{"registries":{"bad":{"type":"ftp"},"ok":{"type":"http","url":"https://x/SKILL.md","skill_name":"ok"}}}`, { file: '/c.jsonc', isLocalConfig: true });
    expect(f.registries.map(([n]) => n)).toEqual(['ok']);
    expect(f.problems).toContainEqual(expect.objectContaining({ level: 'error', code: 'config/invalid-entry', registry: 'bad', file: '/c.jsonc' }));
  });
  it('reports a JSONC syntax error with file and offset, returning no registries', ...);
  it('loadConfig on a missing file returns exists:false, no registries, and no throw', ...);
  it('cache.dir "~/x" expands to home/x; default cache dir honours XDG_CACHE_HOME', ...);
  ```
  In `test/paths.test.ts`: `SKILLSEEKR_CONFIG` wins, then `XDG_CONFIG_HOME`, then `~/.config/skillseekr/config.jsonc`.

- [ ] **Step 3: Run** `npx vitest run test/config test/paths.test.ts`. Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `parseRegistriesFile`, `loadConfig`, and the paths functions.** Use `jsonc-parser`'s `parseTree` with `{ allowTrailingComma: true }` and iterate the `registries` object node's `children` in order, so the order of digit-only keys is kept. Validate each entry with a zod schema per `type`, and turn validation failures into `config/invalid-entry` problems. `cache` is read only when `isLocalConfig`.

- [ ] **Step 5: Run the tests.** Expected: PASS. Run `npm run lint`. Expected: no errors.

- [ ] **Step 6: Commit** `feat: scaffold package, shared types, and config loading`.

---

### Task 2: Comment-preserving config edits

**Files:**
- Create: `src/config/edit.ts`
- Test: `test/config/edit.test.ts`

**Interfaces:**
- Consumes: `parseRegistriesFile` (Task 1).
- Produces: `addRegistry(text: string, name: string, entry: object): string` (appends as the **last** entry; throws `Error('registry "<name>" already exists')` if present), `removeRegistry(text: string, name: string): string` (throws if absent), `defaultConfigText(opts: { owner: string; repo: string; name: string }): string`.

- [ ] **Step 1: Write failing tests:**
  - `addRegistry keeps existing comments and appends last`: the output still contains `// keep me`, and `parseRegistriesFile(out).registries.at(-1)[0] === 'new'`.
  - `removeRegistry removes only that entry and keeps comments`.
  - `defaultConfigText` parses to exactly one entry, `[name, {type:'github-registry', owner, repo, ref:'main', path:'registries.jsonc', policy:true, auth:{type:'gh_cli'}, …}]`. Its text contains the comment `// Personal additions go below` and a `cache` block with `enabled: true`, `ttl_seconds: 3600`, `dir: "~/.cache/skillseekr"`.
- [ ] **Step 2: Run** `npx vitest run test/config/edit.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with `jsonc-parser` `modify` + `applyEdits` (`formattingOptions: { insertSpaces: true, tabSize: 2 }`). `defaultConfigText` returns a literal template matching the spec's local config example (with `description: "ripit-ai shared skills"` when `name === 'ripit-ai'`, otherwise `"<owner>/<repo>"`).
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: comment-preserving config edits`.

---

### Task 3: Auth

**Files:**
- Create: `src/auth.ts`
- Test: `test/auth.test.ts`

**Interfaces:**
- Consumes: `Auth`, `Ctx`.
- Produces:
  ```ts
  export interface AuthResult { headers: Record<string, string>; problem?: Problem }
  export function authHeaders(auth: Auth, target: { url: string; kind: 'github' | 'http' }, opts: { trusted: boolean }, ctx: Ctx): Promise<AuthResult>;
  export function resetGhTokenCache(): void; // tests only
  ```

- [ ] **Step 1: Write failing tests:**
  - `github_token reads the named env var and sends "Authorization: Bearer <value>"` (trusted).
  - `env-var auth in an untrusted (included) entry never reads the env var`: pass an `env` Proxy that throws on any read of `SECRET`. Expect `headers` `{}` and `problem.code === 'auth/untrusted-env-auth'`. Do this for `github_token`, `bearer`, and `basic`.
  - `gh_cli runs "gh auth token" once per process and caches it`: the fake `exec` is called once across two calls.
  - `gh_cli falls back to no auth with a warning problem when gh is missing or exits non-zero` (`code: 'auth/gh-unavailable'`).
  - `gh_cli never attaches the token to a host other than the GitHub API host`: `url: 'https://evil.example/x'` returns `{}` headers.
  - `basic` encodes `user:pass` as base64. `none` returns `{}`. A missing env var gives `problem.code === 'auth/env-missing'` naming the variable, not its value.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `authHeaders`.** The GitHub API host is `new URL(ctx.githubApi).host`. The `gh auth token` timeout is 5000 ms.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: registry auth with untrusted-include restriction`.

---

### Task 4: HTTP client, cache state, and the GitHub source

**Files:**
- Create: `src/net/http.ts`, `src/cache/state.ts`, `src/sources/github.ts`, `test/helpers/fakeGithub.ts`, `test/helpers/tmp.ts`
- Test: `test/sources/github.test.ts`, `test/cache/state.test.ts`

**Interfaces:**
- Consumes: `authHeaders` (Task 3), `Ctx`, `CacheSettings`.
- Produces (`src/net/http.ts`):
  ```ts
  export interface HttpResponse { status: number; headers: Record<string, string>; body: Buffer }
  export interface Http { get(url: string, headers?: Record<string, string>): Promise<HttpResponse> } // follows redirects; throws NetworkError on connection failure
  export class NetworkError extends Error {}
  export function fetchHttp(): Http;
  ```
- Produces (`src/cache/state.ts`): `readState<T>(cacheDir: string, key: string): Promise<T | undefined>`, `writeState(cacheDir: string, key: string, value: unknown): Promise<void>` (temp file, then `rename`), `isFresh(checkedAt: number, ttlSeconds: number, now: number): boolean`.
- Produces (`src/sources/github.ts`):
  ```ts
  export interface FetchOpts { force: boolean; trusted: boolean; ttlSeconds: number /* 0 when caching disabled */ }
  export interface TreeResult { sha: string; root: string /* abs dir = repo root at sha */; stale: boolean; problems: Problem[] }
  export function isShaRef(ref: string): boolean; // /^[0-9a-f]{7,40}$/
  export function materializeGithub(o: { owner: string; repo: string; ref: string; auth: Auth }, opts: FetchOpts, cache: CacheSettings, ctx: Ctx): Promise<TreeResult | { error: Problem }>;
  export function readGithubFile(o: { owner: string; repo: string; ref: string; path: string; auth: Auth }, opts: FetchOpts, cache: CacheSettings, ctx: Ctx): Promise<{ sha: string; text: string; stale: boolean; problems: Problem[] } | { error: Problem }>;
  ```
- Produces (`test/helpers/fakeGithub.ts`): `fakeGithub(spec: { [ownerRepo: string]: { refs: Record<string, string>; commits: Record<string, Record<string, string | { symlink: string }>>; token?: string } }): { http: Http; calls: string[]; offline(on: boolean): void; nodeHandler: (req: IncomingMessage, res: ServerResponse) => void /* same routes, for Task 15's real HTTP server */ }`. It serves `GET {api}/repos/{o}/{r}/commits/{ref}` (`Accept: application/vnd.github.sha` → sha text), `/tarball/{sha}` (a gzip tar whose top folder is `{o}-{r}-{sha7}/`, built with `tar`), and `/contents/{path}?ref=` (raw). A repo with `token` returns 404 unless `Authorization: Bearer <token>` matches. When offline, it throws `NetworkError`.

- [ ] **Step 1: Write failing tests** in `test/sources/github.test.ts`:
  - `branch ref resolves to sha, extracts tree to <cache>/github/<owner>/<repo>/<sha>/ without the top folder`.
  - `sha ref is never re-resolved` (no `commits/` call on the second call, even with `ttlSeconds: 0`).
  - `branch ref is re-checked only after ttl`: with `now` advanced by `ttl - 1`, there's no call. At `ttl + 1`, one `commits/` call.
  - `force re-checks a branch ref regardless of ttl`.
  - `offline with a previous resolution returns the cached tree with stale: true and a warning problem`. `offline with no previous resolution returns { error: { code: 'source/unreachable' } }`.
  - `404/401/403 returns error code 'source/no-access' whose message names owner/repo and suggests "gh auth login" when auth is gh_cli`. A rate-limit 403 (`x-ratelimit-remaining: 0`) gives `source/rate-limited`.
  - `tar entries with ../ or absolute paths are skipped; symlinks and hard links are not created` (the fixture includes `{ symlink: '/etc/passwd' }`, and after extraction nothing exists at that path inside the tree).
  - `concurrent materialize of the same sha yields one complete tree`: `Promise.all` of two calls both resolve to the same `root`. The root contains every fixture file, and there are no leftover `.tmp-*` dirs.
  - `readGithubFile returns raw text at the resolved sha and caches it by sha`.
  - `isShaRef`: `'a1b2c3d'` → true, `'main'` → false, `'v1.2.3'` → false, a 40-hex string → true.
  - In `test/cache/state.test.ts`: `writeState` is atomic (writes a temp file, then renames), and `isFresh` boundaries are correct.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Ref resolution: `GET {githubApi}/repos/{o}/{r}/commits/{ref}` with `Accept: application/vnd.github.sha`. Store the state key `ref/{o}/{r}/{ref}` = `{ sha, checkedAt }`.
  - Tarball: `GET …/tarball/{sha}`. Extract with `tar.x({ cwd: tmp, strip: 1, filter })` into `<cache>/github/{o}/{r}/.tmp-<random>`, where the filter rejects absolute paths, any `..` segment, and `SymbolicLink`/`Link` entry types. Then `rename` to `<sha>`. If the rename fails because the target exists, delete the temp dir and use the existing one.
  - Cap tarball size at 100 MB (`source/too-large`).
  - File reads: `GET …/contents/{path}?ref={sha}` with `Accept: application/vnd.github.raw`, cached at `<cache>/files/{o}/{r}/{sha}/{path}`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: GitHub source with tarball cache and TTL`.

---

### Task 5: HTTP source

**Files:**
- Create: `src/sources/http.ts`, `test/helpers/fakeHttp.ts`
- Test: `test/sources/http.test.ts`

**Interfaces:**
- Consumes: `Http`, `authHeaders`, `state.ts`, `FetchOpts`.
- Produces:
  ```ts
  export function materializeHttpSkill(e: { url: string; skill_name: string; auth: Auth }, opts: FetchOpts, cache: CacheSettings, ctx: Ctx): Promise<{ root: string /* dir containing SKILL.md */; stale: boolean; problems: Problem[] } | { error: Problem }>;
  export function fetchHttpText(e: { url: string; auth: Auth }, opts: FetchOpts, cache: CacheSettings, ctx: Ctx): Promise<{ text: string; stale: boolean; problems: Problem[] } | { error: Problem }>;
  ```
- Produces: `fakeHttp(routes: Record<string, { status?: number; body: string; etag?: string; requireAuth?: string }>): { http: Http; calls: Array<{ url: string; headers: Record<string, string> }>; offline(on: boolean): void }`.

- [ ] **Step 1: Write failing tests:**
  - The skill is stored at `<cache>/http/<sha256(url)>/<skill_name>/SKILL.md`.
  - Within the TTL, there's no request.
  - After the TTL, `If-None-Match` is sent, and a 304 keeps the cached content.
  - Offline with a cache gives stale; offline without a cache gives `source/unreachable`.
  - A 401/403/404 gives `source/no-access` naming the URL.
  - Responses over 1 MB give `source/too-large`.
  - `fetchHttpText` uses the same caching.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with state key `http/<sha256(url)>` = `{ etag?, checkedAt }`. Writes are atomic (temp, then rename).
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: HTTP source with ETag cache`.

---

### Task 6: Resolver (expand → hoist → dedupe)

**Files:**
- Create: `src/resolve/resolve.ts`
- Test: `test/resolve/resolve.test.ts`

**Interfaces:**
- Consumes: `Config`, `parseRegistriesFile`, `readGithubFile`, `fetchHttpText`, `FetchOpts`.
- Produces:
  ```ts
  export interface ResolvedRegistry { name: string; entry: SourceEntry; via: string[]; trusted: boolean /* true iff declared directly in local config */ }
  export interface Override { kind: 'registry' | 'skill'; key: string; replaced: { registry: string; via: string[] }; by: { registry: string; via: string[] } }
  export interface IncludeInfo { name: string; via: string[]; entry: IncludeEntry; sha?: string; stale: boolean; policy: boolean /* entry.policy && depth===1 */ }
  export interface Resolution { registries: ResolvedRegistry[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[]; stale: boolean }
  export function resolve(config: Config, opts: { force: boolean }, ctx: Ctx): Promise<Resolution>;
  ```

- [ ] **Step 1: Write failing tests** (using `fakeGithub` and `fakeHttp`):
  - `expands includes depth-first in file order`. With the local config `[A(include → [x, y]), z]`, the registry order is `x, y, z`, and `via` of `x` is `['A', 'x']`.
  - `registry name collision: last wins and is recorded`. The local config `[A(include → [shared]), shared]` keeps the local `shared`, with an override `{kind:'registry', key:'shared', replaced:{via:['A','shared']}, by:{via:['shared']}}`.
  - `loop is detected and reported, not infinite`: repo `o/a` includes `o/b`, which includes `o/a`. The result has the problem `resolve/include-loop` and terminates.
  - `depth beyond 5 is skipped with resolve/too-deep`.
  - `included entry with github_token is skipped with auth/untrusted-env-auth and its env var never read`.
  - `cache in included file is ignored; policy only set for depth-1 includes from local config`.
  - `inaccessible registry is reported by name and others still load`: one include returns 404, the problem has `registry` = its name, and the other registries are present.
  - `a skills-mcp-only config (github + http) resolves to the same entries, in order, with via = [name]` (AC-5).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement `resolve`.**
  - A recursive walk with a `seen` set of include identities (`gh:{owner}/{repo}@{ref}:{path}` or `url:{url}`) along the current path, for loop detection.
  - The TTL for each fetch: `config.cache.enabled && entry.cache_enabled ? config.cache.ttlSeconds : 0`.
  - The hoisted list is a `Map` that deletes and re-inserts on collision, so the final order follows the last occurrence. *(Decision: a winner takes the position of its last occurrence.)*
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: registry resolution with includes, hoisting, last-wins`.

---

### Task 7: Skill discovery, frontmatter, and content hash

**Files:**
- Create: `src/catalog/frontmatter.ts`, `src/catalog/discover.ts`, `src/catalog/hash.ts`, `test/fixtures/skills/**`
- Test: `test/catalog/discover.test.ts`, `test/catalog/frontmatter.test.ts`, `test/catalog/hash.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function parseFrontmatter(text: string): { data: Record<string, unknown>; body: string; ok: boolean } // never throws
  export interface DiscoveredSkill { id: string; name: string; description: string; dir: string /* abs */; files: string[] /* sorted POSIX rel paths, excl. .skillseekr.json */; contentHash: string; warnings: string[] }
  export function discoverSkills(treeRoot: string, skillsDir: string): Promise<DiscoveredSkill[]>; // sorted by id
  export function contentHash(dir: string): Promise<{ hash: string; files: string[] }>;
  ```
  `discoverSkills` results for a github tree are cached as JSON at `<cache>/index/<owner>/<repo>/<sha>/<sha256(skills_dir)>.json`. That's done by the caller in Task 10, so `discoverSkills` itself stays pure.

- [ ] **Step 1: Build the fixtures** matching the spec's layout examples: flat (`my-skill`, `another-skill` with `references/guide.md`), nested (`engineering/testing/tdd-development`, `business/brainstorming`), a category folder with no `SKILL.md`, a skill bundling an example `SKILL.md` in `references/example/SKILL.md`, a `SKILL.md` directly at `skills_dir`, CRLF, BOM, missing frontmatter, and a name mismatch.
- [ ] **Step 2: Write failing tests:**
  - `flat layout ids` equal `['another-skill', 'my-skill']`. `nested layout ids` equal `['business/brainstorming', 'engineering/testing/tdd-development']` (copied from the spec).
  - `skills_dir ""` means the repo root.
  - `nested SKILL.md inside a skill is pruned (shallowest wins)`. `SKILL.md at skills_dir itself is not a skill`.
  - `CRLF and BOM frontmatter parse`.
  - `missing frontmatter → name = folder basename, warning "missing frontmatter"`. `name mismatch → indexed with warning naming both`. `missing description → description "" and warning`.
  - `contentHash` is stable regardless of file creation order, changes when one byte changes, and ignores `.skillseekr.json`. Its format matches `/^sha256:[0-9a-f]{64}$/`.
  - `discovery never follows symlinks out of the tree`.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement.**
  - `parseFrontmatter` strips a leading BOM, normalizes CRLF, and parses the block between the first `---` pair with `yaml`, catching any error. Don't use a regex parser.
  - The walk uses `fs.readdir` with `withFileTypes` and never descends into symlinked dirs. The hash algorithm is the one in Global Constraints.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: skill discovery, frontmatter parsing, content hash`.

---

### Task 8: Catalog and search

**Files:**
- Create: `src/catalog/catalog.ts`, `src/catalog/search.ts`
- Test: `test/catalog/catalog.test.ts`, `test/catalog/search.test.ts`

**Interfaces:**
- Consumes: `DiscoveredSkill`, `ResolvedRegistry`, `Override`, `Problem`.
- Produces:
  ```ts
  export interface SkillRecord extends DiscoveredSkill { registry: string; via: string[]; ref?: string; sha?: string; instructions?: string }
  export type Lookup = { kind: 'found'; skill: SkillRecord } | { kind: 'ambiguous'; ids: string[] } | { kind: 'missing' };
  export type FileRead = { kind: 'text'; content: string } | { kind: 'binary' | 'too_large'; size: number; path: string } | { kind: 'refused'; reason: string } | { kind: 'missing' };
  export interface SearchHit { id: string; name: string; description: string; registry: string; via: string[]; score: number; overrode: Array<{ registry: string; via: string[] }> /* skills this one replaced; [] if none */ }
  export class Catalog {
    constructor(perRegistry: Array<{ registry: ResolvedRegistry; ref?: string; sha?: string; skills: DiscoveredSkill[] }>, overrides: Override[], problems: Problem[], stale: boolean);
    readonly skills: SkillRecord[]; readonly overrides: Override[] /* registry + skill */; readonly problems: Problem[]; readonly stale: boolean;
    lookup(idOrName: string): Lookup;      // exact id first; else unique frontmatter name; else ambiguous ids (sorted) or missing
    overridesFor(id: string): Override[];
    readFile(skill: SkillRecord, relPath: string): Promise<FileRead>;
    search(query: string, limit?: number /* default 10 */): SearchHit[];
  }
  ```

- [ ] **Step 1: Write failing tests:**
  - `skill id collision: later registry wins, override recorded with both registries and vias` (AC-7). `same name at different ids are both kept`.
  - `lookup`: an exact id wins over a name. A unique bare name resolves. A duplicate bare name gives `{kind:'ambiguous', ids:[…sorted]}`. An unknown name gives `missing`.
  - `readFile`: returns text for `references/guide.md`. Gives `refused` for `../x`, `/etc/passwd`, `references/../../x`, and for a path that is a symlink (create one in a temp copy of the fixture). Gives `binary` when the first 8 KB contain a NUL byte. Gives `too_large` over 1 MB, and returns the absolute `path`.
  - `search`: the query `"tdd testing"` ranks `engineering/testing/tdd-development` first. An empty query returns `[]`. Results include `registry` and `via`. A skill that replaced another has `overrode` naming the replaced registry and via (AC-6). The default `limit` is 10.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Search:** BM25 with `k1 = 1.2`, `b = 0.75` over tokens. Tokens are lowercase, split on `/[^a-z0-9]+/`, and must be at least 2 characters long. Fields are weighted by repeating tokens: name ×3, ID path segments ×2, description ×1. Return hits with `score > 0`, sorted by score descending then `id` ascending.
  - **`readFile`:** resolve with `path.resolve(skill.dir, rel)`, require the result to start with `skill.dir + sep`, then `lstat`, and refuse symlinks.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: catalog with dedupe, lookup, safe file reads, BM25 search`.

---

### Task 9: Install targets and installer

**Files:**
- Create: `src/install/targets.ts`, `src/install/installer.ts`
- Test: `test/install/installer.test.ts`

**Interfaces:**
- Consumes: `SkillRecord`, `Catalog`, `contentHash`, `Ctx`.
- Produces:
  ```ts
  export type ToolId = 'claude' | 'opencode' | 'copilot';
  export type Scope = 'project' | 'user';
  export const TOOL_TARGETS: Record<ToolId, { userSkillsDir: string /* relative to home */; homeMarker: string /* dir whose existence means "tool present" */; docs: string /* URL verified */ }>;
  export const PROJECT_SKILLS_DIR = '.claude/skills';
  export function presentTools(ctx: Ctx): Promise<ToolId[]>;
  export interface Marker { id: string; name: string; registry: string; via: string[]; ref?: string; sha?: string; contentHash: string; installedAt: string }
  export interface Installed { name: string; scope: Scope; dir: string; tool?: ToolId; marker: Marker; modified: boolean }
  export type InstallStatus = 'current' | 'outdated' | 'modified' | 'missing-from-catalog';
  export function installSkill(skill: SkillRecord, scope: Scope, ctx: Ctx, opts?: { projectDir?: string }): Promise<{ dirs: string[]; tools: ToolId[] }>;
  export function listInstalled(ctx: Ctx, opts?: { scope?: Scope; projectDir?: string }): Promise<Installed[]>;
  export function statusOf(i: Installed, catalog: Catalog): InstallStatus;
  export function removeInstalled(name: string, scope: Scope, ctx: Ctx, opts?: { projectDir?: string }): Promise<string[]>;
  export function updateInstalled(catalog: Catalog, ctx: Ctx, opts: { name?: string; force: boolean; scope?: Scope; projectDir?: string }): Promise<Array<{ name: string; dir: string; result: 'updated' | 'current' | 'skipped-modified' | 'missing-from-catalog' }>>;
  export class InstallError extends Error { code: 'name-conflict' | 'unmanaged-folder' | 'not-installed'; }
  ```

- [ ] **Step 1: Verify tool skill paths** against current official docs for Claude Code, OpenCode, and Copilot CLI (user and project). Record the URL in each `TOOL_TARGETS[*].docs`. Starting values from the spec: `claude: ~/.claude/skills`, `opencode: ~/.config/opencode/skills`, `copilot: ~/.copilot/skills`. Project scope: `.claude/skills` (read by all three). If the docs disagree (for example OpenCode uses `skill/` singular), use the documented path and note it in the commit message.
- [ ] **Step 2: Write failing tests** (with a temp home and project dir):
  - `project install copies the skill folder to <project>/.claude/skills/<name>/ with a .skillseekr.json marker` whose fields equal the skill's id, name, registry, via, sha, and contentHash.
  - `user install writes to each present tool's user dir` (create the `homeMarker` dirs for claude and copilot only, and expect exactly those two dirs).
  - `install refuses when <name>/ exists with a marker for a different id` (`name-conflict`, message names the existing id). `install refuses when <name>/ exists without a marker` (`unmanaged-folder`). Re-installing the same id overwrites.
  - `listInstalled finds only marked folders` and sets `modified: true` when the content hash differs from the marker.
  - `statusOf`: current, outdated (catalog contentHash differs), modified, missing-from-catalog.
  - `remove refuses unmarked folders and deletes marked ones`.
  - `update skips modified installs unless force`.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement.** Copy with `fs.cp(src, tmp, { recursive: true, verbatimSymlinks: false })` into a `.tmp-*` sibling, write the marker, then `rename` (removing the previous managed folder first).
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: install, list, update, remove with markers`.

---

### Task 10: Engine facade

**Files:**
- Create: `src/engine.ts`
- Test: `test/engine.test.ts`

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces:
  ```ts
  export interface RegistryView { name: string; type: SourceEntry['type']; via: string[]; description?: string; instructions?: string; ref?: string; sha?: string; cacheAgeSeconds?: number; stale: boolean; skillCount: number; overriddenBy?: string[] }
  export interface Engine {
    config(): Promise<Config>;
    catalog(opts?: { force?: boolean }): Promise<Catalog>;   // memoized per process; reloaded when force or when any non-SHA source's TTL has elapsed
    registries(): Promise<{ registries: RegistryView[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[] }>;
  }
  export function createEngine(ctx: Ctx): Engine;
  ```

- [ ] **Step 1: Write failing tests:**
  - `end-to-end: config with an include → catalog contains skills from both repos with correct via`.
  - `discovery results are cached per (owner, repo, sha, skills_dir) and not recomputed`: spy on `discoverSkills`, and call `catalog({ force: true })` twice with an unchanged sha.
  - `missing config → empty catalog with problem config/missing naming the path, no throw`.
  - `broken config → empty catalog with config/parse-error problem, no throw`.
  - `offline after a successful load → catalog.stale === true and skills still present` (AC-11).
  - `registries() lists each source with via, sha, stale, skillCount, and overrides`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Load the config, then `resolve`, then for each registry `materializeGithub` or `materializeHttpSkill`, then `discoverSkills` (using the JSON index cache from Task 7), then `new Catalog`. Merge all problems. `stale` is true if any source is stale.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: engine facade`.

---

### Task 11: MCP server

**Files:**
- Create: `src/mcp/server.ts`
- Test: `test/mcp/server.test.ts`

**Interfaces:**
- Consumes: `Engine`, the installer functions, `Catalog`.
- Produces: `createMcpServer(engine: Engine, ctx: Ctx): McpServer` (from `@modelcontextprotocol/sdk/server/mcp.js`) and `runStdio(): Promise<void>`. The server name is `skillseekr`, and the version comes from `package.json`.

The tool contracts are exactly as in the spec's MCP table. Each tool returns one JSON text content block. Fields:
- `search_skills {query: string, limit?: number}` → `{ results: SearchHit[] (score omitted), stale: boolean, problems: Problem[] /* errors only */ }`.
- `get_skill {skill: string}` → found: `{ id, name, description, registry, via, body /* SKILL.md full text */, files, path /* abs cache dir */, overrides, warnings, stale }`. Ambiguous: `isError: true`, `{ error: 'ambiguous', candidates: ids }`. Missing: `isError: true`, `{ error: 'not-found', suggestions: top-3 search ids }`.
- `read_skill_file {skill: string, path: string}` → `{ content }`, or `{ kind: 'binary'|'too_large', size, path }`. A refused path gives `isError: true`.
- `install_skill {skill: string, scope?: 'project'|'user' /* default project */}` → `{ dirs, tools }`. `InstallError` gives `isError: true` with its code and message.
- `list_installed {scope?}` → `[{ name, scope, dir, tool, id, registry, status }]`.
- `list_registries {}` → the `Engine.registries()` result.

**Project dir:** the first `file://` root from the client's `roots/list` when the client supports roots, otherwise `process.cwd()`. *(Decision.)*

**Server `instructions`** (exact text):
> Use skillseekr to find organization skills before specialized or unfamiliar work. Call search_skills with a short description of the task; if a result fits, call get_skill and follow it, reading supporting files with read_skill_file. Say which registry a skill came from if the user asks or if it overrides another skill. Only call install_skill if the user asks to keep a skill or agrees when you offer.

- [ ] **Step 1: Write failing tests** using the SDK's `InMemoryTransport` linked pair with a `Client`:
  - `listTools returns exactly the six tool names`.
  - `search → get → read_skill_file round trip on the fixture catalog`.
  - `get_skill with an ambiguous bare name returns isError with candidates`.
  - `read_skill_file refuses ../ with isError`.
  - `get_skill does not create anything under .claude/skills or tool user dirs` (AC-4).
  - `install_skill installs into the project dir from roots`.
  - `config problems surface as problems, not crashes` (missing config: `search_skills` returns `results: []` plus `config/missing`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement** with `server.registerTool(name, { description, inputSchema: zodShape }, handler)`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: MCP server with six skill tools`.

---

### Task 12: CLI (catalog and install commands)

**Files:**
- Create: `src/cli/main.ts`, `src/cli/output.ts`, `src/cli/commands/{search,show,install,remove,list,outdated,update,registries,sync,mcp}.ts`
- Test: `test/cli/cli.test.ts`

**Interfaces:**
- Consumes: `Engine`, the installer, `addRegistry`/`removeRegistry`, `runStdio`.
- Produces: `buildProgram(ctx: Ctx, io: { out(s: string): void; err(s: string): void }): Command` (commander), and `main(argv: string[]): Promise<number>`, which returns the exit code. Global flags: `--config <path>` (sets `SKILLSEEKR_CONFIG`) and `--json` (machine output on every command).

Commands and flags follow the spec's CLI table. Exit codes: `0` ok, `1` user error (not found, conflict, ambiguous), `2` config or registry errors that prevent the command.

- [ ] **Step 1: Write failing tests** (calling `main` with a fake ctx and capturing io):
  - `search prints id, registry, and description per hit; --json prints SearchHit[]`.
  - `show accepts id or unique name; ambiguous name exits 1 listing candidate ids`.
  - `show prints overrides when the skill replaced another`.
  - `install defaults to project scope; --user installs to present tools`.
  - `remove refuses unmarked folders (exit 1)`.
  - `list shows status per install; outdated lists only non-current`.
  - `update skips modified without --force`.
  - `registries prints the resolved list with via; registries add <name> --type github --owner o --repo r --ref main [--skills-dir s] [--auth gh_cli] appends to config keeping comments; registries add --type github-registry … ; registries remove <name>`.
  - `sync forces a reload` (the fake records a `commits/` call even within the TTL).
  - `stale catalog prints a one-line warning to stderr`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Keep human output plain and aligned, with no colour dependency.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `feat: CLI for search, show, install, list, update, registries, sync, mcp`.

---

### Task 13: Starter skill, tool registration, setup, doctor, and validate

**Files:**
- Create: `assets/starter-skill/SKILL.md`, `src/setup/jsonMerge.ts`, `src/setup/registrars/{claude,opencode,copilotCli,vscode}.ts`, `src/setup/setup.ts`, `src/doctor.ts`, `src/validate.ts`, `src/cli/commands/{setup,doctor,validate}.ts`
- Test: `test/setup/setup.test.ts`, `test/setup/jsonMerge.test.ts`, `test/doctor.test.ts`, `test/validate.test.ts`

**Interfaces:**
- Consumes: `defaultConfigText`, `Engine`, `TOOL_TARGETS`, `presentTools`, `Exec`.
- Produces:
  ```ts
  export interface Registrar { id: ToolId | 'vscode'; detect(ctx: Ctx): Promise<boolean>; isRegistered(ctx: Ctx): Promise<boolean>; register(ctx: Ctx, opts: { yes: boolean }): Promise<Change[]> }
  export interface Change { file?: string; command?: string; before?: string; after?: string; backup?: string }
  export function mergeJsonFile(file: string, path: string[], value: unknown, ctx: Ctx): Promise<Change | null>; // null when already equal; writes "<file>.skillseekr-backup-<epochms>" before changing an existing file; keeps comments via jsonc-parser
  export function setup(ctx: Ctx, opts: { tools?: Array<ToolId | 'vscode'>; yes: boolean; registry?: string /* "owner/repo", default "ripit-ai/agent-skills" */ }): Promise<{ changes: Change[]; doctor: DoctorReport }>;
  export interface DoctorCheck { id: string; status: 'ok' | 'warn' | 'fail'; message: string }
  export interface DoctorReport { checks: DoctorCheck[] }
  export function doctor(engine: Engine, ctx: Ctx): Promise<DoctorReport>;
  export function validatePath(p: string, ctx: Ctx): Promise<{ problems: Problem[] }>; // a skill dir, or a registries .jsonc file
  ```

Starter skill (`assets/starter-skill/SKILL.md`), exact text:
```markdown
---
name: skillseekr
description: Use at the start of any specialized task (a framework, platform, workflow, or document type) to search the organization's skill catalog for an existing skill before working from scratch.
---
Call `search_skills` with a short description of the task. If a result fits, call `get_skill` and follow it. Don't install a skill unless the user asks or agrees.
```
It's installed with a marker whose `id: "skillseekr"` and `registry: "builtin"`, so `list` and `remove` treat it as managed.

- [ ] **Step 1: Verify the registration formats** against current docs, and record the URLs in each registrar's header comment. Starting values:
  - **Claude Code:** preferred is `claude plugin marketplace add ripit-ai/skillseekr`, then `claude plugin install skillseekr@skillseekr`. The fallback is `claude mcp add --scope user skillseekr -- skillseekr mcp`. `isRegistered` uses `claude mcp get skillseekr` or the plugin list.
  - **OpenCode:** in `~/.config/opencode/opencode.json`, set `mcp.skillseekr = { "type": "local", "command": ["skillseekr", "mcp"], "enabled": true }`.
  - **Copilot CLI:** in `~/.copilot/mcp-config.json`, set `mcpServers.skillseekr = { "type": "local", "command": "skillseekr", "args": ["mcp"], "tools": ["*"] }`.
  - **VS Code:** in the user `mcp.json`, set `servers.skillseekr = { "type": "stdio", "command": "skillseekr", "args": ["mcp"] }`. The local path is `~/Library/Application Support/Code/User/mcp.json` on macOS and `~/.config/Code/User/mcp.json` on Linux. **Remote** (VS Code Server on this machine) is `~/.vscode-server/data/User/mcp.json`. Confirm that VS Code reads remote user-level MCP config there. If it doesn't, `--vscode-workspace <dir>` writes `<dir>/.vscode/mcp.json` instead.
- [ ] **Step 2: Write failing tests:**
  - `mergeJsonFile adds the key, keeps other keys and comments, writes a backup, and returns null when equal`.
  - `setup writes the default config when missing and leaves an existing config untouched`.
  - `setup --registry acme/skills writes that owner/repo`.
  - `setup registers only detected tools`.
  - `setup twice changes nothing the second time` (AC-10: the second run's `changes` is `[]`, and the file mtimes are unchanged).
  - `setup installs the starter skill into each present tool's user dir`.
  - `claude registrar uses plugin commands when available, falls back to mcp add` (fake `exec`).
  - `doctor reports config parse, each registry's access (fail names the registry), include loops, overrides (warn), unauthenticated GitHub sources (warn: rate limits), MCP registration per detected tool, and skill folder paths`.
  - `validate on a skill dir flags missing name/description and a name/folder mismatch; on a registries file reports parse errors, loops, and untrusted env-var auth in includes`.
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Implement.** `setup` prints each change as a short diff (`before` → `after` of the touched key). With `--yes`, nothing prompts. Without it, ask once to confirm before writing (read from stdin, default yes). `doctor` exits 1 if any check is `fail`.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: setup, tool registration, starter skill, doctor, validate`.

---

### Task 14: Claude Code plugin, packaging, and README

**Files:**
- Create: `.claude-plugin/marketplace.json`, `plugins/skillseekr/.claude-plugin/plugin.json`, `plugins/skillseekr/.mcp.json`, `plugins/skillseekr/skills/skillseekr/SKILL.md`, `README.md`
- Test: `test/packaging.test.ts`

**Interfaces:**
- Consumes: `assets/starter-skill/SKILL.md`.
- Produces: the marketplace named `skillseekr`, containing a plugin `skillseekr` whose `.mcp.json` is `{ "mcpServers": { "skillseekr": { "command": "skillseekr", "args": ["mcp"] } } }`.

- [ ] **Step 1: Verify** the Claude Code marketplace and plugin manifest schema against current docs, and record the URL in the README.
- [ ] **Step 2: Write failing tests:**
  - `plugin starter skill is byte-identical to assets/starter-skill/SKILL.md`.
  - `marketplace.json lists plugin "skillseekr" with source "./plugins/skillseekr"`.
  - `.mcp.json runs "skillseekr mcp"`.
  - `npm pack --dry-run --json includes dist/cli/main.js, assets/, plugins/, .claude-plugin/` (build first).
- [ ] **Step 3: Run.** Expected: FAIL.
- [ ] **Step 4: Create the files.** The README covers install (`npm i -g github:ripit-ai/skillseekr`, or `volta install github:ripit-ai/skillseekr`), `skillseekr setup`, the config format (skills-mcp compatible, plus the two include types, `policy`, and the include auth rule), the CLI table, and the MCP tools. It notes that the npm name `skillseekr` should be registered as a placeholder.
- [ ] **Step 5: Run.** Expected: PASS.
- [ ] **Step 6: Commit** `feat: Claude Code plugin marketplace, packaging, README`.

---

### Task 15: End-to-end tests, the discovery eval harness, and the acceptance checklist

**Files:**
- Create: `test/e2e/stdio.test.ts`, `evals/discovery/registry/registries.jsonc`, `evals/discovery/skills/**` (10 skills), `evals/discovery/prompts.json`, `evals/discovery/run.mjs`, `docs/acceptance.md`

**Interfaces:**
- Consumes: the built `dist/cli/main.js`.

- [ ] **Step 1: Write the e2e test.** Spawn `node dist/cli/main.js mcp` with `SKILLSEEKR_CONFIG` pointing at a temp config and `SKILLSEEKR_GITHUB_API` pointing at a local `http.createServer(fakeGithub(…).nodeHandler)`. Connect an SDK `Client` over `StdioClientTransport`, then run search → get → read_skill_file → install (project). Assert the marker exists. Kill the server.
- [ ] **Step 2: Run** `npm run build && npx vitest run test/e2e`. Expected: PASS.
- [ ] **Step 3: Build the eval set (AC-3).** Create 10 realistic skills and 10 task prompts, each matching exactly one skill without using its name. `prompts.json` holds `[{ prompt, expectedId }]`. `run.mjs --tool claude|opencode|copilot` runs each prompt headless:
  - Claude Code: `claude -p "<prompt>" --output-format stream-json`.
  - OpenCode: `opencode run "<prompt>" --format json`.
  - Copilot CLI: `copilot -p "<prompt>" --allow-all-tools`.

  Verify each command's flags against current docs. Detect from the tool-call log whether `search_skills` was called and `get_skill` returned `expectedId`. Print `n/10` per tool, where the pass mark is ≥ 8.
- [ ] **Step 4: Write `docs/acceptance.md`**, a manual checklist that maps AC-1 to AC-11 to the automated test that covers each, or to a manual step: AC-1 (four tools each call the tools after `setup`), AC-3 (the eval harness), and AC-9 (each tool loads the project install). Each entry has an exact command and the expected observation.
- [ ] **Step 5: Run** the full suite `npm run lint && npm test`. Expected: all PASS.
- [ ] **Step 6: Commit** `test: e2e stdio test, discovery eval harness, acceptance checklist`.

---

## Self-review notes (for the plan author; already applied)

- **Spec coverage:**
  - Config and types: Task 1.
  - Edits / `registries add`: Tasks 2 and 12.
  - Auth, including the include restriction: Task 3.
  - GitHub/HTTP fetch, TTL, SHA immutability, `cache_enabled`, offline: Tasks 4 and 5.
  - Expand/hoist/dedupe, loops, depth, `policy`, `via`: Task 6.
  - IDs, nesting, pruning, frontmatter: Task 7.
  - Skill dedupe, bare names, `read_skill_file` safety, search: Task 8.
  - Install, markers, conflicts, local edits, scopes: Task 9.
  - Index caching and staleness: Task 10.
  - MCP tools and instructions: Task 11.
  - CLI table: Tasks 12 and 13.
  - Setup, tool registration, VS Code remote, idempotence, starter skill, doctor, validate: Task 13.
  - Plugin and distribution: Task 14.
  - AC-1, AC-3, AC-9 manual and eval: Task 15.
  - **Phase 2 commands (`scan`, `allow`, `block`, `keys`, `sign`) are intentionally absent.**
- **Decisions this plan made that the spec left open:**
  - `parseTree` keeps key order, so digit-only keys are allowed.
  - The hoisted position is the last occurrence.
  - `cache.enabled: false` means a TTL of 0.
  - Symlinks and hard links are dropped on extraction.
  - The tarball cap is 100 MB and the file-read cap is 1 MB.
  - The MCP project dir comes from client roots, falling back to cwd.
  - Tools count as "present" when their home dir exists.
  - The starter skill marker uses `registry: "builtin"`.
  - Search weights are name ×3, ID ×2, description ×1.
  - `instructions` is surfaced in `list_registries` and `RegistryView` only, not in the server instructions, so included files can't inject text into every session.
