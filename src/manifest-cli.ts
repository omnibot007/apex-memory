#!/usr/bin/env node
/**
 * apex-memory-manifest — print the session manifest on stdout.
 *
 * Called by the SessionStart hook. Prints nothing and exits 0 when the store is empty or
 * unreadable: a hook that cannot produce context must degrade to silence, never to a
 * broken session.
 *
 *   apex-memory-manifest                 # default budget
 *   apex-memory-manifest --max-chars 900 # tighter budget
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omnibot007
 */
import { MANIFEST_DEFAULTS, memoryManifest } from './manifest.js';
import { JsonlCustodyStore } from './store.js';

function num(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const parsed = Number(process.argv[i + 1]);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

async function main(): Promise<void> {
  const block = await memoryManifest(new JsonlCustodyStore(), {
    maxChars: num('max-chars', MANIFEST_DEFAULTS.maxChars),
    maxPolicy: num('max-policy', MANIFEST_DEFAULTS.maxPolicy),
    maxFacts: num('max-facts', MANIFEST_DEFAULTS.maxFacts),
    maxProjects: num('max-projects', MANIFEST_DEFAULTS.maxProjects),
  });
  if (block.length > 0) process.stdout.write(`${block}\n`);
}

main().catch(() => {
  // Silence is the correct failure mode here. The hook still injects STATE.md.
  process.exit(0);
});
