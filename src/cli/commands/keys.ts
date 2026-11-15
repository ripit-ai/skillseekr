import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Command } from 'commander';
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
      }
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const { privateKeyPem, publicKey } = createKeyPair();
      // Write both files to temp names first, so a failed write never touches existing keys.
      const sfx = `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
      const tmpPriv = privateKeyPath + sfx; const tmpPub = publicKeyPath + sfx;
      const placed: string[] = [];
      try {
        await writeFile(tmpPriv, privateKeyPem, { mode: 0o600, flag: 'wx' });
        await writeFile(tmpPub, publicKey + '\n', { mode: 0o644, flag: 'wx' });
        for (const [tmp, final] of [[tmpPriv, privateKeyPath], [tmpPub, publicKeyPath]] as const) {
          // --force swaps into place (rename); otherwise link() fails with EEXIST rather than overwrite.
          if (opts.force) await rename(tmp, final);
          else {
            try { await link(tmp, final); } catch (e) {
              if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`${final} already exists (use --force to replace the keys)`);
              throw e;
            }
            placed.push(final);
          }
        }
      } catch (e) {
        for (const p of placed) await rm(p, { force: true }).catch(() => {});
        throw e;
      } finally {
        await rm(tmpPriv, { force: true }).catch(() => {}); await rm(tmpPub, { force: true }).catch(() => {});
      }
      if (isJson(cmd)) printJson(cli.io, { publicKey, privateKeyPath, publicKeyPath });
      else cli.io.out(publicKey + '\n');
    });
}
