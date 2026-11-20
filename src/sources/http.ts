import { authHeaders } from '../auth.js';
import type { Ctx } from '../context.js';
import { NetworkError, TooLargeError, type HttpResponse } from '../net/http.js';
import type { Auth, Problem } from '../types.js';

export const MAX_HTTP_BYTES = 1024 * 1024;

interface Failure { error: Problem }

const errorProblem = (code: string, message: string): Problem => ({ level: 'error', code, message });
const fail = (code: string, message: string): Failure => ({ error: errorProblem(code, message) });

/** " (auth: ...)" naming why auth failed (missing env var, untrusted entry), or "" when auth was fine (R10). */
const authCause = (problems: Problem[]): string => {
  const a = problems.filter((p) => p.code.startsWith('auth/'));
  return a.length ? ` (auth: ${a.map((p) => p.message).join('; ')})` : '';
};

/** skill_name becomes a directory name, so it can never be empty, "." / "..", or hold a separator or NUL. */
export function invalidSkillName(name: string): Problem | undefined {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name)) {
    return errorProblem('source/invalid', `skill_name ${JSON.stringify(name)} is not a valid folder name (no "/", "\\", NUL, ".", ".." or empty)`);
  }
  return undefined;
}

function failureFor(url: string, res: HttpResponse): Failure {
  const s = res.status;
  if (s >= 500) return fail('source/unreachable', `${url} is unreachable (HTTP ${s}: server error)`);
  if (s === 401 || s === 403 || s === 404) {
    return fail('source/no-access', `Cannot access ${url} (HTTP ${s}): it does not exist or you have no access. Check the URL and the configured auth.`);
  }
  return fail('source/http-error', `Unexpected response from ${url} (HTTP ${s})`);
}

const limitText = (maxBytes: number) => (maxBytes === MAX_HTTP_BYTES ? '1 MB' : `${maxBytes} bytes`);

/**
 * One GET with failures mapped to Problems. A 304 is returned as-is only when allowNotModified; any other
 * non-2xx status or an oversize body is a Failure.
 */
async function getChecked(
  url: string, headers: Record<string, string>, maxBytes: number, allowNotModified: boolean, ctx: Ctx,
): Promise<HttpResponse | Failure> {
  let res: HttpResponse;
  try {
    res = await ctx.http.get(url, headers, { maxBytes });
  } catch (err) {
    if (err instanceof TooLargeError) return fail('source/too-large', `${url} is over the ${limitText(maxBytes)} limit`);
    if (err instanceof NetworkError) return fail('source/unreachable', `${url} is unreachable: ${err.message}`);
    throw err;
  }
  if (res.status === 304 && allowNotModified) return res;
  if (res.status < 200 || res.status > 299) return failureFor(url, res);
  if (res.body.length > maxBytes) return fail('source/too-large', `${url} is over the ${limitText(maxBytes)} limit`);
  return res;
}

/** A plain GET: no persistence, no stale fallback. With opts.etag a 304 gives notModified. */
export async function fetchHttpBody(
  e: { url: string; auth: Auth },
  opts: { trusted: boolean; etag?: string; maxBytes?: number },
  ctx: Ctx,
): Promise<{ notModified: true; problems: Problem[] } | { notModified: false; body: Buffer; etag?: string; problems: Problem[] } | { error: Problem }> {
  const problems: Problem[] = [];
  const a = await authHeaders(e.auth, { url: e.url, kind: 'http' }, { trusted: opts.trusted }, ctx);
  if (a.problem) problems.push(a.problem);
  const headers: Record<string, string> = { 'User-Agent': 'skillseekr', ...a.headers };
  if (opts.etag) headers['If-None-Match'] = opts.etag;
  const res = await getChecked(e.url, headers, opts.maxBytes ?? MAX_HTTP_BYTES, opts.etag !== undefined, ctx);
  if ('error' in res) return { error: { ...res.error, message: `${res.error.message}${authCause(problems)}` } };
  if (res.status === 304) return { notModified: true, problems };
  const etag = res.headers['etag'];
  return { notModified: false, body: res.body, ...(etag ? { etag } : {}), problems };
}
