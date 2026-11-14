import { describe, it, expect } from 'vitest';
import { addRegistry, removeRegistry, defaultConfigText } from '../../src/config/edit.js';
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
