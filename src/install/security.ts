import { open, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../context.js';
import type { Catalog } from '../catalog/catalog.js';
import { contentHash } from '../catalog/hash.js';
import { MAX_FILE_BYTES } from '../catalog/limits.js';
import { evaluate, type Security } from '../policy/evaluate.js';
import { cachedScan } from '../scan/cache.js';
import { qualityFindings } from '../scan/quality.js';
import { scanSkillDir, UNSCANNABLE_RULE, type Finding } from '../scan/scan.js';
import type { Installed } from './installer.js';

async function readSkillMd(dir: string): Promise<string> {
  try {
    const file = join(dir, 'SKILL.md');
    if (!(await lstat(file)).isFile()) return '';
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
  } catch { return ''; }
}

/**
 * Verdict for an installed copy: scans what is on disk now (cached by its actual content hash), then evaluates with
 * the catalog's policy under the marker's id. No signature check. Never throws: a failure is a blocked verdict.
 */
export async function securityOfInstalled(i: Installed, catalog: Catalog, _ctx: Ctx): Promise<Security> {
  const id = i.marker.id;
  try {
    const { hash, files } = await contentHash(i.dir);
    const scan = () => scanSkillDir(i.dir, files);
    const findings: Finding[] = [...(catalog.cacheDir !== undefined ? await cachedScan(catalog.cacheDir, hash, scan) : await scan()).findings];
    const known = catalog.byId(id);
    const quality = await qualityFindings({ description: known?.description ?? '', dir: i.dir, files }, await readSkillMd(i.dir));
    // An installed copy has no parsed description; without the catalog's, skip the description checks.
    findings.push(...(known ? quality : quality.filter((f) => !f.rule.startsWith('quality/description-'))));
    return evaluate({ id, contentHash: hash }, findings, catalog.policy);
  } catch (e) {
    const finding: Finding = { rule: UNSCANNABLE_RULE, severity: 'critical', file: 'SKILL.md', line: 1, message: `scan failed: ${e instanceof Error ? e.message : String(e)}` };
    return { status: 'blocked', findings: [finding], blockedBy: { kind: 'scan', rules: [UNSCANNABLE_RULE] } };
  }
}

/** Message part naming why a verdict blocks: `rule file:line` of the first critical finding, or `deny: <reason>`. */
export function blockReason(s: Security): string {
  if (s.blockedBy?.kind === 'deny') return `deny: ${s.blockedBy.entry.reason}`;
  const f = s.findings.find((x) => x.severity === 'critical');
  return f ? `${f.rule} ${f.file}:${f.line}` : 'blocked';
}
