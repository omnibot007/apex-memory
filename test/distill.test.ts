import { beforeEach, describe, expect, it } from 'vitest';

import { decisionsFrom, distill, MAX_UTTERANCE_CHARS } from '../src/distill.js';
import { MemoryCustodyStore } from '../src/store.js';
import { recallInForce, supersede } from '../src/custody.js';
import { projectOf, resetProjectCache, UNATTRIBUTED } from '../src/readers.js';
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
    ['credential scaffolding', 'Your API key is in the AGENTMAIL_API_KEY environment variable; never log it.'],
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

/**
 * THE REGRESSION SUITE FOR 2026-09-10.
 *
 * Dedupe used to be keyed per project. Re-filing 91 rows onto their real projects emptied
 * the `Warp` bucket, the next sweep matched nothing, and all 91 were written again under the
 * cwd-derived name -- 71 claims ended up filed under two projects at once. Identity is now
 * (locator, claim), which is a property of the SOURCE, not of where a row was later filed.
 */
describe('distill idempotence survives re-filing (the duplication bug)', () => {
  const u = utter('Always branch before committing to main.', {
    locator: 'opencode:ses_abc#prt_1',
    project: 'Warp',
  });

  it('writes once, then never again on a re-sweep', async () => {
    const store = new MemoryCustodyStore();
    expect((await distill(store, [u])).written).toBe(1);
    expect((await distill(store, [u])).written).toBe(0);
    expect((await distill(store, [u])).skippedDuplicate).toBe(1);
  });

  it('does NOT re-write a claim after its row is re-filed to another project', async () => {
    const store = new MemoryCustodyStore();
    await distill(store, [u]);
    const [row] = await store.listAll();
    expect(row).toBeDefined();

    // exactly what refile.ps1 did: change project, touch nothing else
    await store.put({ ...row!, project: 'yt-wire' });

    const again = await distill(store, [u]);
    expect(again.written).toBe(0);
    expect(again.skippedDuplicate).toBe(1);

    const all = await store.listAll();
    expect(all).toHaveLength(1);
    expect(all.map((r) => r.project)).toEqual(['yt-wire']);
  });

  it('does not resurrect a claim that was superseded by hand', async () => {
    const store = new MemoryCustodyStore();
    await distill(store, [u]);
    const [row] = await store.listAll();
    const replacement = await store.get(row!.id);
    await supersede(store, row!.project, row!.id, `${replacement!.id}-next`, 5_000);
    expect((await distill(store, [u])).written).toBe(0);
  });

  it('keeps two different utterances that happen to say the same thing', async () => {
    const store = new MemoryCustodyStore();
    const a = utter('Always branch before committing to main.', { locator: 'opencode:s1#p1', project: 'one' });
    const b = utter('Always branch before committing to main.', { locator: 'opencode:s2#p2', project: 'two' });
    expect((await distill(store, [a, b])).written).toBe(2);
    expect((await distill(store, [a, b])).written).toBe(0);
  });
});

describe('projectOf — a project name comes from a repo, never from the cwd basename', () => {
  const home = 'C:\\Users\\LENOVO';
  /** Only these paths hold a repo marker. */
  const repoAt = (roots: string[]) => (p: string) =>
    roots.some((r) => p === `${r}\\.git` || p === `${r}\\package.json`);

  beforeEach(() => resetProjectCache());

  it('walks UP to the repo root instead of naming the leaf directory', () => {
    const exists = repoAt(['C:\\Users\\LENOVO\\tools\\apex-memory']);
    expect(projectOf('C:\\Users\\LENOVO\\tools\\apex-memory\\src', exists, home)).toBe('apex-memory');
    expect(projectOf('C:\\Users\\LENOVO\\tools\\apex-memory', exists, home)).toBe('apex-memory');
  });

  it('refuses the two directories that caused the incident', () => {
    const exists = repoAt([]);
    // a program directory -- was filed as `Warp`, 69 rows
    expect(projectOf('C:\\Users\\LENOVO\\AppData\\Local\\Programs\\Warp', exists, home)).toBe(UNATTRIBUTED);
    // the home directory -- was filed as `LENOVO`, 22 rows
    expect(projectOf(home, exists, home)).toBe(UNATTRIBUTED);
  });

  it('never names the home directory a project even when it holds a repo marker', () => {
    expect(projectOf(home, repoAt([home]), home)).toBe(UNATTRIBUTED);
  });

  it('returns unattributed for empty, missing, or repo-less directories', () => {
    const exists = repoAt([]);
    expect(projectOf(undefined, exists, home)).toBe(UNATTRIBUTED);
    expect(projectOf('', exists, home)).toBe(UNATTRIBUTED);
    expect(projectOf('   ', exists, home)).toBe(UNATTRIBUTED);
    expect(projectOf('C:\\Users\\LENOVO\\some\\random\\folder', exists, home)).toBe(UNATTRIBUTED);
  });

  it('skips generic leaf names and takes the enclosing repo', () => {
    // build output inside a repo: the answer is the repo, not `dist`
    expect(projectOf('C:\\proj\\dist', repoAt(['C:\\proj']), home)).toBe('proj');
    expect(projectOf('C:\\proj\\node_modules\\dep', repoAt(['C:\\proj']), home)).toBe('proj');
  });
});