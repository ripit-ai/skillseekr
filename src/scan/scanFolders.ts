// Read-only scan of folders outside the catalog: no policy, so findings are the scanner's own. Quality findings are
// reported apart and never set the status (P2-R20).
import { lstat, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { discoverSkills } from '../catalog/discover.js';
import { parseFrontmatter } from '../catalog/frontmatter.js';
import { contentHash } from '../catalog/hash.js';
import { cachedScan } from './cache.js';
import { qualityFindings, readSkillMd } from './quality.js';
import { scanSkillDir, type Finding } from './scan.js';

export interface ScannedSkill { target: string; skill: string; dir: string; status: 'critical' | 'warning' | 'clean'; findings: Finding[]; quality: Finding[] }

export const statusOf = (findings: Finding[]): ScannedSkill['status'] =>
  findings.some((f) => f.severity === 'critical') ? 'critical' : findings.length > 0 ? 'warning' : 'clean';

async function scanOne(target: string, id: string, dir: string, description: string, hash: string, files: string[], cacheDir?: string): Promise<ScannedSkill> {
  const scan = () => scanSkillDir(dir, files);
  const findings = [...(cacheDir !== undefined ? await cachedScan(cacheDir, hash, scan) : await scan()).findings];
  const quality = await qualityFindings({ description, dir, files }, await readSkillMd(dir));
  return { target, skill: id, dir, status: statusOf(findings), findings, quality };
}

/** `dir` is a skill folder (has SKILL.md) or a skills root. Never writes into `dir`; `cacheDir` is where results are cached. */
export async function scanFolder(target: string, dir: string, cacheDir?: string): Promise<ScannedSkill[]> {
  let isSkill = false;
  try { isSkill = (await lstat(join(dir, 'SKILL.md'))).isFile(); } catch { /* a root */ }
  if (!isSkill) {
    const out: ScannedSkill[] = [];
    for (const s of await discoverSkills(dir, '')) out.push(await scanOne(target, s.id, s.dir, s.description, s.contentHash, s.files, cacheDir));
    return out;
  }
  const fm = parseFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8').catch(() => ''));
  const description = fm.ok && typeof fm.data.description === 'string' ? fm.data.description : '';
  const { hash, files } = await contentHash(dir);
  return [await scanOne(target, basename(dir), dir, description, hash, files, cacheDir)];
}
