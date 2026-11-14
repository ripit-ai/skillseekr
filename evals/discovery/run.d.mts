export const PASS_MARK: number;
export function skillIds(skillsDir?: string): string[];
export function validatePrompts(prompts: unknown, ids: string[], skillsDir?: string): string[];
export interface Call { name: string; input: any; output: string }
export function callsFromClaude(out: string): Call[];
export function callsFromOpencode(out: string): Call[];
export function callsFromCopilot(out: string): Call[];
export function judge(calls: Call[], expectedId: string): { searched: boolean; fetched: boolean; pass: boolean };
export function main(argv: string[]): Promise<number>;
