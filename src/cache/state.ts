import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Small JSON records under <cacheDir>/state/, one file per key. The file name is a hash of the
// key, so keys (which hold refs like "feature/x" or untrusted names) can never form a path.
function stateFile(cacheDir: string, key: string): string {
  return join(cacheDir, 'state', `${createHash('sha256').update(key).digest('hex')}.json`);
}

export async function readState<T>(cacheDir: string, key: string): Promise<T | undefined> {
  let text: string;
  try { text = await readFile(stateFile(cacheDir, key), 'utf8'); } catch { return undefined; }
  try {
    const rec = JSON.parse(text) as { key?: unknown; value?: T };
    return rec.key === key ? rec.value : undefined;
  } catch { return undefined; }
}

/** Atomic: a unique temp file in the same dir, then rename over the target (readers never see a partial file). */
export async function writeState(cacheDir: string, key: string, value: unknown): Promise<void> {
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const file = stateFile(cacheDir, key);
  await mkdir(join(cacheDir, 'state'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, JSON.stringify({ key, value }), { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/**
 * checkedAt and now in ms (ctx.now()); fresh while less than ttlSeconds have passed. ttl 0 is never
 * fresh, and neither is a checkedAt in the future (clock went back, or a bogus record).
 */
export function isFresh(checkedAt: number, ttlSeconds: number, now: number): boolean {
  const age = now - checkedAt;
  return age >= 0 && age < ttlSeconds * 1000;
}
