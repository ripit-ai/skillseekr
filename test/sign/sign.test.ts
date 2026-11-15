import { describe, it, expect } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SIGNATURE_FILE, buildManifest, createKeyPair, signFiles, verifyFiles, verifySkillDir, publicKeyFromString } from '../../src/sign/sign.js';
import { tmpDir } from '../helpers/tmp.js';

const f = (path: string, c: string) => ({ path, content: Buffer.from(c) });
const files = () => [f('SKILL.md', 'hello'), f('ref/a.md', 'a'), f('b.txt', 'b')];

describe('signing', () => {
  it('sign then verify is ok', () => {
    const k = createKeyPair();
    const doc = signFiles(files(), k.privateKeyPem);
    expect(verifyFiles(files(), doc, [k.publicKey])).toEqual({ ok: true, changed: [] });
  });
  it('changing one byte names the file', () => {
    const k = createKeyPair();
    const doc = signFiles(files(), k.privateKeyPem);
    const r = verifyFiles([f('SKILL.md', 'hellp'), f('ref/a.md', 'a'), f('b.txt', 'b')], doc, [k.publicKey]);
    expect(r.ok).toBe(false);
    expect(r.changed).toEqual(['SKILL.md']);
  });
  it('detects added and removed files', () => {
    const k = createKeyPair();
    const doc = signFiles(files(), k.privateKeyPem);
    expect(verifyFiles([...files(), f('new.md', 'x')], doc, [k.publicKey])).toMatchObject({ ok: false, changed: ['new.md'] });
    expect(verifyFiles(files().slice(1), doc, [k.publicKey])).toMatchObject({ ok: false, changed: ['SKILL.md'] });
  });
  it('another key fails; one matching key among several passes (rotation)', () => {
    const a = createKeyPair(); const b = createKeyPair();
    const doc = signFiles(files(), a.privateKeyPem);
    expect(verifyFiles(files(), doc, [b.publicKey]).ok).toBe(false);
    expect(verifyFiles(files(), doc, [b.publicKey, a.publicKey])).toEqual({ ok: true, changed: [] });
  });
  it('a malformed doc returns an error', () => {
    const k = createKeyPair();
    for (const d of [null, 'x', {}, { alg: 'rsa', manifest: {}, sig: 'x' }, { alg: 'ed25519', manifest: { a: 1 }, sig: 'x' }, { alg: 'ed25519', manifest: [], sig: 'x' }]) {
      const r = verifyFiles(files(), d, [k.publicKey]);
      expect(r.ok).toBe(false);
      expect(r.error).toBeTruthy();
    }
  });
  it('an edited manifest fails the signature', () => {
    const k = createKeyPair();
    const doc = signFiles(files(), k.privateKeyPem);
    doc.manifest['SKILL.md'] = '0'.repeat(64);
    expect(verifyFiles([f('SKILL.md', 'hello'), f('ref/a.md', 'a'), f('b.txt', 'b')], doc, [k.publicKey]).ok).toBe(false);
  });
  it('the manifest excludes the signature file and the install marker', () => {
    const m = buildManifest([...files(), f(SIGNATURE_FILE, '{}'), f('.skillseekr.json', '{}')]);
    expect(Object.keys(m)).toEqual(['SKILL.md', 'b.txt', 'ref/a.md']);
  });
  it('the public key round-trips through the ed25519: string form', () => {
    const k = createKeyPair();
    expect(k.publicKey).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
    const jwk = publicKeyFromString(k.publicKey).export({ format: 'jwk' });
    expect('ed25519:' + jwk.x).toBe(k.publicKey);
  });
  it('rejects malformed key strings clearly', () => {
    for (const s of ['', 'ed25519:', 'ed25519:abc', 'rsa:' + 'A'.repeat(43), 'ed25519:' + 'A'.repeat(44), 'ed25519:' + '+'.repeat(43)]) {
      expect(() => publicKeyFromString(s)).toThrow(/invalid public key/);
    }
    const doc = signFiles(files(), createKeyPair().privateKeyPem);
    expect(verifyFiles(files(), doc, ['nope']).error).toMatch(/invalid public key/);
  });
  it('signFiles rejects a non-ed25519 private key', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => signFiles(files(), pem)).toThrow(/ed25519/);
    expect(() => signFiles(files(), 'garbage')).toThrow(/private key/);
  });
});

describe('hostile manifests', () => {
  it('a file named __proto__ is signed and its tampering detected', () => {
    const k = createKeyPair();
    const fl = [...files(), f('__proto__', 'orig')];
    const doc = signFiles(fl, k.privateKeyPem);
    expect(Object.keys(doc.manifest)).toContain('__proto__');
    expect(verifyFiles(fl, JSON.parse(JSON.stringify(doc)), [k.publicKey]).ok).toBe(true);
    const r = verifyFiles([...files(), f('__proto__', 'EVIL')], JSON.parse(JSON.stringify(doc)), [k.publicKey]);
    expect(r).toMatchObject({ ok: false, changed: ['__proto__'] });
    expect(verifyFiles([...files(), f('__proto__', 'EVIL')], signFiles(files(), k.privateKeyPem), [k.publicKey]).ok).toBe(false);
  });
  it('hostile manifest keys signed validly but absent from files are reported', () => {
    const k = createKeyPair();
    for (const name of ['__proto__', '../x']) {
      const doc = signFiles([...files(), f(name, 'z')], k.privateKeyPem);
      expect(verifyFiles(files(), doc, [k.publicKey])).toMatchObject({ ok: false, changed: [name] });
    }
  });
  it('a validly signed manifest that does not match files fails in both directions', () => {
    const k = createKeyPair();
    const fewer = signFiles(files().slice(0, 2), k.privateKeyPem); // manifest lacks b.txt
    expect(verifyFiles(files(), fewer, [k.publicKey])).toMatchObject({ ok: false, changed: ['b.txt'] });
    const more = signFiles(files(), k.privateKeyPem); // manifest has b.txt, files lack it
    expect(verifyFiles(files().slice(0, 2), more, [k.publicKey])).toMatchObject({ ok: false, changed: ['b.txt'] });
  });
});

describe('verifySkillDir', () => {
  it('verifies a signed dir, skips symlinks, reports missing signature, never throws', async () => {
    const dir = await tmpDir();
    const k = createKeyPair();
    await writeFile(join(dir, 'SKILL.md'), 'hello');
    await mkdir(join(dir, 'ref'));
    await writeFile(join(dir, 'ref', 'a.md'), 'a');
    expect(await verifySkillDir(dir, ['SKILL.md', 'ref/a.md'], [k.publicKey])).toEqual({ ok: false, changed: [], error: 'missing signature' });
    const doc = signFiles([f('SKILL.md', 'hello'), f('ref/a.md', 'a')], k.privateKeyPem);
    await writeFile(join(dir, SIGNATURE_FILE), JSON.stringify(doc));
    expect(await verifySkillDir(dir, ['SKILL.md', 'ref/a.md'], [k.publicKey])).toEqual({ ok: true, changed: [] });
    await symlink('/etc/hostname', join(dir, 'link'));
    expect((await verifySkillDir(dir, ['SKILL.md', 'ref/a.md', 'link'], [k.publicKey])).ok).toBe(true);
    await writeFile(join(dir, 'ref', 'a.md'), 'X');
    expect(await verifySkillDir(dir, ['SKILL.md', 'ref/a.md'], [k.publicKey])).toMatchObject({ ok: false, changed: ['ref/a.md'] });
    await writeFile(join(dir, SIGNATURE_FILE), '{not json');
    expect((await verifySkillDir(dir, ['SKILL.md'], [k.publicKey])).error).toBe('malformed signature');
    await writeFile(join(dir, SIGNATURE_FILE), 'x'.repeat(1024 * 1024 + 1));
    expect((await verifySkillDir(dir, ['SKILL.md'], [k.publicKey])).error).toBe('signature file too large');
    expect((await verifySkillDir(join(dir, 'nope'), ['SKILL.md'], [k.publicKey])).error).toBe('missing signature');
  });
});
