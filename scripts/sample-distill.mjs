import { allReaders } from '../dist/readers.js';
import { decisionsFrom } from '../dist/distill.js';

const perHarness = Number(process.argv[2] ?? 8);
const buckets = new Map();

for (const reader of allReaders()) {
  if (!reader.available()) continue;
  for (const u of reader.read()) {
    for (const sentence of decisionsFrom(u.text)) {
      const list = buckets.get(u.harness) ?? [];
      if (list.length < perHarness) list.push({ project: u.project, sentence });
      buckets.set(u.harness, list);
    }
  }
}

for (const [harness, rows] of buckets) {
  console.log(`\n===== ${harness} (${rows.length} shown) =====`);
  for (const r of rows) {
    console.log(`[${r.project}] ${r.sentence.slice(0, 150).replace(/\s+/g, ' ')}`);
  }
}
