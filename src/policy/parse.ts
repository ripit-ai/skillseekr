import { getNodeValue, type Node } from 'jsonc-parser';
import type { Problem } from '../types.js';
import { publicKeyFromString } from '../sign/sign.js';
import { emptyPolicyBlock, type AllowEntry, type BlockEntry, type PolicyBlock, type TrustEntry } from './types.js';

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

function child(obj: Node, key: string): Node | undefined {
  return obj.children?.find((p) => p.type === 'property' && p.children?.[0]?.value === key)?.children?.[1];
}

/** Parses the top-level `allow`, `block` and `trust` keys. Invalid entries are skipped with `policy/invalid-entry`. */
export function parsePolicy(root: Node | undefined, file: string): { policy: PolicyBlock; problems: Problem[] } {
  const policy: PolicyBlock = emptyPolicyBlock();
  const problems: Problem[] = [];
  if (!root || root.type !== 'object') return { policy, problems };
  const bad = (what: string, why: string): void => {
    problems.push({ level: 'error', code: 'policy/invalid-entry', file, message: `${file}: ${what} is invalid (${why}). Skipped.` });
  };

  const allowNode = child(root, 'allow');
  if (allowNode) {
    if (allowNode.type !== 'object') bad('"allow"', 'must be an object keyed by skill ID');
    else {
      for (const prop of allowNode.children ?? []) {
        const id = String(prop.children?.[0]?.value);
        const v = prop.children?.[1] ? getNodeValue(prop.children[1]) as unknown : undefined;
        const what = `allow entry "${id}"`;
        if (!isObj(v)) { bad(what, 'must be an object'); continue; }
        if (typeof v.content_hash !== 'string' || !HASH_RE.test(v.content_hash)) { bad(what, 'content_hash must be "sha256:" followed by 64 hex characters'); continue; }
        if (!Array.isArray(v.rules) || v.rules.length === 0 || !v.rules.every(nonEmpty)) { bad(what, 'rules must be a non-empty array of strings'); continue; }
        if (!nonEmpty(v.reason)) { bad(what, 'reason must be a non-empty string'); continue; }
        if (!nonEmpty(v.added)) { bad(what, 'added must be a non-empty string'); continue; }
        policy.allow[id] = { content_hash: v.content_hash, rules: [...v.rules as string[]], reason: v.reason, added: v.added };
      }
    }
  }

  const blockNode = child(root, 'block');
  if (blockNode) {
    if (blockNode.type !== 'array') bad('"block"', 'must be an array');
    else {
      (blockNode.children ?? []).forEach((n, i) => {
        const v = getNodeValue(n) as unknown;
        const what = `block entry #${i + 1}`;
        if (!isObj(v)) return bad(what, 'must be an object');
        const hasId = v.id !== undefined, hasHash = v.content_hash !== undefined;
        if (hasId === hasHash) return bad(what, 'needs exactly one of id or content_hash');
        if (hasId && !nonEmpty(v.id)) return bad(what, 'id must be a non-empty string');
        if (hasHash && (typeof v.content_hash !== 'string' || !HASH_RE.test(v.content_hash))) return bad(what, 'content_hash must be "sha256:" followed by 64 hex characters');
        if (!nonEmpty(v.reason)) return bad(what, 'reason must be a non-empty string');
        if (!nonEmpty(v.added)) return bad(what, 'added must be a non-empty string');
        const e: BlockEntry = hasId
          ? { id: v.id as string, reason: v.reason, added: v.added }
          : { content_hash: v.content_hash as string, reason: v.reason, added: v.added };
        policy.block.push(e);
      });
    }
  }

  const trustNode = child(root, 'trust');
  if (trustNode) {
    if (trustNode.type !== 'array') bad('"trust"', 'must be an array');
    else {
      (trustNode.children ?? []).forEach((n, i) => {
        const v = getNodeValue(n) as unknown;
        const what = `trust entry #${i + 1}`;
        if (!isObj(v)) return bad(what, 'must be an object');
        if (!nonEmpty(v.owner)) return bad(what, 'owner must be a non-empty string');
        if (!Array.isArray(v.public_keys) || v.public_keys.length === 0) return bad(what, 'public_keys must be a non-empty array');
        const keys: string[] = [];
        for (const k of v.public_keys as unknown[]) {
          try { publicKeyFromString(k as string); keys.push(k as string); } catch { bad(`${what} (owner "${v.owner}") key ${JSON.stringify(k)}`, 'expected "ed25519:" followed by 43 base64url characters'); }
        }
        if (keys.length === 0) return;
        const e: TrustEntry = { owner: v.owner, public_keys: keys };
        policy.trust.push(e);
      });
    }
  }
  return { policy, problems };
}
