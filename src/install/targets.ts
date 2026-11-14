import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Ctx } from '../context.js';

export type ToolId = 'claude' | 'opencode' | 'copilot';
export type Scope = 'project' | 'user';

/**
 * The single table of tool skill folders. Verified 2026-11-14 against official docs
 * (all three match the spec's starting values; no disagreements found).
 */
export const TOOL_TARGETS: Record<ToolId, { userSkillsDir: string; homeMarker: string; docs: string }> = {
  // ~/.claude/skills (personal), .claude/skills (project)
  claude: { userSkillsDir: '.claude/skills', homeMarker: '.claude', docs: 'https://code.claude.com/docs/en/skills' },
  // Global ~/.config/opencode/skills; also reads ~/.claude/skills and project .claude/skills
  opencode: { userSkillsDir: '.config/opencode/skills', homeMarker: '.config/opencode', docs: 'https://opencode.ai/docs/skills/' },
  // Personal ~/.copilot/skills; project .github/skills, .claude/skills, .agents/skills. Does not read ~/.claude/skills.
  copilot: { userSkillsDir: '.copilot/skills', homeMarker: '.copilot', docs: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills' },
};

export const PROJECT_SKILLS_DIR = '.claude/skills';

export const TOOL_IDS = Object.keys(TOOL_TARGETS) as ToolId[];

export async function presentTools(ctx: Ctx): Promise<ToolId[]> {
  const out: ToolId[] = [];
  for (const id of TOOL_IDS) {
    try {
      if ((await stat(join(ctx.home, TOOL_TARGETS[id].homeMarker))).isDirectory()) out.push(id);
    } catch { /* not present */ }
  }
  return out;
}
