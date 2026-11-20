import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
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

describe('lock races', () => {
  it('concurrent acquires: exactly one wins, no temp files left', async () => {
    const dir = await tmpDir();
    const rs = await Promise.allSettled(Array.from({ length: 10 }, () => acquireLock(dir, ctx)));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of rs) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(LockBusyError);
    expect(readdirSync(dir).filter((f) => f.startsWith('.lock'))).toEqual(['.lock']);
    expect((await readLock(dir))?.pid).toBe(process.pid);
  });
  it('lock content is complete as soon as the file exists', async () => {
    const dir = await tmpDir();
    await acquireLock(dir, ctx);
    expect(JSON.parse(readFileSync(`${dir}/.lock`, 'utf8'))).toMatchObject({ pid: process.pid });
  });
  it('takeover does not delete a live lock that replaced the dead one meanwhile', async () => {
    const dir = await tmpDir();
    writeFileSync(`${dir}/.lock`, JSON.stringify({ pid: 111, at: 'x' }));
    lockHooks.isAlive = (pid) => {
      if (pid === 111) writeFileSync(`${dir}/.lock`, JSON.stringify({ pid: 222, at: 'y' })); // replaced mid-check
      return pid === 222;
    };
    await expect(acquireLock(dir, ctx)).rejects.toBeInstanceOf(LockBusyError);
    expect(JSON.parse(readFileSync(`${dir}/.lock`, 'utf8')).pid).toBe(222);
  });
  it('release leaves a lock that now belongs to someone else', async () => {
    const dir = await tmpDir();
    const release = await acquireLock(dir, ctx);
    writeFileSync(`${dir}/.lock`, JSON.stringify({ pid: 999999, at: 'z' }));
    await release();
    expect(existsSync(`${dir}/.lock`)).toBe(true);
  });
});
