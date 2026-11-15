import { describe, it, expect } from 'vitest';
import { evaluate, CLEAN } from '../../src/policy/evaluate.js';
import type { Finding } from '../../src/scan/scan.js';
import type { AllowEntry, BlockEntry, Policy, PolicySource } from '../../src/policy/types.js';

const H = `sha256:${'a'.repeat(64)}`;
const H2 = `sha256:${'a'.repeat(63)}b`;
const skill = { id: 'o/skill', contentHash: H };
const crit = (rule: string): Finding => ({ rule, severity: 'critical', file: 'SKILL.md', line: 1, message: 'm' });
const warn = (rule: string): Finding => ({ rule, severity: 'warning', file: 'SKILL.md', line: 2, message: 'm' });
const downgraded = (rule: string): Finding => ({ ...crit(rule), severity: 'warning', downgraded: 'in quotation marks' });
const local: PolicySource = { kind: 'local', file: '/c.jsonc' };
const inc: PolicySource = { kind: 'include', name: 'corp', via: ['corp'], file: '/r.jsonc' };
const allow = (over: Partial<AllowEntry> = {}): AllowEntry => ({ content_hash: H, rules: ['a/1'], reason: 'ok', added: '2026-11-14', ...over });
const pol = (...s: Array<{ source: PolicySource; allow?: Record<string, AllowEntry>; block?: BlockEntry[] }>): Policy =>
  ({ sources: s.map((x) => ({ source: x.source, allow: x.allow ?? {}, block: x.block ?? [] })), trust: [] });

describe('evaluate', () => {
  it('no findings is clean; warnings only is warned', () => {
    expect(evaluate(skill, [], pol())).toEqual({ status: 'clean', findings: [] });
    const w = [warn('w/1'), downgraded('a/1')];
    expect(evaluate(skill, w, pol())).toEqual({ status: 'warned', findings: w });
  });

  it('CLEAN is frozen', () => {
    expect(CLEAN).toEqual({ status: 'clean', findings: [] });
    expect(Object.isFrozen(CLEAN)).toBe(true);
  });

  it('a critical finding blocks by scan with distinct rules', () => {
    const f = [crit('a/1'), crit('a/1'), crit('b/2')];
    expect(evaluate(skill, f, pol())).toEqual({ status: 'blocked', findings: f, blockedBy: { kind: 'scan', rules: ['a/1', 'b/2'] } });
  });

  it('allow with right hash and rules lifts the block (extra rules fine)', () => {
    const f = [crit('a/1')];
    const p = pol({ source: local, allow: { 'o/skill': allow({ rules: ['a/1', 'z/9'] }) } });
    expect(evaluate(skill, f, p)).toEqual({
      status: 'allowed', findings: f,
      allowedBy: { label: 'user', rules: ['a/1', 'z/9'], added: '2026-11-14', reason: 'ok' },
    });
  });

  it('hash differing by one character does not lift; note names content change', () => {
    const r = evaluate(skill, [crit('a/1')], pol({ source: local, allow: { 'o/skill': allow({ content_hash: H2 }) } }));
    expect(r.status).toBe('blocked');
    expect(r.blockedBy).toEqual({ kind: 'scan', rules: ['a/1'] });
    expect(r.note).toMatch(/content changed since allowed/);
  });

  it('a new critical rule not in rules keeps it blocked; note names it', () => {
    const r = evaluate(skill, [crit('a/1'), crit('b/2')], pol({ source: local, allow: { 'o/skill': allow() } }));
    expect(r.status).toBe('blocked');
    expect(r.note).toMatch(/allow entry does not cover b\/2/);
  });

  it('downgraded findings never block or count as critical rules', () => {
    const r = evaluate(skill, [crit('a/1'), downgraded('b/2')], pol({ source: local, allow: { 'o/skill': allow() } }));
    expect(r.status).toBe('allowed');
  });

  it('deny by id beats a matching allow', () => {
    const entry: BlockEntry = { id: 'o/skill', reason: 'bad', added: 'd' };
    const p = pol({ source: local, allow: { 'o/skill': allow() }, block: [entry] });
    expect(evaluate(skill, [crit('a/1')], p)).toMatchObject({ status: 'blocked', blockedBy: { kind: 'deny', entry, source: local } });
  });

  it('deny blocks even a clean skill; by content_hash under a different id', () => {
    const entry: BlockEntry = { content_hash: H, reason: 'bad', added: 'd' };
    const r = evaluate({ id: 'other/id', contentHash: H }, [], pol({ source: inc, block: [entry] }));
    expect(r).toEqual({ status: 'blocked', findings: [], blockedBy: { kind: 'deny', entry, source: inc } });
  });

  it('first deny match in source order wins', () => {
    const a: BlockEntry = { id: 'o/skill', reason: 'local', added: 'd' };
    const b: BlockEntry = { id: 'o/skill', reason: 'inc', added: 'd' };
    const r = evaluate(skill, [], pol({ source: local, block: [a] }, { source: inc, block: [b] }));
    expect(r.blockedBy).toMatchObject({ entry: a, source: local });
  });

  it('allowedBy.label is user for local and the include name for an include', () => {
    const p = pol({ source: inc, allow: { 'o/skill': allow() } });
    expect(evaluate(skill, [crit('a/1')], p).allowedBy?.label).toBe('corp');
  });

  it('local allow wins over an include allow; a failing local falls through to an applying include', () => {
    const both = pol({ source: local, allow: { 'o/skill': allow({ reason: 'L' }) } }, { source: inc, allow: { 'o/skill': allow({ reason: 'I' }) } });
    expect(evaluate(skill, [crit('a/1')], both).allowedBy).toMatchObject({ label: 'user', reason: 'L' });
    const fall = pol({ source: local, allow: { 'o/skill': allow({ content_hash: H2 }) } }, { source: inc, allow: { 'o/skill': allow({ reason: 'I' }) } });
    const r = evaluate(skill, [crit('a/1')], fall);
    expect(r.status).toBe('allowed');
    expect(r.allowedBy).toMatchObject({ label: 'corp', reason: 'I' });
    expect(r.note).toBeUndefined();
  });

  it('note explains the first non-applying entry, local first', () => {
    const p = pol({ source: local, allow: { 'o/skill': allow({ content_hash: H2 }) } }, { source: inc, allow: { 'o/skill': allow({ rules: [] }) } });
    expect(evaluate(skill, [crit('a/1')], p).note).toMatch(/content changed/);
  });

  it('integrity/signature can be allowed like any other critical finding', () => {
    const p = pol({ source: local, allow: { 'o/skill': allow({ rules: ['integrity/signature'] }) } });
    expect(evaluate(skill, [crit('integrity/signature')], p).status).toBe('allowed');
  });

  it('allow entries for other ids and inherited keys are ignored', () => {
    const p = pol({ source: local, allow: { 'x/y': allow() } });
    const r = evaluate({ id: 'toString', contentHash: H }, [crit('a/1')], p);
    expect(r.status).toBe('blocked');
    expect(r.note).toBeUndefined();
  });

  it('block beats allow across sources, in either order', () => {
    const f = [crit('a/1')];
    const block: BlockEntry[] = [{ id: 'o/skill', reason: 'incident', added: '2026-11-14' }];
    const okAllow = { 'o/skill': allow() };
    // include block, local allow
    const r1 = evaluate(skill, f, pol({ source: local, allow: okAllow }, { source: inc, block }));
    expect(r1).toMatchObject({ status: 'blocked', blockedBy: { kind: 'deny', entry: block[0], source: inc } });
    expect(r1.allowedBy).toBeUndefined();
    // local block, include allow
    const r2 = evaluate(skill, f, pol({ source: local, block }, { source: inc, allow: okAllow }));
    expect(r2).toMatchObject({ status: 'blocked', blockedBy: { kind: 'deny', entry: block[0], source: local } });
    expect(r2.allowedBy).toBeUndefined();
  });
});
