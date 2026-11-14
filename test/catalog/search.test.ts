import { describe, it, expect } from 'vitest';
import { resolve, join } from 'node:path';
import { Catalog } from '../../src/catalog/catalog.js';
import { discoverSkills, type DiscoveredSkill } from '../../src/catalog/discover.js';
import { tokenize } from '../../src/catalog/search.js';
import type { ResolvedRegistry } from '../../src/resolve/resolve.js';

const FX = resolve(import.meta.dirname, '../fixtures/skills');
const reg = (name: string, via: string[] = [name]) => ({ name, via, trusted: true, entry: {} }) as unknown as ResolvedRegistry;
const sk = (id: string, name: string, description = ''): DiscoveredSkill =>
  ({ id, name, description, dir: '/x', files: [], contentHash: 'h', warnings: [] });

describe('tokenize', () => {
  it('lowercases, splits, drops short tokens', () => {
    expect(tokenize('TDD-Dev/a x9 b!')).toEqual(['tdd', 'dev', 'x9']);
  });
});

describe('Catalog.search', () => {
  it('"tdd testing" ranks the tdd skill first', async () => {
    const skills = await discoverSkills(join(FX, 'nested'), 'skills');
    const c = new Catalog([{ registry: reg('r', ['top', 'r']), skills }], [], [], false);
    const hits = c.search('tdd testing');
    expect(hits[0]!.id).toBe('engineering/testing/tdd-development');
    expect(hits[0]!.registry).toBe('r');
    expect(hits[0]!.via).toEqual(['top', 'r']);
    expect(hits[0]!.overrode).toEqual([]);
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });
  it('empty / no-token / no-match queries return []', () => {
    const c = new Catalog([{ registry: reg('r'), skills: [sk('a', 'alpha')] }], [], [], false);
    expect(c.search('')).toEqual([]);
    expect(c.search('a ! -')).toEqual([]);
    expect(c.search('zzzz')).toEqual([]);
  });
  it('overrode names the replaced registry and via', () => {
    const c = new Catalog([
      { registry: reg('old', ['t', 'old']), skills: [sk('s', 'shared')] },
      { registry: reg('new', ['new']), skills: [sk('s', 'shared')] },
    ], [], [], false);
    const h = c.search('shared');
    expect(h).toHaveLength(1);
    expect(h[0]!.registry).toBe('new');
    expect(h[0]!.overrode).toEqual([{ registry: 'old', via: ['t', 'old'] }]);
  });
  it('default limit is 10; explicit limit honoured; ties sort by id', () => {
    const skills = Array.from({ length: 15 }, (_, i) => sk(`s${String(i).padStart(2, '0')}`, 'widget'));
    const c = new Catalog([{ registry: reg('r'), skills }], [], [], false);
    const hits = c.search('widget');
    expect(hits).toHaveLength(10);
    expect(hits.map((h) => h.id)).toEqual(skills.slice(0, 10).map((s) => s.id));
    expect(c.search('widget', 3)).toHaveLength(3);
  });
  it('name matches outweigh description matches', () => {
    const c = new Catalog([{ registry: reg('r'), skills: [sk('a', 'other', 'deploy deploy'), sk('b', 'deploy', 'x')] }], [], [], false);
    expect(c.search('deploy')[0]!.id).toBe('b');
  });
});
