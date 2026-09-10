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
import path from 'node:path';

import { record, supersede } from './custody.js';
import type { CustodyStore } from './types.js';

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

const fmt = (n: number): string => n.toLocaleString('en-US');

/** The literal receipt block. This is the sourceText the custody gate digests. */
export function renderReceipt(o: SessionOutcome): string {
  const mins = Math.round((o.endedAtMs - o.startedAtMs) / 60_000);
  const lines = [
    `SESSION ${o.sessionId}`,
    `window ${new Date(o.startedAtMs).toISOString()} -> ${new Date(o.endedAtMs).toISOString()} (${mins} min)`,
    `model ${o.spend.models.join(', ') || 'unknown'}`,
    `tokens in=${fmt(o.spend.input)} out=${fmt(o.spend.output)} cacheR=${fmt(o.spend.cacheRead)} cacheW=${fmt(o.spend.cacheWrite)} over ${fmt(o.spend.messages)} messages`,
    `tool calls ${fmt(o.toolCalls)}   files written ${o.filesWritten.length}`,
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
  if (o.filesWritten.length === 0 && o.commits.length === 0) return null;

  const receipt = renderReceipt(o);
  const quote = `tokens in=${fmt(o.spend.input)} out=${fmt(o.spend.output)} cacheR=${fmt(o.spend.cacheRead)} cacheW=${fmt(o.spend.cacheWrite)} over ${fmt(o.spend.messages)} messages`;
  const mins = Math.round((o.endedAtMs - o.startedAtMs) / 60_000);

  const text =
    `SESSION OUTCOME ${o.sessionId} (${mins} min, ${o.spend.models.join(', ') || 'unknown model'}): ` +
    `${o.filesWritten.length} files written across ${o.repos.map(([n, c]) => `${n}(${c})`).join(' ') || 'no repo'}; ` +
    `${o.commits.length} commit(s)${o.commits.length > 0 ? `: ${o.commits.slice(0, 4).join('; ')}` : ''}; ` +
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
