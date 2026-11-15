// Default folders `skillseekr scan` looks at: the project's skills folder, every supported tool's user skills
// folder, and the skill folders of installed plugins.
//
// Plugin locations, checked against the official docs on 2026-11-14:
// - Claude Code: https://code.claude.com/docs/en/plugins/loading.md ("Find plugins on disk"): installed marketplace
//   plugins are copied to `<plugins root>/cache/<marketplace>/<plugin>/<version>/`, where the plugins root is
//   `~/.claude/plugins` unless CLAUDE_CODE_PLUGIN_CACHE_DIR is set; plugins synced from claude.ai live under
//   `<plugins root>/synced/`. https://code.claude.com/docs/en/plugins-reference ("Standard layout"): a plugin's
//   skills are `skills/<name>/SKILL.md` under the plugin root (a manifest `skills` key can add more folders).
// - Copilot CLI: https://docs.github.com/en/copilot/concepts/agents/about-agent-skills documents only plain skill
//   folders (~/.copilot/skills, ~/.agents/skills; project .github/skills, .claude/skills, .agents/skills). It
//   documents no plugin skill location, so none is added.
// - OpenCode: https://opencode.ai/docs/plugins/ documents plugin folders (.opencode/plugins, ~/.config/opencode/plugins)
//   but says nothing about plugins bundling skills, so no plugin skill location is added.
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../context.js';
import { PROJECT_SKILLS_DIR, TOOL_IDS, TOOL_TARGETS } from '../install/targets.js';

export interface ScanTarget { label: string /* e.g. "claude user", "plugin superpowers@5.0.0" */; dir: string /* a skills root */ }

const MAX_DEPTH = 6;
/** Plugin trees under the plugins root that hold installed plugin files. */
const PLUGIN_TREES = ['cache', 'synced'];
const SKIP = new Set(['node_modules', '.git', '.trash']);

const isDir = async (p: string): Promise<boolean> => { try { return (await lstat(p)).isDirectory(); } catch { return false; } };

/** Directories named `skills` below `abs` (`depth` is that of abs's children, counted from the plugins root), without following symlinks. */
async function findSkillsDirs(abs: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name)) continue; // a Dirent for a symlink is not a directory
    const p = join(abs, e.name);
    if (e.name === 'skills') out.push(p); // a skills root is not searched further
    else await findSkillsDirs(p, depth + 1, out);
  }
}

function pluginLabel(rel: string[]): string {
  // cache/<marketplace>/<plugin>/<version>/skills
  if (rel[0] === 'cache' && rel.length >= 5) return `plugin ${rel[2]}@${rel[3]}`;
  return `plugin ${rel.slice(0, -1).join('/')}`;
}

/** Existing folders only. */
export async function defaultScanTargets(ctx: Ctx, projectDir: string): Promise<ScanTarget[]> {
  const out: ScanTarget[] = [];
  const seen = new Set<string>();
  const add = async (label: string, dir: string) => {
    if (seen.has(dir) || !(await isDir(dir))) return;
    seen.add(dir);
    out.push({ label, dir });
  };
  await add('project', join(projectDir, PROJECT_SKILLS_DIR));
  for (const t of TOOL_IDS) await add(`${t} user`, join(ctx.home, TOOL_TARGETS[t].userSkillsDir));
  const root = ctx.env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(ctx.home, '.claude', 'plugins');
  for (const tree of PLUGIN_TREES) {
    const found: string[] = [];
    await findSkillsDirs(join(root, tree), 2, found); // `tree` itself is depth 1 below the root
    for (const dir of found) await add(pluginLabel([tree, ...dir.slice(join(root, tree).length + 1).split(/[\\/]/)]), dir);
  }
  return out;
}
