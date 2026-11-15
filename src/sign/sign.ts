// Scheme follows skillyard (MIT) src/sign.js @ 83ee690
//
// Signed skills: ed25519 over a canonical manifest (sorted path -> sha256) of a skill's files.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SIGNATURE_FILE = '.skillseekr-signature.json';
const MARKER_FILE = '.skillseekr.json';
const EXCLUDED = new Set([SIGNATURE_FILE, MARKER_FILE]);
const KEY_PREFIX = 'ed25519:';

export interface SignatureDoc { alg: 'ed25519'; manifest: Record<string, string>; sig: string }
export interface VerifyResult { ok: boolean; changed: string[]; error?: string }
type FileEntry = { path: string; content: Buffer };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sha = (c: Buffer): string => createHash('sha256').update(c).digest('hex');

/** The `ed25519:<base64url of the raw 32-byte key>` string for a public KeyObject-compatible key. */
function publicKeyString(x: string): string { return KEY_PREFIX + x; }

/** Parses `ed25519:<43 base64url chars>`; throws a clear Error when malformed. */
export function publicKeyFromString(s: string): ReturnType<typeof createPublicKey> {
  if (typeof s !== 'string' || !s.startsWith(KEY_PREFIX)) throw new Error(`invalid public key "${String(s)}": expected "ed25519:<base64url>"`);
  const x = s.slice(KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{43}$/.test(x) || Buffer.from(x, 'base64url').length !== 32) {
    throw new Error(`invalid public key "${s}": expected 43 base64url characters (a raw 32-byte ed25519 key, no padding)`);
  }
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
}

/** Loads a PKCS#8 PEM; throws a clear Error when unreadable or not an ed25519 key. */
function loadPrivateKey(pem: string): ReturnType<typeof createPrivateKey> {
  let key;
  try { key = createPrivateKey(pem); } catch { throw new Error('not a valid private key (expected a PKCS#8 PEM)'); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`not an ed25519 private key (found ${key.asymmetricKeyType ?? 'unknown'})`);
  return key;
}

/** The `ed25519:` public key string derived from a private key PEM. */
export function publicKeyOf(privateKeyPem: string): string {
  const jwk = createPublicKey(loadPrivateKey(privateKeyPem)).export({ format: 'jwk' });
  return publicKeyString(jwk.x as string);
}

export function createKeyPair(): { privateKeyPem: string; publicKey: string } {
  const { privateKey } = generateKeyPairSync('ed25519');
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  return { privateKeyPem, publicKey: publicKeyOf(privateKeyPem) };
}

/** { path: sha256 hex }, sorted by path; the signature file and install marker are never included. */
export function buildManifest(files: FileEntry[]): Record<string, string> {
  // Null prototype: a file named `__proto__` must be an ordinary key, not dropped by the setter.
  const m: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const f of files.filter((x) => !EXCLUDED.has(x.path)).sort((a, b) => cmp(a.path, b.path))) {
    Object.defineProperty(m, f.path, { value: sha(f.content), enumerable: true, writable: true, configurable: true });
  }
  return m;
}

const canonical = (manifest: Record<string, string>): Buffer =>
  Buffer.from(JSON.stringify(Object.entries(manifest).sort((a, b) => cmp(a[0], b[0]))));

export function signFiles(files: FileEntry[], privateKeyPem: string): SignatureDoc {
  const key = loadPrivateKey(privateKeyPem);
  const manifest = buildManifest(files);
  return { alg: 'ed25519', manifest, sig: sign(null, canonical(manifest), key).toString('base64') };
}

function asDoc(doc: unknown): SignatureDoc | undefined {
  if (typeof doc !== 'object' || doc === null) return undefined;
  const d = doc as Record<string, unknown>;
  if (d.alg !== 'ed25519' || typeof d.sig !== 'string') return undefined;
  const m = d.manifest;
  if (typeof m !== 'object' || m === null || Array.isArray(m)) return undefined;
  if (!Object.values(m).every((v) => typeof v === 'string')) return undefined;
  return d as unknown as SignatureDoc;
}

/** Valid when the signature verifies against any one of `publicKeys` AND the files match the manifest. */
export function verifyFiles(files: FileEntry[], doc: unknown, publicKeys: string[]): VerifyResult {
  const d = asDoc(doc);
  if (!d) return { ok: false, changed: [], error: 'malformed signature' };
  const have = new Map(Object.entries(buildManifest(files)));
  const signed = new Map(Object.entries(d.manifest)); // Map: hostile keys like `__proto__` are plain entries
  const changed = [...new Set([...have.keys(), ...signed.keys()])].filter((p) => have.get(p) !== signed.get(p)).sort(cmp);
  const keys: Array<ReturnType<typeof createPublicKey>> = [];
  const bad: string[] = [];
  for (const k of publicKeys) { try { keys.push(publicKeyFromString(k)); } catch (e) { bad.push((e as Error).message); } }
  if (keys.length === 0) return { ok: false, changed, error: bad[0] ?? 'no public keys to verify against' };
  const data = canonical(d.manifest);
  const sigBuf = Buffer.from(d.sig, 'base64');
  const valid = keys.some((k) => { try { return verify(null, data, k, sigBuf); } catch { return false; } });
  if (!valid) return { ok: false, changed, error: 'signature does not match any trusted key (wrong key, or the manifest was edited)' };
  return changed.length === 0 ? { ok: true, changed } : { ok: false, changed };
}

const MAX_SIGNATURE_BYTES = 1024 * 1024;

/**
 * Reads the regular files named in `files` (symlinks skipped) plus the signature file. Never throws.
 * Callers must pass the skill's real file list (e.g. from listFiles): files not named here are not checked, so
 * an empty or partial list can only verify what it names; supplying the full list is the caller's responsibility.
 * Symlinks are out of scope, matching contentHash (regular files only).
 */
export async function verifySkillDir(dir: string, files: string[], publicKeys: string[]): Promise<VerifyResult> {
  try {
    const sigPath = join(dir, SIGNATURE_FILE);
    let raw: string;
    try {
      const st = await lstat(sigPath);
      if (!st.isFile()) return { ok: false, changed: [], error: 'missing signature' };
      if (st.size > MAX_SIGNATURE_BYTES) return { ok: false, changed: [], error: 'signature file too large' };
      raw = await readFile(sigPath, 'utf8');
    } catch { return { ok: false, changed: [], error: 'missing signature' }; }
    let doc: unknown;
    try { doc = JSON.parse(raw); } catch { return { ok: false, changed: [], error: 'malformed signature' }; }
    const entries: FileEntry[] = [];
    for (const f of files) {
      if (EXCLUDED.has(f)) continue;
      const abs = join(dir, f);
      try {
        if (!(await lstat(abs)).isFile()) continue;
        entries.push({ path: f, content: await readFile(abs) });
      } catch { /* unreadable or vanished: counts as absent, so it shows up as changed */ }
    }
    return verifyFiles(entries, doc, publicKeys);
  } catch (e) {
    return { ok: false, changed: [], error: e instanceof Error ? e.message : String(e) };
  }
}
