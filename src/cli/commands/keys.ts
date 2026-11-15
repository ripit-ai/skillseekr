import { lstat, mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
import { writeFileAtomic } from '../../atomicWrite.js';
import { createKeyPair } from '../../sign/sign.js';
import { CliError, isJson, printJson, type Cli } from '../output.js';

const exists = (p: string): Promise<boolean> => lstat(p).then(() => true, () => false);

export function registerKeys(program: Command, cli: Cli): void {
  const keys = program.command('keys').description('manage skill signing keys');
  keys.command('create').description('create an ed25519 signing key pair')
    .requiredOption('--out <dir>', 'folder to write skillseekr-private.pem and skillseekr-public.txt into')
    .option('--force', 'overwrite existing key files')
    .action(async (opts: { out: string; force?: boolean }, cmd: Command) => {
      const dir = resolve(cli.ctx.cwd, opts.out);
      const privateKeyPath = join(dir, 'skillseekr-private.pem');
      const publicKeyPath = join(dir, 'skillseekr-public.txt');
      if (!opts.force) {
        for (const p of [privateKeyPath, publicKeyPath]) if (await exists(p)) throw new CliError(`${p} already exists (use --force to replace the keys)`);
      } else {
        // writeFileAtomic keeps an existing file's mode, so remove old files to get fresh 0600.
        await rm(privateKeyPath, { force: true }); await rm(publicKeyPath, { force: true });
      }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const { privateKeyPem, publicKey } = createKeyPair();
      await writeFileAtomic(privateKeyPath, privateKeyPem, { defaultMode: 0o600 });
      await writeFileAtomic(publicKeyPath, publicKey + '\n', { defaultMode: 0o644 });
      if (isJson(cmd)) printJson(cli.io, { publicKey, privateKeyPath, publicKeyPath });
      else cli.io.out(publicKey + '\n');
    });
}
