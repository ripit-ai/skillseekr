import { join } from 'node:path';
import type { Ctx } from './context.js';

export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

export function configPath(ctx: Ctx): string {
  const { env, home } = ctx;
  if (env.SKILLSEEKR_CONFIG) return expandHome(env.SKILLSEEKR_CONFIG, home);
  const base = env.XDG_CONFIG_HOME || join(home, '.config');
  return join(base, 'skillseekr', 'config.jsonc');
}

export function defaultCacheDir(ctx: Ctx): string {
  const base = ctx.env.XDG_CACHE_HOME || join(ctx.home, '.cache');
  return join(base, 'skillseekr');
}
