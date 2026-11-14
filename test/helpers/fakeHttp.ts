import { NetworkError, TooLargeError, type Http, type HttpResponse } from '../../src/net/http.js';

export interface FakeRoute {
  status?: number; body: string; etag?: string;
  /** The exact Authorization header value required; anything else gets a 401. */
  requireAuth?: string;
}

export interface FakeHttp {
  http: Http;
  /** Every request in order (including ones made while offline), with the headers as sent. */
  calls: Array<{ url: string; headers: Record<string, string> }>;
  offline(on: boolean): void;
}

/** Routes are keyed by the exact URL. A matching If-None-Match gets a 304; an unknown URL gets a 404. */
export function fakeHttp(routes: Record<string, FakeRoute>): FakeHttp {
  const calls: FakeHttp['calls'] = [];
  let isOffline = false;
  return {
    calls,
    offline(on) { isOffline = on; },
    http: {
      async get(url, headers = {}, opts = {}): Promise<HttpResponse> {
        calls.push({ url, headers: { ...headers } });
        if (isOffline) throw new NetworkError(`fake http is offline: GET ${url}`);
        const lower: Record<string, string> = {};
        for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
        const route = routes[url];
        if (!route) return { status: 404, headers: {}, body: Buffer.from('not found') };
        if (route.requireAuth !== undefined && lower.authorization !== route.requireAuth) {
          return { status: 401, headers: {}, body: Buffer.from('unauthorized') };
        }
        const out: Record<string, string> = route.etag ? { etag: route.etag } : {};
        if (route.etag && lower['if-none-match'] === route.etag) {
          return { status: 304, headers: out, body: Buffer.alloc(0) };
        }
        const body = Buffer.from(route.body);
        if (opts.maxBytes !== undefined && body.length > opts.maxBytes) {
          throw new TooLargeError(`fake http: body is over the ${opts.maxBytes} byte limit`);
        }
        return { status: route.status ?? 200, headers: out, body };
      },
    },
  };
}
