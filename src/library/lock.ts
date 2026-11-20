import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Ctx } from '../context.js';

/** Replaceable in tests. */
export const lockHooks = {
  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
};

export class LockBusyError extends Error {
  constructor(public pid: number) {
    super(`another skillseekr update is running (pid ${pid})`);
    this.name = 'LockBusyError';
  }
}

const lockFile = (libDir: string): string => join(libDir, '.lock');

export async function readLock(libDir: string): Promise<{ pid: number; at: string; alive: boolean } | undefined> {
  try {
    const j = JSON.parse(await readFile(lockFile(libDir), 'utf8')) as { pid?: unknown; at?: unknown };
    if (typeof j.pid !== 'number' || typeof j.at !== 'string') return undefined;
    return { pid: j.pid, at: j.at, alive: lockHooks.isAlive(j.pid) };
  } catch {
    return undefined;
  }
}

const tmpName = (file: string, tag: string): string => `${file}.${tag}-${process.pid}-${randomBytes(6).toString('hex')}`;

/** Takes `<libDir>/.lock`. A dead holder is taken over once; a live one throws LockBusyError. */
export async function acquireLock(libDir: string, ctx: Ctx): Promise<() => Promise<void>> {
  const file = lockFile(libDir);
  await mkdir(libDir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ pid: process.pid, at: new Date(ctx.now()).toISOString() });
  // Written in full to a temp file, then hard-linked into place: the lock never exists partially written.
  const create = async (): Promise<boolean> => {
    const tmp = tmpName(file, 'tmp');
    try {
      await writeFile(tmp, body, { mode: 0o600 });
      await link(tmp, file);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }
  };
  const release = async (): Promise<void> => {
    // Only remove the lock if it is still ours (it may have been taken over after we were judged dead).
    const held = await readLock(libDir);
    if (held?.pid === process.pid) await rm(file, { force: true });
  };

  if (await create()) return release;
  const held = await readLock(libDir);
  if (held?.alive) throw new LockBusyError(held.pid);
  // Stale (dead holder or corrupt file): move it aside atomically, so only one contender can win it.
  const aside = tmpName(file, 'stale');
  try {
    await rename(file, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    throw new LockBusyError(held?.pid ?? 0); // someone else took it over first
  }
  const moved = await readFile(aside, 'utf8').then((t) => { try { return JSON.parse(t) as { pid?: unknown }; } catch { return undefined; } }, () => undefined);
  if (moved?.pid !== held?.pid) {
    // We moved a different (possibly live) lock than the one we judged stale: put it back.
    await link(aside, file).catch(() => {});
    await rm(aside, { force: true }).catch(() => {});
    throw new LockBusyError(typeof moved?.pid === 'number' ? moved.pid : 0);
  }
  await rm(aside, { force: true }).catch(() => {});
  if (await create()) return release;
  const now = await readLock(libDir);
  throw new LockBusyError(now?.pid ?? 0);
}
