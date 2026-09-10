import { describe, expect, it } from 'vitest';

import { record, supersede } from '../src/custody.js';
import { MANIFEST_DEFAULTS, memoryManifest, projectCounts } from '../src/manifest.js';
import { MemoryCustodyStore } from '../src/store.js';
import type { CustodyRequest } from '../src/types.js';

const SOURCE = 'the operator said: always branch before committing to main, and $ npm test -> 71 passed';

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

/** A verified-command row, which the gate admits at `fact`. */
function factReq(overrides: Partial<CustodyRequest> = {}): CustodyRequest {
  return req({
    kind: 'fact',
    text: '71 passed',
    quote: '71 passed',
    sourceKind: 'verified-command',
    claimedAuthority: 'fact',
    ...overrides,
  });
}

describe('memory manifest', () => {
  it('injects nothing at all for an empty store', async () => {
    expect(await memoryManifest(new MemoryCustodyStore())).toBe('');
  });

  it('injects nothing when every row is superseded', async () => {
    const store = new MemoryCustodyStore();
    const old = await record(store, req());
    const next = await record(store, req({ validFromMs: 2_000, recordedAtMs: 2_000 }));
    await supersede(store, 'apex', old.id, next.id, 2_000);
    await supersede(store, 'apex', next.id, old.id, 3_000);
    expect(await projectCounts(store)).toEqual([]);
    expect(await memoryManifest(store)).toBe('');
  });

  it('names every project with its in-force count, richest first', async () => {
    const store = new MemoryCustodyStore();
    await record(store, factReq({ project: 'yt-wire' }));
    await record(store, factReq({ project: 'yt-wire', validFromMs: 1_100, recordedAtMs: 1_100 }));
    await record(store, factReq({ project: 'xau-bot' }));

    expect(await projectCounts(store)).toEqual([
      ['yt-wire', 2],
      ['xau-bot', 1],
    ]);
    const block = await memoryManifest(store);
    expect(block).toContain('3 facts in force across 2 projects');
    expect(block).toContain('yt-wire 2 · xau-bot 1');
  });

  it('advertises counts that match what recall would actually return', async () => {
    const store = new MemoryCustodyStore();
    await record(store, factReq({ project: 'p' }));
    // a conjecture row is below the recall floor, so it must NOT be advertised
    await record(
      store,
      req({
        project: 'p',
        text: 'a guess',
        sourceKind: 'assistant-claim',
        claimedAuthority: 'conjecture',
      }),
    );
    expect(await projectCounts(store)).toEqual([['p', 1]]);
    expect(await memoryManifest(store)).toContain('1 facts in force across 1 projects');
  });

  it('separates policy from verified facts', async () => {
    const store = new MemoryCustodyStore();
    await record(store, req({ project: 'doctrine' }));
    await record(store, factReq({ project: 'build' }));
    const block = await memoryManifest(store);
    expect(block).toContain('POLICY');
    expect(block).toContain('[doctrine] always branch before committing to main');
    expect(block).toContain('NEWEST VERIFIED FACT PER PROJECT');
    expect(block).toContain('[build] 71 passed');
  });

  it('shows breadth, not one busy project — at most one fact per project', async () => {
    const store = new MemoryCustodyStore();
    // `loud` gets 10 of the newest rows; `quiet` gets one older row.
    await record(store, factReq({ project: 'quiet', text: 'quiet fact', validFromMs: 500, recordedAtMs: 500 }));
    for (let i = 0; i < 10; i++) {
      await record(
        store,
        factReq({ project: 'loud', text: `loud ${i}`, validFromMs: 9_000 + i, recordedAtMs: 9_000 + i }),
      );
    }
    const block = await memoryManifest(store);
    const factLines = block
      .slice(block.indexOf('NEWEST VERIFIED FACT PER PROJECT'))
      .split('\n')
      .filter((l) => l.startsWith('  · '));
    expect(factLines.filter((l) => l.includes('[loud]'))).toHaveLength(1);
    // pure recency ordering would have buried this entirely
    expect(factLines.filter((l) => l.includes('[quiet]'))).toHaveLength(1);
  });

  it('collapses the project list past maxProjects instead of running long', async () => {
    const store = new MemoryCustodyStore();
    for (let i = 0; i < 20; i++) {
      await record(store, factReq({ project: `p${i}`, validFromMs: 1_000 + i, recordedAtMs: 1_000 + i }));
    }
    const block = await memoryManifest(store, { maxProjects: 5 });
    expect(block).toContain('(+15 more projects)');
    expect(block).toContain('20 facts in force across 20 projects');
  });

  it('respects the char budget and says it trimmed', async () => {
    const store = new MemoryCustodyStore();
    for (let i = 0; i < 30; i++) {
      await record(
        store,
        factReq({ project: `project-with-a-long-name-${i}`, validFromMs: 1_000 + i, recordedAtMs: 1_000 + i }),
      );
    }
    const block = await memoryManifest(store, { maxChars: 400 });
    expect(block).toContain('trimmed to fit 400 chars');
    // and it must trim on line boundaries, never mid-claim
    for (const line of block.split('\n')) {
      if (line.startsWith('  · ')) expect(line).toMatch(/^ {2}· \[[^\]]+\] .+$/);
    }
  });

  it('keeps the default budget small enough to sit beside the 6000-char STATE.md cap', async () => {
    expect(MANIFEST_DEFAULTS.maxChars).toBeLessThanOrEqual(2500);
  });

  it('flattens multi-line claims so one row cannot eat the block', async () => {
    const store = new MemoryCustodyStore();
    await record(
      store,
      factReq({ project: 'p', text: 'line one\n\n   line two\tline three', quote: '71 passed' }),
    );
    const block = await memoryManifest(store);
    expect(block).toContain('line one line two line three');
    expect(block).not.toContain('line one\n');
  });
});
