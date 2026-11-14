import { parse } from 'yaml';

export interface Frontmatter { data: Record<string, unknown>; body: string; ok: boolean }

/** Parses the YAML block between a leading `---` pair. Never throws. */
export function parseFrontmatter(text: string): Frontmatter {
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  src = src.replace(/\r\n?/g, '\n');
  const fail: Frontmatter = { data: {}, body: src, ok: false };
  const lines = src.split('\n');
  if (lines[0]?.trimEnd() !== '---') return fail;
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end < 0) return fail;
  try {
    const data: unknown = parse(lines.slice(1, end).join('\n'));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail;
    return { data: data as Record<string, unknown>, body: lines.slice(end + 1).join('\n'), ok: true };
  } catch {
    return fail;
  }
}
