import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { authHeaders } from '../auth.js';
import type { Ctx } from '../context.js';
import { isFresh, readState, writeState } from '../cache/state.js';
import { NetworkError, TooLargeError, type HttpResponse } from '../net/http.js';
import type { Auth, CacheSettings, Problem } from '../types.js';
import type { FetchOpts } from './github.js';

export const MAX_HTTP_BYTES = 1024 * 1024;

interface HttpState { etag?: string; checkedAt: number }
interface Failure { error: Problem }

const errorProblem = (code: string, message: string): Problem => ({ level: 'error', code, message });
const fail = (code: string, message: string): Failure => ({ error: errorProblem(code, message) });
const cleanup = (p: string) => rm(p, { force: true, maxRetries: 3 }).catch(() => {});
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

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

/** Atomic: temp file next to the target, then rename. */
async function writeAtomic(file: string, tmpDir: string, body: Buffer): Promise<void> {
  const tmp = `${join(tmpDir, '.tmp-')}${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, file);
  } catch (e) {
    await cleanup(tmp);
    throw e;
  }
}

/**
 * Shared flow: a fresh cached copy is used without a request; otherwise GET (with If-None-Match when
 * there is a cached copy). Any failure falls back to the cached copy when one exists (R8).
 */
async function fetchCached(
  e: { url: string; auth: Auth }, file: string, tmpDir: string, opts: FetchOpts, cache: CacheSettings, ctx: Ctx,
): Promise<{ body: Buffer; stale: boolean; problems: Problem[]; cached: boolean } | Failure> {
  const problems: Problem[] = [];
  const key = `http/${sha256(e.url)}`;
  const rec = await readState<HttpState>(cache.dir, key);
  let prevBody: Buffer | undefined;
  if (rec && typeof rec.checkedAt === 'number') {
    try { prevBody = await readFile(file); } catch { /* no usable cached copy */ }
  }
  const prev = prevBody && rec ? { body: prevBody, etag: typeof rec.etag === 'string' ? rec.etag : undefined, checkedAt: rec.checkedAt } : undefined;

  if (prev && !opts.force && isFresh(prev.checkedAt, opts.ttlSeconds, ctx.now())) {
    return { body: prev.body, stale: false, problems, cached: true };
  }

  const useStale = (why: Failure) => {
    if (!prev) {
      // Surface why auth failed (missing env var, untrusted entry) when there is no cache to fall back to (R10).
      return fail(why.error.code, `${why.error.message}${authCause(problems)}`);
    }
    problems.push({
      level: 'warning', code: 'source/stale',
      message: `${why.error.message}; using the cached copy of ${e.url}, which may be stale`,
    });
    return { body: prev.body, stale: true, problems, cached: true };
  };

  // Lazy (R9): only now is a request actually sent.
  const a = await authHeaders(e.auth, { url: e.url, kind: 'http' }, { trusted: opts.trusted }, ctx);
  if (a.problem) problems.push(a.problem);
  const headers: Record<string, string> = { 'User-Agent': 'skillseekr', ...a.headers };
  if (prev?.etag) headers['If-None-Match'] = prev.etag;

  const res = await getChecked(e.url, headers, MAX_HTTP_BYTES, prev !== undefined, ctx);
  if ('error' in res) return useStale(res);
  if (res.status === 304 && prev) {
    await writeState(cache.dir, key, { etag: prev.etag, checkedAt: ctx.now() } satisfies HttpState).catch(() => {});
    return { body: prev.body, stale: false, problems, cached: true };
  }

  let cached = true;
  try {
    await writeAtomic(file, tmpDir, res.body);
    const etag = res.headers['etag'];
    await writeState(cache.dir, key, { ...(etag ? { etag } : {}), checkedAt: ctx.now() } satisfies HttpState);
  } catch (err) {
    cached = false;
    problems.push({ level: 'warning', code: 'cache/write-failed', message: `could not cache ${e.url}: ${(err as Error).message}` });
  }
  return { body: res.body, stale: false, problems, cached };
}

export async function materializeHttpSkill(
  e: { url: string; skill_name: string; auth: Auth },
  opts: FetchOpts, cache: CacheSettings, ctx: Ctx,
): Promise<{ root: string; stale: boolean; problems: Problem[] } | { error: Problem }> {
  const bad = invalidSkillName(e.skill_name);
  if (bad) return { error: bad };
  const root = join(cache.dir, 'http', sha256(e.url), e.skill_name);
  const r = await fetchCached(e, join(root, 'SKILL.md'), dirname(root), opts, cache, ctx);
  if ('error' in r) return r;
  if (!r.cached) return { error: errorProblem('source/cache-error', `cannot write the cache for ${e.url}: ${r.problems.at(-1)?.message ?? 'unknown error'}${authCause(r.problems)}`) };
  return { root, stale: r.stale, problems: r.problems };
}

export async function fetchHttpText(
  e: { url: string; auth: Auth },
  opts: FetchOpts, cache: CacheSettings, ctx: Ctx,
): Promise<{ text: string; stale: boolean; problems: Problem[] } | { error: Problem }> {
  const file = join(cache.dir, 'http-text', `${sha256(e.url)}.body`);
  const r = await fetchCached(e, file, dirname(file), opts, cache, ctx);
  if ('error' in r) return r;
  return { text: r.body.toString('utf8'), stale: r.stale, problems: r.problems };
}

/** A plain GET: no cache, no stale fallback. With opts.etag a 304 gives notModified. */
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
