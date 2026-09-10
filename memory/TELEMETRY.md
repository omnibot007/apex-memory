# APEX MEMORY — TELEMETRY (where the receipts live)

Every god-round appends JSONL. No log, no learning. Schemas:

## legs.jsonl (~/.commandcode/fam-gods/)
`{ts, leg, model, ok, cost, tried[]}` per failover completion; failures carry
the packet (`failures[]`). Writer: apex-pantheon/legs.ts `tele()`.

## cli-legs.jsonl (~/.commandcode/fam-gods/)
`{ts, leg, ok, wallMs, chars}` per CLI run. Writer: apex-pantheon/cli-legs.ts.

## guard log (planned)
Per-answer `{model, verdict, latency, reasons}` beside the above. Feeds the
monthly harvest (misses become custom-detector candidates).

## Corpus + calibration
- Session harvest: `SIMURG/examples/harvest_sessions.py` (transcripts + md vaults).
- Corpora live in temp during runs; sidecars ship in SIMURG weights/.
- Current sidecar: 890-text calibration (FPR 0.000). Recalibrate monthly.

## Dashboard rule
Counts and deltas may print. Content prints only with operator approval.
Secrets print NEVER (paths + lengths only).
