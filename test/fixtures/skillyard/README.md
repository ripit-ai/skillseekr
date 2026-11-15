# skillyard examples (vendored test fixtures)

Copied from https://github.com/agentwik-labs/skillyard `examples/bad` and `examples/good` at commit
`83ee69064aaa5934bc92ecafc66cc4818dff0bbb` (MIT, Copyright (c) 2026 Skillyard contributors; see `LICENSE` here and
`THIRD_PARTY_NOTICES.md` at the repo root). Each file was fetched with
`gh api repos/agentwik-labs/skillyard/contents/<path>?ref=<sha> -H "Accept: application/vnd.github.raw"`.

These files are data for `test/scan/corpus.test.ts`. Nothing in them is ever run. The three scripts upstream marks
executable (`bad/env-doctor/scripts/diagnose.py`, `bad/lint-everything/scripts/setup.sh`,
`good/env-doctor/scripts/diagnose.py`) are committed without the executable bit; the scanner classifies them by
extension and shebang, not mode.

## Substitution

Every file is byte-identical to upstream except one. `bad/billing-reports/SKILL.md` has a secret-shaped example key
on line 13 (an `sk-` key that matches `secrets/ai-key`). It is committed as the placeholder `{{SKILLYARD_FAKE_KEY}}`
so that GitHub push protection and secret scanners don't flag this repo. `materializeSkillyard` in
`test/fixtures/rules/make-secrets.ts` (Task 1's generator approach) copies this folder to a temp dir and restores the
upstream text from split parts. A test checks that the restored file's git blob SHA equals upstream's
(`f6390d0cde5edd4f7154269117ece85d7ddcba4a`).

Not copied: upstream `examples/README.md` and `examples/catalog.json`, which the tests don't use.
