// Secret-shaped and invisible-character fixture content, built at test time from split parts so that nothing
// in git looks like a real token (GitHub push protection) or hides invisible characters in a diff.
// Every body is obviously fake but still matches the scanner's pattern.
import { cp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpDir } from '../../helpers/tmp.js';

const dash5 = '-'.repeat(5);

/** The triggering text for each generated rule, without surrounding context. */
export const SECRET_TEXT: Record<string, string> = {
  'secrets/private-key': `${dash5}BEGIN ${'OPENSSH'} PRIVATE ${'KEY'}${dash5}`,
  'secrets/aws-key': 'AKIA' + 'FAKE'.repeat(4),
  'secrets/github-token': 'ghp' + '_' + 'FAKE0'.repeat(8),
  'secrets/slack-token': 'xox' + 'b-' + '0000-0000-' + 'fake'.repeat(4),
  'secrets/ai-key': 'sk-' + 'ant-' + 'fake'.repeat(10),
  'hidden-unicode/bidi-or-tag': 'report' + String.fromCodePoint(0x202e) + 'fdp.exe',
  'zero-width/invisible-char': 'zero' + String.fromCodePoint(0x200b) + 'width',
};

/** The generated file that carries SECRET_TEXT[id] in a rule's `bad` fixture. */
export const SECRET_FILE = 'notes.txt';

/** Copies a committed fixture dir to a fresh temp dir and, for generated rules, adds the triggering file. */
export async function materialize(fixtureDir: string, ruleId: string): Promise<string> {
  const dir = await tmpDir('skillseekr-rules-');
  await cp(fixtureDir, dir, { recursive: true });
  const text = SECRET_TEXT[ruleId];
  if (text !== undefined) await writeFile(join(dir, SECRET_FILE), `value: ${text}\n`);
  return dir;
}
