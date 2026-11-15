/**
 * Wall-clock budget for the scanner's "stays bounded" tests. These tests exist to catch super-linear regexes
 * (earlier regressions took 25 s to minutes on the same inputs), not to benchmark hardware. Locally the design
 * target of 2 s per skill applies; shared CI runners are 2-4x slower and run test files in parallel, so CI gets a
 * looser ceiling that still fails any catastrophic backtracking. Override with SKILLSEEKR_SCAN_BUDGET_MS.
 */
export const SCAN_BUDGET_MS = Number(process.env.SKILLSEEKR_SCAN_BUDGET_MS ?? (process.env.CI ? 15_000 : 2_000));
/** Per-test timeout for those tests: comfortably above the budget so the assertion, not the timeout, reports. */
export const SCAN_TEST_TIMEOUT_MS = Math.max(60_000, SCAN_BUDGET_MS * 8);
