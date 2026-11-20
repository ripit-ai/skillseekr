import { expect } from 'vitest';
import type { Ctx } from '../../src/context.js';
import { pullLibrary, type PullResult } from '../../src/library/pull.js';

/** Runs a pull and fails the test if it aborted. */
export async function pull(ctx: Ctx): Promise<PullResult> {
  const r = await pullLibrary(ctx);
  expect(r.aborted, `pull aborted: ${JSON.stringify(r.problems)}`).toBe(false);
  return r;
}
