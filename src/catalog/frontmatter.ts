import { parseDocument } from 'yaml';

/** `lenient` is set when strict YAML failed and the top-level `key: value` lines were read instead. */
export interface Frontmatter { data: Record<string, unknown>; body: string; ok: boolean; lenient?: true }

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
    // logLevel 'silent' stops warnings reaching stderr, but also stops parse() throwing, so check errors here.
    const doc = parseDocument(lines.slice(1, end).join('\n'), { logLevel: 'silent' });
    if (doc.errors.length > 0) return lenientParse(lines.slice(1, end), lines.slice(end + 1).join('\n')) ?? fail;
    const data: unknown = doc.toJS();
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail;
    return { data: data as Record<string, unknown>, body: lines.slice(end + 1).join('\n'), ok: true };
  } catch {
    return fail;
  }
}

/** Fallback for YAML that strict parsing rejects (typically an unquoted ": " in a value). Top-level pairs only. */
function lenientParse(block: string[], body: string): Frontmatter | undefined {
  const data: Record<string, unknown> = {};
  for (const line of block) {
    const m = /^([A-Za-z][\w-]*):(?: (.*))?$/.exec(line.trimEnd());
    if (!m) continue;
    let v = (m[2] ?? '').trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
    data[m[1]!] = v;
  }
  return Object.keys(data).length === 0 ? undefined : { data, body, ok: true, lenient: true };
}
