/**
 * Custody Memory — core types.
 *
 * Authority is COMPUTED from the source kind. It is never accepted from a writer.
 * See LINEAGE.md for credits: every mechanism here is credited to the project whose
 * published description inspired it. No donor code was read or copied.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omnibot007
 */

/** Where a claim came from. This, not the writer, decides how much authority it can carry. */
export type SourceKind =
  | 'user-decision'
  | 'verified-command'
  | 'code-read'
  | 'assistant-claim'
  | 'repo-content';

/** How much weight a claim is allowed to carry once admitted. */
export type Authority = 'policy' | 'fact' | 'observation' | 'conjecture';

export const AUTHORITY_RANK: Readonly<Record<Authority, number>> = {
  conjecture: 0,
  observation: 1,
  fact: 2,
  policy: 3,
};

/**
 * The ceiling table. This is the heart of the system.
 *
 * `assistant-claim` and `repo-content` top out at `conjecture` on purpose:
 *  - a model asserting something is not evidence (anti epistemic-laundering)
 *  - text living inside a repository must never become operator policy (prompt-injection defence)
 */
export const SOURCE_CEILING: Readonly<Record<SourceKind, Authority>> = {
  'user-decision': 'policy',
  'verified-command': 'fact',
  'code-read': 'observation',
  'assistant-claim': 'conjecture',
  'repo-content': 'conjecture',
};

export type FactKind = 'fact' | 'decision' | 'pattern';

/**
 * Default page size for `recallInForce`.
 *
 * Named on purpose. A silent slice is how a memory store stops answering: past this many
 * in-force rows, recall returns a PAGE and looks exactly like the whole truth. Callers that
 * need the rest must page with `offset`, and `countInForce` tells them whether there is a rest.
 */
export const DEFAULT_RECALL_LIMIT = 50;

export type CustodyDenial =
  | 'authority-exceeds-source'
  | 'quote-not-in-source'
  | 'empty-quote'
  | 'empty-source'
  | 'empty-text'
  | 'empty-project'
  | 'missing-locator'
  | 'unknown-source-kind'
  | 'unknown-authority'
  | 'unknown-kind'
  | 'recorded-before-valid';

export interface CustodyRequest {
  readonly project: string;
  readonly kind: FactKind;
  readonly text: string;
  /** Must occur verbatim inside `sourceText`, or the write is refused. */
  readonly quote: string;
  /** The retained immutable source. Digests are derived from THIS, never supplied by the caller. */
  readonly sourceText: string;
  readonly sourceKind: SourceKind;
  readonly claimedAuthority: Authority;
  readonly sourceLocator: string;
  readonly sourceSession: string;
  readonly validFromMs: number;
  readonly recordedAtMs: number;
}

export interface CustodyGrant {
  readonly admitted: true;
  readonly authority: Authority;
  readonly sourceDigest: string;
  readonly quoteDigest: string;
}

export interface CustodyRefusal {
  readonly admitted: false;
  readonly denial: CustodyDenial;
  readonly ceiling: Authority;
}

export type CustodyVerdict = CustodyGrant | CustodyRefusal;

export interface CustodiedFact {
  readonly id: string;
  readonly project: string;
  readonly kind: FactKind;
  readonly text: string;
  readonly quote: string;
  readonly sourceKind: SourceKind;
  readonly authority: Authority;
  readonly sourceLocator: string;
  readonly sourceDigest: string;
  readonly quoteDigest: string;
  readonly sourceSession: string;
  readonly validFromMs: number;
  readonly recordedAtMs: number;
  readonly supersededBy: string | null;
  readonly supersededAtMs: number | null;
  readonly archivedAtMs: number | null;
}

export interface RecallOptions {
  readonly kind?: FactKind;
  readonly minAuthority?: Authority;
  /** Point-in-time recall: hide anything that became true after this instant. */
  readonly asOfMs?: number;
  /** Withhold claims that lack independent, non-conjecture corroboration. */
  readonly requireCorroboration?: boolean;
  readonly limit?: number;
  /** Rows to skip before the page starts. Pair with `limit` to page a whole project. */
  readonly offset?: number;
  /**
   * Free-text filter. Whitespace-separated terms, ALL of which must appear (case
   * insensitive) somewhere in the row's claim, quote, or locator.
   *
   * AND, not OR: a memory search with one broad term returning everything is the same as
   * no search. Matching is plain substring — deliberately not fuzzy, so that a row either
   * contains what you asked for or is honestly absent.
   */
  readonly query?: string;
}

export interface CustodyStore {
  put(fact: CustodiedFact): Promise<void>;
  get(id: string): Promise<CustodiedFact | undefined>;
  list(project: string): Promise<CustodiedFact[]>;
  /**
   * Every row, across every project.
   *
   * On the interface because idempotence cannot be project-scoped: a sweep that dedupes
   * only within one project re-writes a claim the moment its row is filed elsewhere.
   * That defect duplicated 71 claims on 2026-09-10.
   */
  listAll(): Promise<CustodiedFact[]>;
  remove(id: string): Promise<void>;
}
