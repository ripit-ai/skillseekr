import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { callsFromClaude, callsFromCopilot, callsFromOpencode, judge, skillIds, validatePrompts } from '../../evals/discovery/run.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'evals', 'discovery');
const prompts = JSON.parse(readFileSync(join(dir, 'prompts.json'), 'utf8')) as Array<{ prompt: string; expectedId: string }>;
const ids = skillIds();
const good = { id: 'csv-data-cleaning' };
const result = JSON.stringify(good);

describe('discovery eval set', () => {
  it('prompts.json is valid: 10 prompts, every expectedId is a skill, none names its skill', () => {
    expect(ids).toHaveLength(10);
    expect(validatePrompts(prompts, ids)).toEqual([]);
  });

  it('validatePrompts reports an unknown expectedId, a duplicate and a prompt that names its skill', () => {
    const bad = [...prompts.slice(0, 8), { prompt: 'use csv-data-cleaning please', expectedId: 'nope' }, { prompt: 'x', expectedId: prompts[0]!.expectedId }];
    const problems = validatePrompts(bad, ids);
    expect(problems).toEqual(expect.arrayContaining([
      expect.stringContaining('"nope" is not a skill'),
      expect.stringContaining('already used'),
      expect.stringContaining('names skill "csv-data-cleaning"'),
    ]));
  });
});

describe('discovery eval log parsing', () => {
  it('claude stream-json: search then get_skill returning expectedId passes', () => {
    const out = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__skillseekr__search_skills', input: { query: 'csv' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"results":[]}' }] }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'mcp__skillseekr__get_skill', input: { skill: 'csv-data-cleaning' } }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: result }] }] } },
    ].map((e) => JSON.stringify(e)).join('\n');
    expect(judge(callsFromClaude(out), 'csv-data-cleaning')).toEqual({ searched: true, fetched: true, pass: true });
    expect(judge(callsFromClaude(out), 'pdf-form-filling').pass).toBe(false);
  });

  it('opencode json: a get_skill without a search fails', () => {
    const out = JSON.stringify({ type: 'tool_use', part: { tool: 'skillseekr_get_skill', state: { input: { skill: 'csv-data-cleaning' }, output: result } } });
    expect(judge(callsFromOpencode(out), 'csv-data-cleaning')).toEqual({ searched: false, fetched: true, pass: false });
  });

  it('copilot jsonl: generic tool-call objects are found', () => {
    const out = [
      { type: 'tool.execution_start', data: { toolCallId: 'a', toolName: 'skillseekr-search_skills', arguments: { query: 'x' } } },
      { type: 'tool.execution_start', data: { toolCallId: 'b', toolName: 'skillseekr-get_skill', arguments: { skill: 'csv-data-cleaning' } } },
      { type: 'tool.execution_complete', data: { toolCallId: 'b', result: { content: result } } },
    ].map((e) => JSON.stringify(e)).join('\n');
    expect(judge(callsFromCopilot(out), 'csv-data-cleaning').pass).toBe(true);
  });
});
