import type { Auth, Problem } from './types.js';
import type { Ctx } from './context.js';

export interface AuthResult { headers: Record<string, string>; problem?: Problem }

const GH_TOKEN_TIMEOUT_MS = 5000;

// Per process. A failure is cached too (as null) so gh isn't re-spawned on every call.
let ghToken: Promise<string | null> | undefined;

export function resetGhTokenCache(): void { ghToken = undefined; }

function loadGhToken(ctx: Ctx): Promise<string | null> {
  ghToken ??= ctx.exec('gh', ['auth', 'token'], { timeoutMs: GH_TOKEN_TIMEOUT_MS }).then(
    (r) => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null),
    () => null,
  );
  return ghToken;
}

const fail = (level: Problem['level'], code: string, message: string): AuthResult =>
  ({ headers: {}, problem: { level, code, message } });

export async function authHeaders(
  auth: Auth,
  target: { url: string; kind: 'github' | 'http' },
  opts: { trusted: boolean },
  ctx: Ctx,
): Promise<AuthResult> {
  if (auth.type === 'none') return { headers: {} };

  if (auth.type === 'gh_cli') {
    // Full origin (scheme + host + port): never send the token in cleartext or to another port.
    let origin: string | undefined;
    try { origin = new URL(target.url).origin; } catch { /* unparseable url: no token */ }
    if (origin === undefined || origin !== new URL(ctx.githubApi).origin) return { headers: {} };
    const token = await loadGhToken(ctx);
    if (!token) {
      return fail('warning', 'auth/gh-unavailable',
        'gh_cli auth is configured but "gh auth token" gave no token; continuing without auth (run "gh auth login")');
    }
    return { headers: { Authorization: `Bearer ${token}` } };
  }

  // Env-var based auth: never touch ctx.env unless the entry is trusted.
  if (!opts.trusted) {
    return fail('warning', 'auth/untrusted-env-auth',
      `${auth.type} auth is not allowed in an included registries file; only gh_cli or no auth is. Entry skipped auth.`);
  }
  const read = (name: string): string | undefined => ctx.env[name] || undefined;
  const missing = (name: string) => fail('warning', 'auth/env-missing',
    `auth env var ${name} is not set or empty`);

  if (auth.type === 'basic') {
    const user = read(auth.username_env_var);
    if (user === undefined) return missing(auth.username_env_var);
    const pass = read(auth.password_env_var);
    if (pass === undefined) return missing(auth.password_env_var);
    return { headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}` } };
  }
  if (auth.type === 'github_token' || auth.type === 'bearer') {
    const value = read(auth.env_var);
    if (value === undefined) return missing(auth.env_var);
    return { headers: { Authorization: `Bearer ${value}` } };
  }
  const unreachable: never = auth;
  throw new Error(`unknown auth type: ${JSON.stringify(unreachable)}`);
}
