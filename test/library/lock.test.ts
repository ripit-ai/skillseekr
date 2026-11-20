import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpDir } from '../helpers/tmp.js';
import { acquireLock, readLock, LockBusyError, lockHooks } from '../../src/library/lock.js';
import type { Ctx } from '../../src/context.js';

const ctx = { now: () => 0 } as unknown as Ctx;
const realAlive = lockHooks.isAlive;
afterEach(() => { lockHooks.isAlive = realAlive; });

describe('lock', () => {
  it('second acquire while held throws LockBusyError; release removes the file', async () => {
    const dir = await tmpDir();
    const release = await acquireLock(dir, ctx);
    expect((await readLock(dir))?.alive).toBe(true);
    await expect(acquireLock(dir, ctx)).rejects.toBeInstanceOf(LockBusyError);
    await release();
    expect(existsSync(`${dir}/.lock`)).toBe(false);
    expect(await readLock(dir)).toBeUndefined();
  });
  it('takes over a dead holder', async () => {
    const dir = await tmpDir();
    await acquireLock(dir, ctx);
    lockHooks.isAlive = () => false;
    const release = await acquireLock(dir, ctx);
    await release();
    expect(existsSync(`${dir}/.lock`)).toBe(false);
  });
});
