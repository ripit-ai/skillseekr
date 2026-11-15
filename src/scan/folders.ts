// Default folders `skillseekr scan` looks at: the project's skills folders, every supported tool's user skills
// folder, the shared ~/.agents/skills, and the skill folders of installed plugins.
//
// Plain skill folders, checked against the official docs on 2026-11-14 (P2-11):
// - Copilot: https://docs.github.com/en/copilot/concepts/agents/about-agent-skills lists project `.github/skills`,
//   `.claude/skills`, `.agents/skills` and personal `~/.copilot/skills`, `~/.agents/skills`.
// - OpenCode: https://opencode.ai/docs/skills/ ("Discovery") lists project `.opencode/skills`, `.claude/skills`,
//   `.agents/skills` and global `~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`.
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
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import type { Ctx } from '../context.js';
import { expandHome } from '../paths.js';
import { PROJECT_SKILLS_DIR, TOOL_IDS, TOOL_TARGETS } from '../install/targets.js';

export interface ScanTarget { label: string /* e.g. "claude user", "plugin superpowers@5.0.0" */; dir: string /* a skills root */ }

const MAX_DEPTH = 6;
/** Project skill folders other tools read, besides .claude/skills (see the docs above). */
const PROJECT_EXTRA_DIRS = ['.github/skills', '.agents/skills', '.opencode/skills'];
const MAX_MANIFEST_BYTES = 64 * 1024;
/** Plugin trees under the plugins root that hold installed plugin files. */
const PLUGIN_TREES = ['cache', 'synced'];
const SKIP = new Set(['node_modules', '.git', '.trash']);

const isFile = async (p: string): Promise<boolean> => { try { return (await lstat(p)).isFile(); } catch { return false; } };
const isDir = async (p: string): Promise<boolean> => { try { return (await lstat(p)).isDirectory(); } catch { return false; } };

/**
 * The folders a plugin's manifest adds under `skills` (a string or an array of strings, relative to the plugin root;
 * "." is the root itself). Absolute paths, `..`, backslashes and anything reached through a symlink are dropped.
 */
async function manifestSkillDirs(root: string): Promise<string[]> {
  const file = join(root, '.claude-plugin', 'plugin.json');
  let skills: unknown;
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > MAX_MANIFEST_BYTES) return [];
    skills = (JSON.parse(await readFile(file, 'utf8')) as { skills?: unknown } | null)?.skills;
  } catch { return []; }
  const list = typeof skills === 'string' ? [skills] : Array.isArray(skills) ? skills : [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string' || raw === '' || raw.includes('\0') || raw.includes('\\') || isAbsolute(raw)) continue;
    const parts = raw.split('/').filter((x) => x !== '' && x !== '.');
    if (parts.includes('..')) continue;
    let cur = root;
    let ok = true;
    for (const part of parts) {
      cur = join(cur, part);
      if (!(await isDir(cur))) { ok = false; break; } // lstat: a symlink is not a directory here
    }
    if (ok && parts.length === 0 && !(await isFile(join(root, 'SKILL.md')))) continue; // ".": only a plugin that is itself a skill
    if (ok) out.push(cur);
  }
  return out;
}

interface Found { dir: string; plugin?: string /* plugin root, for manifest entries */ }

/** Directories named `skills` below `abs` (`depth` is that of abs's children, counted from the plugins root), without following symlinks. */
async function findSkillsDirs(abs: string, depth: number, out: Found[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (entries.some((e) => e.isDirectory() && e.name === '.claude-plugin')) {
    for (const dir of await manifestSkillDirs(abs)) out.push({ dir, plugin: abs });
  }
  for (const e of entries) {
    if (!e.isDirectory() || SKIP.has(e.name) || e.name === '.claude-plugin') continue; // a Dirent for a symlink is not a directory
    const p = join(abs, e.name);
    if (e.name === 'skills') out.push({ dir: p }); // a skills root is not searched further
    else await findSkillsDirs(p, depth + 1, out);
  }
}

function pluginLabel(rel: string[]): string {
  // cache/<marketplace>/<plugin>/<version>/...
  if (rel[0] === 'cache' && rel.length >= 4) return `plugin ${rel[2]}@${rel[3]}`;
  return `plugin ${rel.join('/')}`;
}

/** Existing folders only. */
export async function defaultScanTargets(ctx: Ctx, projectDir: string): Promise<ScanTarget[]> {
  const out: ScanTarget[] = [];
  const seen = new Set<string>();
  /** Deduped by real path, so a folder reached twice (e.g. through a symlinked parent) is scanned once. */
  const add = async (label: string, dir: string) => {
    if (seen.has(dir) || !(await isDir(dir))) return;
    let real = dir;
    try { real = await realpath(dir); } catch { /* keep dir */ }
    if (seen.has(real)) return;
    seen.add(dir).add(real);
    out.push({ label, dir });
  };
  await add('project', join(projectDir, PROJECT_SKILLS_DIR));
  for (const d of PROJECT_EXTRA_DIRS) await add(`project ${d}`, join(projectDir, d));
  for (const t of TOOL_IDS) await add(`${t} user`, join(ctx.home, TOOL_TARGETS[t].userSkillsDir));
  await add('agents user', join(ctx.home, '.agents', 'skills'));
  const override = ctx.env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const root = override ? resolve(ctx.cwd, expandHome(override, ctx.home)) : join(ctx.home, '.claude', 'plugins');
  for (const tree of PLUGIN_TREES) {
    const found: Found[] = [];
    await findSkillsDirs(join(root, tree), 2, found); // `tree` itself is depth 1 below the root
    const rel = (p: string) => [tree, ...p.slice(join(root, tree).length + 1).split(/[\\/]/).filter(Boolean)];
    for (const f of found) await add(pluginLabel(rel(f.plugin ?? f.dir)), f.dir);
  }
  return out;
}
