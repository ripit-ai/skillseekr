import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { Header, Parser, type HeaderData, type ReadEntry } from 'tar';
import { NetworkError, type Http, type HttpResponse } from '../../src/net/http.js';

// ---------- raw tar building (R2: names are written exactly as given) ----------

export interface TarEntry { path: string; type: NonNullable<HeaderData['type']>; body?: string | Buffer; linkpath?: string }

/**
 * Raw ustar bytes built from hand-encoded 512-byte headers (tar's Header computes the checksum).
 * Unlike tar.c, nothing is sanitised, so hostile names like "../evil" or "/abs/evil" survive.
 */
export function buildTar(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const body = Buffer.from(e.body ?? '');
    const header = new Header({
      path: e.path, type: e.type, mode: e.type === 'Directory' ? 0o755 : 0o644, size: body.length,
      mtime: new Date(0), uid: 0, gid: 0, uname: '', gname: '', linkpath: e.linkpath ?? '',
    });
    const block = Buffer.alloc(512);
    if (header.encode(block)) throw new Error(`tar header for ${e.path} needs pax (name too long)`);
    blocks.push(block, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export const buildTarGz = (entries: TarEntry[]): Buffer => gzipSync(buildTar(entries));

/** Lists the raw entries of a (gzipped) tarball, before any extraction-side sanitising. */
export function listTar(buf: Buffer): Promise<Array<{ path: string; type: string; linkpath?: string }>> {
  return new Promise((resolve, reject) => {
    const out: Array<{ path: string; type: string; linkpath?: string }> = [];
    const p = new Parser({
      onReadEntry: (e: ReadEntry) => { out.push({ path: e.path, type: e.type, linkpath: e.linkpath }); e.resume(); },
    });
    p.on('error', reject);
    p.on('end', () => resolve(out));
    p.end(buf);
  });
}

// ---------- fake GitHub API ----------

export type FakeFile = string | { symlink: string };
export interface FakeRepo { refs: Record<string, string>; commits: Record<string, Record<string, FakeFile>>; token?: string }
export type FakeSpec = Record<string, FakeRepo>;

export interface FakeGithub {
  http: Http;
  /** "<pathname><search>" of every request, in order (including ones made while offline). */
  calls: string[];
  offline(on: boolean): void;
  /** Same routes, for a real http.createServer. Offline: the socket is destroyed. */
  nodeHandler: (req: IncomingMessage, res: ServerResponse) => void;
}

const SHA_RE = /^[0-9a-f]{7,40}$/;
const text = (status: number, body: string | Buffer, type = 'text/plain'): HttpResponse =>
  ({ status, headers: { 'content-type': type }, body: Buffer.from(body) });
const notFound = () => text(404, JSON.stringify({ message: 'Not Found' }), 'application/json');

/** One pax record: "<len> <key>=<value>\n", where len counts the whole record including itself. */
function paxRecord(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  let len = rest.length + 1;
  while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
  return `${len}${rest}`;
}

/** GitHub's tarball shape: pax global header with the sha, then "{o}-{r}-{sha7}/" with dirs before their files. */
function repoTarball(owner: string, repo: string, sha: string, files: Record<string, FakeFile>): Buffer {
  const top = `${owner}-${repo}-${sha.slice(0, 7)}`;
  const entries: TarEntry[] = [
    { path: 'pax_global_header', type: 'GlobalExtendedHeader', body: paxRecord('comment', sha) },
    { path: `${top}/`, type: 'Directory' },
  ];
  const dirs = new Set<string>();
  for (const p of Object.keys(files).sort()) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const d = parts.slice(0, i).join('/');
      if (!dirs.has(d)) { dirs.add(d); entries.push({ path: `${top}/${d}/`, type: 'Directory' }); }
    }
    const f = files[p];
    entries.push(typeof f === 'string'
      ? { path: `${top}/${p}`, type: 'File', body: f }
      : { path: `${top}/${p}`, type: 'SymbolicLink', linkpath: f.symlink });
  }
  return buildTarGz(entries);
}

export function fakeGithub(spec: FakeSpec): FakeGithub {
  const calls: string[] = [];
  let isOffline = false;

  const handle = (url: string, rawHeaders: Record<string, string | string[] | undefined>): HttpResponse => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawHeaders)) if (v !== undefined) headers[k.toLowerCase()] = String(v);
    const u = new URL(url, 'http://fake.invalid');
    const m = /\/repos\/([^/]+)\/([^/]+)\/(commits|tarball|contents)\/(.+)$/.exec(u.pathname);
    if (!m) return notFound();
    const [owner, name, route] = [decodeURIComponent(m[1]), decodeURIComponent(m[2]), m[3]];
    const rest = m[4].split('/').map(decodeURIComponent).join('/');
    const repo = spec[`${owner}/${name}`];
    if (!repo) return notFound();
    if (repo.token !== undefined && headers.authorization !== `Bearer ${repo.token}`) return notFound();

    const findSha = (ref: string): string | undefined => {
      if (repo.refs[ref]) return repo.refs[ref];
      if (repo.commits[ref]) return ref;
      return SHA_RE.test(ref) ? Object.keys(repo.commits).find((s) => s.startsWith(ref)) : undefined;
    };

    if (route === 'commits') {
      const sha = findSha(rest);
      if (!sha) return text(422, JSON.stringify({ message: `No commit found for SHA: ${rest}` }), 'application/json');
      return headers.accept === 'application/vnd.github.sha'
        ? text(200, sha)
        : text(200, JSON.stringify({ sha }), 'application/json');
    }
    if (route === 'tarball') {
      const sha = findSha(rest);
      if (!sha || !repo.commits[sha]) return notFound();
      return text(200, repoTarball(owner, name, sha, repo.commits[sha]), 'application/x-gzip');
    }
    // contents/{path}?ref=
    const sha = findSha(u.searchParams.get('ref') ?? 'main');
    const file = sha ? repo.commits[sha]?.[rest] : undefined;
    if (file === undefined) return notFound();
    return text(200, typeof file === 'string' ? file : file.symlink);
  };

  return {
    calls,
    offline(on) { isOffline = on; },
    http: {
      async get(url, headers = {}) {
        const u = new URL(url);
        calls.push(u.pathname + u.search);
        if (isOffline) throw new NetworkError(`fake github is offline: GET ${url}`);
        return handle(url, headers);
      },
    },
    nodeHandler(req, res) {
      calls.push(req.url ?? '');
      if (isOffline) { req.socket.destroy(); return; }
      const r = handle(req.url ?? '/', req.headers);
      res.writeHead(r.status, r.headers);
      res.end(r.body);
    },
  };
}
