import { applyEdits, findNodeAtLocation, modify, parseTree, type FormattingOptions } from 'jsonc-parser';

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
