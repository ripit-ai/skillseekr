import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contentHash } from '../catalog/hash.js';
import type { Manifest } from './manifest.js';

export const textHash = (text: string | Buffer): string => `sha256:${createHash('sha256').update(text).digest('hex')}`;

const isDir = async (p: string): Promise<boolean> => { try { return (await lstat(p)).isDirectory(); } catch { return false; } };

/**
 * Library-relative folders that are missing or hold a skill whose files no longer match its contentHash,
 * plus include files whose text no longer matches its textHash.
 */
export async function verifyFolders(libDir: string, m: Manifest): Promise<string[]> {
  const bad = new Set<string>();
  for (const s of m.sources) {
    if (!s.folder || bad.has(s.folder)) continue;
    if (!(await isDir(join(libDir, s.folder)))) { bad.add(s.folder); continue; }
    for (const k of s.skills) {
      const ok = await contentHash(join(libDir, k.dir)).then((h) => h.hash === k.contentHash, () => false);
      if (!ok) { bad.add(s.folder); break; }
    }
  }
  for (const i of m.includes) {
    if (!i.file) continue;
    const ok = await readFile(join(libDir, i.file)).then((t) => textHash(t) === i.textHash, () => false);
    if (!ok) bad.add(i.file);
  }
  return [...bad];
}
