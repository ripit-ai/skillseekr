export interface AllowEntry { content_hash: string; rules: string[]; reason: string; added: string }
export type BlockEntry =
  | { id: string; reason: string; added: string }
  | { content_hash: string; reason: string; added: string };
export interface TrustEntry { owner: string; public_keys: string[] }
export interface PolicyBlock { allow: Record<string, AllowEntry>; block: BlockEntry[]; trust: TrustEntry[] }
export type PolicySource =
  | { kind: 'local'; file: string }
  | { kind: 'include'; name: string; via: string[]; file: string };
export interface Policy {
  sources: Array<{ source: PolicySource; allow: Record<string, AllowEntry>; block: BlockEntry[] }>;
  trust: TrustEntry[];
}
export const EMPTY_POLICY: Policy = { sources: [], trust: [] };

export const emptyPolicyBlock = (): PolicyBlock => ({ allow: Object.create(null) as Record<string, AllowEntry>, block: [], trust: [] });
