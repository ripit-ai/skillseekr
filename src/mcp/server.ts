import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { defaultContext, type Ctx } from '../context.js';
import { createEngine, type Engine } from '../engine.js';
import { InstallError, installSkill, listInstalled, statusOf } from '../install/installer.js';
import type { Catalog } from '../catalog/catalog.js';
import type { Problem } from '../types.js';

const INSTRUCTIONS = 'Use skillseekr to find organization skills before specialized or unfamiliar work. Call search_skills with a short description of the task; if a result fits, call get_skill and follow it, reading supporting files with read_skill_file. Say which registry a skill came from if the user asks or if it overrides another skill. Only call install_skill if the user asks to keep a skill or agrees when you offer.';

type Result = CallToolResult;
const ok = (data: unknown): Result => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const fail = (data: unknown): Result => ({ ...ok(data), isError: true });
const errorsOf = (ps: Problem[]) => ps.filter((p) => p.level === 'error');

function version(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const v = (JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function createMcpServer(engine: Engine, ctx: Ctx, opts: { rootsTimeoutMs?: number } = {}): McpServer {
  const server = new McpServer({ name: 'skillseekr', version: version() }, { instructions: INSTRUCTIONS });

  async function projectDir(): Promise<string> {
    try {
      if (server.server.getClientCapabilities()?.roots) {
        const { roots } = await server.server.listRoots(undefined, { timeout: opts.rootsTimeoutMs ?? 2000 });
        const first = roots.find((r) => r.uri.startsWith('file://'));
        if (first) return fileURLToPath(first.uri);
      }
    } catch { /* fall back */ }
    return ctx.cwd;
  }

  /** Looks a skill up; returns the record or an isError result. */
  function resolveSkill(catalog: Catalog, skill: string) {
    const l = catalog.lookup(skill);
    if (l.kind === 'found') return { skill: l.skill };
    if (l.kind === 'ambiguous') return { error: fail({ error: 'ambiguous', candidates: l.ids }) };
    return { error: fail({ error: 'not-found', suggestions: catalog.search(skill, 3).map((h) => h.id) }) };
  }

  const tool = <S extends z.ZodRawShape>(
    name: string, description: string, inputSchema: S,
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<Result>,
  ) => {
    server.registerTool(name, { description, inputSchema }, (async (args: z.infer<z.ZodObject<S>>): Promise<Result> => {
      try {
        return await handler(args);
      } catch (e) {
        return fail({ error: 'internal', message: e instanceof Error ? e.message : String(e) });
      }
    }) as never);
  };

  tool('search_skills', 'Search the organization skill catalog. Call this before specialized or unfamiliar work, with a short description of the task.',
    { query: z.string(), limit: z.number().int().positive().optional() },
    async ({ query, limit }) => {
      const c = await engine.catalog();
      const results = c.search(query, limit ?? 10).map(({ score: _score, ...h }) => h);
      return ok({ results, stale: c.stale, problems: errorsOf(c.problems) });
    });

  tool('get_skill', 'Fetch a skill by id or unique name. Returns the SKILL.md body, its files and its folder in the skill library. Follow it. Does not install anything.',
    { skill: z.string() },
    async ({ skill }) => {
      const c = await engine.catalog();
      const r = resolveSkill(c, skill);
      if (r.error) return r.error;
      const s = r.skill;
      const f = await c.readFile(s, 'SKILL.md');
      if (f.kind === 'refused') return fail({ error: 'refused', reason: f.reason });
      if (f.kind === 'missing') return fail({ error: 'not-found', message: `SKILL.md of "${s.id}" is missing from the skill library; run 'skillseekr update'` });
      return ok({
        id: s.id, name: s.name, description: s.description, registry: s.registry, via: s.via,
        // Over 1 MB (or binary): metadata only, like read_skill_file.
        ...(f.kind === 'text' ? { body: f.content } : { skillMd: { kind: f.kind, size: f.size, path: f.path } }),
        files: s.files, path: s.dir, overrides: c.overridesFor(s.id), warnings: s.warnings,
        stale: c.stale, problems: errorsOf(c.problems),
      });
    });

  tool('read_skill_file', 'Read a supporting file from a skill folder, by path relative to the skill. Use for files the skill refers to.',
    { skill: z.string(), path: z.string() },
    async ({ skill, path }) => {
      const c = await engine.catalog();
      const r = resolveSkill(c, skill);
      if (r.error) return r.error;
      const f = await c.readFile(r.skill, path);
      switch (f.kind) {
        case 'text': return ok({ content: f.content });
        case 'binary':
        case 'too_large': return ok({ kind: f.kind, size: f.size, path: f.path });
        case 'refused': return fail({ error: 'refused', reason: f.reason });
        default: return fail({ error: 'not-found' });
      }
    });

  tool('install_skill', 'Install a skill so tools load it permanently. Only call when the user asks to keep a skill or agrees when offered.',
    { skill: z.string(), scope: z.enum(['project', 'user']).optional() },
    async ({ skill, scope }) => {
      const c = await engine.catalog();
      const r = resolveSkill(c, skill);
      if (r.error) return r.error;
      try {
        return ok(await installSkill(r.skill, scope ?? 'project', ctx, { projectDir: await projectDir() }));
      } catch (e) {
        if (e instanceof InstallError) return fail({ error: e.code, message: e.message });
        throw e;
      }
    });

  tool('list_installed', 'List skills installed by skillseekr, with status (current, outdated, modified, missing-from-catalog).',
    { scope: z.enum(['project', 'user']).optional() },
    async ({ scope }) => {
      const c = await engine.catalog();
      const items = await listInstalled(ctx, { ...(scope && { scope }), projectDir: await projectDir() });
      return ok({
        installed: items.map((i) => ({
          name: i.name, scope: i.scope, dir: i.dir, tool: i.tool, id: i.marker.id,
          registry: i.marker.registry, via: i.marker.via, status: statusOf(i, c),
        })),
        problems: errorsOf(c.problems),
      });
    });

  tool('list_registries', 'List the resolved registries in order, with include chain, resolved SHA, last fetch time and overrides.',
    {},
    async () => {
      const r = await engine.registries();
      return ok({ ...r, problems: errorsOf(r.problems) });
    });

  return server;
}

export async function runStdio(ctx: Ctx = defaultContext()): Promise<void> {
  const server = createMcpServer(createEngine(ctx), ctx);
  await server.connect(new StdioServerTransport());
}
