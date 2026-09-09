#!/usr/bin/env node
/**
 * apex-memory-distill — sweep every harness on this machine into custodied memory.
 *
 *   apex-memory-distill                 # all harnesses, write
 *   apex-memory-distill --dry-run       # show what WOULD be written
 *   apex-memory-distill --harness kimi  # one harness
 *   apex-memory-distill --json          # machine-readable report
 *
 * Idempotent: re-running writes nothing new. That is what lets one trigger cover
 * Claude Code, kimi-code and OpenCode instead of needing a hook inside each.
 *
 * Reads harness session stores; writes only to the custody store. No network.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omninbot
 */
import { distill } from './distill.js';
import { allReaders, type Utterance } from './readers.js';
import { JsonlCustodyStore } from './store.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next !== undefined && !next.startsWith('--') ? next : '';
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  if (has('help')) {
    process.stdout.write(
      [
        'apex-memory-distill [--harness claude|kimi|opencode] [--dry-run] [--json]',
        '                    [--since <ms>] [--authority observation|policy|conjecture]',
        '',
        'Default authority is `observation`: the operator said it, but whether it is a',
        'standing rule is unverified. Promote to `policy` deliberately, never in bulk.',
      ].join('\n') + '\n',
    );
    return;
  }

  const only = arg('harness');
  const dryRun = has('dry-run');
  const sinceRaw = arg('since');
  const since = sinceRaw !== undefined && sinceRaw.length > 0 ? Number(sinceRaw) : undefined;
  const authRaw = arg('authority');
  const authority =
    authRaw === 'policy' || authRaw === 'observation' || authRaw === 'conjecture'
      ? authRaw
      : undefined;

  const readers = allReaders().filter((r) => (only === undefined || only === '' ? true : r.name === only));
  const utterances: Utterance[] = [];
  const skipped: string[] = [];

  for (const reader of readers) {
    if (!reader.available()) {
      skipped.push(reader.name);
      continue;
    }
    try {
      utterances.push(...reader.read());
    } catch {
      skipped.push(`${reader.name}(error)`);
    }
  }

  const store = new JsonlCustodyStore();
  const report = await distill(store, utterances, {
    dryRun,
    ...(since === undefined || Number.isNaN(since) ? {} : { sinceMs: since }),
    ...(authority === undefined ? {} : { authority }),
  });

  if (has('json')) {
    process.stdout.write(`${JSON.stringify({ ...report, skipped, store: store.path }, null, 2)}\n`);
    return;
  }

  const lines = [
    `apex-memory distill${dryRun ? ' (dry run)' : ''}`,
    `  store       ${store.path}`,
    `  harnesses   ${readers.map((r) => r.name).join(', ') || 'none'}${skipped.length > 0 ? `  (unavailable: ${skipped.join(', ')})` : ''}`,
    `  utterances  ${report.scanned}`,
    `  candidates  ${report.candidates}`,
    `  written     ${report.written}`,
    `  duplicate   ${report.skippedDuplicate}`,
    `  refused     ${report.refused}`,
  ];
  for (const [harness, n] of Object.entries(report.byHarness)) lines.push(`    ${harness}: ${n}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`apex-memory-distill failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
