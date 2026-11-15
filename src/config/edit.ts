import { applyEdits, findNodeAtLocation, getNodeValue, modify, parseTree, type FormattingOptions } from 'jsonc-parser';
import type { AllowEntry, BlockEntry } from '../policy/types.js';

const formattingOptions: FormattingOptions = { insertSpaces: true, tabSize: 2 };

function registryKeys(text: string): string[] {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const regs = root && findNodeAtLocation(root, ['registries']);
  if (!regs || regs.type !== 'object') return [];
  return (regs.children ?? []).map((p) => String(p.children?.[0]?.value));
}

/** Appends a registry as the last entry of `registries` (created if missing), keeping comments. */
export function addRegistry(text: string, name: string, entry: object): string {
  const keys = registryKeys(text);
  if (keys.includes(name)) throw new Error(`registry "${name}" already exists`);
  const edits = modify(text, ['registries', name], entry, {
    formattingOptions,
    getInsertionIndex: () => keys.length,
  });
  return applyEdits(text, edits);
}

/** Removes one registry entry, keeping all other content and comments. */
export function removeRegistry(text: string, name: string): string {
  if (!registryKeys(text).includes(name)) throw new Error(`registry "${name}" not found`);
  return applyEdits(text, modify(text, ['registries', name], undefined, { formattingOptions }));
}

function arrayAt(text: string, key: string): unknown[] {
  const root = parseTree(text, [], { allowTrailingComma: true });
  const node = root && findNodeAtLocation(root, [key]);
  if (!node || node.type !== 'array') return [];
  return (node.children ?? []).map((n) => getNodeValue(n) as unknown);
}

const sameBlock = (a: unknown, m: { id: string } | { content_hash: string }): boolean => {
  if (typeof a !== 'object' || a === null) return false;
  const o = a as Record<string, unknown>;
  return 'id' in m ? o.id === m.id : o.content_hash === m.content_hash;
};

/** Appends a `block` entry (array created if missing), keeping comments. Throws if the same id or hash is already blocked. */
export function addBlock(text: string, entry: BlockEntry): string {
  const existing = arrayAt(text, 'block');
  const match = 'id' in entry ? { id: entry.id } : { content_hash: entry.content_hash };
  if (existing.some((e) => sameBlock(e, match))) throw new Error('already blocked');
  return applyEdits(text, modify(text, ['block', -1], entry, { formattingOptions }));
}

/** Removes the local `block` entry with this id or content hash. Throws if there is none. */
export function removeBlock(text: string, match: { id: string } | { content_hash: string }): string {
  const idx = arrayAt(text, 'block').findIndex((e) => sameBlock(e, match));
  if (idx < 0) throw new Error('not blocked');
  return applyEdits(text, modify(text, ['block', idx], undefined, { formattingOptions }));
}

/** Sets (adds or replaces) `allow.<id>`, keeping comments. */
export function setAllow(text: string, id: string, entry: AllowEntry): string {
  return applyEdits(text, modify(text, ['allow', id], entry, { formattingOptions }));
}

/** Removes `allow.<id>`. Throws if there is none. */
export function removeAllow(text: string, id: string): string {
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (!root || !findNodeAtLocation(root, ['allow', id])) throw new Error(`no allow entry for "${id}"`);
  return applyEdits(text, modify(text, ['allow', id], undefined, { formattingOptions }));
}

/** Sets the trusted public keys for an owner (case-insensitive match), replacing that owner's entry or appending one. */
export function setTrust(text: string, owner: string, publicKeys: string[]): string {
  const entry = { owner, public_keys: publicKeys };
  const idx = arrayAt(text, 'trust').findIndex((e) => typeof e === 'object' && e !== null && String((e as { owner?: unknown }).owner).toLowerCase() === owner.toLowerCase());
  return applyEdits(text, modify(text, ['trust', idx < 0 ? -1 : idx], entry, { formattingOptions }));
}

export function defaultConfigText(opts: { owner: string; repo: string; name: string }): string {
  const description = opts.name === 'ripit-ai' ? 'ripit-ai shared skills' : `${opts.owner}/${opts.repo}`;
  const q = JSON.stringify;
  return `{
  "registries": {
    ${q(opts.name)}: {
      "type": "github-registry",
      "owner": ${q(opts.owner)},
      "repo": ${q(opts.repo)},
      "ref": "main",
      "path": "registries.jsonc",
      "description": ${q(description)},
      "policy": true,
      "auth": { "type": "gh_cli" }
    }
    // Personal additions go below. Anything here is resolved after the entry above,
    // so it overrides its skills or registries with the same name.
  },
  "cache": {
    "enabled": true,
    "ttl_seconds": 3600,
    "dir": "~/.cache/skillseekr"
  }
}
`;
}
