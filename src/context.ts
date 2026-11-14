import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import type { Http } from './net/http.js';

export interface ExecResult { code: number; stdout: string; stderr: string }
export type Exec = (
  cmd: string, args: string[], opts?: { timeoutMs?: number; input?: string },
) => Promise<ExecResult>;

export interface Ctx {
  env: Record<string, string | undefined>;
  home: string;
  cwd: string;
  http: Http;
  exec: Exec;
  now: () => number;
  /** Default "https://api.github.com"; override with env SKILLSEEKR_GITHUB_API. */
  githubApi: string;
}

const realExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (r: ExecResult) => { if (!settled) { settled = true; resolve(r); } };
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = opts?.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => { if (timer) clearTimeout(timer); done({ code: 127, stdout, stderr: stderr + String(e.message) }); });
    child.on('close', (code) => { if (timer) clearTimeout(timer); done({ code: code ?? 1, stdout, stderr }); });
    child.stdin.on('error', () => {});
    child.stdin.end(opts?.input ?? '');
  });

export function defaultContext(): Ctx {
  const env = process.env as Record<string, string | undefined>;
  return {
    env,
    home: homedir(),
    cwd: process.cwd(),
    http: {}, // placeholder until Task 4 provides the real implementation
    exec: realExec,
    now: () => Date.now(),
    githubApi: env.SKILLSEEKR_GITHUB_API || 'https://api.github.com',
  };
}
