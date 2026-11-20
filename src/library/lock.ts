import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

/** Takes `<libDir>/.lock`. A dead holder is taken over once; a live one throws LockBusyError. */
export async function acquireLock(libDir: string, ctx: Ctx): Promise<() => Promise<void>> {
  const file = lockFile(libDir);
  await mkdir(libDir, { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ pid: process.pid, at: new Date(ctx.now()).toISOString() });
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(file, body, { flag: 'wx', mode: 0o600 });
      return () => rm(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const held = await readLock(libDir);
      if (held?.alive) throw new LockBusyError(held.pid);
      if (attempt > 0) throw new LockBusyError(held?.pid ?? 0);
      await rm(file, { force: true });
    }
  }
}
