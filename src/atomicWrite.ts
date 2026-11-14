import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The target is a dangling symlink or can't be resolved: replacing it could clobber something unexpected. */
export class UnsafeWriteError extends Error {
  constructor(message: string) { super(message); this.name = 'UnsafeWriteError'; }
}

/**
 * Writes a user-owned file atomically: follows a symlinked path, keeps the existing file mode
 * (new files get `defaultMode`), and renames a temp file beside the real target.
 */
export async function writeFileAtomic(file: string, data: string, opts: { defaultMode?: number } = {}): Promise<void> {
  let target = file;
  let mode = opts.defaultMode ?? 0o600;
  let present = true;
  try { await lstat(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    present = false;
  }
  if (present) {
    try {
      target = await realpath(file);
      mode = (await stat(target)).mode & 0o7777;
    } catch (e) {
      throw new UnsafeWriteError(`cannot write ${file}: it is a dangling symlink or unreadable (${(e as NodeJS.ErrnoException).code ?? 'error'}); refusing to replace it`);
    }
  }
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await writeFile(tmp, data, { mode });
    await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}
