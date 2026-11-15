# Phase 2 acceptance checklist

For whoever signs off Phase 2 (runtime security and integrity). Each criterion from [spec-phase-2.md](spec-phase-2.md) ("Phase 2 acceptance criteria") is covered by automated tests, named by file and test title, or has a manual step with the exact command and what you should see.

Run the automated part first:

```sh
npm run lint && npm test && npm run build
```

Expected: no type errors, every test file passes, no warnings in the output. `test/e2e/stdio.test.ts` runs the built `dist/cli/main.js` (the vitest global setup builds it first).

Test file paths are relative to the repo root. Rules, values and commands are documented in the README's [Security](../README.md#security) section.

| Criterion | Covered by | Sign-off |
|---|---|---|
| P2-1 | Automated | Test |
| P2-2 | Automated | Test |
| P2-3 | Automated | Test |
| P2-4 | Automated | Test |
| P2-5 | Automated | Test |
| P2-6 | Automated (false-positive budget: 0) | Test |
| P2-7 | Automated | Test |
| P2-8 | Automated | Test |
| P2-9 | Automated | Test |
| P2-10 | Automated | Test |
| P2-11 | Automated, plus a manual check | Both |
| P2-12 | Automated | Test |
| P2-13 | Automated | Test |

## P2-1: a critical skill never reaches an agent

- `test/engine.test.ts` > "P2-1: a skill with curl | sh in a script is absent from search; lookup finds it blocked with rule, file and line"
- `test/mcp/server.test.ts` > "P2-1: blocked skill is missing from search; get, read and install return the blocked shape"
- `test/install/installer.test.ts` > "P2-1: installing a blocked skill throws blocked and creates nothing"
- `test/cli/cli.test.ts` > "P2-8: block by id removes the skill from search and install exits 1; unblock restores it" (CLI `install` refusal)
- `test/e2e/stdio.test.ts` > "a skill with curl | sh is hidden from search and get_skill returns the blocked shape" (built binary over real stdio: rule `download-and-run/curl-pipe-shell`, file `scripts/x.sh`, line 1)
- Every registry type: `test/engine.test.ts` > "a blocked skill from an http registry".

## P2-2: an update that adds a critical pattern is blocked on its own

- `test/engine.test.ts` > "P2-2: a branch ref that advances to a commit with a critical is blocked after TTL expiry, without sync"
- `test/install/installer.test.ts` > "P2-2: catalog moves to blocked v2: update is blocked, copy untouched, list shows the old copy clean"
- `test/install/installer.test.ts` > "Review Focus 5: a hand-edited copy with curl | sh is blocked, by list and by update"
- `test/doctor.test.ts` > "doctor reports blocked skills, local allow entries with added date, near-duplicates, trust keys and policy problems; a blocked installed copy fails"

## P2-3: an `allow` is tied to one content hash and the named rules

- `test/policy/evaluate.test.ts` > "allow with right hash and rules lifts the block (extra rules fine)"
- `test/policy/evaluate.test.ts` > "hash differing by one character does not lift; note names content change"
- `test/policy/evaluate.test.ts` > "a new critical rule not in rules keeps it blocked; note names it"
- `test/cli/cli.test.ts` > "P2-3: allow --yes then search shows [allowed by user]; allow --list and --json"
- `test/cli/cli.test.ts` > "P2-3: allow --prune drops a stale local entry and keeps a live one"

## P2-4: where `allow`, `block` and `trust` are honoured

- `test/resolve/resolve.test.ts` > "policy:true depth-1 include contributes allow and block with source {kind:include, name}"
- `test/resolve/resolve.test.ts` > "allow/block in a non-policy include are ignored and reported"
- `test/resolve/resolve.test.ts` > "allow/block in a depth-2 include under a policy include are ignored and reported"
- `test/resolve/resolve.test.ts` > "policy:true in an included file has no effect"
- `test/doctor.test.ts` > "policy:ignored is reported for allow/block entries in an include that is not a policy include"
- `test/mcp/server.test.ts` > "P2-4: no MCP tool can change allow/block: six tools, and arbitrary calls leave the config byte-identical"
- `test/mcp/server.test.ts` > "listTools returns exactly the six tool names"

## P2-5: labels everywhere

- `test/mcp/server.test.ts` > "P2-5: a warned skill carries security.warnings in search and get_skill; an allowed one carries allowedBy and allowedRules"
- `test/cli/cli.test.ts` > "P2-5: show works for a blocked skill and prints findings; warnings label search; list shows security"
- `test/cli/cli.test.ts` > "P2-5: a blocked installed copy shows blocked in list and outdated, with the remove hint on stderr"
- `test/catalog/catalog.test.ts` > "search skips blocked skills; hits carry status, allowedBy label and the warning count"

## P2-6: bad skills are blocked; legitimate skills are not

The false-positive budget is **0 blocks** across `test/fixtures/legit`, `evals/discovery/skills`, the starter skill (`assets/`, `plugins/skillseekr/skills`) and the skillyard `good/` fixtures.

- Bad set: `test/scan/rules.test.ts` > "every rule id has a bad fixture that yields exactly that rule at its base severity: %s" (one fixture per rule, in `test/fixtures/rules`)
- Bad set: `test/scan/corpus.test.ts` > "skillyard bad examples"
- Budget: `test/scan/corpus.test.ts` > "false-positive corpus produces zero blocks"
- Budget: `test/scan/corpus.test.ts` > "skillyard good examples produce zero criticals"
- `test/scan/corpus.test.ts` > "the legit corpus exercises every downgrade reason, and the emoji ZWJ sequence is not flagged"

## P2-7: offline, and no repeat work

- `test/engine.test.ts` > "P2-7: rescanning an unchanged catalog does no scan work; a new RULES_VERSION rescans every skill"
- `test/engine.test.ts` > "P2-7: scanning never touches the network (rescan with every http call failing)"
- `test/scan/cache.test.ts` > "a miss scans and stores the result at <cache>/scan/<RULES_VERSION>/<hex>.json; a hit does not scan"
- `test/scan/cache.test.ts` > "a different rules version misses the cache"

## P2-8: `block` beats everything

- `test/cli/cli.test.ts` > "P2-8: block by id removes the skill from search and install exits 1; unblock restores it"
- `test/cli/cli.test.ts` > "P2-8: block by hash, hash validation, and argument errors"
- `test/cli/cli.test.ts` > "P2-8: unblock on a policy-include entry exits 1 naming the include; no flag lifts a block"
- `test/engine.test.ts` > "adding a local block takes effect on the next catalog() without sync"
- `test/policy/evaluate.test.ts` > "deny by id beats a matching allow"
- `test/policy/evaluate.test.ts` > "deny blocks even a clean skill; by content_hash under a different id"
- `test/policy/evaluate.test.ts` > "block beats allow across sources, in either order"
- `test/catalog/catalog.test.ts` > "readFile refuses a blocked skill, naming the first critical rule and its place, or the deny reason"
- `test/install/installer.test.ts` > "P2-8: a block by content_hash of the installed copy blocks it even though the catalog skill is fine" (installed copies flagged)

## P2-9: quoting is a warning; hidden Unicode, keys and tokens always block

- `test/scan/corpus.test.ts` > "skillyard good examples produce zero criticals"
- `test/scan/rules.test.ts` > "every downgradable critical rule's quoted fixture yields a warning with the matching downgraded reason: %s"
- `test/scan/rules.test.ts` > "never-downgrade rules stay critical inside code blocks, quotes and comments: %s"
- `test/scan/rules.test.ts` > "secrets, hidden unicode and only those are never downgraded"
- `test/scan/rules.test.ts` > "text rule %s: example block, quotation marks and defensive sentence each give their own reason"

## P2-10: every remote-code rule has a failing fixture

- `test/scan/rules.test.ts` > "every rule id has a bad fixture that yields exactly that rule at its base severity: %s" (covers `download-and-run/*`, `remote-code/*` and `encoded-exec/eval-decoded`)
- `test/scan/rules.test.ts` > "rule coverage beyond the fixtures" (the `it.each` cases for `bash <(curl …)`, `iex (iwr …)`, `npx github:…`, `pip install git+…` and the other forms)

## P2-11: `scan` covers every tool and plugin folder and changes nothing

- `test/cli/cli.test.ts` > "P2-11: bare scan reports user, copilot, unmarked and plugin skills, never touches HOME; --gate and --json"
- `test/cli/cli.test.ts` > "P2-11: with a real config the cache lives outside the scanned folders and the scanned trees are unchanged"
- `test/cli/cli.test.ts` > "--gate warning exits 1 on any finding, but not on a clean folder; explicit dirs may be a skill or a root"
- `test/scan/folders.test.ts` > "returns only existing folders: project, every tool, and plugin skill folders with labels"

Manual check on a real machine:

```sh
skillseekr scan --gate critical; echo "exit $?"
```

Expected: one line per skill folder found (`CLEAN`, `WARNING` or `CRITICAL`, with findings below it), including skills skillseekr did not install. Exit 0 when nothing is critical, exit 1 with `N skills have critical findings` otherwise. No file in any scanned folder changes.

## P2-12: signatures

- `test/engine.test.ts` > "a trusted owner with a correctly signed skill loads clean"
- `test/engine.test.ts` > "changing one byte after signing gives integrity/signature, blocked"
- `test/engine.test.ts` > "a missing signature file gives blocked"
- `test/engine.test.ts` > "a key placed in an included registries file has no effect: the owner is not trusted, the skill loads clean"
- `test/engine.test.ts` > "owners without a trusted key are not checked"
- `test/sign/sign.test.ts` > "sign then verify is ok", "changing one byte names the file", "another key fails; one matching key among several passes (rotation)"
- `test/setup/setup.test.ts` > "setup --trust writes the trust entry with the default config, and a second run changes nothing"
- `test/setup/setup.test.ts` > "setup --trust merges keys for the same owner without duplicates and keeps comments"
- `test/setup/setup.test.ts` > "setup --trust with a bad key or spec throws and writes nothing"

## P2-13: quality warnings and near-duplicates

- `test/scan/quality.test.ts` > "bad/notes-v2 gets description-no-trigger", "bad/team-helper gets description-hijack", "bad/schema-check gets broken-reference naming each missing path, with line numbers", "flags a 1.5 MB file as oversized-file"
- `test/cli/cli.test.ts` > "P2-13: scan shows quality warnings for bad/notes-v2; show lists them"
- `test/mcp/server.test.ts` > "get_skill shows quality warnings in security.warnings"
- `test/scan/quality.test.ts` > "pairs descriptions that differ by one word, sorted, and not unrelated ones"
- `test/doctor.test.ts` > "doctor reports blocked skills, local allow entries with added date, near-duplicates, trust keys and policy problems; a blocked installed copy fails"
