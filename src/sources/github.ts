import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, posix, win32 } from 'node:path';
import { x as extract, type ReadEntry } from 'tar';
import { authHeaders } from '../auth.js';
import type { Ctx } from '../context.js';
import { isFresh, readState, writeState } from '../cache/state.js';
import { NetworkError, TooLargeError, type HttpResponse } from '../net/http.js';
import type { Auth, CacheSettings, Problem } from '../types.js';

export interface FetchOpts { force: boolean; trusted: boolean; ttlSeconds: number /* 0 when caching disabled */ }
export interface TreeResult { sha: string; root: string /* abs dir = repo root at sha */; stale: boolean; problems: Problem[] }

interface Repo { owner: string; repo: string; ref: string; auth: Auth }
interface RefState { sha: string; checkedAt: number }
/** A failed request or download. Any failure falls back to an older cached copy when one exists (R8). */
interface Failure { error: Problem }

export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const MAX_EXTRACT_BYTES = 500 * 1024 * 1024;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const NAME_RE = /^[A-Za-z0-9_.-]+$/;
/** Entry types that may be extracted. Everything else (symlinks, hard links, devices, FIFOs) is skipped. */
const EXTRACTABLE = new Set(['File', 'OldFile', 'ContiguousFile', 'Directory']);

export function isShaRef(ref: string): boolean { return SHA_RE.test(ref); }

const errorProblem = (code: string, message: string): Problem => ({ level: 'error', code, message });
const fail = (code: string, message: string): Failure => ({ error: errorProblem(code, message) });
/** Best-effort removal on error paths: a cleanup failure must never replace the Problem with a throw. */
const cleanup = (p: string) => rm(p, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
const short = (sha: string) => sha.slice(0, 7);
const slug = (o: Repo) => `${o.owner}/${o.repo}`;

// ---------- input validation (owner/repo/ref/path may come from untrusted registries files) ----------

function invalidRepo(o: Repo): Problem | undefined {
  for (const [field, v] of [['owner', o.owner], ['repo', o.repo]] as const) {
    if (!NAME_RE.test(v) || v === '.' || v === '..') {
      return errorProblem('source/invalid', `GitHub ${field} ${JSON.stringify(v)} is not a valid name (in ${slug(o)})`);
    }
  }
  // Roughly git check-ref-format: also guarantees the ref can't change the API path (no "..", "//", edges).
  if (!o.ref || /[\x00-\x20\x7f~^:?*[\\]|\.\.|\/\/|@\{|^\/|\/$|^-/.test(o.ref)) {
    return errorProblem('source/invalid', `ref ${JSON.stringify(o.ref)} of GitHub repo ${slug(o)} is not a valid git ref`);
  }
  return undefined;
}

/** Repo-relative POSIX path split into segments, or undefined when it is empty, absolute or escapes. */
function safeSegments(path: string): string[] | undefined {
  if (!path || path.includes('\0') || path.includes('\\')) return undefined;
  if (posix.isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path)) return undefined;
  const segs = path.split('/');
  return segs.some((s) => s === '' || s === '.' || s === '..') ? undefined : segs;
}

/** tar filter: only plain files and dirs, never absolute names or any ".." segment. */
function extractable(path: string, entry: unknown): boolean {
  const type = (entry as ReadEntry).type;
  if (!EXTRACTABLE.has(type)) return false;
  if (path.includes('\0')) return false;
  if (posix.isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path)) return false;
  return !path.split(/[\\/]+/).includes('..');
}

// ---------- requests ----------

function failureFor(o: Repo, res: HttpResponse, what: string): Failure {
  const s = res.status;
  const where = `GitHub repo ${slug(o)} (HTTP ${s} while ${what})`;
  if (s >= 500) return fail('source/unreachable', `${where}: server error`);
  if (s === 429 || (s === 403 && res.headers['x-ratelimit-remaining'] === '0')) {
    const reset = Number(res.headers['x-ratelimit-reset']);
    const when = Number.isFinite(reset) && reset > 0 ? `; it resets at ${new Date(reset * 1000).toISOString()}` : '';
    const hint = o.auth.type === 'none' ? ' Authenticated requests get a higher limit (auth: gh_cli).' : '';
    return fail('source/rate-limited', `GitHub API rate limit reached for ${where}${when}.${hint}`);
  }
  if (s === 401 || s === 403 || s === 404) {
    const hint = o.auth.type === 'gh_cli'
      ? ' Run "gh auth login" with an account that can read it.'
      : o.auth.type === 'none'
        ? ' If it is private, configure auth (for example gh_cli).'
        : ' Check that the configured token can read it.';
    return fail('source/no-access', `Cannot access ${where}: it does not exist or you have no access.${hint}`);
  }
  if (s === 422 && what.startsWith('resolving')) {
    return fail('source/ref-not-found', `ref ${JSON.stringify(o.ref)} was not found in GitHub repo ${slug(o)} (HTTP 422)`);
  }
  return fail('source/http-error', `Unexpected response from ${where}`);
}

type Get = (url: string, accept: string, what: string) => Promise<HttpResponse | Failure>;

function getter(o: Repo, headers: () => Promise<Record<string, string>>, ctx: Ctx): Get {
  return async (url, accept, what) => {
    let res: HttpResponse;
    try {
      res = await ctx.http.get(url, { 'User-Agent': 'skillseekr', Accept: accept, ...await headers() }, { maxBytes: MAX_DOWNLOAD_BYTES });
    } catch (e) {
      if (e instanceof TooLargeError) return fail('source/too-large', `GitHub repo ${slug(o)}: response while ${what} is over 100 MB`);
      if (e instanceof NetworkError) return fail('source/unreachable', `GitHub repo ${slug(o)} is unreachable while ${what}: ${e.message}`);
      throw e;
    }
    if (res.status < 200 || res.status > 299) return failureFor(o, res, what);
    if (res.body.length > MAX_DOWNLOAD_BYTES) return fail('source/too-large', `GitHub repo ${slug(o)}: response while ${what} is over 100 MB`);
    return res;
  };
}

const isFailure = (r: unknown): r is Failure => typeof r === 'object' && r !== null && 'error' in r;

// ---------- the shared flow: resolve the ref, use or fill the cache, fall back to stale ----------

async function withSha<T>(
  o: Repo, opts: FetchOpts, cache: CacheSettings, ctx: Ctx,
  cached: (sha: string) => Promise<T | undefined>,
  fetchNew: (sha: string, get: Get) => Promise<T | Failure>,
): Promise<{ sha: string; value: T; stale: boolean; problems: Problem[] } | { error: Problem }> {
  const bad = invalidRepo(o);
  if (bad) return { error: bad };
  const problems: Problem[] = [];
  const base = `${ctx.githubApi.replace(/\/+$/, '')}/repos/${o.owner}/${o.repo}`;
  // Lazy (R9): a cache hit makes no request, so it must not spawn gh or report auth problems.
  let auth: Promise<Record<string, string>> | undefined;
  const headers = () => (auth ??= authHeaders(o.auth, { url: base, kind: 'github' }, { trusted: opts.trusted }, ctx)
    .then((a) => { if (a.problem) problems.push(a.problem); return a.headers; }));
  const get = getter(o, headers, ctx);

  // Surface why auth failed (missing env var, untrusted entry) on an error with no cache to fall back to (R10).
  const err = (e: Problem): { error: Problem } => ({
    error: problems.length ? { ...e, message: `${e.message} (auth: ${problems.map((p) => p.message).join('; ')})` } : e,
  });

  const stale = async (prev: RefState | undefined, why: Failure) => {
    const value = prev ? await cached(prev.sha) : undefined;
    if (!prev || value === undefined) return undefined;
    problems.push({
      level: 'warning', code: 'source/stale',
      message: `${why.error.message}; using the cached copy of ${slug(o)} at ${short(prev.sha)} (ref "${o.ref}"), which may be stale`,
    });
    return { sha: prev.sha, value, stale: true, problems };
  };

  let sha = o.ref;
  let stateKey: string | undefined;
  let prev: RefState | undefined;
  if (!isShaRef(o.ref)) {
    const key = `ref/${o.owner}/${o.repo}/${o.ref}`;
    const rec = await readState<RefState>(cache.dir, key);
    prev = rec && typeof rec.sha === 'string' && FULL_SHA_RE.test(rec.sha) && typeof rec.checkedAt === 'number' ? rec : undefined;
    if (prev && !opts.force && isFresh(prev.checkedAt, opts.ttlSeconds, ctx.now())) {
      sha = prev.sha;
    } else {
      const ref = o.ref.split('/').map(encodeURIComponent).join('/');
      const res = await get(`${base}/commits/${ref}`, 'application/vnd.github.sha', `resolving ref "${o.ref}"`);
      if (isFailure(res)) return (await stale(prev, res)) ?? err(res.error);
      sha = res.body.toString('utf8').trim();
      if (!FULL_SHA_RE.test(sha)) {
        const bad = fail('source/bad-response', `GitHub repo ${slug(o)}: resolving ref "${o.ref}" did not return a commit sha`);
        return (await stale(prev, bad)) ?? err(bad.error);
      }
      stateKey = key;
    }
  }

  let value = await cached(sha);
  if (value === undefined) {
    const got = await fetchNew(sha, get);
    if (isFailure(got)) {
      // Only an older sha can be cached here (this sha's copy was just found missing).
      const older = prev && prev.sha !== sha ? await stale(prev, got) : undefined;
      return older ?? err(got.error);
    }
    value = got;
  }
  if (stateKey) {
    try {
      await writeState(cache.dir, stateKey, { sha, checkedAt: ctx.now() } satisfies RefState);
    } catch (e) {
      problems.push({ level: 'warning', code: 'cache/write-failed', message: `could not record ref "${o.ref}" of ${slug(o)} in the cache: ${(e as Error).message}` });
    }
  }
  return { sha, value, stale: false, problems };
}

// ---------- trees ----------

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

export class ExtractTooLargeError extends Error {
  override name = 'ExtractTooLargeError';
}

/**
 * Extract a (gzipped) GitHub tarball into cwd, dropping the top folder. Only plain files and dirs with
 * safe relative names are written. Aborts with ExtractTooLargeError once the declared sizes of the
 * entries to extract add up to more than maxBytes.
 */
export function extractTarball(buf: Buffer, cwd: string, maxBytes = MAX_EXTRACT_BYTES): Promise<void> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const u = extract({
      cwd, strip: 1, preservePaths: false, preserveOwner: false,
      filter: (path, entry) => {
        if (!extractable(path, entry)) return false;
        total += (entry as ReadEntry).size ?? 0;
        if (total <= maxBytes) return true;
        u.abort(new ExtractTooLargeError(`it expands to more than ${maxBytes} bytes`));
        return false;
      },
    });
    u.on('error', reject);
    u.on('close', () => resolve());
    u.end(buf);
  });
}

/**
 * Extract into a unique ".tmp-*" sibling, then rename to <sha>/: a tree is visible only once complete.
 * If another process won the race the rename fails (EEXIST/ENOTEMPTY/EPERM), and its tree is used.
 */
async function storeTree(o: Repo, body: Buffer, repoDir: string, root: string): Promise<string | Failure> {
  let tmp: string;
  try {
    await mkdir(repoDir, { recursive: true, mode: 0o700 });
    tmp = await mkdtemp(join(repoDir, '.tmp-'));
  } catch (e) {
    return fail('source/cache-error', `cannot write the cache for GitHub repo ${slug(o)}: ${(e as Error).message}`);
  }
  try {
    await extractTarball(body, tmp);
  } catch (e) {
    await cleanup(tmp);
    if (e instanceof ExtractTooLargeError) {
      return fail('source/too-large', `the tarball of GitHub repo ${slug(o)} is too large: ${e.message}`);
    }
    return fail('source/bad-archive', `the tarball of GitHub repo ${slug(o)} could not be extracted: ${(e as Error).message}`);
  }
  try {
    await rename(tmp, root);
  } catch (e) {
    await cleanup(tmp);
    if (!(await isDir(root))) {
      return fail('source/cache-error', `cannot write the cache for GitHub repo ${slug(o)}: ${(e as Error).message}`);
    }
  }
  return root;
}

export async function materializeGithub(
  o: { owner: string; repo: string; ref: string; auth: Auth },
  opts: FetchOpts, cache: CacheSettings, ctx: Ctx,
): Promise<TreeResult | { error: Problem }> {
  const repoDir = join(cache.dir, 'github', o.owner, o.repo);
  const r = await withSha(o, opts, cache, ctx,
    async (sha) => (await isDir(join(repoDir, sha)) ? join(repoDir, sha) : undefined),
    async (sha, get) => {
      const res = await get(`${ctx.githubApi.replace(/\/+$/, '')}/repos/${o.owner}/${o.repo}/tarball/${sha}`,
        'application/vnd.github+json', `downloading the tarball for ${short(sha)}`);
      return isFailure(res) ? res : storeTree(o, res.body, repoDir, join(repoDir, sha));
    });
  if ('error' in r) return r;
  return { sha: r.sha, root: r.value, stale: r.stale, problems: r.problems };
}

// ---------- single files ----------

export async function readGithubFile(
  o: { owner: string; repo: string; ref: string; path: string; auth: Auth },
  opts: FetchOpts, cache: CacheSettings, ctx: Ctx,
): Promise<{ sha: string; text: string; stale: boolean; problems: Problem[] } | { error: Problem }> {
  const segs = safeSegments(o.path);
  if (!segs) {
    return { error: errorProblem('source/invalid', `path ${JSON.stringify(o.path)} in GitHub repo ${o.owner}/${o.repo} must be relative with no "." or ".." segments`) };
  }
  const fileAt = (sha: string) => join(cache.dir, 'files', o.owner, o.repo, sha, ...segs);
  const r = await withSha(o, opts, cache, ctx,
    async (sha) => { try { return await readFile(fileAt(sha), 'utf8'); } catch { return undefined; } },
    async (sha, get) => {
      const path = segs.map(encodeURIComponent).join('/');
      const res = await get(`${ctx.githubApi.replace(/\/+$/, '')}/repos/${o.owner}/${o.repo}/contents/${path}?ref=${sha}`,
        'application/vnd.github.raw', `reading ${o.path} at ${short(sha)}`);
      if (isFailure(res)) return res;
      const file = fileAt(sha);
      const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        await writeFile(tmp, res.body);
        await rename(tmp, file);
      } catch {
        await cleanup(tmp);
        // Not cached this time; the content is still good to return.
      }
      return res.body.toString('utf8');
    });
  if ('error' in r) return r;
  return { sha: r.sha, text: r.value, stale: r.stale, problems: r.problems };
}
