import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const server = path.join(here, '..', 'dist', 'mcp.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-mcp-smoke-'));

const child = spawn(process.execPath, [server], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, APEX_MEMORY_HOME: sandbox },
});

let out = '';
child.stdout.on('data', (b) => (out += b.toString()));
child.stderr.on('data', (b) => process.stderr.write(`[server] ${b}`));

const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1.0.0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

const SOURCE = 'operator: cap retries at three, we are hammering upstream';
send({
  jsonrpc: '2.0',
  id: 3,
  method: 'tools/call',
  params: {
    name: 'custody_record',
    arguments: {
      project: 'smoke',
      kind: 'decision',
      text: 'retries capped at three',
      quote: 'cap retries at three',
      sourceText: SOURCE,
      sourceKind: 'user-decision',
      claimedAuthority: 'policy',
      sourceLocator: 'smoke:1',
      sourceSession: 'smoke',
    },
  },
});
send({
  jsonrpc: '2.0',
  id: 4,
  method: 'tools/call',
  params: {
    name: 'custody_record',
    arguments: {
      project: 'smoke',
      kind: 'fact',
      text: 'the model is certain about this',
      quote: 'cap retries at three',
      sourceText: SOURCE,
      sourceKind: 'assistant-claim',
      claimedAuthority: 'fact',
      sourceLocator: 'smoke:2',
      sourceSession: 'smoke',
    },
  },
});
send({
  jsonrpc: '2.0',
  id: 5,
  method: 'tools/call',
  params: { name: 'custody_recall', arguments: { project: 'smoke' } },
});

setTimeout(() => {
  child.kill();
  const lines = out.split('\n').filter((l) => l.trim().length > 0);
  const byId = new Map();
  for (const line of lines) {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined) byId.set(msg.id, msg);
    } catch {
      /* partial frame */
    }
  }

  const init = byId.get(1);
  const tools = byId.get(2);
  const admitted = byId.get(3);
  const refused = byId.get(4);
  const recalled = byId.get(5);

  const textOf = (m) => m?.result?.content?.[0]?.text ?? JSON.stringify(m?.error ?? m ?? null);

  console.log('INIT server:', init?.result?.serverInfo?.name ?? 'MISSING');
  console.log('TOOLS:', (tools?.result?.tools ?? []).map((t) => t.name).join(', ') || 'MISSING');
  console.log('RECORD user-decision ->', textOf(admitted));
  console.log('RECORD assistant-claim-as-fact ->', textOf(refused));
  console.log('RECALL ->', textOf(recalled));

  const ok =
    init?.result?.serverInfo?.name === 'apex-memory' &&
    (tools?.result?.tools ?? []).length === 5 &&
    textOf(admitted).startsWith('admitted') &&
    textOf(refused).includes('REFUSED') &&
    textOf(recalled).includes('retries capped at three');
  console.log(ok ? 'SMOKE: PASS' : 'SMOKE: FAIL');
  fs.rmSync(sandbox, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}, 4000);
