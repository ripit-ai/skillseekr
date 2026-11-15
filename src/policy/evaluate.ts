import type { Finding } from '../scan/scan.js';
import type { AllowEntry, BlockEntry, Policy, PolicySource } from './types.js';

export type SecurityStatus = 'clean' | 'warned' | 'allowed' | 'blocked';
export interface Security {
  status: SecurityStatus;
  findings: Finding[]; // scan + integrity (P2-R20: quality findings are kept apart, on SkillRecord.quality)
  blockedBy?: { kind: 'scan'; rules: string[] } | { kind: 'deny'; entry: BlockEntry; source: PolicySource };
  allowedBy?: { label: string /* 'user' | include name */; rules: string[]; added: string; reason: string };
  note?: string; // e.g. why a present allow entry didn't apply
}

export const CLEAN: Security = Object.freeze({ status: 'clean', findings: Object.freeze([]) as unknown as Finding[] });

/** Pure: turns findings and the block/allow policy into a skill's Security verdict. */
export function evaluate(skill: { id: string; contentHash: string }, findings: Finding[], policy: Policy): Security {
  for (const s of policy.sources) {
    for (const entry of s.block) {
      if (('id' in entry && entry.id === skill.id) || ('content_hash' in entry && entry.content_hash === skill.contentHash)) {
        return { status: 'blocked', findings, blockedBy: { kind: 'deny', entry, source: s.source } };
      }
    }
  }

  const crit = [...new Set(findings.filter((f) => f.severity === 'critical').map((f) => f.rule))];
  if (crit.length === 0) return findings.length > 0 ? { status: 'warned', findings } : { status: 'clean', findings };

  let note: string | undefined;
  for (const s of policy.sources) {
    const entry: AllowEntry | undefined = Object.hasOwn(s.allow, skill.id) ? s.allow[skill.id] : undefined;
    if (!entry) continue;
    if (entry.content_hash !== skill.contentHash) { note ??= 'content changed since allowed'; continue; }
    const missing = crit.filter((r) => !entry.rules.includes(r));
    if (missing.length > 0) { note ??= `allow entry does not cover ${missing.join(', ')}`; continue; }
    const label = s.source.kind === 'local' ? 'user' : s.source.name;
    return { status: 'allowed', findings, allowedBy: { label, rules: [...entry.rules], added: entry.added, reason: entry.reason } };
  }

  const out: Security = { status: 'blocked', findings, blockedBy: { kind: 'scan', rules: crit } };
  if (note !== undefined) out.note = note;
  return out;
}
