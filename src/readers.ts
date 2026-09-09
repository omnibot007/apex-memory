/**
 * Transcript readers — one per harness.
 *
 * Every harness stores what the operator typed somewhere different. Each reader's only
 * job is to turn that store into a flat list of Utterances. Nothing here knows what a
 * "decision" is; that lives in distill.ts, so adding a fourth harness never touches the
 * extraction logic.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omninbot
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// This package is ESM, where bare `require` does not exist. node:sqlite has no stable
// ESM named export across Node versions, so bridge to CJS explicitly.
const nodeRequire = createRequire(import.meta.url);

export interface Utterance {
  /** Exactly what the operator typed. */
  readonly text: string;
  readonly atMs: number;
  /** Stable pointer back to the source, used as the custody sourceLocator. */
  readonly locator: string;
  /** Project scope, derived from the session's working directory. */
  readonly project: string;
  readonly session: string;
  readonly harness: string;
}

export interface TranscriptReader {
  readonly name: string;
  available(): boolean;
  read(): Utterance[];
}

function projectOf(dir: string | null | undefined): string {
  if (typeof dir !== 'string' || dir.trim().length === 0) return 'default';
  const base = path.basename(dir.replace(/[/\\]+$/, ''));
  return base.length > 0 ? base : 'default';
}

function readJsonl(file: string): unknown[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows: unknown[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      continue;
    }
  }
  return rows;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** Claude Code: ~/.claude/projects/<cwd-slug>/<session-id>.jsonl */
export class ClaudeReader implements TranscriptReader {
  readonly name = 'claude';

  constructor(private readonly root = path.join(os.homedir(), '.claude', 'projects')) {}

  available(): boolean {
    return fs.existsSync(this.root);
  }

  read(): Utterance[] {
    const out: Utterance[] = [];
    let dirs: fs.Dirent[] = [];
    try {
      dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return out;
    }
    for (const dir of dirs) {
      const dirPath = path.join(this.root, dir.name);
      let files: string[] = [];
      try {
        files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        const session = file.replace(/\.jsonl$/, '');
        for (const raw of readJsonl(path.join(dirPath, file))) {
          const row = asRecord(raw);
          if (row === null || row['type'] !== 'user') continue;
          const message = asRecord(row['message']);
          const content = message?.['content'];
          // Tool results also arrive as type:"user" but carry an array of blocks.
          // Only string content is something a human typed.
          if (typeof content !== 'string' || content.trim().length === 0) continue;
          if (content.startsWith('<')) continue;
          out.push({
            text: content,
            atMs: Date.parse(String(row['timestamp'] ?? '')) || 0,
            locator: `claude:${session}#${String(row['uuid'] ?? 'na')}`,
            project: projectOf(typeof row['cwd'] === 'string' ? row['cwd'] : dir.name),
            session,
            harness: 'claude',
          });
        }
      }
    }
    return out;
  }
}

/** kimi-code: ~/.kimi-code/sessions/wd_<slug>/session_<id>/agents/<agent>/wire.jsonl */
export class KimiReader implements TranscriptReader {
  readonly name = 'kimi';

  constructor(private readonly root = path.join(os.homedir(), '.kimi-code', 'sessions')) {}

  available(): boolean {
    return fs.existsSync(this.root);
  }

  private wireFiles(): string[] {
    const found: string[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 5) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (entry.name === 'wire.jsonl') found.push(full);
      }
    };
    walk(this.root, 0);
    return found;
  }

  read(): Utterance[] {
    const out: Utterance[] = [];
    const workDirs = new Map<string, string>();
    try {
      for (const raw of readJsonl(path.join(os.homedir(), '.kimi-code', 'session_index.jsonl'))) {
        const row = asRecord(raw);
        if (row === null) continue;
        const id = row['sessionId'];
        const wd = row['workDir'];
        if (typeof id === 'string' && typeof wd === 'string') workDirs.set(id, wd);
      }
    } catch {
      /* index is optional */
    }

    for (const file of this.wireFiles()) {
      const match = /session_([^\\/]+)/.exec(file);
      const session = match?.[1] ?? 'unknown';
      const indexed = workDirs.get(`session_${session}`);
      for (const raw of readJsonl(file)) {
        const row = asRecord(raw);
        if (row === null || row['type'] !== 'turn.prompt') continue;
        const origin = asRecord(row['origin']);
        if (origin?.['kind'] !== 'user') continue;
        const input = row['input'];
        if (!Array.isArray(input)) continue;
        const text = input
          .map((block) => {
            const b = asRecord(block);
            return b !== null && b['type'] === 'text' && typeof b['text'] === 'string' ? b['text'] : '';
          })
          .filter((s) => s.length > 0)
          .join('\n')
          .trim();
        if (text.length === 0) continue;
        const at = typeof row['time'] === 'number' ? row['time'] : 0;
        out.push({
          text,
          atMs: at,
          locator: `kimi:${session}#${at}`,
          project: projectOf(indexed ?? null),
          session,
          harness: 'kimi',
        });
      }
    }
    return out;
  }
}

/**
 * OpenCode: SQLite at ~/.local/share/opencode/opencode.db
 *
 * The database is held open by a running OpenCode, and SQLite reports a live lock as
 * `SQLITE_NOTADB` ("file is not a database") rather than SQLITE_BUSY — which reads
 * exactly like corruption or encryption and is not. The fix is to snapshot the db, wal
 * and shm together into a temp directory and read the copy.
 */
export class OpenCodeReader implements TranscriptReader {
  readonly name = 'opencode';

  constructor(
    private readonly dbPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db'),
  ) {}

  available(): boolean {
    return fs.existsSync(this.dbPath);
  }

  private snapshot(): string | null {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-oc-'));
    try {
      for (const suffix of ['', '-wal', '-shm']) {
        const src = `${this.dbPath}${suffix}`;
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(tmp, `${path.basename(this.dbPath)}${suffix}`));
        }
      }
      return path.join(tmp, path.basename(this.dbPath));
    } catch {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      return null;
    }
  }

  read(): Utterance[] {
    const out: Utterance[] = [];
    const copy = this.snapshot();
    if (copy === null) return out;
    const tmpDir = path.dirname(copy);
    try {
      // Loaded lazily so a Node build without node:sqlite degrades to "no utterances"
      // instead of taking the whole distiller down.
      const sqlite = nodeRequire('node:sqlite') as {
        DatabaseSync: new (p: string, o?: object) => {
          prepare(sql: string): { all(): unknown[] };
          close(): void;
        };
      };
      const db = new sqlite.DatabaseSync(copy, { readOnly: true });
      const rows = db
        .prepare(
          `SELECT p.data AS part, p.time_created AS at, m.data AS msg, m.session_id AS sid,
                  p.id AS pid, s.directory AS dir
             FROM part p
             JOIN message m ON m.id = p.message_id
             LEFT JOIN session s ON s.id = p.session_id
            ORDER BY p.time_created ASC`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        let msg: Record<string, unknown> | null = null;
        let part: Record<string, unknown> | null = null;
        try {
          msg = asRecord(JSON.parse(String(row['msg'])));
          part = asRecord(JSON.parse(String(row['part'])));
        } catch {
          continue;
        }
        if (msg?.['role'] !== 'user') continue;
        if (part?.['type'] !== 'text') continue;
        const text = part['text'];
        if (typeof text !== 'string' || text.trim().length === 0) continue;
        const session = String(row['sid'] ?? 'unknown');
        out.push({
          text,
          atMs: typeof row['at'] === 'number' ? row['at'] : 0,
          locator: `opencode:${session}#${String(row['pid'] ?? 'na')}`,
          project: projectOf(typeof row['dir'] === 'string' ? row['dir'] : null),
          session,
          harness: 'opencode',
        });
      }
      db.close();
    } catch {
      /* unreadable store is not a distiller failure */
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    return out;
  }
}

export function allReaders(): TranscriptReader[] {
  return [new ClaudeReader(), new KimiReader(), new OpenCodeReader()];
}
