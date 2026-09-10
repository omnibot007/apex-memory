---
name: apex-pantheon
description: "Command the guarded god-pack: split any task across free-model legs, guard every output with SIMURG, return one verified ruling for $0. Use when the user says pantheon, gods, run the pack, do a task cheap, drive free models, guard the run, or gives a mission with cost or quality constraints. Does NOT fire for single static fetches, code review, explaining repos, or anything one reply handles."
---

# /apex-pantheon — one sentence in, guarded truth out

$ARGUMENTS is the mission. If empty, resolve from session context or ask one
question and wait. You command free-model legs; SIMURG frisks everything;
the operator gets one ruling. Cost target: $0 unless the operator approves spend.

## Wave 1 — split (no models burned yet)

Carve the mission into non-overlapping god-tasks (fewest gods that cover it,
2-4 sweet spot). State the split + who is benched and why. Each god gets a
SELF-CONTAINED brief: one falsifiable done-condition, file paths, scope fence,
and the return contract: VERDICT + RECEIPTS + HANDOFF FACTS (10 max).

## Wave 2 — drive (free legs first, always)

Leg order: openrouter-free, groq, cerebras, zenfree, cline-cli, kilo-cli,
pollinations (keyed), then Go paid fallback ONLY on free-leg failure or
explicit approval. Legs live in the fam-gods repo (legs.ts, cli-legs.ts);
keys arrive via files, never chat (see /keywire). Respect free-tier limits
(20-30 RPM typical) — terse prompts, no chatter between gods, handoff facts
only. Quota/429 hit = rotate legs, never hammer.

## Wave 3 — frisk (the conscience)

Every leg output passes SIMURG with fam weights before it counts:
CLEAN ships, SUSPECT ships flagged with the warning, CORRUPT regenerates
unseen (one retry, then model/leg swap). ActionTracker benches stuck gods
(same action x6, thin-output stalls). Abort + retry + fallback is the ladder;
first clean wins. No leg self-certifies. Ever.

## Wave 4 — the word (final ruling)

```
# PANTHEON REPORT: <mission>
OUTCOME: done / partial / blocked — one sentence
FINDINGS: merged result with sources
SPEND: $ total + per-leg (free legs show $0)
GUARD: verdicts + retries + swaps (quoted reasons)
TELEMETRY: logged where (legs.jsonl, cli-legs.jsonl, guard log)
NEXT: <=3 unexecuted followups
```

## Laws

- Free first, paid on approval. Every paid token reported, no exceptions.
- No secrets in prompts, logs, or rulings. Paths and env names only.
- Two strikes on one leg → rotate, report the packet, continue.
- Telemetry every round (leg, model, verdict, latency, cost) — starves the
  calibration flywheel otherwise. Corpus grows monthly; sidecars versioned.
- Bench the ceremony when the mission dies early or raw output was asked.
- Lineage: legs pi-ai (MIT (c) 2025 Mario Zechner) · guard SIMURG (Apache-2.0,
  (c) doofZ/HAL-X AI) · bodies Cline/Kilo CLIs (their accounts, their quotas).
