import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

/** Vitest globalSetup: builds dist/ once, before any test file runs, so no two tsc runs overlap and no test sees a stale dist. */
export default async function setup(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  await promisify(execFile)(pnpm, ['--silent', 'run', 'build'], { cwd: root });
}
