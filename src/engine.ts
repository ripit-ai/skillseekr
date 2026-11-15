import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Ctx } from './context.js';
import { Catalog } from './catalog/catalog.js';
import { discoverSkills, type DiscoveredSkill } from './catalog/discover.js';
import { loadConfig } from './config/load.js';
import { MAX_FILE_BYTES } from './catalog/limits.js';
import { configPath } from './paths.js';
import { evaluate, type Security } from './policy/evaluate.js';
import { EMPTY_POLICY, type Policy } from './policy/types.js';
import { cachedScan } from './scan/cache.js';
import { qualityFindings } from './scan/quality.js';
import { UNSCANNABLE_RULE, scanSkillDir, type Finding } from './scan/scan.js';
import { SIGNATURE_FILE, verifySkillDir } from './sign/sign.js';
import { readState, writeCacheFile } from './cache/state.js';
import { resolve, ttlFor, type IncludeInfo, type Override, type ResolvedRegistry } from './resolve/resolve.js';
import { isShaRef, materializeGithub, type FetchOpts } from './sources/github.js';
import { materializeHttpSkill } from './sources/http.js';
import type { CacheSettings, Config, Problem, SourceEntry } from './types.js';

export interface RegistryView {
  name: string; type: SourceEntry['type']; auth: SourceEntry['auth']['type']; via: string[]; description?: string; instructions?: string;
  ref?: string; sha?: string; cacheAgeSeconds?: number; stale: boolean; skillCount: number;
  /** The registries this one replaced by name ("last wins"); absent when it replaced none. */
  overrode?: Array<{ registry: string; via: string[] }>;
}
export interface Engine {
  config(): Promise<Config>;
  catalog(opts?: { force?: boolean }): Promise<Catalog>;
  /** `overrides` holds every override: registry-name ones first, then skill-id ones (same as the catalog's). */
  registries(): Promise<{ registries: RegistryView[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[] }>;
}
export interface EngineDeps { discover?: typeof discoverSkills; scan?: typeof scanSkillDir }

/** What a memo was built from; any change to either means the memo is stale. */
interface Stamps { configFile: string; config: string; generationFile: string; generation: string }

interface Loaded {
  catalog: Catalog; views: RegistryView[]; includes: IncludeInfo[]; overrides: Override[]; problems: Problem[];
  /** ms timestamp after which the memo is stale; Infinity when nothing is ever re-checked. */
  expiresAt: number;
  stamps?: Stamps;
}

/** A load with any error-level problem is retried at least this often, whatever the TTL. */
export const ERROR_RETRY_MS = 60_000;

/** `<cacheDir>/state/generation`: rewritten by every forced load (`sync`) so other processes reload. */
export const generationFile = (cacheDir: string): string => join(cacheDir, 'state', 'generation');

async function fileStamp(file: string): Promise<string> {
  try {
    const st = await stat(file);
    return `${st.mtimeMs}:${st.size}:${st.ino}`;
  } catch (e) {
    return `absent:${(e as NodeJS.ErrnoException).code ?? 'error'}`;
  }
}

async function generationStamp(file: string): Promise<string> {
  try { return await readFile(file, 'utf8'); } catch { return 'absent'; }
}

/** SKILL.md as text, at most MAX_FILE_BYTES of it; '' when it isn't a readable regular file. */
async function readSkillMd(dir: string): Promise<string> {
  try {
    const file = join(dir, 'SKILL.md');
    if (!(await lstat(file)).isFile()) return '';
    const fh = await open(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_FILE_BYTES);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      return buf.subarray(0, bytesRead).toString('utf8');
    } finally { await fh.close(); }
  } catch { return ''; }
}

/** A discovered skill with its verdict: the engine never hands the catalog a skill without one. */
type SecuredSkill = DiscoveredSkill & { security: Security };

const CONTENT_HASH_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_CHANGED_NAMES = 10;

function signatureFinding(r: { changed: string[]; error?: string }): Finding {
  const names = r.changed.slice(0, MAX_CHANGED_NAMES).join(', ') + (r.changed.length > MAX_CHANGED_NAMES ? ` and ${r.changed.length - MAX_CHANGED_NAMES} more` : '');
  const parts = [r.error !== undefined ? `signature check failed: ${r.error}` : 'files do not match the signature'];
  if (names !== '') parts.push(`changed: ${names}`);
  return { rule: 'integrity/signature', severity: 'critical', file: SIGNATURE_FILE, line: 1, message: parts.join('; ') };
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

function validSkills(v: unknown): v is DiscoveredSkill[] {
  return Array.isArray(v) && v.every((s) => s && typeof s === 'object'
    && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.description === 'string'
    && typeof s.dir === 'string' && typeof s.contentHash === 'string' && CONTENT_HASH_RE.test(s.contentHash)
    && Array.isArray(s.files) && Array.isArray(s.warnings));
}

export function createEngine(ctx: Ctx, deps: EngineDeps = {}): Engine {
  const discover = deps.discover ?? discoverSkills;
  const scan = deps.scan ?? scanSkillDir;

  /**
   * Scan (cached by content hash and rules version) + quality + signature (only for a github owner the local config
   * trusts), then the block/allow verdict. Skills in one registry are checked one at a time.
   */
  async function secure(skills: DiscoveredSkill[], entry: SourceEntry, policy: Policy, cacheDir: string): Promise<SecuredSkill[]> {
    const keys = entry.type === 'github'
      ? policy.trust.filter((t) => t.owner.toLowerCase() === entry.owner.toLowerCase()).flatMap((t) => t.public_keys)
      : [];
    const out: SecuredSkill[] = [];
    for (const s of skills) {
      const findings: Finding[] = [];
      try {
        findings.push(...(await cachedScan(cacheDir, s.contentHash, () => scan(s.dir, s.files))).findings);
        findings.push(...await qualityFindings(s, await readSkillMd(s.dir)));
        if (keys.length > 0) {
          const v = await verifySkillDir(s.dir, s.files, keys);
          if (!v.ok) findings.push(signatureFinding(v));
        }
      } catch (e) {
        // Fail closed for this skill only; its siblings and the registry still load. Not cached, so it is retried.
        findings.push({ rule: UNSCANNABLE_RULE, severity: 'critical', file: 'SKILL.md', line: 1, message: `scan failed: ${msg(e)}` });
      }
      out.push({ ...s, security: evaluate(s, findings, policy) });
    }
    return out;
  }
  let memo: { promise: Promise<Loaded>; done?: Loaded } | undefined;

  async function indexed(cache: CacheSettings, owner: string, repo: string, sha: string, skillsDir: string, root: string): Promise<DiscoveredSkill[]> {
    const file = join(cache.dir, 'index', owner, repo, sha, `${sha256(skillsDir)}.json`);
    try {
      const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
      if (validSkills(parsed)) return parsed;
    } catch { /* missing or unreadable: recompute */ }
    const skills = await discover(root, skillsDir);
    await writeCacheFile(file, JSON.stringify(skills)).catch(() => {});
    return skills;
  }

  async function loadOne(reg: ResolvedRegistry, config: Config, force: boolean, policy: Policy) {
    const { entry } = reg;
    const attach = (p: Problem): Problem => ({ ...p, registry: reg.name, via: reg.via });
    const fo: FetchOpts = {
      force, trusted: reg.trusted,
      ttlSeconds: ttlFor(config, entry),
    };
    const problems: Problem[] = [];
    let skills: SecuredSkill[] = [];
    let sha: string | undefined;
    let stale = false;
    let cacheAgeSeconds: number | undefined;
    let recheck = false;
    try {
      if (entry.type === 'github') {
        recheck = !isShaRef(entry.ref);
        const r = await materializeGithub(entry, fo, config.cache, ctx);
        if ('error' in r) {
          problems.push(attach(r.error));
        } else {
          sha = r.sha; stale = r.stale;
          problems.push(...r.problems.map(attach));
          skills = await secure(await indexed(config.cache, entry.owner, entry.repo, r.sha, entry.skills_dir, r.root), entry, policy, config.cache.dir);
          if (recheck) {
            const rec = await readState<{ checkedAt?: unknown }>(config.cache.dir, `ref/${entry.owner}/${entry.repo}/${entry.ref}`);
            if (typeof rec?.checkedAt === 'number') cacheAgeSeconds = (ctx.now() - rec.checkedAt) / 1000;
          }
        }
      } else {
        recheck = true;
        const r = await materializeHttpSkill(entry, fo, config.cache, ctx);
        if ('error' in r) {
          problems.push(attach(r.error));
        } else {
          stale = r.stale;
          problems.push(...r.problems.map(attach));
          skills = await secure((await discover(dirname(r.root), '')).filter((s) => s.id === entry.skill_name), entry, policy, config.cache.dir);
          const rec = await readState<{ checkedAt?: unknown }>(config.cache.dir, `http/${sha256(entry.url)}`);
          if (typeof rec?.checkedAt === 'number') cacheAgeSeconds = (ctx.now() - rec.checkedAt) / 1000;
        }
      }
    } catch (e) {
      skills = [];
      problems.push(attach({ level: 'error', code: 'engine/source-failed', message: `registry "${reg.name}" failed unexpectedly: ${msg(e)}` }));
    }
    return { reg, sha, stale, skills, problems, cacheAgeSeconds, ttl: fo.ttlSeconds, recheck };
  }

  async function loadInner(force: boolean): Promise<Loaded> {
    // Stamped before reading, so an edit made while loading still triggers a reload next time.
    const configFile = configPath(ctx);
    const configStamp = await fileStamp(configFile);
    const config = await loadConfig(ctx);
    const genFile = generationFile(config.cache.dir);
    const stamps: Stamps = { configFile, config: configStamp, generationFile: genFile, generation: await generationStamp(genFile) };
    const res = await resolve(config, { force }, ctx);
    const results = await Promise.all(res.registries.map((r) => loadOne(r, config, force, res.policy)));

    const problems = [...res.problems, ...results.flatMap((r) => r.problems)];
    const stale = res.stale || results.some((r) => r.stale);
    const catalog = new Catalog(
      results.map((r) => ({
        registry: r.reg, skills: r.skills,
        ...(r.reg.entry.type === 'github' ? { ref: r.reg.entry.ref } : {}),
        ...(r.sha !== undefined ? { sha: r.sha } : {}),
      })),
      res.overrides, problems, stale, res.policy, config.cache.dir,
    );

    const views: RegistryView[] = results.map((r) => {
      const e = r.reg.entry;
      const overrode = res.overrides
        .filter((o) => o.kind === 'registry' && o.by.registry === r.reg.name && o.by.via.join('\0') === r.reg.via.join('\0'))
        .map((o) => o.replaced);
      return {
        name: r.reg.name, type: e.type, auth: e.auth.type, via: r.reg.via,
        ...(e.description !== undefined ? { description: e.description } : {}),
        ...(e.instructions !== undefined ? { instructions: e.instructions } : {}),
        ...(e.type === 'github' ? { ref: e.ref } : {}),
        ...(r.sha !== undefined ? { sha: r.sha } : {}),
        ...(r.cacheAgeSeconds !== undefined ? { cacheAgeSeconds: r.cacheAgeSeconds } : {}),
        stale: r.stale, skillCount: r.skills.length,
        ...(overrode.length ? { overrode } : {}),
      };
    });

    // The memo lasts until the earliest re-check of any non-SHA github source, http source or include.
    const ttls = results.filter((r) => r.recheck).map((r) => r.ttl);
    for (const i of res.includes) if (i.entry.type === 'http-registry' || !isShaRef(i.entry.ref)) ttls.push(ttlFor(config, i.entry));
    const doneAt = ctx.now(); // anchored at load completion, not start
    let expiresAt = ttls.length ? doneAt + Math.min(...ttls) * 1000 : Infinity;
    if (!config.exists) expiresAt = doneAt; // setup may create the config at any moment
    if (problems.some((p) => p.level === 'error')) expiresAt = Math.min(expiresAt, doneAt + ERROR_RETRY_MS);
    return { catalog, views, includes: res.includes, overrides: catalog.overrides, problems, expiresAt, stamps };
  }

  async function load(force: boolean): Promise<Loaded> {
    try {
      return await loadInner(force);
    } catch (e) {
      const problems: Problem[] = [{ level: 'error', code: 'engine/load-failed', message: `loading the catalog failed unexpectedly: ${msg(e)}` }];
      let now = 0;
      try { now = ctx.now(); } catch { /* keep 0 */ }
      return { catalog: new Catalog([], [], problems, false, EMPTY_POLICY), views: [], includes: [], overrides: [], problems, expiresAt: now };
    }
  }

  /** True while the config file and the sync generation are what the memo was built from. */
  async function unchanged(st: Stamps | undefined): Promise<boolean> {
    if (!st) return false;
    return (await fileStamp(st.configFile)) === st.config && (await generationStamp(st.generationFile)) === st.generation;
  }

  /** Marks a forced load for other processes; this engine records the new generation so it doesn't reload itself. */
  async function bumpGeneration(l: Loaded): Promise<void> {
    if (!l.stamps) return;
    const value = `${ctx.now()}-${process.pid}-${randomBytes(6).toString('hex')}\n`;
    try {
      await writeCacheFile(l.stamps.generationFile, value);
      l.stamps.generation = value;
    } catch { /* unwritable cache: other processes reload on their own TTL */ }
  }

  async function get(force: boolean): Promise<Loaded> {
    if (!force && memo) {
      const cur = memo;
      if (!cur.done) return cur.promise; // a load is in flight: share it
      if (ctx.now() < cur.done.expiresAt && await unchanged(cur.done.stamps)) return cur.promise;
      if (memo !== cur) return memo.promise; // another caller started the reload while we checked
    }
    const entry: NonNullable<typeof memo> = { promise: undefined as unknown as Promise<Loaded> };
    entry.promise = load(force).then(
      async (l) => { if (force) await bumpGeneration(l); entry.done = l; return l; },
      (e) => { if (memo === entry) memo = undefined; throw e; }, // unreachable: load() never rejects
    );
    memo = entry;
    return entry.promise;
  }

  return {
    config: () => loadConfig(ctx),
    async catalog(opts) { return (await get(opts?.force ?? false)).catalog; },
    async registries() {
      const l = await get(false);
      return { registries: l.views, includes: l.includes, overrides: l.overrides, problems: l.problems };
    },
  };
}
