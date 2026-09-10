/**
 * The write-side custody gate.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omnibot007
 */
import { createHash } from 'node:crypto';

import {
  AUTHORITY_RANK,
  DEFAULT_RECALL_LIMIT,
  SOURCE_CEILING,
  type Authority,
  type CustodiedFact,
  type CustodyDenial,
  type CustodyRefusal,
  type CustodyRequest,
  type CustodyStore,
  type CustodyVerdict,
  type RecallOptions,
  type SourceKind,
} from './types.js';

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function makeId(atMs: number): string {
  const stamp = Math.max(0, Math.floor(atMs)).toString(36);
  const rand = Math.floor(Math.random() * 36 ** 8).toString(36);
  return `${stamp}-${rand}`;
}

export function normalizeClaim(text: string): string {
  return text.trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

export function sourceCeiling(sourceKind: SourceKind): Authority {
  return SOURCE_CEILING[sourceKind] ?? 'conjecture';
}

/** A source whose ceiling is above `conjecture` can contribute independent corroboration. */
export function isCorroborating(sourceKind: SourceKind): boolean {
  return AUTHORITY_RANK[sourceCeiling(sourceKind)] > AUTHORITY_RANK.conjecture;
}

/**
 * The gate. Pure: no I/O, no store, fully testable.
 *
 * Provenance is COMPUTED here — `sourceDigest` and `quoteDigest` are derived from the
 * caller's retained source text, never accepted as input. A forged provenance field
 * cannot survive because there is no provenance field to forge.
 */
export function admitCustody(request: CustodyRequest): CustodyVerdict {
  const ceiling = sourceCeiling(request.sourceKind);
  const refuse = (denial: CustodyDenial): CustodyRefusal => ({ admitted: false, denial, ceiling });

  if ((SOURCE_CEILING as Record<string, Authority | undefined>)[request.sourceKind] === undefined) {
    return refuse('unknown-source-kind');
  }
  if ((AUTHORITY_RANK as Record<string, number | undefined>)[request.claimedAuthority] === undefined) {
    return refuse('unknown-authority');
  }
  if (request.kind !== 'fact' && request.kind !== 'decision' && request.kind !== 'pattern') {
    return refuse('unknown-kind');
  }
  if (!isNonEmpty(request.project)) return refuse('empty-project');
  if (!isNonEmpty(request.text)) return refuse('empty-text');
  if (!isNonEmpty(request.quote)) return refuse('empty-quote');
  if (!isNonEmpty(request.sourceText)) return refuse('empty-source');
  if (!isNonEmpty(request.sourceLocator)) return refuse('missing-locator');
  if (request.recordedAtMs < request.validFromMs) return refuse('recorded-before-valid');
  if (AUTHORITY_RANK[request.claimedAuthority] > AUTHORITY_RANK[ceiling]) {
    return refuse('authority-exceeds-source');
  }
  if (!request.sourceText.includes(request.quote.trim())) return refuse('quote-not-in-source');

  return {
    admitted: true,
    authority: request.claimedAuthority,
    sourceDigest: digest(request.sourceText),
    quoteDigest: digest(request.quote.trim()),
  };
}

export class CustodyRefusedError extends Error {
  constructor(
    readonly denial: CustodyDenial,
    readonly ceiling: Authority,
    readonly sourceKind: SourceKind,
  ) {
    super(`custody refused: ${denial} (source '${sourceKind}' tops out at '${ceiling}')`);
    this.name = 'CustodyRefusedError';
  }
}

export async function record(store: CustodyStore, request: CustodyRequest): Promise<CustodiedFact> {
  const verdict = admitCustody(request);
  if (!verdict.admitted) {
    throw new CustodyRefusedError(verdict.denial, verdict.ceiling, request.sourceKind);
  }
  const fact: CustodiedFact = {
    id: makeId(request.recordedAtMs),
    project: request.project.trim(),
    kind: request.kind,
    text: request.text.trim(),
    quote: request.quote.trim(),
    sourceKind: request.sourceKind,
    authority: verdict.authority,
    sourceLocator: request.sourceLocator.trim(),
    sourceDigest: verdict.sourceDigest,
    quoteDigest: verdict.quoteDigest,
    sourceSession: request.sourceSession,
    validFromMs: request.validFromMs,
    recordedAtMs: request.recordedAtMs,
    supersededBy: null,
    supersededAtMs: null,
    archivedAtMs: null,
  };
  await store.put(fact);
  return fact;
}

/** Marks, never deletes. Superseded decisions and rejected approaches stay queryable. */
export async function supersede(
  store: CustodyStore,
  project: string,
  supersededId: string,
  supersedingId: string,
  atMs: number,
): Promise<boolean> {
  const existing = await store.get(supersededId);
  if (existing === undefined || existing.project !== project) return false;
  if (existing.supersededBy !== null) return false;
  await store.put({ ...existing, supersededBy: supersedingId, supersededAtMs: atMs });
  return true;
}

/**
 * Independent corroboration, weighted by source kind.
 *
 * Counts DISTINCT locators that come from a corroborating source. Two assistant claims
 * therefore never corroborate each other, which was the known weakness in v1.
 */
export function corroborationOf(rows: readonly CustodiedFact[]): number {
  const seen = new Set<string>();
  let weight = 0;
  for (const row of rows) {
    if (seen.has(row.sourceLocator)) continue;
    seen.add(row.sourceLocator);
    if (isCorroborating(row.sourceKind)) weight += 1;
  }
  return weight;
}

function corroborated(rows: readonly CustodiedFact[]): CustodiedFact[] {
  const byClaim = new Map<string, CustodiedFact[]>();
  for (const row of rows) {
    const claim = normalizeClaim(row.text);
    const bucket = byClaim.get(claim) ?? [];
    bucket.push(row);
    byClaim.set(claim, bucket);
  }
  return rows.filter((row) => corroborationOf(byClaim.get(normalizeClaim(row.text)) ?? []) >= 2);
}

/** Terms of a free-text query. Empty when the query is absent or only whitespace. */
export function queryTerms(query: string | undefined): string[] {
  if (typeof query !== 'string') return [];
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/**
 * Does a row satisfy every term?
 *
 * Searches the claim, the retained quote and the locator. The locator is included on
 * purpose: "opencode ses_f76b" is a legitimate way to ask what a given session established.
 */
export function matchesQuery(row: CustodiedFact, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = `${row.text}\n${row.quote}\n${row.sourceLocator}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Everything in force for a project, ordered, with NO paging applied.
 *
 * Private on purpose: `recallInForce` and `countInForce` both go through here, so a page
 * and its total can never be computed by two filters that have drifted apart.
 */
async function inForce(
  store: CustodyStore,
  project: string,
  options?: RecallOptions,
): Promise<CustodiedFact[]> {
  const all = await store.list(project);
  const floor = AUTHORITY_RANK[options?.minAuthority ?? 'observation'];
  const asOf = options?.asOfMs;
  const terms = queryTerms(options?.query);

  let rows = all.filter((row) => {
    if (!matchesQuery(row, terms)) return false;
    if (row.supersededBy !== null) return false;
    if (row.archivedAtMs !== null) return false;
    if (!isNonEmpty(row.text) || !isNonEmpty(row.quote)) return false;
    if (!isNonEmpty(row.sourceDigest) || !isNonEmpty(row.quoteDigest)) return false;
    const rank = (AUTHORITY_RANK as Record<string, number | undefined>)[row.authority];
    if (rank === undefined || rank < floor) return false;
    if (options?.kind !== undefined && row.kind !== options.kind) return false;
    if (asOf !== undefined && row.validFromMs > asOf) return false;
    return true;
  });

  if (options?.requireCorroboration === true) rows = corroborated(rows);
  return rows.toSorted((a, b) => b.validFromMs - a.validFromMs);
}

/**
 * One page of in-force memory, newest first.
 *
 * Pages rather than truncating: `offset` walks the rest. Ask `countInForce` with the same
 * options to learn whether a page is the whole answer or just the front of it.
 */
export async function recallInForce(
  store: CustodyStore,
  project: string,
  options?: RecallOptions,
): Promise<CustodiedFact[]> {
  const rows = await inForce(store, project, options);
  const offset = Math.max(0, Math.floor(options?.offset ?? 0));
  const limit = Math.max(0, Math.floor(options?.limit ?? DEFAULT_RECALL_LIMIT));
  return rows.slice(offset, offset + limit);
}

/** How many rows are in force for these options, ignoring `limit` and `offset`. */
export async function countInForce(
  store: CustodyStore,
  project: string,
  options?: RecallOptions,
): Promise<number> {
  return (await inForce(store, project, options)).length;
}
