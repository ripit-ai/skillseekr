import type { Ctx } from '../context.js';
import { updateInstalled, type UpdateResult } from '../install/installer.js';
import type { Problem } from '../types.js';
import { catalogFromManifest } from './catalog.js';
import { LockBusyError } from './lock.js';
import { pullLibrary, type SkillChange } from './pull.js';

export interface UpdateOptions { name?: string; force: boolean; installs: boolean; projectDir: string }
export interface UpdateReport {
  aborted: boolean; registries: number; skills: number; changes: SkillChange[]; installs: UpdateResult[]; problems: Problem[]; stale: boolean;
}

/** Pulls the library, then (unless disabled or aborted) refreshes the user and project installs from it. */
export async function runUpdate(ctx: Ctx, opts: UpdateOptions): Promise<UpdateReport> {
  let pulled;
  try {
    pulled = await pullLibrary(ctx);
  } catch (e) {
    if (!(e instanceof LockBusyError)) throw e;
    const problems: Problem[] = [{ level: 'error', code: 'library/lock-busy', message: e.message }];
    return { aborted: true, registries: 0, skills: 0, changes: [], installs: [], problems, stale: false };
  }
  const { manifest } = pulled;
  if (pulled.aborted || !manifest || pulled.libDir === undefined) {
    return { aborted: true, registries: 0, skills: 0, changes: [], installs: [], problems: pulled.problems, stale: pulled.stale };
  }
  const { catalog } = catalogFromManifest(pulled.libDir, manifest);
  const installs = opts.installs
    ? await updateInstalled(catalog, ctx, { ...(opts.name !== undefined && { name: opts.name }), force: opts.force, projectDir: opts.projectDir })
    : [];
  return {
    aborted: false, registries: manifest.sources.length, skills: catalog.skills.length,
    changes: pulled.changes, installs, problems: pulled.problems, stale: pulled.stale,
  };
}
