// Scan results cached by (content hash, RULES_VERSION): unchanged content is never rescanned, and a release with
// new rules rescans everything because its results live under a new version folder.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeCacheFile } from '../cache/state.js';
import { RULES_VERSION } from './rules.js';
import type { Finding, ScanResult } from './scan.js';

const HEX = /^[0-9a-f]{64}$/;

const isFinding = (f: unknown): f is Finding => {
  if (typeof f !== 'object' || f === null) return false;
  const x = f as Record<string, unknown>;
  return typeof x.rule === 'string' && (x.severity === 'critical' || x.severity === 'warning')
    && typeof x.file === 'string' && typeof x.line === 'number' && typeof x.message === 'string'
    && (x.downgraded === undefined || typeof x.downgraded === 'string');
};

const isScanResult = (v: unknown): v is ScanResult => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const x = v as Record<string, unknown>;
  return Array.isArray(x.findings) && x.findings.every(isFinding) && typeof x.critical === 'number' && typeof x.warning === 'number';
};

/**
 * The cached scan for `contentHash` ("sha256:<hex>"), else `scan()`, stored as `{ contentHash, result }` at
 * `<cacheDir>/scan/<version>/<hex>.json`; an entry whose contentHash differs from its key is rescanned.
 * A missing, unreadable or malformed entry is rescanned. A hash that isn't sha256 hex is never used as a path (no
 * caching). Writes are atomic and best effort: a failure is swallowed.
 */
export async function cachedScan(cacheDir: string, contentHash: string, scan: () => Promise<ScanResult>, version: string = RULES_VERSION): Promise<ScanResult> {
  const hex = contentHash.startsWith('sha256:') ? contentHash.slice(7) : '';
  if (!HEX.test(hex)) return scan();
  const file = join(cacheDir, 'scan', version, `${hex}.json`);
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { contentHash?: unknown; result?: unknown } | null;
    // The entry names the hash it was made for, so a file copied or renamed to another key is not trusted.
    if (parsed?.contentHash === contentHash && isScanResult(parsed.result)) return parsed.result;
  } catch { /* missing or unreadable: rescan */ }
  const result = await scan(); // a throw propagates and nothing is cached
  await writeCacheFile(file, JSON.stringify({ contentHash, result })).catch(() => {});
  return result;
}
