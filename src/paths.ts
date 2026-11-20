import { isAbsolute, join } from 'node:path';
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

/** Library root: $SKILLSEEKR_LIBRARY, then the configured dir (`~` expanded), then ~/.skillseekr/library. A relative value is not used: the default is. */
export function libraryDir(ctx: Ctx, configured?: string): string {
  const chosen = ctx.env.SKILLSEEKR_LIBRARY || configured;
  const dir = chosen ? expandHome(chosen, ctx.home) : undefined;
  return dir && isAbsolute(dir) ? dir : join(ctx.home, '.skillseekr', 'library');
}

/** The library values (env, then config) that are relative after `~` expansion, so cannot be used. */
export function relativeLibraryValues(ctx: Ctx, configured?: string): Array<{ from: string; value: string }> {
  return [{ from: '$SKILLSEEKR_LIBRARY', value: ctx.env.SKILLSEEKR_LIBRARY }, { from: 'library.dir', value: configured }]
    .filter((x): x is { from: string; value: string } => !!x.value && !isAbsolute(expandHome(x.value, ctx.home)));
}
