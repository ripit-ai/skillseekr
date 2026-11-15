import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { contentHash } from './hash.js';
import { MAX_FILE_BYTES } from './limits.js';

export interface DiscoveredSkill {
  id: string;
  name: string;
  description: string;
  dir: string;
  files: string[];
  contentHash: string;
  warnings: string[];
}

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Finds skills under treeRoot/skillsDir. Never follows symlinks; never throws for bad input. */
export async function discoverSkills(treeRoot: string, skillsDir: string): Promise<DiscoveredSkill[]> {
  const norm = skillsDir.replace(/\\/g, '/');
  // Leading/trailing slashes are stripped (the path stays under treeRoot); drive-letter paths are refused.
  if (/^[A-Za-z]:/.test(norm)) return [];
  const parts = norm.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) return [];

  // Every component from the tree root down must be a real directory (no symlinks).
  let root = treeRoot;
  try {
    if (!(await lstat(root)).isDirectory()) return [];
    for (const p of parts) {
      root = join(root, p);
      if (!(await lstat(root)).isDirectory()) return [];
    }
  } catch {
    return [];
  }

  const found: DiscoveredSkill[] = [];
  async function walk(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return; // unreadable or vanished directory: skip it, keep going
    }
    if (rel !== '' && entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      try {
        found.push(await build(abs, rel));
      } catch {
        // unreadable SKILL.md or file vanished mid-walk: skip this skill
      }
      return; // prune: shallowest wins
    }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(abs, e.name), rel ? `${rel}/${e.name}` : e.name);
    }
  }
  await walk(root, '');
  return found.sort((a, b) => byCodeUnit(a.id, b.id));
}

async function build(dir: string, id: string): Promise<DiscoveredSkill> {
  const folder = basename(dir);
  const warnings: string[] = [];
  let name = folder;
  let description = '';
  const size = (await lstat(join(dir, 'SKILL.md'))).size;
  if (size > MAX_FILE_BYTES) {
    warnings.push(`SKILL.md is larger than 1 MB (${size} bytes); frontmatter not read`);
    const { hash, files } = await contentHash(dir);
    return { id, name, description, dir, files, contentHash: hash, warnings };
  }
  const fm = parseFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8'));
  if (!fm.ok) {
    warnings.push('missing frontmatter');
  } else {
    if (fm.lenient) warnings.push('frontmatter is not strict YAML');
    const n = typeof fm.data.name === 'string' ? fm.data.name.trim() : '';
    if (n !== '') {
      name = n;
      if (n !== folder) warnings.push(`name mismatch: frontmatter name "${n}" does not match folder "${folder}"`);
    } else {
      warnings.push(`missing name in frontmatter; using folder name "${folder}"`);
    }
  }
  if (fm.ok) {
    if (typeof fm.data.description === 'string' && fm.data.description.trim() !== '') description = fm.data.description;
    else warnings.push('missing description in frontmatter');
  }
  const { hash, files } = await contentHash(dir);
  return { id, name, description, dir, files, contentHash: hash, warnings };
}
