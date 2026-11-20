import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { OLD_PREFIX, STAGING } from './layout.js';

/** Top-level library folders that hold fetched content (everything else is ours: manifest, lock, staging). */
const CONTENT_ROOTS = ['github', 'http', 'registries'];

const rmrf = (p: string) => rm(p, { recursive: true, force: true, maxRetries: 3 });

/** Removes `.staging` and every `.old-*` left by an interrupted run. Best effort. */
export async function cleanLeftovers(libDir: string): Promise<void> {
  const names = await readdir(libDir).catch(() => [] as string[]);
  await Promise.all(names.filter((n) => n === STAGING || n.startsWith(OLD_PREFIX)).map((n) => rmrf(join(libDir, n)).catch(() => {})));
}

/**
 * Moves a staged folder or file to `<libDir>/<rel>`. The current one (if any) is renamed to `.old-*`
 * first and put back if the move fails. Returns the `.old-*` path to delete later, or undefined.
 */
export async function swapIn(libDir: string, staged: string, rel: string): Promise<string | undefined> {
  const target = join(libDir, rel);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const old = join(libDir, `${OLD_PREFIX}${randomBytes(6).toString('hex')}`);
  let moved = false;
  try {
    await rename(target, old);
    moved = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  try {
    await rename(staged, target);
  } catch (e) {
    if (moved) await rename(old, target).catch(() => {});
    throw e;
  }
  return moved ? old : undefined;
}

export const removeOld = (paths: string[]) => Promise.all(paths.map((p) => rmrf(p).catch(() => {})));

/**
 * Deletes everything under the content roots that is neither a kept path nor an ancestor of one.
 * Symlinked folders are removed, never followed. Returns the paths it could not remove.
 */
export async function prune(libDir: string, keep: Iterable<string>): Promise<string[]> {
  const kept = new Set(keep);
  const ancestors = new Set<string>();
  for (const k of kept) {
    const parts = k.split('/');
    for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join('/'));
  }
  const failed: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(join(libDir, rel), { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = `${rel}/${e.name}`;
      if (kept.has(r)) continue;
      if (ancestors.has(r) && e.isDirectory()) await walk(r);
      else await rmrf(join(libDir, r)).catch(() => failed.push(r));
    }
  };
  for (const root of CONTENT_ROOTS) {
    if (kept.has(root)) continue;
    if (ancestors.has(root)) await walk(root);
    else await rmrf(join(libDir, root)).catch(() => failed.push(root));
  }
  return failed;
}
