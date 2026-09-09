import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  admitCustody,
  corroborationOf,
  CustodyRefusedError,
  isCorroborating,
  recallInForce,
  record,
  sourceCeiling,
  supersede,
} from '../src/custody.js';
import { MemoryCustodyStore } from '../src/store.js';
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
