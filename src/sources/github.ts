import { mkdir, rm } from 'node:fs/promises';
import { dirname, posix, win32 } from 'node:path';
import { x as extract, type ReadEntry } from 'tar';
import { authHeaders } from '../auth.js';
import type { Ctx } from '../context.js';
import { NetworkError, TooLargeError, type HttpResponse } from '../net/http.js';
import type { Auth, Problem } from '../types.js';

interface Repo { owner: string; repo: string; ref: string; auth: Auth }
/** A failed request or download. */
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

export function invalidRepo(o: Repo): Problem | undefined {
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
export function safeSegments(path: string): string[] | undefined {
  if (!path || path.includes('\0') || path.includes('\\')) return undefined;
  if (posix.isAbsolute(path) || win32.isAbsolute(path) || /^[A-Za-z]:/.test(path)) return undefined;
  const segs = path.split('/');
  return segs.some((s) => s === '' || s === '.' || s === '..') ? undefined : segs;
}

const invalidPath = (o: Repo & { path: string }): Problem =>
  errorProblem('source/invalid', `path ${JSON.stringify(o.path)} in GitHub repo ${o.owner}/${o.repo} must be relative with no "." or ".." segments`);

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

/** Request plumbing shared by the fetchers: base URL, lazy auth (R9), problems, and R10 error context. */
function session(o: Repo, trusted: boolean, ctx: Ctx) {
  const problems: Problem[] = [];
  const base = `${ctx.githubApi.replace(/\/+$/, '')}/repos/${o.owner}/${o.repo}`;
  // Lazy (R9): a request that is never made must not spawn gh or report auth problems.
  let auth: Promise<Record<string, string>> | undefined;
  const headers = () => (auth ??= authHeaders(o.auth, { url: base, kind: 'github' }, { trusted }, ctx)
    .then((a) => { if (a.problem) problems.push(a.problem); return a.headers; }));
  // Surface why auth failed (missing env var, untrusted entry) on an error (R10).
  const err = (e: Problem): { error: Problem } => ({
    error: problems.length ? { ...e, message: `${e.message} (auth: ${problems.map((p) => p.message).join('; ')})` } : e,
  });
  return { base, problems, get: getter(o, headers, ctx), err };
}

/** Resolve a ref to a full commit sha with one /commits/<ref> request. */
async function resolveRef(o: Repo, base: string, get: Get): Promise<string | Failure> {
  const ref = o.ref.split('/').map(encodeURIComponent).join('/');
  const res = await get(`${base}/commits/${ref}`, 'application/vnd.github.sha', `resolving ref "${o.ref}"`);
  if (isFailure(res)) return res;
  const sha = res.body.toString('utf8').trim();
  return FULL_SHA_RE.test(sha) ? sha : fail('source/bad-response', `GitHub repo ${slug(o)}: resolving ref "${o.ref}" did not return a commit sha`);
}

// ---------- trees ----------

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

/** Extract a tarball into the existing dir; on failure remove it and return the Failure. */
async function extractInto(o: Repo, body: Buffer, dir: string): Promise<Failure | undefined> {
  try {
    await extractTarball(body, dir);
  } catch (e) {
    await cleanup(dir);
    if (e instanceof ExtractTooLargeError) {
      return fail('source/too-large', `the tarball of GitHub repo ${slug(o)} is too large: ${e.message}`);
    }
    return fail('source/bad-archive', `the tarball of GitHub repo ${slug(o)} could not be extracted: ${(e as Error).message}`);
  }
  return undefined;
}

// ---------- fetchers (no persistence, no stale fallback: the library pull decides what to keep) ----------

/** Resolve the ref and download its tarball into a new dir. A sha equal to knownSha returns unchanged with no download. */
export async function fetchGithubTree(
  o: Repo, opts: { trusted: boolean; knownSha?: string }, intoDir: string, ctx: Ctx,
): Promise<{ sha: string; unchanged: boolean; problems: Problem[] } | { error: Problem }> {
  const bad = invalidRepo(o);
  if (bad) return { error: bad };
  const { base, problems, get, err } = session(o, opts.trusted, ctx);
  let sha = o.ref;
  if (!isShaRef(o.ref)) {
    const got = await resolveRef(o, base, get);
    if (isFailure(got)) return err(got.error);
    sha = got;
  }
  if (opts.knownSha !== undefined && sha === opts.knownSha) return { sha, unchanged: true, problems };
  const res = await get(`${base}/tarball/${sha}`, 'application/vnd.github+json', `downloading the tarball for ${short(sha)}`);
  if (isFailure(res)) return err(res.error);
  try {
    await mkdir(dirname(intoDir), { recursive: true, mode: 0o700 });
    await mkdir(intoDir, { mode: 0o700 }); // not recursive: fails when intoDir already exists, and then it is not ours to remove
  } catch (e) {
    return err(fail('source/write-failed', `cannot create ${intoDir} for GitHub repo ${slug(o)}: ${(e as Error).message}`).error);
  }
  const failed = await extractInto(o, res.body, intoDir);
  return failed ? err(failed.error) : { sha, unchanged: false, problems };
}

/** One file at the ref's commit. */
export async function fetchGithubFile(
  o: Repo & { path: string }, opts: { trusted: boolean }, ctx: Ctx,
): Promise<{ sha: string; text: string; problems: Problem[] } | { error: Problem }> {
  const bad = invalidRepo(o);
  if (bad) return { error: bad };
  const segs = safeSegments(o.path);
  if (!segs) return { error: invalidPath(o) };
  const { base, problems, get, err } = session(o, opts.trusted, ctx);
  let sha = o.ref;
  if (!isShaRef(o.ref)) {
    const got = await resolveRef(o, base, get);
    if (isFailure(got)) return err(got.error);
    sha = got;
  }
  const res = await get(`${base}/contents/${segs.map(encodeURIComponent).join('/')}?ref=${sha}`,
    'application/vnd.github.raw', `reading ${o.path} at ${short(sha)}`);
  return isFailure(res) ? err(res.error) : { sha, text: res.body.toString('utf8'), problems };
}
