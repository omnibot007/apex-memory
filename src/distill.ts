/**
 * Distillation — turn what the operator typed into custodied policy.
 *
 * Deliberately deterministic. No model call, no inference, no cost. Broad inference is
 * how epistemic laundering starts, so this only ever promotes text a human actually
 * typed, and only when it carries an explicit standing-instruction marker.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omninbot
 */
import { normalizeClaim, record, recallInForce } from './custody.js';
import type { Utterance } from './readers.js';
import type { CustodyStore } from './types.js';

/**
 * Markers for an explicit standing instruction.
 *
 * MEASURED, not guessed. An earlier set included `i want you to`; run against a real
 * transcript it produced 4 false positives out of 5 captures, because that phrase is how
 * people introduce a one-off TASK. It was removed. A false positive here becomes durable
 * `policy`, so precision beats recall every time.
 */
export const MARKERS: readonly RegExp[] = [
  /\balways\b/i,
  /\bnever\b/i,
  /\bfrom now on\b/i,
  /\bgoing forward\b/i,
  /\bdon'?t\b/i,
  /\bdo not\b/i,
  /\bmake sure\b/i,
  /\bremember (?:that|to)\b/i,
  /\bwe decided\b/i,
  /\binstead of\b/i,
];

/**
 * Looks like an instruction but is not one.
 *
 * MEASURED against 1,223 real utterances across three harnesses. The first pass had
 * roughly 10-15% precision: `never mind` matched `never`, past-tense narrative
 * ("had never run end to end", "/api/generate never returned") read as standing rules,
 * and pasted documentation was treated as typed instruction. Each rule below kills a
 * class that was observed, not imagined.
 */
export const ANTI_MARKERS: readonly RegExp[] = [
  /\?\s*$/,
  /^\s*(?:ok|okay|thanks|thank you|cool|nice|lol|yes|no)\b/i,
  // List items and headings: pasted specs, not decisions typed at a harness.
  /^\s*(?:[-*#>|]|\d+[.)])\s/,
  // Task framing rather than standing policy.
  /\b(?:i want|i need|i'?d like) you to\b/i,
  /\bcan you\b/i,
  /(?:^|\s)\/[a-z][a-z0-9-]*/i,
  // "never mind" is not a prohibition.
  /\bnever\s*mind\b/i,
  // Past-tense narrative describing what happened, not what must happen.
  /\b(?:was|were|had|has|have|did|didn'?t|hadn'?t|wasn'?t|weren'?t)\s+(?:\w+\s+){0,2}(?:never|always)\b/i,
  /\b(?:never|always)\s+(?:ran|run|returned|worked|fired|happened|existed|been)\b/i,
  // Markdown, code spans and URLs mark pasted or quoted material.
  /[`*_]{2}/,
  /`[^`]+`/,
  /https?:\/\//i,
  // A trailing colon introduces a block; the rule (if any) is not this line.
  /:\s*$/,
  // Complaints and corrections about the current turn, not durable policy.
  /\b(?:i|we)\s+(?:didn'?t|don'?t|never)\s+(?:ask|want|need|care|said)\b/i,
  // Harness-injected system text that lands in the user channel. Observed verbatim in
  // real transcripts; it is the harness talking, not the operator.
  /\banswer only from (?:injected )?context\b/i,
  /\bcontinue the task you were working on when the limit was reached\b/i,
];

/**
 * Long utterances are pastes — logs, specs, documentation, prior output. A standing
 * instruction someone types is short. Measured: dropping this cut most false positives.
 */
export const MAX_UTTERANCE_CHARS = 800;

export function decisionsFrom(text: string): string[] {
  if (text.length > MAX_UTTERANCE_CHARS) return [];
  const found: string[] = [];
  const sentences = text
    .split(/(?<=[.!?\n])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 320);
  for (const sentence of sentences) {
    if (ANTI_MARKERS.some((re) => re.test(sentence))) continue;
    if (!MARKERS.some((re) => re.test(sentence))) continue;
    found.push(sentence);
  }
  return found;
}

export interface DistillOptions {
  readonly nowMs?: number;
  readonly dryRun?: boolean;
  /** Only consider utterances at or after this instant. */
  readonly sinceMs?: number;
  /**
   * Authority to claim. Defaults to `observation`, NOT the `policy` ceiling that
   * `user-decision` permits.
   *
   * Why: measured against 1,223 real utterances, surface markers cannot separate a
   * standing rule from a one-off task -- "make sure X" is how people phrase both. So the
   * distiller records that the operator said something (true, attributable, quoted) and
   * declines to assert that it is binding policy (unverified). Promotion to `policy` is
   * a deliberate human act, not a regex's guess.
   */
  readonly authority?: 'policy' | 'observation' | 'conjecture';
}

export interface DistillReport {
  readonly scanned: number;
  readonly candidates: number;
  readonly written: number;
  readonly skippedDuplicate: number;
  readonly refused: number;
  readonly byHarness: Record<string, number>;
  readonly dryRun: boolean;
}

/**
 * Idempotent. Re-running over the same transcripts writes nothing new, which is what
 * lets a single sweep cover every harness instead of needing a hook inside each one.
 */
export async function distill(
  store: CustodyStore,
  utterances: readonly Utterance[],
  options: DistillOptions = {},
): Promise<DistillReport> {
  const now = options.nowMs ?? Date.now();
  const dryRun = options.dryRun === true;
  const since = options.sinceMs ?? 0;
  const authority = options.authority ?? 'observation';

  const seenByProject = new Map<string, Set<string>>();
  const inForceFor = async (project: string): Promise<Set<string>> => {
    const cached = seenByProject.get(project);
    if (cached !== undefined) return cached;
    let seen = new Set<string>();
    try {
      // Dedupe against everything already held, at any authority -- a claim promoted to
      // policy by hand must not be re-added as a fresh observation on the next sweep.
      const rows = await recallInForce(store, project, { minAuthority: 'conjecture', limit: 2000 });
      seen = new Set(rows.map((row) => normalizeClaim(row.text)));
    } catch {
      seen = new Set<string>();
    }
    seenByProject.set(project, seen);
    return seen;
  };

  let candidates = 0;
  let written = 0;
  let skippedDuplicate = 0;
  let refused = 0;
  const byHarness: Record<string, number> = {};

  for (const utterance of utterances) {
    if (utterance.atMs < since) continue;
    const seen = await inForceFor(utterance.project);
    for (const sentence of decisionsFrom(utterance.text)) {
      candidates += 1;
      const key = normalizeClaim(sentence);
      if (seen.has(key)) {
        skippedDuplicate += 1;
        continue;
      }
      seen.add(key);
      if (dryRun) {
        written += 1;
        byHarness[utterance.harness] = (byHarness[utterance.harness] ?? 0) + 1;
        continue;
      }
      try {
        await record(store, {
          project: utterance.project,
          kind: 'decision',
          text: sentence,
          quote: sentence,
          sourceText: utterance.text,
          sourceKind: 'user-decision',
          claimedAuthority: authority,
          sourceLocator: utterance.locator,
          sourceSession: utterance.session,
          validFromMs: utterance.atMs > 0 ? utterance.atMs : now,
          recordedAtMs: now,
        });
        written += 1;
        byHarness[utterance.harness] = (byHarness[utterance.harness] ?? 0) + 1;
      } catch {
        refused += 1;
      }
    }
  }

  return {
    scanned: utterances.length,
    candidates,
    written,
    skippedDuplicate,
    refused,
    byHarness,
    dryRun,
  };
}
