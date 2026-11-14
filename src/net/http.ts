export interface HttpResponse { status: number; headers: Record<string, string>; body: Buffer }

export interface HttpGetOptions {
  /** Stop reading and throw TooLargeError once the body exceeds this many bytes. */
  maxBytes?: number;
}

export interface Http {
  /** Follows redirects. Throws NetworkError on connection failure (refused, reset, DNS, timeout). */
  get(url: string, headers?: Record<string, string>, opts?: HttpGetOptions): Promise<HttpResponse>;
}

export class NetworkError extends Error {
  override name = 'NetworkError';
}

export class TooLargeError extends Error {
  override name = 'TooLargeError';
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The URL without query or fragment, so error messages never echo query-string secrets. */
function describe(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}`; } catch { return '<invalid url>'; }
}

function causeText(e: unknown): string {
  if (e instanceof Error) {
    const cause = e.cause instanceof Error ? `: ${e.cause.message}` : '';
    return `${e.message}${cause}`;
  }
  return String(e);
}

async function readBody(res: Response, maxBytes: number | undefined, url: string): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const declared = Number(res.headers.get('content-length'));
  if (maxBytes !== undefined && declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new TooLargeError(`GET ${describe(url)}: body is ${declared} bytes, over the ${maxBytes} byte limit`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (maxBytes !== undefined && total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new TooLargeError(`GET ${describe(url)}: body is over the ${maxBytes} byte limit`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * Http over the global fetch (Node >= 20). Redirects are followed by fetch itself, which drops
 * Authorization on a cross-origin redirect (R3); never re-add it here.
 */
export function fetchHttp(o: { timeoutMs?: number } = {}): Http {
  const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return {
    async get(url, headers = {}, opts = {}) {
      const signal = AbortSignal.timeout(timeoutMs);
      try {
        const res = await fetch(url, { headers, redirect: 'follow', signal });
        const body = await readBody(res, opts.maxBytes, url);
        const h: Record<string, string> = {};
        res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
        return { status: res.status, headers: h, body };
      } catch (e) {
        if (e instanceof TooLargeError) throw e;
        throw new NetworkError(`GET ${describe(url)} failed: ${causeText(e)}`, { cause: e });
      }
    },
  };
}
