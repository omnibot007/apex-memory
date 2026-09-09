import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { compactProject, planCompaction } from '../src/compaction.js';
import { recallInForce, record, supersede } from '../src/custody.js';
import { JsonlCustodyStore, MemoryCustodyStore } from '../src/store.js';
import type { CustodyRequest } from '../src/types.js';

const SOURCE = 'the operator said: always branch before committing to main';

function req(overrides: Partial<CustodyRequest> = {}): CustodyRequest {
  return {
    project: 'apex',
    kind: 'decision',
    text: 'always branch before committing to main',
    quote: 'always branch before committing to main',
    sourceText: SOURCE,
    sourceKind: 'user-decision',
    claimedAuthority: 'policy',
    sourceLocator: 'session:abc#12',
    sourceSession: 'abc',
    validFromMs: 1_000,
    recordedAtMs: 1_000,
    ...overrides,
  };
}

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-memory-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('compaction', () => {
  it('never evicts a policy fact, even over budget', async () => {
    const store = new MemoryCustodyStore();
    for (let i = 0; i < 5; i += 1) {
      await record(store, req({ text: `policy ${i}`, sourceLocator: `loc:${i}` }));
    }
    const report = await compactProject(store, 'apex', { nowMs: 10_000, maxLiveRows: 1 });
    expect(report.budgetArchived).toBe(0);
    expect(report.policiesProtected).toBe(5);
    expect(await recallInForce(store, 'apex')).toHaveLength(5);
  });

  it('evicts weakest-and-oldest first when over budget', async () => {
    const store = new MemoryCustodyStore();
    await record(store, req({ text: 'keep me', sourceLocator: 'a' }));
    await record(
      store,
      req({
        text: 'weak old',
        sourceKind: 'code-read',
        claimedAuthority: 'observation',
        sourceLocator: 'b',
        validFromMs: 1_000,
        recordedAtMs: 1_000,
      }),
    );
    await record(
      store,
      req({
        text: 'strong new',
        sourceKind: 'verified-command',
        claimedAuthority: 'fact',
        sourceLocator: 'c',
        validFromMs: 9_000,
        recordedAtMs: 9_000,
      }),
    );
    const report = await compactProject(store, 'apex', { nowMs: 20_000, maxLiveRows: 2 });
    expect(report.budgetArchived).toBe(1);
    const live = (await recallInForce(store, 'apex')).map((r) => r.text);
    expect(live).toContain('keep me');
    expect(live).toContain('strong new');
    expect(live).not.toContain('weak old');
  });

  it('archives duplicates but keeps the earliest', async () => {
    const store = new MemoryCustodyStore();
    await record(
      store,
      req({
        text: 'dupe',
        sourceKind: 'code-read',
        claimedAuthority: 'observation',
        recordedAtMs: 1_000,
      }),
    );
    await record(
      store,
      req({
        text: 'Dupe  ',
        sourceKind: 'code-read',
        claimedAuthority: 'observation',
        recordedAtMs: 2_000,
      }),
    );
    const report = await compactProject(store, 'apex', { nowMs: 5_000 });
    expect(report.duplicatesArchived).toBe(1);
    const live = await recallInForce(store, 'apex');
    expect(live).toHaveLength(1);
    expect(live[0]?.recordedAtMs).toBe(1_000);
  });

  it('archives superseded rows only once they are old enough', async () => {
    const store = new MemoryCustodyStore();
    const old = await record(store, req({ text: 'v1', sourceLocator: 'a' }));
    const next = await record(
      store,
      req({ text: 'v2', sourceLocator: 'b', validFromMs: 2_000, recordedAtMs: 2_000 }),
    );
    await supersede(store, 'apex', old.id, next.id, 2_000);

    const early = await compactProject(store, 'apex', {
      nowMs: 2_500,
      archiveSupersededAfterMs: 1_000,
      dryRun: true,
    });
    expect(early.supersededArchived).toBe(0);

    const later = await compactProject(store, 'apex', {
      nowMs: 9_000,
      archiveSupersededAfterMs: 1_000,
    });
    expect(later.supersededArchived).toBe(1);
  });

  it('dry run reports without mutating', async () => {
    const store = new MemoryCustodyStore();
    await record(
      store,
      req({ text: 'x', sourceKind: 'code-read', claimedAuthority: 'observation', sourceLocator: 'a' }),
    );
    await record(
      store,
      req({ text: 'y', sourceKind: 'code-read', claimedAuthority: 'observation', sourceLocator: 'b' }),
    );
    const report = await compactProject(store, 'apex', {
      nowMs: 5_000,
      maxLiveRows: 1,
      dryRun: true,
    });
    expect(report.dryRun).toBe(true);
    expect(report.budgetArchived).toBe(1);
    expect(await recallInForce(store, 'apex')).toHaveLength(2);
  });

  it('does not destroy sibling projects when compacting one', async () => {
    const store = new MemoryCustodyStore();
    await record(store, req({ project: 'apex', text: 'mine' }));
    await record(store, req({ project: 'other', text: 'theirs' }));
    await compactProject(store, 'apex', { nowMs: 5_000, maxLiveRows: 0 });
    expect((await recallInForce(store, 'other')).map((r) => r.text)).toEqual(['theirs']);
  });

  it('planCompaction is pure', () => {
    const { report } = planCompaction([], { nowMs: 1 });
    expect(report.scanned).toBe(0);
    expect(report.liveAfter).toBe(0);
  });
});

describe('jsonl store', () => {
  it('round-trips through an append-only log and survives junk lines', async () => {
    const dir = tmpDir();
    const store = new JsonlCustodyStore(dir);
    const saved = await record(store, req({ text: 'durable' }));
    fs.appendFileSync(store.path, 'not json at all\n', 'utf8');

    const reopened = new JsonlCustodyStore(dir);
    expect((await reopened.get(saved.id))?.text).toBe('durable');
    expect(await reopened.list('apex')).toHaveLength(1);
    expect(await reopened.allProjects()).toEqual(['apex']);
  });

  it('last write wins per id, so supersession is just another append', async () => {
    const dir = tmpDir();
    const store = new JsonlCustodyStore(dir);
    const a = await record(store, req({ text: 'v1', sourceLocator: 'a' }));
    const b = await record(
      store,
      req({ text: 'v2', sourceLocator: 'b', validFromMs: 2_000, recordedAtMs: 2_000 }),
    );
    await supersede(store, 'apex', a.id, b.id, 3_000);

    const reopened = new JsonlCustodyStore(dir);
    expect((await reopened.get(a.id))?.supersededBy).toBe(b.id);
    expect((await recallInForce(reopened, 'apex')).map((r) => r.text)).toEqual(['v2']);
  });

  it('returns empty for a store that does not exist yet', async () => {
    const store = new JsonlCustodyStore(path.join(tmpDir(), 'nope'));
    expect(await store.list('apex')).toEqual([]);
  });
});
