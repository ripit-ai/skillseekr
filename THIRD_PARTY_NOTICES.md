# Third-party notices

skillseekr includes code ported from, and test fixtures copied from, third-party projects. Their licences follow.

## skillyard

- Project: https://github.com/agentwik-labs/skillyard
- Commit: `83ee69064aaa5934bc92ecafc66cc4818dff0bbb`
- Licence: MIT
- Copyright (c) 2026 Skillyard contributors

### Ported code

These files re-implement upstream code. Each one has a header comment naming the upstream file and commit.

| skillseekr file | Upstream file (at 83ee690) | What was ported |
|---|---|---|
| `src/scan/rules.ts` | `src/scan.js`, `src/secure.js` | The scan rule patterns, severities and targets |
| `src/scan/context.ts` | `src/scan.js` | `fencedLines`, `looksBenign` and `DEFENSIVE_RE`: the context-aware downgrade |
| `src/scan/scan.ts` | `src/scan.js` | The structure of `scanFiles`: per-file classification, per-line rule loop, finding caps |

### Test fixtures

Copied unchanged from upstream `examples/` into `test/fixtures/skillyard/`, except for one substitution: the
secret-shaped example key in `bad/billing-reports/SKILL.md` is committed as a placeholder and restored at test
time (see `test/fixtures/skillyard/README.md`). Upstream's `LICENSE` is copied to `test/fixtures/skillyard/LICENSE`.

- `test/fixtures/skillyard/bad/billing-reports/SKILL.md`
- `test/fixtures/skillyard/bad/engineering-handbook/SKILL.md`
- `test/fixtures/skillyard/bad/env-doctor/SKILL.md`
- `test/fixtures/skillyard/bad/env-doctor/scripts/diagnose.py`
- `test/fixtures/skillyard/bad/fast-refactor/SKILL.md`
- `test/fixtures/skillyard/bad/lint-everything/SKILL.md`
- `test/fixtures/skillyard/bad/lint-everything/scripts/setup.sh`
- `test/fixtures/skillyard/bad/notes-v2/SKILL.md`
- `test/fixtures/skillyard/bad/notes-v2/evals/evals.json`
- `test/fixtures/skillyard/bad/quick-commits/SKILL.md`
- `test/fixtures/skillyard/bad/quick-commits/evals/evals.json`
- `test/fixtures/skillyard/bad/readme-polisher/SKILL.md`
- `test/fixtures/skillyard/bad/schema-check/SKILL.md`
- `test/fixtures/skillyard/bad/sql-helper/SKILL.md`
- `test/fixtures/skillyard/bad/strict-reviewer/SKILL.md`
- `test/fixtures/skillyard/bad/team-helper/SKILL.md`
- `test/fixtures/skillyard/good/api-error-format/SKILL.md`
- `test/fixtures/skillyard/good/billing-reports/SKILL.md`
- `test/fixtures/skillyard/good/env-doctor/SKILL.md`
- `test/fixtures/skillyard/good/env-doctor/scripts/diagnose.py`
- `test/fixtures/skillyard/good/lint-everything/SKILL.md`
- `test/fixtures/skillyard/good/readme-polisher/SKILL.md`

### Licence text

```text
MIT License

Copyright (c) 2026 Skillyard contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
