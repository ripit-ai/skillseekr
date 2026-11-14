import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER = '.skillseekr.json';

/** Sorted POSIX relative paths of regular files under dir (symlinks skipped), excluding the root marker. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    for (const e of await readdir(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(join(abs, e.name), r);
      else if (e.isFile() && r !== MARKER) out.push(r);
    }
  }
  await walk(dir, '');
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export async function contentHash(dir: string): Promise<{ hash: string; files: string[] }> {
  const files = await listFiles(dir);
  const h = createHash('sha256');
  for (const f of files) {
    const digest = createHash('sha256').update(await readFile(join(dir, f))).digest('hex');
    h.update(`${f}\0${digest}\n`);
  }
  return { hash: `sha256:${h.digest('hex')}`, files };
}
