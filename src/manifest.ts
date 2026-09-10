/**
 * The session manifest — what memory EXISTS, cheap enough to inject on every session start.
 *
 * A store nothing reads is a filing cabinet in another building. Before this, the only way
 * custodied memory reached a session was for an agent to already know to call
 * `custody_recall` — which requires remembering the thing you are trying to remember.
 *
 * This deliberately injects an INDEX, not the contents:
 *  - the whole store is far too large for a session preamble, and always will be;
 *  - the alternative — guessing ONE project from the process cwd — is the exact defect that
 *    filed 91 rows under `Warp` and `LENOVO`. A manifest needs no guess: it names every
 *    project and lets the agent recall the one it actually needs.
 *
 * Counts come from `countInForce`, so what the manifest advertises and what `custody_recall`
 * returns can never disagree.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omnibot007
 */
import { countInForce, recallInForce } from './custody.js';
import type { CustodiedFact, CustodyStore } from './types.js';

/** A store that can enumerate across projects. Both shipped stores satisfy this. */
export type EnumerableStore = CustodyStore & { listAll(): Promise<CustodiedFact[]> };

export interface ManifestOptions {
  /** Hard ceiling on the returned block. Lists are trimmed; the header always survives. */
  readonly maxChars?: number;
  /** How many `policy` rows to spell out in full. */
  readonly maxPolicy?: number;
  /** How many newest `fact`-authority rows to spell out in full. */
  readonly maxFacts?: number;
  /** How many projects to name before collapsing the rest into a count. */
  readonly maxProjects?: number;
}

export const MANIFEST_DEFAULTS = {
  maxChars: 2200,
  maxPolicy: 4,
  maxFacts: 6,
  maxProjects: 14,
} as const;

function oneLine(value: string, max: number): string {
  const flat = value.replaceAll(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Per-project in-force counts, richest first. Empty projects are dropped: a project whose
 * every row is superseded or archived is not something to advertise.
 */
export async function projectCounts(store: EnumerableStore): Promise<Array<[string, number]>> {
  const all = await store.listAll();
  const names = [...new Set(all.map((row) => row.project))];
  const counted: Array<[string, number]> = [];
  for (const name of names) {
    const n = await countInForce(store, name);
    if (n > 0) counted.push([name, n]);
  }
  return counted.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/**
 * Newest in-force rows across every project, at or above `minAuthority`.
 *
 * `perProject` caps how many one project may contribute. An index wants BREADTH: sorting
 * purely by recency lets a single busy project fill the whole section, which tells the
 * reader that one project exists and hides the other twenty-six.
 */
async function newestAcross(
  store: EnumerableStore,
  projects: readonly string[],
  minAuthority: 'policy' | 'fact',
  take: number,
  perProject = Number.POSITIVE_INFINITY,
): Promise<CustodiedFact[]> {
  const rows: CustodiedFact[] = [];
  for (const project of projects) {
    rows.push(...(await recallInForce(store, project, { minAuthority, limit: 1000 })));
  }
  const wanted = minAuthority === 'policy' ? rows.filter((r) => r.authority === 'policy') : rows;
  const ordered = wanted.toSorted((a, b) => b.validFromMs - a.validFromMs);

  const used = new Map<string, number>();
  const picked: CustodiedFact[] = [];
  for (const row of ordered) {
    if (picked.length >= take) break;
    const n = used.get(row.project) ?? 0;
    if (n >= perProject) continue;
    used.set(row.project, n + 1);
    picked.push(row);
  }
  return picked;
}

/**
 * Trim to budget by dropping whole lines from the tail.
 *
 * Never mid-line: a claim cut in half is worse than a claim absent, because the reader
 * cannot tell that it was cut. `keep` lines are the header and always survive.
 */
function trimToBudget(lines: readonly string[], maxChars: number, keep: number): string {
  const kept = [...lines];
  const notice = (n: number): string =>
    `\n[${n} more line(s) trimmed to fit ${maxChars} chars — call custody_recall for the rest]`;
  let dropped = 0;
  while (kept.length > keep && kept.join('\n').length + notice(dropped + 1).length > maxChars) {
    kept.pop();
    dropped++;
  }
  return dropped === 0 ? kept.join('\n') : kept.join('\n') + notice(dropped);
}

/**
 * The injectable block. Returns '' when there is nothing in force — an empty store must
 * inject nothing rather than an empty ceremony.
 */
export async function memoryManifest(
  store: EnumerableStore,
  options?: ManifestOptions,
): Promise<string> {
  const cfg = { ...MANIFEST_DEFAULTS, ...options };
  const counts = await projectCounts(store);
  if (counts.length === 0) return '';

  const total = counts.reduce((sum, [, n]) => sum + n, 0);
  const names = counts.map(([name]) => name);

  const shown = counts.slice(0, cfg.maxProjects);
  const hidden = counts.length - shown.length;
  const projectLine =
    shown.map(([name, n]) => `${name} ${n}`).join(' · ') +
    (hidden > 0 ? ` · (+${hidden} more projects)` : '');

  const lines: string[] = [
    `${total} facts in force across ${counts.length} projects.`,
    'This is an INDEX, not the memory. Call custody_recall(project=…) for detail;',
    'it reports the in-force total beside the page, so page with offset when rows remain.',
    '',
    `PROJECTS  ${projectLine}`,
  ];

  const headerLines = lines.length;

  const policy = await newestAcross(store, names, 'policy', cfg.maxPolicy);
  if (policy.length > 0) {
    lines.push('', 'POLICY — operator decisions, the highest authority the gate grants:');
    for (const row of policy) lines.push(`  · [${row.project}] ${oneLine(row.text, 220)}`);
  }

  // One per project: breadth beats depth in an index.
  const facts = await newestAcross(store, names, 'fact', cfg.maxFacts, 1);
  if (facts.length > 0) {
    lines.push('', 'NEWEST VERIFIED FACT PER PROJECT:');
    for (const row of facts) lines.push(`  · [${row.project}] ${oneLine(row.text, 150)}`);
  }

  return trimToBudget(lines, cfg.maxChars, headerLines);
}
