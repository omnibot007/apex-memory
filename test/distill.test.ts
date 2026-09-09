import { describe, expect, it } from 'vitest';

import { decisionsFrom, distill, MAX_UTTERANCE_CHARS } from '../src/distill.js';
import { MemoryCustodyStore } from '../src/store.js';
import { recallInForce } from '../src/custody.js';
import type { Utterance } from '../src/readers.js';

function utter(text: string, over: Partial<Utterance> = {}): Utterance {
  return {
    text,
    atMs: 1_000,
    locator: 'test:1#1',
    project: 'p',
    session: 's',
    harness: 'test',
    ...over,
  };
}

describe('decisionsFrom — accepts real standing instructions', () => {
  it('captures explicit standing rules', () => {
    expect(decisionsFrom('Always branch before committing to main.')).toHaveLength(1);
    expect(decisionsFrom('From now on use pnpm rather than npm here.')).toHaveLength(1);
    expect(decisionsFrom('Make sure every change ships with tests.')).toHaveLength(1);
  });
});

/**
 * Every case below was produced by an EARLIER marker set against real transcripts.
 * They are regressions, not hypotheticals. Loosening a rule that lets one of these back
 * in will fail here, which is the point.
 */
describe('decisionsFrom — measured false positives stay rejected', () => {
  const rejected: Array<[string, string]> = [
    ['never mind', 'Actually never mind lets finish building the sub agents'],
    ['past-tense narrative', '`yt-scrape --visual` had never run end to end.'],
    ['past-tense narrative 2', 'The endpoint never returned, even for a small model.'],
    ['task framing', 'I want you to make ten input delay tweaks for fortnite.'],
    ['question', 'are there any tests we can do that we dont have to reboot for?'],
    ['list item', '- L3 NEVER-DONE-BEFORE: subtractive router with a kill test'],
    ['slash command', 'So what i want you to do is /sauce it up and make sure it works'],
    ['markdown paste', 'The extractor **always** expands domain shorthand on its own.'],
    ['code span', 'Note that `igl/errors.py` is stale and should never be imported.'],
    ['url', 'See https://example.com/docs which says you should always cache.'],
    ['trailing colon', 'Verify the session file exists, and do not print its contents:'],
    ['complaint', 'I didnt ask for all this, i dont care about the extra output.'],
    ['harness injection', 'Answer ONLY from injected context, do not use tools.'],
    ['limit resumption', 'Continue the task you were working on when the limit was reached.'],
    ['can you', 'Can you make sure the tests always run before the push?'],
  ];

  for (const [label, sentence] of rejected) {
    it(`rejects ${label}`, () => {
      expect(decisionsFrom(sentence)).toEqual([]);
    });
  }

  it('ignores long pastes wholesale', () => {
    const paste = `${'x'.repeat(MAX_UTTERANCE_CHARS)} Always branch before committing.`;
    expect(decisionsFrom(paste)).toEqual([]);
  });
});

describe('distill', () => {
  it('writes at observation authority, never policy, by default', async () => {
    const store = new MemoryCustodyStore();
    const report = await distill(store, [utter('Always branch before committing to main.')]);
    expect(report.written).toBe(1);
    const rows = await recallInForce(store, 'p', { minAuthority: 'conjecture' });
    expect(rows[0]?.authority).toBe('observation');
    expect(rows[0]?.sourceKind).toBe('user-decision');
  });

  it('is idempotent — a second sweep writes nothing', async () => {
    const store = new MemoryCustodyStore();
    const input = [utter('Always branch before committing to main.')];
    await distill(store, input);
    const second = await distill(store, input);
    expect(second.written).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
  });

  it('dry run reports without writing', async () => {
    const store = new MemoryCustodyStore();
    const report = await distill(store, [utter('Never push straight to main.')], { dryRun: true });
    expect(report.written).toBe(1);
    expect(report.dryRun).toBe(true);
    expect(await store.listAll()).toHaveLength(0);
  });

  it('honours an explicit policy authority and counts per harness', async () => {
    const store = new MemoryCustodyStore();
    const report = await distill(
      store,
      [
        utter('Always branch before committing to main.', { harness: 'claude' }),
        utter('Never cap the frame rate.', { harness: 'opencode', locator: 'oc:1#1' }),
      ],
      { authority: 'policy' },
    );
    expect(report.byHarness).toEqual({ claude: 1, opencode: 1 });
    const rows = await recallInForce(store, 'p', { minAuthority: 'policy' });
    expect(rows).toHaveLength(2);
  });

  it('respects sinceMs', async () => {
    const store = new MemoryCustodyStore();
    const report = await distill(store, [utter('Always branch first.', { atMs: 500 })], {
      sinceMs: 1_000,
    });
    expect(report.written).toBe(0);
  });
});
