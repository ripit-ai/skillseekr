import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { writeFileAtomic } from '../../atomicWrite.js';
import { listFiles } from '../../catalog/hash.js';
import { publicKeyOf, signFiles, SIGNATURE_FILE } from '../../sign/sign.js';
import { CliError, isJson, printJson, type Cli } from '../output.js';

export function registerSign(program: Command, cli: Cli): void {
  program.command('sign <skill-dir>').description('sign a skill folder with an ed25519 private key')
    .requiredOption('--key <pem>', 'private key file (PKCS#8 PEM, from "keys create")')
    .action(async (skillDir: string, opts: { key: string }, cmd: Command) => {
      const dir = resolve(cli.ctx.cwd, skillDir);
      const skillMd = await lstat(join(dir, 'SKILL.md')).then((s) => s.isFile(), () => false);
      if (!skillMd) throw new CliError(`${dir} has no SKILL.md`);
      const keyPath = resolve(cli.ctx.cwd, opts.key);
      let pem: string;
      try { pem = await readFile(keyPath, 'utf8'); } catch (e) { throw new CliError(`cannot read key ${keyPath}: ${(e as NodeJS.ErrnoException).code ?? 'error'}`); }
      let publicKey: string;
      let doc;
      try {
        publicKey = publicKeyOf(pem);
        const files = await Promise.all((await listFiles(dir)).map(async (path) => ({ path, content: await readFile(join(dir, path)) })));
        doc = signFiles(files, pem);
      } catch (e) { throw new CliError(`${keyPath}: ${(e as Error).message}`); }
      await writeFileAtomic(join(dir, SIGNATURE_FILE), JSON.stringify(doc, null, 2) + '\n', { defaultMode: 0o644 });
      const count = Object.keys(doc.manifest).length;
      if (isJson(cmd)) printJson(cli.io, { skillDir: dir, files: count, publicKey, signatureFile: join(dir, SIGNATURE_FILE) });
      else cli.io.out(`signed ${count} ${count === 1 ? 'file' : 'files'} in ${dir}\npublic key: ${publicKey}\n`);
    });
}
