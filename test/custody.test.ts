import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  admitCustody,
  corroborationOf,
  countInForce,
  CustodyRefusedError,
  isCorroborating,
  recallInForce,
  record,
  sourceCeiling,
  supersede,
} from '../src/custody.js';
import { MemoryCustodyStore } from '../src/store.js';
import { DEFAULT_RECALL_LIMIT } from '../src/types.js';
import type { Authority, CustodyRequest, SourceKind } from '../src/types.js';

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

describe('ceilings', () => {
  it('maps every source kind to its ceiling', () => {
    const table: Array<[SourceKind, Authority]> = [
      ['user-decision', 'policy'],
      ['verified-command', 'fact'],
      ['code-read', 'observation'],
      ['assistant-claim', 'conjecture'],
      ['repo-content', 'conjecture'],
    ];
    for (const [kind, ceiling] of table) expect(sourceCeiling(kind)).toBe(ceiling);
  });

  it('refuses an assistant claim promoted to fact', () => {
    const verdict = admitCustody(req({ sourceKind: 'assistant-claim', claimedAuthority: 'fact' }));
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) {
      expect(verdict.denial).toBe('authority-exceeds-source');
      expect(verdict.ceiling).toBe('conjecture');
    }
  });

  it('refuses repository content promoted to policy', () => {
    const verdict = admitCustody(req({ sourceKind: 'repo-content', claimedAuthority: 'policy' }));
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.denial).toBe('authority-exceeds-source');
  });

  it('admits at or below the ceiling', () => {
    expect(admitCustody(req()).admitted).toBe(true);
    expect(
      admitCustody(req({ sourceKind: 'assistant-claim', claimedAuthority: 'conjecture' })).admitted,
    ).toBe(true);
  });
});

describe('provenance is computed, never claimed', () => {
  it('rejects a quote absent from the retained source', () => {
    const verdict = admitCustody(req({ quote: 'never branch, push straight to main' }));
    expect(verdict.admitted).toBe(false);
    if (!verdict.admitted) expect(verdict.denial).toBe('quote-not-in-source');
  });

  it('derives digests from the source itself', () => {
    const verdict = admitCustody(req());
    expect(verdict.admitted).toBe(true);
    if (verdict.admitted) {
      expect(verdict.sourceDigest).toBe(createHash('sha256').update(SOURCE, 'utf8').digest('hex'));
      expect(verdict.sourceDigest).not.toBe(verdict.quoteDigest);
    }
  });

  it('refuses malformed input across every guard', () => {
    const bad = [
      req({ project: ' ' }),
      req({ text: '  ' }),
      req({ quote: '  ' }),
      req({ sourceText: '' }),
      req({ sourceLocator: '' }),
      req({ validFromMs: 5_000, recordedAtMs: 1_000 }),
      req({ kind: 'gossip' as never }),
      req({ sourceKind: 'hearsay' as never }),
      req({ claimedAuthority: 'gospel' as never }),
    ];
    for (const request of bad) expect(admitCustody(request).admitted).toBe(false);
  });
});

describe('corroboration weighting (v2 fix)', () => {
  it('knows which sources can corroborate', () => {
    expect(isCorroborating('user-decision')).toBe(true);
    expect(isCorroborating('verified-command')).toBe(true);
    expect(isCorroborating('code-read')).toBe(true);
    expect(isCorroborating('assistant-claim')).toBe(false);
    expect(isCorroborating('repo-content')).toBe(false);
  });

  it('two assistant claims never corroborate each other', async () => {
    const store = new MemoryCustodyStore();
    for (const locator of ['turn:1', 'turn:2']) {
      await record(
        store,
        req({
          text: 'the cache is write-through',
          sourceKind: 'assistant-claim',
          claimedAuthority: 'conjecture',
          sourceLocator: locator,
        }),
      );
    }
    const rows = await recallInForce(store, 'apex', {
      minAuthority: 'conjecture',
      requireCorroboration: true,
    });
    expect(rows).toEqual([]);
  });

  it('two independent non-conjecture sources do corroborate', async () => {
    const store = new MemoryCustodyStore();
    await record(store, req({ text: 'shared claim', sourceLocator: 'session:a#1' }));
    await record(
      store,
      req({
        text: 'Shared   Claim',
        sourceKind: 'verified-command',
        claimedAuthority: 'fact',
        sourceLocator: 'session:b#2',
      }),
    );
    const rows = await recallInForce(store, 'apex', { requireCorroboration: true });
    expect(rows).toHaveLength(2);
  });

  it('counts distinct locators only', () => {
    const base = {
      id: 'x',
      project: 'p',
      kind: 'fact' as const,
      text: 't',
      quote: 'q',
      authority: 'fact' as const,
      sourceDigest: 'd',
      quoteDigest: 'q',
      sourceSession: 's',
      validFromMs: 1,
      recordedAtMs: 1,
      supersededBy: null,
      supersededAtMs: null,
      archivedAtMs: null,
    };
    const same = [
      { ...base, sourceKind: 'verified-command' as const, sourceLocator: 'same' },
      { ...base, sourceKind: 'verified-command' as const, sourceLocator: 'same' },
    ];
    expect(corroborationOf(same)).toBe(1);
  });
});

describe('store lifecycle', () => {
  it('throws a typed error on refusal and writes nothing', async () => {
    const store = new MemoryCustodyStore();
    await expect(
      record(store, req({ sourceKind: 'repo-content', claimedAuthority: 'policy' })),
    ).rejects.toBeInstanceOf(CustodyRefusedError);
    expect(await store.listAll()).toHaveLength(0);
  });

  it('supersedes without deleting', async () => {
    const store = new MemoryCustodyStore();
    const old = await record(store, req());
    const next = await record(store, req({ text: 'branch then open a pr', quote: 'always branch', validFromMs: 2_000, recordedAtMs: 2_000 }));
    expect(await supersede(store, 'apex', old.id, next.id, 2_000)).toBe(true);
    expect(await supersede(store, 'apex', old.id, next.id, 2_000)).toBe(false);
    expect(await supersede(store, 'wrong', next.id, old.id, 3_000)).toBe(false);
    expect(await store.get(old.id)).toBeDefined();
    expect((await recallInForce(store, 'apex')).map((r) => r.id)).toEqual([next.id]);
  });

  it('honours point-in-time, authority floor, project isolation and limit', async () => {
    const store = new MemoryCustodyStore();
    await record(store, req({ text: 'early', validFromMs: 1_000, recordedAtMs: 1_000 }));
    await record(store, req({ text: 'late', validFromMs: 9_000, recordedAtMs: 9_000 }));
    await record(store, req({ project: 'other', text: 'elsewhere' }));
    await record(
      store,
      req({ text: 'a guess', sourceKind: 'assistant-claim', claimedAuthority: 'conjecture' }),
    );

    expect((await recallInForce(store, 'apex', { asOfMs: 5_000 })).map((r) => r.text)).toEqual([
      'early',
    ]);
    expect((await recallInForce(store, 'apex')).map((r) => r.text)).not.toContain('a guess');
    expect((await recallInForce(store, 'other')).map((r) => r.text)).toEqual(['elsewhere']);
    expect(await recallInForce(store, 'apex', { limit: 1 })).toHaveLength(1);
  });
});

describe('recall paging', () => {
  /** 120 rows: more than DEFAULT_RECALL_LIMIT, so the default page cannot be the whole truth. */
  async function seeded(): Promise<MemoryCustodyStore> {
    const store = new MemoryCustodyStore();
    for (let i = 0; i < 120; i++) {
      await record(store, req({ text: `row ${i}`, validFromMs: 1_000 + i, recordedAtMs: 1_000 + i }));
    }
    return store;
  }

  it('defaults to DEFAULT_RECALL_LIMIT and reports the true total separately', async () => {
    const store = await seeded();
    expect(DEFAULT_RECALL_LIMIT).toBe(50);
    expect(await recallInForce(store, 'apex')).toHaveLength(DEFAULT_RECALL_LIMIT);
    // The defect this guards: a 50-row page used to be indistinguishable from 50 rows total.
    expect(await countInForce(store, 'apex')).toBe(120);
  });

  it('pages the whole project without gaps, overlaps or drops', async () => {
    const store = await seeded();
    const total = await countInForce(store, 'apex');
    const seen: string[] = [];
    for (let offset = 0; offset < total; offset += 25) {
      const page = await recallInForce(store, 'apex', { limit: 25, offset });
      // full pages until the tail, which is the remainder — 120 / 25 leaves 20
      expect(page).toHaveLength(Math.min(25, total - offset));
      seen.push(...page.map((r) => r.text));
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
    // newest-first ordering survives paging
    expect(seen[0]).toBe('row 119');
    expect(seen.at(-1)).toBe('row 0');
  });

  it('returns empty past the end rather than wrapping', async () => {
    const store = await seeded();
    expect(await recallInForce(store, 'apex', { offset: 120 })).toHaveLength(0);
    expect(await recallInForce(store, 'apex', { offset: 500 })).toHaveLength(0);
  });

  it('ignores a negative or fractional offset instead of mis-slicing', async () => {
    const store = await seeded();
    const head = (await recallInForce(store, 'apex', { limit: 3 })).map((r) => r.text);
    expect((await recallInForce(store, 'apex', { limit: 3, offset: -10 })).map((r) => r.text)).toEqual(head);
    expect((await recallInForce(store, 'apex', { limit: 3, offset: 0.9 })).map((r) => r.text)).toEqual(head);
  });

  it('counts what the SAME options would return, not the unfiltered project', async () => {
    const store = new MemoryCustodyStore();
    await record(store, req({ text: 'hard fact' }));
    await record(
      store,
      req({ text: 'a guess', sourceKind: 'assistant-claim', claimedAuthority: 'conjecture' }),
    );
    expect(await countInForce(store, 'apex')).toBe(1);
    expect(await countInForce(store, 'apex', { minAuthority: 'conjecture' })).toBe(2);
  });
});

describe('recall query — the search clone (Phase 2)', () => {
  async function seeded() {
    const store = new MemoryCustodyStore();
    await record(store, req({ text: 'the Nero clips channel has 98 videos', quote: 'always branch', validFromMs: 3_000, recordedAtMs: 3_000 }));
    await record(store, req({ text: 'the Nero main channel has 480 videos', quote: 'always branch', validFromMs: 2_000, recordedAtMs: 2_000 }));
    await record(store, req({ text: 'TranscriptAPI is the paid second barrel', quote: 'always branch', validFromMs: 1_000, recordedAtMs: 1_000, sourceLocator: 'opencode:ses_f76b#p1' }));
    return store;
  }

  it('finds rows by a single term, case insensitively', async () => {
    const store = await seeded();
    expect((await recallInForce(store, 'apex', { query: 'nero' })).length).toBe(2);
    expect((await recallInForce(store, 'apex', { query: 'NERO' })).length).toBe(2);
    expect((await recallInForce(store, 'apex', { query: 'transcriptapi' })).length).toBe(1);
  });

  it('ANDs multiple terms rather than ORing them', async () => {
    const store = await seeded();
    expect((await recallInForce(store, 'apex', { query: 'nero clips' })).length).toBe(1);
    expect((await recallInForce(store, 'apex', { query: 'nero 480' })).length).toBe(1);
    // both terms exist in the store but never in the same row
    expect((await recallInForce(store, 'apex', { query: 'clips 480' })).length).toBe(0);
  });

  it('searches the locator too, so a session can be interrogated', async () => {
    const store = await seeded();
    expect((await recallInForce(store, 'apex', { query: 'ses_f76b' })).length).toBe(1);
  });

  it('treats an absent or blank query as no filter', async () => {
    const store = await seeded();
    const all = (await recallInForce(store, 'apex')).length;
    expect((await recallInForce(store, 'apex', { query: '' })).length).toBe(all);
    expect((await recallInForce(store, 'apex', { query: '   ' })).length).toBe(all);
  });

  it('counts and pages the FILTERED set, not the whole project', async () => {
    const store = await seeded();
    expect(await countInForce(store, 'apex', { query: 'nero' })).toBe(2);
    expect(await countInForce(store, 'apex')).toBe(3);
    const page = await recallInForce(store, 'apex', { query: 'nero', limit: 1 });
    expect(page).toHaveLength(1);
    // newest-first survives filtering
    expect(page[0]?.text).toContain('clips');
    expect((await recallInForce(store, 'apex', { query: 'nero', limit: 1, offset: 1 }))[0]?.text).toContain('main');
  });

  it('returns nothing for a term no row contains — never a near miss', async () => {
    const store = await seeded();
    expect(await recallInForce(store, 'apex', { query: 'kubernetes' })).toEqual([]);
  });

  it('respects the authority floor while searching', async () => {
    const store = new MemoryCustodyStore();
    await record(store, req({ text: 'nero guess', sourceKind: 'assistant-claim', claimedAuthority: 'conjecture' }));
    expect(await recallInForce(store, 'apex', { query: 'nero' })).toEqual([]);
    expect((await recallInForce(store, 'apex', { query: 'nero', minAuthority: 'conjecture' })).length).toBe(1);
  });
});