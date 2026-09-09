/**
 * Append-only JSONL store. Zero dependencies, local-first.
 *
 * Every write appends. Reads replay the log with last-write-wins per id, so a
 * supersession or an archival is itself just another append. Nothing is ever
 * rewritten in place, which means a crash mid-write costs the tail, never the history.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omnibot007
 */
import fs from 'node:fs';
import path from 'node:path';

import type { CustodiedFact, CustodyStore } from './types.js';

export function defaultMemoryDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['APEX_MEMORY_HOME'];
  if (explicit !== undefined && explicit.trim().length > 0) return explicit;
  const home = env['USERPROFILE'] ?? env['HOME'] ?? '.';
  return path.join(home, '.apex-memory');
}

export class JsonlCustodyStore implements CustodyStore {
  private readonly file: string;

  constructor(dir: string = defaultMemoryDir()) {
    this.file = path.join(dir, 'custody.jsonl');
  }

  get path(): string {
    return this.file;
  }

  private readAll(): Map<string, CustodiedFact> {
    const rows = new Map<string, CustodiedFact>();
    let text: string;
    try {
      text = fs.readFileSync(this.file, 'utf8');
    } catch {
      return rows;
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as CustodiedFact;
        if (typeof parsed?.id === 'string' && typeof parsed?.project === 'string') {
          rows.set(parsed.id, parsed);
        }
      } catch {
        continue;
      }
    }
    return rows;
  }

  async put(fact: CustodiedFact): Promise<void> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, `${JSON.stringify(fact)}\n`, 'utf8');
  }

  async get(id: string): Promise<CustodiedFact | undefined> {
    return this.readAll().get(id);
  }

  async list(project: string): Promise<CustodiedFact[]> {
    return [...this.readAll().values()].filter((row) => row.project === project);
  }

  async listAll(): Promise<CustodiedFact[]> {
    return [...this.readAll().values()];
  }

  /**
   * Hard removal, for an explicit operator erasure request only. Ordinary lifecycle
   * uses supersede() or archive(); neither loses history.
   */
  async remove(id: string): Promise<void> {
    const rows = this.readAll();
    if (!rows.delete(id)) return;
    const body = [...rows.values()].map((row) => JSON.stringify(row)).join('\n');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, body.length > 0 ? `${body}\n` : '', 'utf8');
  }

  /** Rewrites the log to one line per surviving fact. Used by compaction. */
  async rewrite(facts: readonly CustodiedFact[]): Promise<void> {
    const body = facts.map((row) => JSON.stringify(row)).join('\n');
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, body.length > 0 ? `${body}\n` : '', 'utf8');
  }

  async allProjects(): Promise<string[]> {
    return [...new Set([...this.readAll().values()].map((row) => row.project))].sort();
  }
}

export class MemoryCustodyStore implements CustodyStore {
  private readonly rows = new Map<string, CustodiedFact>();

  async put(fact: CustodiedFact): Promise<void> {
    this.rows.set(fact.id, fact);
  }

  async get(id: string): Promise<CustodiedFact | undefined> {
    return this.rows.get(id);
  }

  async list(project: string): Promise<CustodiedFact[]> {
    return [...this.rows.values()].filter((row) => row.project === project);
  }

  async listAll(): Promise<CustodiedFact[]> {
    return [...this.rows.values()];
  }

  async remove(id: string): Promise<void> {
    this.rows.delete(id);
  }

  async rewrite(facts: readonly CustodiedFact[]): Promise<void> {
    this.rows.clear();
    for (const fact of facts) this.rows.set(fact.id, fact);
  }
}
