/**
 * outcomes.ts -- the mission-close scribe.
 *
 * WHY THIS EXISTS, and why it is not more of distill.ts:
 *
 * distill.ts scrapes UTTERANCES. Measured over 1,223 real ones, surface markers cannot
 * separate a standing rule from a passing remark, so everything it writes correctly sits
 * at `observation` and always will. That ceiling is not a tuning problem; it is what
 * prose is.
 *
 * Mission OUTCOMES are not prose. Nobody types "I shipped 4512d2a and burned 506M cache
 * tokens" -- so no distiller can ever find it. Outcomes have to be COMPUTED at close from
 * receipts: the transcript's own usage records, and `git log` in the repos the work
 * actually touched. Receipts are `verified-command`, which is why this file can write at
 * `fact` where distill.ts cannot.
 *
 * It also fixes the project-naming defect. distill.ts names the project after the
 * process cwd, which produced 43 rows under `Warp` and 22 under `LENOVO` -- a program
 * directory and a home directory, neither of which is a mission. This names it after
 * WHERE THE WORK LANDED: the git repository holding the most files written this session.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omnibot007
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { record, supersede } from './custody.js';
import type { CustodyStore } from './types.js';

// This package is ESM, where bare `require` does not exist. node:sqlite has no stable
// ESM named export across Node versions, so bridge to CJS explicitly (as readers.ts does).
const nodeRequire = createRequire(import.meta.url);

/** Token spend, summed from the transcript's own usage records. */
export interface Spend {
  readonly models: readonly string[];
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly messages: number;
}

export interface SessionOutcome {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly spend: Spend;
  readonly filesWritten: readonly string[];
  readonly toolCalls: number;
  /** Repo name -> files written inside it, most-touched first. */
  readonly repos: ReadonlyArray<readonly [string, number]>;
  readonly project: string;
  readonly commits: readonly string[];
  /** OpenCode names its sessions; Claude Code does not. */
  readonly title?: string | undefined;
  /** OpenCode tracks real dollars. 0 is honest on a free model, not missing data. */
  readonly costUsd?: number | undefined;
}

/** Walk up from a file to the directory holding `.git`. Returns null outside any repo. */
export function repoRootOf(filePath: string): string | null {
  let dir = path.dirname(path.resolve(filePath));
  for (let hops = 0; hops < 40; hops += 1) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

function jsonLines(file: string): unknown[] {
  const out: unknown[] = [];
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn final line is normal on a live transcript */
    }
  }
  return out;
}

interface Rec {
  timestamp?: string;
  message?: {
    model?: string;
    usage?: Record<string, number>;
    content?: Array<{ type?: string; name?: string; input?: Record<string, unknown> }>;
  };
}

/**
 * Read one Claude Code transcript into a computed outcome. Every number here traces to a
 * record the harness wrote itself -- nothing is inferred from what anybody said.
 */
export function readSessionOutcome(transcriptPath: string): SessionOutcome | null {
  const records = jsonLines(transcriptPath) as Rec[];
  if (records.length === 0) return null;

  const models = new Set<string>();
  const files = new Set<string>();
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let messages = 0;
  let toolCalls = 0;
  let first = '';
  let last = '';

  for (const r of records) {
    if (typeof r.timestamp === 'string') {
      if (first === '') first = r.timestamp;
      last = r.timestamp;
    }
    const usage = r.message?.usage;
    if (usage !== undefined) {
      messages += 1;
      input += usage.input_tokens ?? 0;
      output += usage.output_tokens ?? 0;
      cacheRead += usage.cache_read_input_tokens ?? 0;
      cacheWrite += usage.cache_creation_input_tokens ?? 0;
      const m = r.message?.model;
      if (typeof m === 'string' && m !== '<synthetic>') models.add(m);
    }
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== 'tool_use') continue;
      toolCalls += 1;
      if (block.name !== 'Write' && block.name !== 'Edit' && block.name !== 'NotebookEdit') continue;
      const p = block.input?.file_path;
      if (typeof p === 'string' && p.length > 0) files.add(p);
    }
  }

  const filesWritten = [...files];
  const repos = rankRepos(filesWritten);
  const startedAtMs = first === '' ? Date.now() : Date.parse(first);
  const endedAtMs = last === '' ? Date.now() : Date.parse(last);
  const project = repos[0]?.[0] ?? 'unfiled';

  return {
    sessionId: path.basename(transcriptPath, '.jsonl'),
    transcriptPath,
    startedAtMs,
    endedAtMs,
    spend: { models: [...models], input, output, cacheRead, cacheWrite, messages },
    filesWritten,
    toolCalls,
    repos,
    project,
    commits: gitCommitsIn(repos, startedAtMs, endedAtMs),
  };
}

/**
 * Which repository did the work land in? Scratchpad and transcript paths are excluded --
 * a session is not "about" its own temp directory.
 */
export function rankRepos(files: readonly string[]): ReadonlyArray<readonly [string, number]> {
  const counts = new Map<string, number>();
  for (const f of files) {
    if (/[\\/](scratchpad|Temp|AppData[\\/]Local[\\/]Temp)[\\/]/i.test(f)) continue;
    const root = repoRootOf(f);
    const name = root === null ? path.basename(path.dirname(f)) : path.basename(root);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** `git log` in each touched repo, bounded to the session window. Receipts, not guesses. */
export function gitCommitsIn(
  repos: ReadonlyArray<readonly [string, number]>,
  sinceMs: number,
  untilMs: number,
): string[] {
  const out: string[] = [];
  for (const [name] of repos.slice(0, 6)) {
    const root = findRepoByName(name);
    if (root === null) continue;
    try {
      const log = execFileSync(
        'git',
        [
          '-C',
          root,
          'log',
          '--all',
          `--since=${new Date(sinceMs).toISOString()}`,
          `--until=${new Date(untilMs + 60_000).toISOString()}`,
          '--pretty=format:%h %s',
        ],
        { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      for (const line of log.split('\n')) {
        if (line.trim().length > 0) out.push(`${name} ${line.trim()}`);
      }
    } catch {
      /* not a repo, git missing, or no commits -- all mean "nothing to report" */
    }
  }
  return out;
}

const REPO_SEARCH_DIRS = [
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'tools'),
  path.join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'missions'),
  process.env.USERPROFILE ?? process.env.HOME ?? '',
];

function findRepoByName(name: string): string | null {
  for (const base of REPO_SEARCH_DIRS) {
    const candidate = path.join(base, name);
    try {
      if (fs.existsSync(path.join(candidate, '.git'))) return candidate;
    } catch {
      /* unreadable directory is not an error here */
    }
  }
  return null;
}

/* ------------------------------------------------------------------ OpenCode --- */

/**
 * OpenCode keeps outcomes in SQLite, and keeps them BETTER than Claude Code does: the
 * `session` table already carries `cost`, all five token counters, the model and the
 * title. No summing required -- the harness did it.
 *
 * Two traps, both verified on this machine:
 *
 * 1. `session.directory` is the process cwd, so it reads `...\Programs\Warp` for work
 *    that actually landed in kimi-apex and missions. It is the SAME defect rankRepos()
 *    exists to fix, so the project is derived from write/edit tool calls here too --
 *    never from that column.
 * 2. `summary_files` is 0 even on sessions with 41 writes and 75 edits. It is not
 *    populated; the file list has to come from the `part` table.
 *
 * The db is held open by a running OpenCode, and SQLite reports a live lock as
 * SQLITE_NOTADB ("file is not a database"), which reads exactly like corruption and is
 * not. Snapshot db+wal+shm together and read the copy -- same fix as OpenCodeReader.
 */
export function openCodeDbPath(): string {
  return path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
}

function snapshotDb(dbPath: string): string | null {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-oco-'));
  try {
    for (const suffix of ['', '-wal', '-shm']) {
      const src = `${dbPath}${suffix}`;
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(tmp, `${path.basename(dbPath)}${suffix}`));
      }
    }
    return path.join(tmp, path.basename(dbPath));
  } catch {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    return null;
  }
}

/** `model` is stored as a JSON blob, not a string. Pull the id, fall back to raw. */
function modelIdOf(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return 'unknown';
  try {
    const m = JSON.parse(raw) as { id?: unknown; variant?: unknown };
    if (typeof m.id === 'string') {
      return typeof m.variant === 'string' ? `${m.id}:${m.variant}` : m.id;
    }
  } catch {
    /* not JSON -- use it as-is */
  }
  return raw;
}

const WRITE_TOOLS = new Set(['write', 'edit', 'patch', 'multiedit']);

function filesWrittenIn(
  db: { prepare(sql: string): { all(...p: unknown[]): unknown[] } },
  sessionId: string,
): string[] {
  const files = new Set<string>();
  let rows: unknown[] = [];
  try {
    rows = db.prepare('SELECT data FROM part WHERE session_id = ?').all(sessionId);
  } catch {
    return [];
  }
  for (const r of rows) {
    const data = (r as { data?: unknown }).data;
    if (typeof data !== 'string') continue;
    let d: { type?: unknown; tool?: unknown; state?: { input?: Record<string, unknown> } };
    try {
      d = JSON.parse(data);
    } catch {
      continue;
    }
    if (d.type !== 'tool' || typeof d.tool !== 'string') continue;
    if (!WRITE_TOOLS.has(d.tool)) continue;
    const input = d.state?.input;
    const p = input?.['filePath'] ?? input?.['file_path'] ?? input?.['path'];
    if (typeof p === 'string' && p.length > 1) files.add(p);
  }
  return [...files];
}

/**
 * Read finished OpenCode sessions as outcomes. `sinceMs` bounds the sweep so a hook does
 * not re-derive 136 sessions on every close.
 */
export function readOpenCodeOutcomes(
  sinceMs: number,
  dbPath: string = openCodeDbPath(),
): SessionOutcome[] {
  if (!fs.existsSync(dbPath)) return [];
  const copy = snapshotDb(dbPath);
  if (copy === null) return [];
  const tmpDir = path.dirname(copy);
  const out: SessionOutcome[] = [];

  try {
    const sqlite = nodeRequire('node:sqlite') as {
      DatabaseSync: new (
        p: string,
        o?: object,
      ) => {
        prepare(sql: string): { all(...p: unknown[]): unknown[] };
        close(): void;
      };
    };
    const db = new sqlite.DatabaseSync(copy, { readOnly: true });
    const sessions = db
      .prepare(
        `SELECT id, title, model, cost, tokens_input, tokens_output, tokens_cache_read,
                tokens_cache_write, time_created, time_updated
           FROM session
          WHERE time_updated >= ?
          ORDER BY time_updated DESC`,
      )
      .all(sinceMs) as Array<Record<string, unknown>>;

    for (const s of sessions) {
      const id = String(s['id'] ?? '');
      if (id === '') continue;
      const files = filesWrittenIn(db, id);
      if (files.length === 0) continue;

      const repos = rankRepos(files);
      const startedAtMs = Number(s['time_created'] ?? 0);
      const endedAtMs = Number(s['time_updated'] ?? startedAtMs);
      const num = (k: string): number => Number(s[k] ?? 0);

      out.push({
        sessionId: id,
        transcriptPath: `opencode:${id}`,
        startedAtMs,
        endedAtMs,
        spend: {
          models: [modelIdOf(s['model'])],
          input: num('tokens_input'),
          output: num('tokens_output'),
          cacheRead: num('tokens_cache_read'),
          cacheWrite: num('tokens_cache_write'),
          messages: 0,
        },
        filesWritten: files,
        toolCalls: 0,
        repos,
        project: repos[0]?.[0] ?? 'unfiled',
        commits: gitCommitsIn(repos, startedAtMs, endedAtMs),
        title: typeof s['title'] === 'string' ? s['title'] : undefined,
        costUsd: num('cost'),
      });
    }
    db.close();
  } catch {
    /* an unreadable store is not a hook failure */
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  return out;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

/**
 * The spend line, used as BOTH the receipt's token row and the custody quote. The gate
 * refuses a write whose quote is not a verbatim substring of its sourceText, so deriving
 * them from one function makes that structural rather than a thing to remember.
 */
function tokenLine(o: SessionOutcome): string {
  const m = o.spend.messages > 0 ? ` over ${fmt(o.spend.messages)} messages` : '';
  return `tokens in=${fmt(o.spend.input)} out=${fmt(o.spend.output)} cacheR=${fmt(o.spend.cacheRead)} cacheW=${fmt(o.spend.cacheWrite)}${m}`;
}

/** The literal receipt block. This is the sourceText the custody gate digests. */
export function renderReceipt(o: SessionOutcome): string {
  const mins = Math.round((o.endedAtMs - o.startedAtMs) / 60_000);
  const lines = [
    `SESSION ${o.sessionId}`,
    ...(o.title === undefined ? [] : [`title ${o.title}`]),
    `window ${new Date(o.startedAtMs).toISOString()} -> ${new Date(o.endedAtMs).toISOString()} (${mins} min)`,
    `model ${o.spend.models.join(', ') || 'unknown'}`,
    tokenLine(o),
    ...(o.costUsd === undefined ? [] : [`cost $${o.costUsd.toFixed(4)}`]),
    `files written ${o.filesWritten.length}${o.toolCalls > 0 ? `   tool calls ${fmt(o.toolCalls)}` : ''}`,
    `repos touched ${o.repos.map(([n, c]) => `${n}(${c})`).join(' ') || 'none'}`,
    `commits ${o.commits.length}`,
  ];
  for (const c of o.commits) lines.push(`  ${c}`);
  return lines.join('\n');
}

/**
 * Write the outcome as ONE row at `verified-command`. Returns null when there is nothing
 * worth banking -- a session that wrote no files and made no commits is not an outcome.
 *
 * The hook can fire more than once for one session (a resumed session ends twice). An
 * unchanged re-fire is skipped; a CHANGED one writes a new row and supersedes the old,
 * which is the whole reason this store is bitemporal. Sessions never accumulate
 * duplicate outcome rows.
 */
export async function recordOutcome(
  store: CustodyStore,
  o: SessionOutcome,
  nowMs: number = Date.now(),
): Promise<string | null> {
  // `repos` already excludes scratchpad and Temp, so an empty one means the session wrote
  // nothing durable. Measured: gating on filesWritten alone banked 10 `unfiled` rows for
  // sessions whose entire output was temp files. A scratch session is not an outcome.
  if (o.repos.length === 0 && o.commits.length === 0) return null;

  const receipt = renderReceipt(o);
  const quote = tokenLine(o);
  const mins = Math.round((o.endedAtMs - o.startedAtMs) / 60_000);
  const cost = o.costUsd === undefined ? '' : ` cost $${o.costUsd.toFixed(4)};`;

  const text =
    `SESSION OUTCOME ${o.sessionId}${o.title === undefined ? '' : ` "${o.title}"`} ` +
    `(${mins} min, ${o.spend.models.join(', ') || 'unknown model'}): ` +
    `${o.filesWritten.length} files written across ${o.repos.map(([n, c]) => `${n}(${c})`).join(' ') || 'no repo'}; ` +
    `${o.commits.length} commit(s)${o.commits.length > 0 ? `: ${o.commits.slice(0, 4).join('; ')}` : ''};${cost} ` +
    `spend in=${fmt(o.spend.input)} out=${fmt(o.spend.output)} cacheRead=${fmt(o.spend.cacheRead)} cacheWrite=${fmt(o.spend.cacheWrite)}.`;

  const locator = `outcome:${o.transcriptPath}`;
  const priors = (await store.list(o.project)).filter(
    (f) => f.sourceLocator === locator && f.supersededBy === null,
  );
  if (priors.some((f) => f.quote === quote)) return null;

  const fact = await record(store, {
    project: o.project,
    kind: 'fact',
    text,
    quote,
    sourceKind: 'verified-command',
    claimedAuthority: 'fact',
    sourceLocator: locator,
    sourceText: receipt,
    sourceSession: o.sessionId,
    validFromMs: o.endedAtMs,
    recordedAtMs: Math.max(nowMs, o.endedAtMs),
  });

  for (const stale of priors) {
    await supersede(store, o.project, stale.id, fact.id, fact.recordedAtMs);
  }
  return fact.id;
}
