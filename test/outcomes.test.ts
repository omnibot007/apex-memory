import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  rankRepos,
  readOpenCodeOutcomes,
  readSessionOutcome,
  recordOutcome,
  renderReceipt,
} from '../src/outcomes.js';
import { MemoryCustodyStore } from '../src/store.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-outcomes-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A transcript shaped exactly like the ones Claude Code writes. */
function writeTranscript(name: string, records: unknown[]): string {
  const file = path.join(tmp, `${name}.jsonl`);
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
  return file;
}

const usageMsg = (ts: string, usage: Record<string, number>) => ({
  timestamp: ts,
  message: { model: 'claude-opus-5', usage },
});

const wroteFile = (ts: string, p: string) => ({
  timestamp: ts,
  message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: p } }] },
});

describe('rankRepos — the project-naming fix', () => {
  /**
   * The real defect: distill.ts named projects after process cwd, which filed 43 rows
   * under `Warp` (a program directory) and 22 under `LENOVO` (a home directory).
   */
  it('ignores scratchpad and Temp paths so a session is never "about" its own temp dir', () => {
    const ranked = rankRepos([
      'C:/Users/LENOVO/AppData/Local/Temp/claude/abc/scratchpad/notes.md',
      'C:/Users/LENOVO/AppData/Local/Temp/claude/abc/scratchpad/run.mjs',
      'C:/Users/LENOVO/tools/apex-memory/src/outcomes.ts',
    ]);
    expect(ranked.map(([n]) => n)).not.toContain('scratchpad');
    expect(ranked[0]?.[0]).toBe('apex-memory');
  });

  it('ranks by where the most work landed, not by what came first', () => {
    const ranked = rankRepos([
      'C:/Users/LENOVO/tools/sauce-scan/a.mjs',
      'C:/Users/LENOVO/tools/apex-memory/a.ts',
      'C:/Users/LENOVO/tools/apex-memory/b.ts',
      'C:/Users/LENOVO/tools/apex-memory/c.ts',
    ]);
    expect(ranked[0]?.[0]).toBe('apex-memory');
    expect(ranked[0]?.[1]).toBe(3);
  });

  it('returns nothing for a session that wrote nothing outside temp', () => {
    expect(rankRepos(['C:/Users/LENOVO/AppData/Local/Temp/claude/x/scratchpad/a.md'])).toHaveLength(0);
  });
});

describe('readSessionOutcome — spend is computed, never claimed', () => {
  it('sums usage across messages and captures the model', () => {
    const f = writeTranscript('spend', [
      usageMsg('2026-09-09T18:00:00.000Z', { input_tokens: 10, output_tokens: 100, cache_read_input_tokens: 1000 }),
      usageMsg('2026-09-09T18:30:00.000Z', { input_tokens: 5, output_tokens: 50, cache_read_input_tokens: 500 }),
      wroteFile('2026-09-09T19:00:00.000Z', 'C:/Users/LENOVO/tools/apex-memory/src/x.ts'),
    ]);
    const o = readSessionOutcome(f);
    expect(o).not.toBeNull();
    expect(o?.spend.input).toBe(15);
    expect(o?.spend.output).toBe(150);
    expect(o?.spend.cacheRead).toBe(1500);
    expect(o?.spend.messages).toBe(2);
    expect(o?.spend.models).toEqual(['claude-opus-5']);
  });

  it('excludes the <synthetic> model, which is not a model anyone paid for', () => {
    const f = writeTranscript('synth', [
      { timestamp: '2026-09-09T18:00:00.000Z', message: { model: '<synthetic>', usage: { output_tokens: 1 } } },
      wroteFile('2026-09-09T18:01:00.000Z', 'C:/Users/LENOVO/tools/apex-memory/src/y.ts'),
    ]);
    expect(readSessionOutcome(f)?.spend.models).toEqual([]);
  });

  it('survives a torn final line, which is normal on a live transcript', () => {
    const f = writeTranscript('torn', [usageMsg('2026-09-09T18:00:00.000Z', { output_tokens: 7 })]);
    fs.appendFileSync(f, '\n{"timestamp":"2026-09-09T18:0', 'utf8');
    expect(readSessionOutcome(f)?.spend.output).toBe(7);
  });

  it('returns null for a transcript that does not exist', () => {
    expect(readSessionOutcome(path.join(tmp, 'nope.jsonl'))).toBeNull();
  });
});

describe('recordOutcome — receipts earn `fact`, and only one row stays live', () => {
  const transcript = () =>
    writeTranscript(`rec-${Math.random().toString(36).slice(2)}`, [
      usageMsg('2026-09-09T18:00:00.000Z', { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 }),
      wroteFile('2026-09-09T19:00:00.000Z', 'C:/Users/LENOVO/tools/apex-memory/src/z.ts'),
    ]);

  it('writes at `fact`, which distill.ts can never do', async () => {
    const store = new MemoryCustodyStore();
    const o = readSessionOutcome(transcript());
    const id = await recordOutcome(store, o!);
    expect(id).not.toBeNull();
    const [row] = await store.list(o!.project);
    expect(row?.authority).toBe('fact');
    expect(row?.sourceKind).toBe('verified-command');
  });

  it('refuses to bank a session that did nothing', async () => {
    const f = writeTranscript('idle', [usageMsg('2026-09-09T18:00:00.000Z', { output_tokens: 5 })]);
    const o = readSessionOutcome(f);
    expect(await recordOutcome(new MemoryCustodyStore(), o!)).toBeNull();
  });

  /** Measured: gating on filesWritten alone banked 10 `unfiled` rows on the first sweep. */
  it('refuses a session whose entire output was temp files', async () => {
    const f = writeTranscript('scratch', [
      usageMsg('2026-09-09T18:00:00.000Z', { output_tokens: 5 }),
      wroteFile('2026-09-09T18:01:00.000Z', 'C:/Users/LENOVO/AppData/Local/Temp/claude/x/scratchpad/a.md'),
    ]);
    const o = readSessionOutcome(f);
    expect(o?.filesWritten.length).toBe(1);
    expect(o?.repos).toHaveLength(0);
    expect(await recordOutcome(new MemoryCustodyStore(), o!)).toBeNull();
  });

  it('skips an unchanged re-fire instead of duplicating the row', async () => {
    const store = new MemoryCustodyStore();
    const o = readSessionOutcome(transcript());
    expect(await recordOutcome(store, o!)).not.toBeNull();
    expect(await recordOutcome(store, o!)).toBeNull();
    expect(await store.list(o!.project)).toHaveLength(1);
  });

  it('supersedes its own earlier row when the spend has changed', async () => {
    const store = new MemoryCustodyStore();
    const o = readSessionOutcome(transcript());
    const first = await recordOutcome(store, o!);

    const grown = { ...o!, spend: { ...o!.spend, output: o!.spend.output + 999 } };
    const second = await recordOutcome(store, grown);

    expect(second).not.toBe(first);
    const rows = await store.list(o!.project);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.supersededBy === null)).toHaveLength(1);
    expect(rows.find((r) => r.id === first)?.supersededBy).toBe(second);
  });
});

describe('readOpenCodeOutcomes — the harness that keeps better books than we do', () => {
  /** A real SQLite file shaped like OpenCode's, not a mock. */
  function makeDb(name: string, session: Record<string, unknown>, parts: unknown[]): string {
    const file = path.join(tmp, `${name}.db`);
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, model TEXT, cost REAL,
      tokens_input INTEGER, tokens_output INTEGER, tokens_cache_read INTEGER,
      tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER)`);
    db.exec('CREATE TABLE part (id TEXT PRIMARY KEY, session_id TEXT, data TEXT)');
    db.prepare(
      `INSERT INTO session VALUES (@id,@title,@model,@cost,@ti,@to,@tcr,@tcw,@tc,@tu)`,
    ).run(session);
    const ins = db.prepare('INSERT INTO part VALUES (?,?,?)');
    parts.forEach((p, i) => ins.run(`prt_${i}`, String(session['id']), JSON.stringify(p)));
    db.close();
    return file;
  }

  const baseSession = {
    id: 'ses_test1',
    title: 'Building apex harness',
    model: JSON.stringify({ id: 'muse-spark-1.3-contributor-free', variant: 'xhigh' }),
    cost: 0,
    ti: 2_219_731,
    to: 152_388,
    tcr: 158_961_570,
    tcw: 0,
    tc: Date.parse('2026-09-09T18:08:49Z'),
    tu: Date.parse('2026-09-10T02:25:17Z'),
  };

  const writePart = (p: string) => ({ type: 'tool', tool: 'write', state: { input: { filePath: p } } });
  const editPart = (p: string) => ({ type: 'tool', tool: 'edit', state: { input: { filePath: p } } });

  it('reads spend straight from the session row instead of summing messages', () => {
    const db = makeDb('oc-spend', baseSession, [
      writePart('C:/Users/LENOVO/tools/apex-memory/src/a.ts'),
    ]);
    const [o] = readOpenCodeOutcomes(0, db);
    expect(o?.spend.input).toBe(2_219_731);
    expect(o?.spend.cacheRead).toBe(158_961_570);
    expect(o?.costUsd).toBe(0);
    expect(o?.title).toBe('Building apex harness');
  });

  it('unwraps the model JSON blob into an id, because that column is not a string', () => {
    const db = makeDb('oc-model', baseSession, [writePart('C:/Users/LENOVO/tools/apex-memory/b.ts')]);
    expect(readOpenCodeOutcomes(0, db)[0]?.spend.models).toEqual([
      'muse-spark-1.3-contributor-free:xhigh',
    ]);
  });

  it('counts write and edit tools, and ignores read/grep/bash', () => {
    const db = makeDb('oc-tools', baseSession, [
      writePart('C:/Users/LENOVO/tools/apex-memory/a.ts'),
      editPart('C:/Users/LENOVO/tools/apex-memory/b.ts'),
      { type: 'tool', tool: 'read', state: { input: { filePath: 'C:/Users/LENOVO/tools/x/c.ts' } } },
      { type: 'tool', tool: 'bash', state: { input: { command: 'ls' } } },
      { type: 'text', text: 'hello' },
    ]);
    const [o] = readOpenCodeOutcomes(0, db);
    expect(o?.filesWritten).toHaveLength(2);
  });

  /**
   * The trap that makes this worth testing: session.directory reads
   * `...\Programs\Warp` for work that landed in kimi-apex. Never file by that column.
   */
  it('files by where the work landed, never by the session directory', () => {
    const db = makeDb('oc-project', baseSession, [
      writePart('C:/Users/LENOVO/tools/sauce-scan/a.mjs'),
      writePart('C:/Users/LENOVO/tools/apex-memory/a.ts'),
      writePart('C:/Users/LENOVO/tools/apex-memory/b.ts'),
    ]);
    expect(readOpenCodeOutcomes(0, db)[0]?.project).toBe('apex-memory');
  });

  it('skips sessions that wrote no files, and honours the since bound', () => {
    const chat = makeDb('oc-chat', { ...baseSession, id: 'ses_chat' }, [{ type: 'text', text: 'hi' }]);
    expect(readOpenCodeOutcomes(0, chat)).toHaveLength(0);

    const db = makeDb('oc-since', baseSession, [writePart('C:/Users/LENOVO/tools/apex-memory/a.ts')]);
    expect(readOpenCodeOutcomes(Date.parse('2026-12-01T00:00:00Z'), db)).toHaveLength(0);
  });

  it('returns nothing rather than throwing when the database is absent', () => {
    expect(readOpenCodeOutcomes(0, path.join(tmp, 'no-such.db'))).toEqual([]);
  });

  it('banks an OpenCode outcome at `fact` with a cost line', async () => {
    const db = makeDb('oc-bank', baseSession, [writePart('C:/Users/LENOVO/tools/apex-memory/a.ts')]);
    const store = new MemoryCustodyStore();
    const [o] = readOpenCodeOutcomes(0, db);
    expect(await recordOutcome(store, o!)).not.toBeNull();
    const [row] = await store.list('apex-memory');
    expect(row?.authority).toBe('fact');
    expect(row?.text).toContain('cost $0.0000');
    expect(row?.text).toContain('Building apex harness');
  });
});

describe('renderReceipt — the sourceText the gate digests', () => {
  it('carries the quote verbatim, or the custody gate would refuse the write', () => {
    const f = writeTranscript('receipt', [
      usageMsg('2026-09-09T18:00:00.000Z', { input_tokens: 1, output_tokens: 2 }),
      wroteFile('2026-09-09T19:00:00.000Z', 'C:/Users/LENOVO/tools/apex-memory/src/q.ts'),
    ]);
    const o = readSessionOutcome(f)!;
    const receipt = renderReceipt(o);
    expect(receipt).toContain('tokens in=1 out=2');
    expect(receipt).toContain('repos touched apex-memory(1)');
  });
});
