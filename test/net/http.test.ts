import { describe, it, expect } from 'vitest';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetchHttp, NetworkError } from '../../src/net/http.js';

async function serve(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function close(...servers: Server[]) {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
}

describe('fetchHttp', () => {
  it('returns status, lowercased headers and the body bytes', async () => {
    const { server, url } = await serve((req, res) => {
      res.writeHead(418, { 'X-Thing': 'yes', 'content-type': 'text/plain' });
      res.end(`you sent ${req.headers.accept}`);
    });
    try {
      const r = await fetchHttp().get(`${url}/x`, { Accept: 'text/x' });
      expect(r.status).toBe(418);
      expect(r.headers['x-thing']).toBe('yes');
      expect(r.body.toString()).toBe('you sent text/x');
    } finally { await close(server); }
  });

  it('follows redirects and does not carry Authorization to another origin (R3)', async () => {
    const seen: IncomingHttpHeaders[] = [];
    const target = await serve((req, res) => { seen.push(req.headers); res.end('tarball'); });
    const api = await serve((req, res) => {
      if (req.url === '/same') { res.writeHead(302, { location: '/final' }); res.end(); return; }
      if (req.url === '/final') { seen.push(req.headers); res.end('same-origin'); return; }
      res.writeHead(302, { location: `${target.url}/codeload` });
      res.end();
    });
    try {
      const http = fetchHttp();
      const r = await http.get(`${api.url}/tarball`, { Authorization: 'Bearer sekrit' });
      expect(r.status).toBe(200);
      expect(r.body.toString()).toBe('tarball');
      expect(seen[0].authorization).toBeUndefined();
      const same = await http.get(`${api.url}/same`, { Authorization: 'Bearer sekrit' });
      expect(same.body.toString()).toBe('same-origin');
      expect(seen[1].authorization).toBe('Bearer sekrit');
    } finally { await close(target.server, api.server); }
  });

  it('turns a connection failure into NetworkError', async () => {
    const { server, url } = await serve((_req, res) => res.end());
    await close(server);
    await expect(fetchHttp().get(`${url}/x`)).rejects.toBeInstanceOf(NetworkError);
  });

  it('turns a dropped connection into NetworkError', async () => {
    const { server, url } = await serve((req) => req.socket.destroy());
    try {
      await expect(fetchHttp().get(`${url}/x`)).rejects.toBeInstanceOf(NetworkError);
    } finally { await close(server); }
  });

  it('a timeout is a NetworkError', async () => {
    const { server, url } = await serve(() => { /* never answers */ });
    try {
      await expect(fetchHttp({ timeoutMs: 50 }).get(`${url}/x`)).rejects.toBeInstanceOf(NetworkError);
    } finally { await close(server); }
  });
});
