import type { Ctx } from '../context.js';
import { blockedReason, type Catalog } from '../catalog/catalog.js';
import { contentHash } from '../catalog/hash.js';
import { evaluate, type Security } from '../policy/evaluate.js';
import { cachedScan } from '../scan/cache.js';
import { qualityFindings, readSkillMd } from '../scan/quality.js';
import { scanSkillDir, UNSCANNABLE_RULE, type Finding } from '../scan/scan.js';
import type { Installed } from './installer.js';

/**
 * Verdict for an installed copy: scans what is on disk now (cached by its actual content hash), then evaluates with
 * the catalog's policy under the marker's id. No signature check. Never throws: a failure is a blocked verdict.
 */
export async function securityOfInstalled(i: Installed, catalog: Catalog, _ctx: Ctx, known?: { hash: string; files: string[] }): Promise<Security> {
  const id = i.marker.id;
  try {
    const { hash, files } = known ?? await contentHash(i.dir);
    const scan = () => scanSkillDir(i.dir, files);
    const findings: Finding[] = [...(catalog.cacheDir !== undefined ? await cachedScan(catalog.cacheDir, hash, scan) : await scan()).findings];
    const inCatalog = catalog.byId(id);
    const quality = await qualityFindings({ description: inCatalog?.description ?? '', dir: i.dir, files }, await readSkillMd(i.dir));
    // An installed copy has no parsed description; without the catalog's, skip the description checks.
    findings.push(...(inCatalog ? quality : quality.filter((f) => !f.rule.startsWith('quality/description-'))));
    return evaluate({ id, contentHash: hash }, findings, catalog.policy);
  } catch (e) {
    const finding: Finding = { rule: UNSCANNABLE_RULE, severity: 'critical', file: 'SKILL.md', line: 1, message: `scan failed: ${e instanceof Error ? e.message : String(e)}` };
    return { status: 'blocked', findings: [finding], blockedBy: { kind: 'scan', rules: [UNSCANNABLE_RULE] } };
  }
}

/** `blockedReason` plus how to get rid of a blocked installed copy. */
export function removeHint(i: Installed): string {
  return `remove it with: skillseekr remove ${i.name}${i.scope === 'user' ? ' --user' : ''}`;
}
