#!/usr/bin/env node
/**
 * apex-memory MCP server — plugs the custody gate into any MCP client
 * (Claude Code, Codex, Cursor, OpenCode, Windsurf, ...).
 *
 * The gate is the point. An agent calling `custody_record` cannot promote its own
 * assertion to a fact: `assistant-claim` tops out at `conjecture`, and the quote must
 * occur verbatim inside the source text the caller supplies.
 *
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 omnibot007
 */
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

import { compactProject } from './compaction.js';
import { admitCustody, CustodyRefusedError, recallInForce, record, supersede } from './custody.js';
import { JsonlCustodyStore } from './store.js';
import type { Authority, CustodiedFact, FactKind, SourceKind } from './types.js';

const store = new JsonlCustodyStore();

const sourceKind = z.enum([
  'user-decision',
  'verified-command',
  'code-read',
  'assistant-claim',
  'repo-content',
]);
const authority = z.enum(['policy', 'fact', 'observation', 'conjecture']);
const factKind = z.enum(['fact', 'decision', 'pattern']);

const recordShape = z.object({
  project: z.string().describe('Project scope. Memory never leaks across projects.'),
  kind: factKind,
  text: z.string().describe('The claim, in your own words.'),
  quote: z.string().describe('Verbatim span that must occur inside sourceText.'),
  sourceText: z.string().describe('The retained source the quote came from. Digests derive from this.'),
  sourceKind: sourceKind.describe('Where it came from. This caps the authority you may claim.'),
  claimedAuthority: authority.describe('Refused if it exceeds the ceiling for sourceKind.'),
  sourceLocator: z.string().describe('Stable pointer back to the source, e.g. file#L12 or session:id#turn.'),
  sourceSession: z.string().default('mcp'),
  validFromMs: z.number().optional(),
  recordedAtMs: z.number().optional(),
});

function text(body: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: body }] };
}

function line(fact: CustodiedFact): string {
  return `[${fact.authority}] ${fact.text}  <- ${fact.sourceKind} @ ${fact.sourceLocator}  (${fact.id})`;
}

function toRequest(args: z.infer<typeof recordShape>) {
  const now = Date.now();
  return {
    project: args.project,
    kind: args.kind as FactKind,
    text: args.text,
    quote: args.quote,
    sourceText: args.sourceText,
    sourceKind: args.sourceKind as SourceKind,
    claimedAuthority: args.claimedAuthority as Authority,
    sourceLocator: args.sourceLocator,
    sourceSession: args.sourceSession,
    validFromMs: args.validFromMs ?? now,
    recordedAtMs: args.recordedAtMs ?? now,
  };
}

function buildServer(): McpServer {
  const server = new McpServer({ name: 'apex-memory', version: '0.1.0' });

  server.registerTool(
    'custody_record',
    {
      description:
        'Persist a fact through the write-side custody gate. Authority is computed from sourceKind, never from what you claim. An assistant-claim can never become a fact; repo-content can never become policy.',
      inputSchema: recordShape,
    },
    async (args) => {
      try {
        const saved = await record(store, toRequest(args));
        return text(`admitted ${line(saved)}`);
      } catch (error) {
        if (error instanceof CustodyRefusedError) return text(`REFUSED: ${error.message}`);
        return text(`error: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  server.registerTool(
    'custody_check',
    {
      description:
        'Dry-run the custody gate without writing. Use this to find out whether a claim would be admitted, and at what authority, before committing to it.',
      inputSchema: recordShape,
    },
    async (args) => {
      const verdict = admitCustody(toRequest(args));
      return text(
        verdict.admitted
          ? `would admit at authority '${verdict.authority}' (sourceDigest ${verdict.sourceDigest.slice(0, 12)}...)`
          : `would REFUSE: ${verdict.denial} — '${args.sourceKind}' tops out at '${verdict.ceiling}'`,
      );
    },
  );

  server.registerTool(
    'custody_recall',
    {
      description:
        'Read in-force memory. Superseded and archived rows are never returned. Set requireCorroboration to withhold claims that lack two independent non-conjecture sources.',
      inputSchema: z.object({
        project: z.string(),
        kind: factKind.optional(),
        minAuthority: authority.optional(),
        asOfMs: z.number().optional().describe('Point-in-time recall.'),
        requireCorroboration: z.boolean().optional(),
        limit: z.number().optional(),
      }),
    },
    async (args) => {
      const rows = await recallInForce(store, args.project, {
        ...(args.kind === undefined ? {} : { kind: args.kind as FactKind }),
        ...(args.minAuthority === undefined ? {} : { minAuthority: args.minAuthority as Authority }),
        ...(args.asOfMs === undefined ? {} : { asOfMs: args.asOfMs }),
        ...(args.requireCorroboration === undefined
          ? {}
          : { requireCorroboration: args.requireCorroboration }),
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      if (rows.length === 0) return text('(nothing in force — abstaining rather than guessing)');
      return text(rows.map(line).join('\n'));
    },
  );

  server.registerTool(
    'custody_supersede',
    {
      description:
        'Mark a fact superseded by another. Nothing is deleted; superseded decisions stay queryable and stop carrying authority.',
      inputSchema: z.object({
        project: z.string(),
        supersededId: z.string(),
        supersedingId: z.string(),
      }),
    },
    async (args) => {
      const ok = await supersede(
        store,
        args.project,
        args.supersededId,
        args.supersedingId,
        Date.now(),
      );
      return text(ok ? 'superseded' : 'no-op (unknown id, wrong project, or already superseded)');
    },
  );

  server.registerTool(
    'custody_compact',
    {
      description:
        'Compact a project: archive duplicates, archive old superseded rows, and enforce a live-row budget. Policy facts are never evicted. Archival is not deletion.',
      inputSchema: z.object({
        project: z.string(),
        maxLiveRows: z.number().optional(),
        archiveSupersededAfterMs: z.number().optional(),
        dryRun: z.boolean().optional(),
      }),
    },
    async (args) => {
      const report = await compactProject(store, args.project, {
        nowMs: Date.now(),
        ...(args.maxLiveRows === undefined ? {} : { maxLiveRows: args.maxLiveRows }),
        ...(args.archiveSupersededAfterMs === undefined
          ? {}
          : { archiveSupersededAfterMs: args.archiveSupersededAfterMs }),
        ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
      });
      return text(JSON.stringify(report, null, 2));
    },
  );

  return server;
}

serveStdio(() => buildServer());
