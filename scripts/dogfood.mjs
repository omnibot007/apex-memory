import { JsonlCustodyStore } from '../dist/store.js';
import { record, recallInForce } from '../dist/custody.js';

const store = new JsonlCustodyStore();
const now = Date.now();

const SOURCE =
  'operator, 2026-09-09: "im not rebooting till we solve this memeory problem ... ' +
  'publish this mem system as a repo so we can have astral look at it later but in the ' +
  'mean time plug it into all my harnesses including you"';

await record(store, {
  project: 'apex-harness',
  kind: 'decision',
  text: 'apex-memory is published public and wired into Claude Code and kimi-code as an MCP server',
  quote: 'plug it into all my harnesses including you',
  sourceText: SOURCE,
  sourceKind: 'user-decision',
  claimedAuthority: 'policy',
  sourceLocator: 'session:dac152c6#custody-wiring',
  sourceSession: 'dac152c6',
  validFromMs: now,
  recordedAtMs: now,
});

const VERIFIED =
  'node scripts/smoke-mcp.mjs =>\n' +
  'INIT server: apex-memory\n' +
  'TOOLS: custody_record, custody_check, custody_recall, custody_supersede, custody_compact\n' +
  'RECORD assistant-claim-as-fact -> REFUSED: custody refused: authority-exceeds-source\n' +
  'SMOKE: PASS';

await record(store, {
  project: 'apex-harness',
  kind: 'fact',
  text: 'the custody gate refuses an assistant-claim promoted to fact over real MCP stdio',
  quote: 'REFUSED: custody refused: authority-exceeds-source',
  sourceText: VERIFIED,
  sourceKind: 'verified-command',
  claimedAuthority: 'fact',
  sourceLocator: 'apex-memory/scripts/smoke-mcp.mjs',
  sourceSession: 'dac152c6',
  validFromMs: now,
  recordedAtMs: now,
});

let refused = 'NOT REFUSED — BUG';
try {
  await record(store, {
    project: 'apex-harness',
    kind: 'fact',
    text: 'this harness is definitely better than every lab harness',
    quote: 'plug it into all my harnesses',
    sourceText: SOURCE,
    sourceKind: 'assistant-claim',
    claimedAuthority: 'fact',
    sourceLocator: 'session:dac152c6#hubris',
    sourceSession: 'dac152c6',
    validFromMs: now,
    recordedAtMs: now,
  });
} catch (error) {
  refused = error.message;
}

console.log('store:', store.path);
console.log('unverifiable brag ->', refused);
console.log('--- in force ---');
for (const row of await recallInForce(store, 'apex-harness')) {
  console.log(`[${row.authority}] ${row.text}  <- ${row.sourceKind}`);
}
