import { describe, it, expect } from 'vitest';
import { parseFrontmatter } from '../../src/catalog/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses a block and returns the body', () => {
    const r = parseFrontmatter('---\nname: a\ndescription: "b: c"\n---\nbody\n');
    expect(r).toEqual({ ok: true, data: { name: 'a', description: 'b: c' }, body: 'body\n' });
  });
  it('CRLF and BOM frontmatter parse', () => {
    const text = '﻿---\r\nname: a\r\ndescription: b\r\n---\r\nbody\r\n';
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('\r\n');
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ name: 'a', description: 'b' });
  });
  it('falls back to top-level key: value lines when strict YAML fails', () => {
    const r = parseFrontmatter('---\nname: a\ndescription: Does x: y and z\nq: "quoted"\n  indented: no\nnot a pair\n---\nbody');
    expect(r).toEqual({ ok: true, lenient: true, data: { name: 'a', description: 'Does x: y and z', q: 'quoted' }, body: 'body' });
  });
  it.each([
    ['no frontmatter', '# hi\n'],
    ['unterminated', '---\nname: a\n'],
    ['invalid yaml with no key/value lines', '---\n[unclosed\n  - x\n---\n'],
    ['non-object', '---\n- a\n- b\n---\n'],
    ['empty block', '---\n---\n'],
    ['empty text', ''],
  ])('%s is ok:false and never throws', (_n, text) => {
    const r = parseFrontmatter(text);
    expect(r.ok).toBe(false);
    expect(r.data).toEqual({});
  });
});
