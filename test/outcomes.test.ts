import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { readSessionOutcome, rankRepos, recordOutcome, renderReceipt } from '../src/outcomes.js';
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
