# APEX MEMORY — STATE (single source of truth, updated after every mission)

## Pack roster (legs truth table, 2026-09-09)
LIVE ($0): openrouter-free x3 (nemotron-lightning, north-mini-code, nemotron-ultra),
go-paid-fallback x2 (deepseek-flash, glm-flash), groq (qwen3.8-27b),
cerebras (qwen3.8-27b), zenfree (nemotron-lightning-free exact-match),
cline-cli (cline-free/muse-spark-1.3-contributor), kilo-cli (deepseek-flash-free).
PENDING KEYS: pollinations (free key signup). PARKED: tokenforge (Opus-5 only),
Cline/Kilo APIs (in-app only, CLI-driven instead).

## Guard (SIMURG buff/fam-guard on omnibot007/SIMURG)
Calibration: fam sidecar from 890 own texts (FPR 0.000, AUROC 1.0).
Hell-week: slow/mixed/short/code trials green; defended FPR 0.051 (documented).
Watch item: repetition 12/14 (split-noise suspect, telemetry will confirm).

## Keys (paths only — values never enter this repo)
.go-key, .groq-key, .cerebras-key, .tokenforge-key, .tokenrouter-key
(all in ~/.config/opencode/, owner-only ACL). Missing: pollinations.

## Pack-2 (built 2026-09-09, per operator orders)
LIVE: kilo-anon keyless (nemotron-free exact-match, first in pool),
OVH anon trickle (chat 429'd, rotation absorbs until quota returns).
Retired: kilo-CLI subprocess (superseded by kilo-anon direct).
Hardening: per-leg 90s timeouts, 3-strike circuit breaker, 5MB telemetry
rotation. PARKED per operator: tokenrouter (leg removed from pool),
gemini (awaiting better keys from operator), ollama (awaiting model pick).
Go-pennies independent judge: queued (SIMURG side).

## Cloud (wired 2026-09-09)
Workers AI leg PROVEN (llama-3.1-8b answers, account 6d329e..bf3fdbc, key
.cloudflare-key locked). REST shape is NOT OpenAI-compatible (/ai/run/) — needs
a custom pi-ai provider impl before joining rotation. Wrangler 4.130.0 installed,
operator login pending. Agents-starter scaffold + first god port: next cook.

## Pending missions
1. REBOOT (hypervisor fix) -> Docker -> Steel legs -> first live fam-browser drive.
2. Guard-abort drill + god-loop join (Pi loop shape read at cook).
3. README for fam-gods + tokenrouter re-key + pollinations key.
4. Monthly: harvest -> recalibrate -> hell-week -> sidecar.

## Laws of this memory
- Facts carry receipts (command + output) or they don't enter.
- Confidence tagged: (Verified) artifact-read / (Confident) / (Speculative).
- Secrets never: paths and lengths only.
