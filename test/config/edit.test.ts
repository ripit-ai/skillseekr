import { describe, it, expect } from 'vitest';
import { parse } from 'jsonc-parser';
import { addBlock, addRegistry, removeAllow, removeBlock, removeRegistry, setAllow, setTrust, defaultConfigText } from '../../src/config/edit.js';
import { parseRegistriesFile } from '../../src/config/load.js';

const opts = { file: 'f', isLocalConfig: true };
const names = (text: string) => parseRegistriesFile(text, opts).registries.map(([n]) => n);
const http = (n: string) => ({ type: 'http', url: `https://x/${n}/SKILL.md`, skill_name: n });

const base = `{
  // keep me
  "registries": {
    "a": { "type": "http", "url": "https://x/a/SKILL.md", "skill_name": "a" }, // trailing a
    "b": { "type": "http", "url": "https://x/b/SKILL.md", "skill_name": "b" }
  },
  "cache": { "enabled": true } // keep cache
}`;

describe('addRegistry', () => {
  it('keeps existing comments and appends last', () => {
    const out = addRegistry(base, 'new', http('new'));
    expect(out).toContain('// keep me');
    expect(out).toContain('// trailing a');
    expect(out).toContain('// keep cache');
    const regs = parseRegistriesFile(out, opts).registries;
    expect(regs.at(-1)![0]).toBe('new');
    expect(names(out)).toEqual(['a', 'b', 'new']);
  });

  it('appends last when registries ends with a trailing comment', () => {
    const text = defaultConfigText({ owner: 'ripit-ai', repo: 'agent-skills', name: 'ripit-ai' });
    const out = addRegistry(text, 'mine', http('mine'));
    expect(out).toContain('// Personal additions go below');
    expect(names(out)).toEqual(['ripit-ai', 'mine']);
    expect(out).toContain('"cache"');
  });

  it('creates registries when missing', () => {
    const out = addRegistry('{ // hi\n}', 'x', http('x'));
    expect(out).toContain('// hi');
    expect(names(out)).toEqual(['x']);
  });

  it('throws when the registry already exists', () => {
    expect(() => addRegistry(base, 'a', http('a'))).toThrow('registry "a" already exists');
  });
});

describe('removeRegistry', () => {
  it('removes only that entry and keeps comments', () => {
    const out = removeRegistry(base, 'a');
    expect(names(out)).toEqual(['b']);
    expect(out).toContain('// keep me');
    expect(out).toContain('// keep cache');
  });

  it('throws when absent', () => {
    expect(() => removeRegistry(base, 'zz')).toThrow('registry "zz" not found');
  });
});

describe('defaultConfigText', () => {
  it('parses to exactly one entry with the default shape', () => {
    const text = defaultConfigText({ owner: 'ripit-ai', repo: 'agent-skills', name: 'ripit-ai' });
    const f = parseRegistriesFile(text, opts);
    expect(f.registries).toHaveLength(1);
    const [name, e] = f.registries[0]!;
    expect(name).toBe('ripit-ai');
    expect(e).toMatchObject({
      type: 'github-registry', owner: 'ripit-ai', repo: 'agent-skills', ref: 'main',
      path: 'registries.jsonc', policy: true, auth: { type: 'gh_cli' }, description: 'ripit-ai shared skills',
    });
    expect(text).toContain('// Personal additions go below');
    expect(text).toContain('"enabled": true');
    expect(text).toContain('"ttl_seconds": 3600');
    expect(text).toContain('"dir": "~/.cache/skillseekr"');
  });

  it('uses owner/repo as description for other names', () => {
    const f = parseRegistriesFile(defaultConfigText({ owner: 'acme', repo: 'skills', name: 'acme' }), opts);
    expect(f.registries[0]![1]).toMatchObject({ description: 'acme/skills' });
  });
});

describe('policy edit helpers', () => {
  const doc = `{
  // keep me
  "registries": {}, // regs
  "block": [
    { "id": "x/y", "reason": "r", "added": "2026-01-01" } // first
  ]
}`;
  const H = `sha256:${'a'.repeat(64)}`;
  const parsed = (t: string) => parse(t, [], { allowTrailingComma: true });

  it('addBlock appends keeping comments, creates the array, and refuses duplicates', () => {
    const out = addBlock(doc, { content_hash: H, reason: 'bad', added: '2026-11-14' });
    expect(out).toContain('// keep me');
    expect(out).toContain('// first');
    expect(parsed(out).block).toHaveLength(2);
    expect(() => addBlock(out, { content_hash: H, reason: 'again', added: 'd' })).toThrow('already blocked');
    expect(() => addBlock(doc, { id: 'x/y', reason: 'again', added: 'd' })).toThrow('already blocked');
    expect(parsed(addBlock('{ "registries": {} }', { id: 'n', reason: 'r', added: 'd' })).block).toEqual([{ id: 'n', reason: 'r', added: 'd' }]);
  });

  it('removeBlock removes by id or hash, keeps comments, and throws when absent', () => {
    const two = addBlock(doc, { content_hash: H, reason: 'bad', added: '2026-11-14' });
    const noId = removeBlock(two, { id: 'x/y' });
    expect(parsed(noId).block).toEqual([{ content_hash: H, reason: 'bad', added: '2026-11-14' }]);
    expect(noId).toContain('// keep me');
    expect(parsed(removeBlock(two, { content_hash: H })).block).toHaveLength(1);
    expect(() => removeBlock(doc, { id: 'nope' })).toThrow('not blocked');
  });

  it('setAllow adds then replaces idempotently; removeAllow removes and throws when absent', () => {
    const e = { content_hash: H, rules: ['a/b'], reason: 'r', added: 'd' };
    const once = setAllow(doc, 'a/b-skill', e);
    expect(setAllow(once, 'a/b-skill', e)).toBe(once);
    expect(parsed(setAllow(once, 'a/b-skill', { ...e, reason: 'new' })).allow['a/b-skill'].reason).toBe('new');
    expect(once).toContain('// keep me');
    const gone = removeAllow(once, 'a/b-skill');
    expect(parsed(gone).allow).toEqual({});
    expect(() => removeAllow(gone, 'a/b-skill')).toThrow('no allow entry');
  });

  it('setTrust appends and replaces an owner case-insensitively', () => {
    const k1 = `ed25519:${'A'.repeat(43)}`; const k2 = `ed25519:${'B'.repeat(43)}`;
    const one = setTrust(doc, 'Acme', [k1]);
    expect(parsed(one).trust).toEqual([{ owner: 'Acme', public_keys: [k1] }]);
    const two = setTrust(one, 'acme', [k1, k2]);
    expect(parsed(two).trust).toEqual([{ owner: 'acme', public_keys: [k1, k2] }]);
    expect(two).toContain('// keep me');
  });
});
