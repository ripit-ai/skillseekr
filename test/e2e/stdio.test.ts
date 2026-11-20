import { describe, it, expect } from 'vitest';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fetchHttp } from '../../src/net/http.js';
import { fakeGithub } from '../helpers/fakeGithub.js';
import { pull } from '../helpers/library.js';
import { tmpDir } from '../helpers/tmp.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bin = join(root, 'dist', 'cli', 'main.js');
const SHA = 'c'.repeat(40);

// dist/ is built fresh by the vitest globalSetup (test/globalBuild.ts).
describe('stdio end to end (built binary)', () => {
  it('search → get → read_skill_file → install (project) over real stdio, from a library pulled over real HTTP', async () => {
    const dir = await tmpDir();
    const home = join(dir, 'home');
    const cache = join(dir, 'xdg-cache');
    const project = join(dir, 'project');
    await mkdir(project);
    await mkdir(home);
    await mkdir(cache);

    const fake = fakeGithub({
      'acme/skills': { refs: { main: SHA }, commits: { [SHA]: {
        'skills/pdf-forms/SKILL.md': '---\nname: pdf-forms\ndescription: Fill in and flatten PDF forms\n---\nPDF BODY\n',
        'skills/pdf-forms/reference/fields.md': 'field notes',
      } } },
    });
    const server = createServer(fake.nodeHandler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

    const config = join(dir, 'config.jsonc');
    await writeFile(config, JSON.stringify({
      library: { dir: join(dir, 'library') },
      registries: { acme: { type: 'github', owner: 'acme', repo: 'skills', skills_dir: 'skills', ref: 'main', auth: { type: 'none' } } },
    }));

    const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The server only reads the library, so fill it first (over real HTTP).
    await pull({
      env: { SKILLSEEKR_CONFIG: config }, home, cwd: project, http: fetchHttp(),
      exec: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => Date.now(), githubApi: api,
    });
    const pulled = fake.calls.length;

    let stderr = '';
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '', HOME: home, XDG_CACHE_HOME: cache,
      SKILLSEEKR_CONFIG: config,
      SKILLSEEKR_GITHUB_API: api,
    };
    const transport = new StdioClientTransport({ command: process.execPath, args: [bin, 'mcp'], cwd: project, env, stderr: 'pipe' });
    transport.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    const client = new Client({ name: 'e2e', version: '0' });

    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      const c = r.content as Array<{ text: string }>;
      return { isError: r.isError === true, data: JSON.parse(c[0]!.text) as any };
    };

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('search_skills');
      expect(tools.map((t) => t.name)).toContain('update_skills');

      const search = await call('search_skills', { query: 'fill pdf forms' });
      expect(search.isError).toBe(false);
      expect(search.data.results[0]).toMatchObject({ id: 'pdf-forms', registry: 'acme' });

      const got = await call('get_skill', { skill: 'pdf-forms' });
      expect(got.data.body).toContain('PDF BODY');
      expect(got.data.files).toContain('reference/fields.md');

      expect((await call('read_skill_file', { skill: 'pdf-forms', path: 'reference/fields.md' })).data).toEqual({ content: 'field notes' });

      const inst = await call('install_skill', { skill: 'pdf-forms', scope: 'project' });
      expect(inst.isError).toBe(false);
      const marker = JSON.parse(await readFile(join(project, '.claude', 'skills', 'pdf-forms', '.skillseekr.json'), 'utf8'));
      expect(marker).toMatchObject({ id: 'pdf-forms', name: 'pdf-forms', registry: 'acme', sha: SHA });
      expect(await readFile(join(project, '.claude', 'skills', 'pdf-forms', 'SKILL.md'), 'utf8')).toContain('PDF BODY');
      expect(fake.calls).toHaveLength(pulled); // the server made no request
    } catch (e) {
      if (stderr) process.stderr.write(`server stderr:\n${stderr}\n`);
      throw e;
    } finally {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  }, 60_000);
});
