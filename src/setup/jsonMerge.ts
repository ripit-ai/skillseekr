import { copyFile, readFile } from 'node:fs/promises';
import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, printParseErrorCode, type FormattingOptions, type Node, type ParseError } from 'jsonc-parser';
import { writeFileAtomic } from '../atomicWrite.js';
import type { Ctx } from '../context.js';

/** One thing setup changed (or would change): a file edit, or a command it ran. */
export interface Change {
  file?: string; command?: string; before?: string; after?: string; backup?: string;
  /** Claude Code only: which registration route this change belongs to. */
  route?: 'plugin' | 'mcp';
}

/** Structural equality of JSON values. (jsonc-parser builds null-prototype objects, so util.isDeepStrictEqual won't do.) */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  const ob = b as Record<string, unknown>;
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(ob, k) && jsonEqual((a as Record<string, unknown>)[k], ob[k]));
}

const formattingOptions: FormattingOptions = { insertSpaces: true, tabSize: 2 };
const UNSET = '(unset)';

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

function parseObject(text: string, file: string): Node {
  const errors: ParseError[] = [];
  const root = parseTree(text.replace(/^﻿/, ''), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    throw new Error(`cannot update ${file}: ${printParseErrorCode(errors[0]!.error)} at offset ${errors[0]!.offset}; fix the file and re-run`);
  }
  if (root && root.type !== 'object') throw new Error(`cannot update ${file}: the top level is not a JSON object`);
  return root ?? parseTree('{}')!;
}

/** The value at `path` in a JSON/JSONC file; undefined when the file or key is missing. Throws if it doesn't parse. */
export async function readJsonValue(file: string, path: string[]): Promise<unknown> {
  const text = await readText(file);
  if (text === undefined || text.trim() === '') return undefined;
  const node = findNodeAtLocation(parseObject(text, file), path);
  return node ? getNodeValue(node) : undefined;
}

const show = (path: string[], v: unknown) => `${path.join('.')}: ${v === undefined ? UNSET : JSON.stringify(v)}`;

/**
 * Sets `path` to `value` in a JSON/JSONC file, keeping every other key and all comments.
 * Returns null (and writes nothing) when the current value already deep-equals `value`.
 * Before changing an existing file, copies it to `<file>.skillseekr-backup-<epochms>`.
 * Missing files (and their parent dirs) are created. Writes are atomic and follow symlinks.
 */
export async function mergeJsonFile(
  file: string, path: string[], value: unknown, ctx: Ctx, opts: { dryRun?: boolean } = {},
): Promise<Change | null> {
  const existing = await readText(file);
  const base = existing === undefined || existing.trim() === '' ? '{}\n' : existing;
  const root = parseObject(base, file);
  const node = findNodeAtLocation(root, path);
  const current: unknown = node ? getNodeValue(node) : undefined;
  if (jsonEqual(current, value)) return null;

  const next = applyEdits(base, modify(base, path, value, { formattingOptions }));
  const change: Change = { file, before: show(path, current), after: show(path, value) };
  if (existing !== undefined) change.backup = `${file}.skillseekr-backup-${ctx.now()}`;
  if (opts.dryRun) return change;

  if (change.backup) await copyFile(file, change.backup);
  await writeFileAtomic(file, next.endsWith('\n') ? next : `${next}\n`);
  return change;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Sets a server entry: our fields win, any extra fields the user added to that entry (say `disabled`) are kept.
 */
export async function mergeEntry(
  file: string, path: string[], entry: Record<string, unknown>, ctx: Ctx, opts: { dryRun?: boolean } = {},
): Promise<Change | null> {
  const current = await readJsonValue(file, path);
  return mergeJsonFile(file, path, isObject(current) ? { ...current, ...entry } : entry, ctx, opts);
}

/** True when the entry at `path` exists and every field of `entry` matches. False on a missing or unparseable file. */
export async function entryMatches(file: string, path: string[], entry: Record<string, unknown>): Promise<boolean> {
  try {
    const current = await readJsonValue(file, path);
    return isObject(current) && Object.entries(entry).every(([k, v]) => jsonEqual(current[k], v));
  } catch {
    return false;
  }
}
