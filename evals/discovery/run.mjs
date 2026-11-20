#!/usr/bin/env node
/**
 * Discovery eval for AC-3: does an agent, without being told a skill's name, call `search_skills`
 * and then fetch the right skill with `get_skill`? Ten prompts (prompts.json), each matching one
 * skill under skills/. Pass mark: 8 of 10 per tool.
 *
 * Not part of `pnpm test`. It starts real agents (and spends tokens), so run it by hand:
 *
 *   node evals/discovery/run.mjs --dry-run                 # validate prompts.json against skills/
 *   node evals/discovery/run.mjs --tool claude|opencode|copilot [--only <n>] [--timeout <seconds>]
 *
 * Wiring the local registry (once per machine):
 *   1. Make skills/ reachable as a GitHub registry: push this branch to ripit-ai/skillseekr (or edit
 *      registry/registries.jsonc to your fork, and `ref` to your branch).
 *   2. Write an eval-only config, e.g. /tmp/eval-config.jsonc:
 *        { "registries": { "eval": { "type": "github-registry", "owner": "ripit-ai",
 *            "repo": "skillseekr", "ref": "main", "path": "evals/discovery/registry/registries.jsonc",
 *            "auth": { "type": "gh_cli" } } } }
 *   3. Fill an eval-only library from it, then run with both variables set:
 *        export SKILLSEEKR_CONFIG=/tmp/eval-config.jsonc SKILLSEEKR_LIBRARY=/tmp/eval-library
 *        skillseekr update && node evals/discovery/run.mjs --tool claude
 *      The agent's skillseekr MCP server inherits the variables, so only the ten eval skills are visible
 *      (and your own library is left alone).
 *      Run `skillseekr setup` first so each tool has the MCP server registered (AC-1).
 *   4. Don't install any of the eval skills into a tool's skill folder, or the agent can find them
 *      without calling search_skills.
 *
 * Headless commands, checked 2026-11-14 against the docs below:
 *   claude:   claude -p "<prompt>" --output-format stream-json --verbose --allowedTools "mcp__skillseekr"
 *             https://code.claude.com/docs/en/headless  (stream-json needs --verbose; --allowedTools
 *             pre-approves tools, an "mcp__<server>" entry covers the whole server)
 *   opencode: opencode run "<prompt>" --format json
 *             https://opencode.ai/docs/cli/  (the page documents only `opencode run "<prompt>"`; the
 *             `--format json` flag and its NDJSON events -- step_start, tool_use, text, step_finish, with
 *             part.tool and part.state.input/output -- come from `opencode run --help` and the source,
 *             not the official docs. Confirm with `opencode run --help` if parsing finds no tool calls.)
 *   copilot:  copilot -p "<prompt>" --allow-all-tools --output-format json
 *             https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference
 *             (-p, --allow-all-tools and --output-format json, JSONL, are documented; the per-event schema
 *             is not, so the copilot parser looks for tool-call-like objects generically)
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PASS_MARK = 8;

// ---------- validation ----------

/** Skill folder names under skills/ (a folder is a skill if it directly contains SKILL.md). */
export function skillIds(skillsDir = join(here, 'skills')) {
  return readdirSyncSafe(skillsDir).filter((n) => existsSync(join(skillsDir, n, 'SKILL.md')));
}
function readdirSyncSafe(d) { try { return readdirSync(d); } catch { return []; } }

/** Returns a list of problems; empty means prompts.json is consistent with skills/. */
export function validatePrompts(prompts, ids, skillsDir = join(here, 'skills')) {
  const problems = [];
  if (!Array.isArray(prompts)) return ['prompts.json must be an array'];
  if (prompts.length !== 10) problems.push(`expected 10 prompts, found ${prompts.length}`);
  const seen = new Map();
  prompts.forEach((p, i) => {
    const at = `prompt ${i + 1}`;
    if (!p || typeof p.prompt !== 'string' || !p.prompt.trim()) problems.push(`${at}: missing prompt text`);
    if (!p || typeof p.expectedId !== 'string') { problems.push(`${at}: missing expectedId`); return; }
    if (!ids.includes(p.expectedId)) problems.push(`${at}: expectedId "${p.expectedId}" is not a skill`);
    if (seen.has(p.expectedId)) problems.push(`${at}: expectedId "${p.expectedId}" already used by prompt ${seen.get(p.expectedId)}`);
    seen.set(p.expectedId, i + 1);
    if (typeof p.prompt === 'string') {
      for (const id of ids) {
        if (p.prompt.toLowerCase().includes(id.toLowerCase())) problems.push(`${at}: names skill "${id}"`);
      }
    }
  });
  for (const id of ids) {
    if (!existsSync(join(skillsDir, id, 'SKILL.md'))) continue;
    const text = readFileSync(join(skillsDir, id, 'SKILL.md'), 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
    if (!new RegExp(`^name:\\s*${id}\\s*$`, 'm').test(fm)) problems.push(`skill ${id}: frontmatter name must equal the folder name`);
    if (!/^description:\s*\S/m.test(fm)) problems.push(`skill ${id}: missing description`);
  }
  if (ids.length !== 10) problems.push(`expected 10 skills, found ${ids.length}`);
  return problems;
}

// ---------- log parsing: tool-call extraction ----------

const lines = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const textOf = (c) => typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x?.text ?? '').join('') : c == null ? '' : JSON.stringify(c);

/** Claude Code stream-json: assistant tool_use blocks, matched to user tool_result blocks by id. */
export function callsFromClaude(out) {
  const calls = new Map();
  for (const ev of lines(out)) {
    const content = ev?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use') calls.set(b.id, { name: b.name, input: b.input, output: '' });
      if (b.type === 'tool_result' && calls.has(b.tool_use_id)) calls.get(b.tool_use_id).output = textOf(b.content);
    }
  }
  return [...calls.values()];
}

/** OpenCode --format json: `tool_use` events carry part.tool and part.state.{input,output}. */
export function callsFromOpencode(out) {
  return lines(out).filter((ev) => ev?.type === 'tool_use' && ev.part).map((ev) => ({
    name: String(ev.part.tool ?? ''), input: ev.part.state?.input, output: textOf(ev.part.state?.output),
  }));
}

/**
 * Copilot CLI --output-format json (JSONL). The per-event schema is not documented, so walk every
 * object and treat one with a tool-ish name field (toolName/tool/name) plus arguments/input as a call;
 * its result is whatever string content the same event (or one sharing its toolCallId) carries.
 */
export function callsFromCopilot(out) {
  const calls = [];
  const byId = new Map();
  const walk = (o, ev) => {
    if (Array.isArray(o)) { o.forEach((x) => walk(x, ev)); return; }
    if (!o || typeof o !== 'object') return;
    const name = o.toolName ?? o.tool ?? o.name;
    const input = o.arguments ?? o.input ?? o.args;
    const id = o.toolCallId ?? o.id;
    if (typeof name === 'string' && /search_skills|get_skill|read_skill_file|install_skill/.test(name) && input !== undefined) {
      const c = { name, input: typeof input === 'string' ? safeJson(input) : input, output: '' };
      calls.push(c); if (id) byId.set(id, c);
    } else if (o.toolCallId && byId.has(o.toolCallId) && (o.result ?? o.output ?? o.content) !== undefined) {
      byId.get(o.toolCallId).output += textOf(o.result ?? o.output ?? o.content);
    }
    Object.values(o).forEach((v) => walk(v, ev));
  };
  for (const ev of lines(out)) walk(ev, ev);
  return calls;
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return s; } };

export const parsers = { claude: callsFromClaude, opencode: callsFromOpencode, copilot: callsFromCopilot };

/** True only for the skillseekr tool: bare (`search_skills`) or prefixed by server name (mcp__skillseekr__x, skillseekr_x, skillseekr-x, skillseekr.x). */
const is = (name, tool) => new RegExp(`^(?:(?:mcp__)?skillseekr(?:__|[_.-]))?${tool}$`).test(name);

/** Judge one prompt: search_skills called, and get_skill returned (or was asked for) expectedId. */
export function judge(calls, expectedId) {
  const searched = calls.some((c) => is(c.name, 'search_skills'));
  const fetched = calls.some((c) => {
    if (!is(c.name, 'get_skill')) return false;
    const returned = /"id"\s*:\s*"([^"]+)"/.exec(c.output.replace(/\\"/g, '"'))?.[1];
    if (returned !== undefined) return returned === expectedId;
    return c.input?.skill === expectedId; // output missing from the log: fall back to the request
  });
  return { searched, fetched, pass: searched && fetched };
}

// ---------- running ----------

const commands = {
  claude: (p) => ['claude', ['-p', p, '--output-format', 'stream-json', '--verbose', '--allowedTools', 'mcp__skillseekr']],
  opencode: (p) => ['opencode', ['run', p, '--format', 'json']],
  copilot: (p) => ['copilot', ['-p', p, '--allow-all-tools', '--output-format', 'json']],
};

function runAgent(tool, prompt, timeoutMs) {
  const [cmd, args] = commands[tool](prompt);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ out, error: e.message }); });
    child.on('close', () => { clearTimeout(timer); resolve({ out }); });
  });
}

function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

export async function main(argv) {
  const prompts = JSON.parse(readFileSync(join(here, 'prompts.json'), 'utf8'));
  const ids = skillIds();
  const problems = validatePrompts(prompts, ids);
  if (argv.includes('--dry-run')) {
    if (problems.length) { console.error(problems.join('\n')); return 1; }
    console.log(`ok: ${prompts.length} prompts, ${ids.length} skills, every expectedId exists`);
    return 0;
  }
  if (problems.length) { console.error(problems.join('\n')); return 1; }
  const tool = arg(argv, '--tool');
  if (!tool || !(tool in commands)) { console.error('usage: run.mjs --tool claude|opencode|copilot | --dry-run'); return 2; }
  const timeoutMs = Number(arg(argv, '--timeout') ?? 300) * 1000;
  const only = arg(argv, '--only');
  let passed = 0;
  const list = prompts.map((p, i) => ({ ...p, n: i + 1 })).filter((p) => !only || String(p.n) === only);
  for (const p of list) {
    const r = await runAgent(tool, p.prompt, timeoutMs);
    const j = r.error ? { searched: false, fetched: false, pass: false } : judge(parsers[tool](r.out), p.expectedId);
    if (j.pass) passed++;
    console.log(`${j.pass ? 'PASS' : 'FAIL'} ${p.n}/${prompts.length} ${p.expectedId} searched=${j.searched} fetched=${j.fetched}${r.error ? ` (${r.error})` : ''}`);
  }
  if (only) { console.log(`${tool}: ${passed}/${list.length} (partial run with --only, no verdict)`); return passed === list.length ? 0 : 1; }
  console.log(`${tool}: ${passed}/${list.length} (pass mark ${PASS_MARK}/10) ${passed >= PASS_MARK ? 'PASS' : 'FAIL'}`);
  return passed >= PASS_MARK ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
