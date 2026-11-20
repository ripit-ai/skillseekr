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

/** Library root: $SKILLSEEKR_LIBRARY, then the configured dir (`~` expanded), then ~/.skillseekr/library. */
export function libraryDir(ctx: Ctx, configured?: string): string {
  if (ctx.env.SKILLSEEKR_LIBRARY) return expandHome(ctx.env.SKILLSEEKR_LIBRARY, ctx.home);
  if (configured) return expandHome(configured, ctx.home);
  return join(ctx.home, '.skillseekr', 'library');
}
