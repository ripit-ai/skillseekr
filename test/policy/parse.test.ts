import { describe, it, expect } from 'vitest';
import { parseTree } from 'jsonc-parser';
import { parsePolicy } from '../../src/policy/parse.js';

const H = `sha256:${'a'.repeat(64)}`;
const KEY = `ed25519:${'A'.repeat(43)}`;
const run = (v: unknown) => parsePolicy(parseTree(JSON.stringify(v)), '/c.jsonc');

describe('parsePolicy', () => {
  it('missing keys and no root give empty values', () => {
    expect(parsePolicy(undefined, 'f')).toEqual({ policy: { allow: {}, block: [], trust: [] }, problems: [] });
    expect(run({}).policy).toEqual({ allow: {}, block: [], trust: [] });
  });

  it('parses valid allow, block and trust entries', () => {
    const allow = { 'a/b': { content_hash: H, rules: ['r/1'], reason: 'why', added: '2026-11-14' } };
    const block = [{ id: 'x/y', reason: 'bad', added: '2026-11-20' }, { content_hash: H, reason: 'bad', added: 'd' }];
    const trust = [{ owner: 'o', public_keys: [KEY] }];
    const r = run({ allow, block, trust });
    expect(r.problems).toEqual([]);
    expect(r.policy).toEqual({ allow, block, trust });
  });

  it('wrong top-level types give one policy/invalid-entry per key', () => {
    const r = run({ allow: [], block: {}, trust: 'x' });
    expect(r.problems.map((p) => [p.code, p.level, p.file])).toEqual([
      ['policy/invalid-entry', 'error', '/c.jsonc'], ['policy/invalid-entry', 'error', '/c.jsonc'], ['policy/invalid-entry', 'error', '/c.jsonc'],
    ]);
    expect(r.policy).toEqual({ allow: {}, block: [], trust: [] });
  });

  it('skips invalid block entries', () => {
    const r = run({ block: [
      { id: 'a', content_hash: H, reason: 'r', added: 'd' },
      { reason: 'r', added: 'd' },
      { content_hash: 'sha256:abc', reason: 'r', added: 'd' },
      { content_hash: `sha256:${'A'.repeat(64)}`, reason: 'r', added: 'd' },
      { id: 'a', reason: '', added: 'd' },
      { id: 'a', reason: 'r' },
      { id: 'ok', reason: 'r', added: 'd' },
      7,
    ] });
    expect(r.policy.block).toEqual([{ id: 'ok', reason: 'r', added: 'd' }]);
    expect(r.problems).toHaveLength(7);
  });

  it('skips invalid allow entries but keeps valid ones', () => {
    const good = { content_hash: H, rules: ['r'], reason: 'w', added: 'd' };
    const r = run({ allow: {
      good,
      badHash: { ...good, content_hash: 'sha256:zz' },
      noRules: { ...good, rules: [] },
      strRules: { ...good, rules: 'r' },
      numRules: { ...good, rules: [1] },
      noReason: { ...good, reason: '' },
      noAdded: { content_hash: H, rules: ['r'], reason: 'w' },
      notObj: 3,
    } });
    expect(Object.keys(r.policy.allow)).toEqual(['good']);
    expect(r.problems).toHaveLength(7);
  });

  it('trust: keeps valid keys, reports invalid ones, skips entries with none', () => {
    const r = run({ trust: [
      { owner: 'o', public_keys: [KEY, 'ed25519:short', 'rsa:xx'] },
      { owner: 'p', public_keys: ['nope'] },
      { owner: '', public_keys: [KEY] },
      { owner: 'q', public_keys: [] },
      { public_keys: [KEY] },
    ] });
    expect(r.policy.trust).toEqual([{ owner: 'o', public_keys: [KEY] }]);
    expect(r.problems).toHaveLength(2 + 1 + 1 + 1 + 1);
    expect(r.problems.every((p) => p.code === 'policy/invalid-entry')).toBe(true);
  });

  it('does not let a __proto__ allow key pollute', () => {
    const r = parsePolicy(parseTree(`{"allow":{"__proto__":{"content_hash":"${H}","rules":["r"],"reason":"w","added":"d"}}}`), 'f');
    expect(Object.getPrototypeOf(r.policy.allow)).toBe(null);
    expect(Object.keys(r.policy.allow)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).content_hash).toBeUndefined();
  });
});
