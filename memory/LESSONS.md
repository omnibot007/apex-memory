# APEX MEMORY — LESSONS (scars paid on this box, so nobody pays twice)

1. Cloudflare 1010 beats python-urllib default UA. Fix: overwrite (never
   append) User-Agent + stable session header. Receipt: Go legs-ready.
2. Go gateway demands x-opencode-session or 400s. Stable per conversation.
3. GuardedLLM base_url must EXCLUDE /chat/completions (it appends; doubled = 404).
4. request_extra lands in the BODY, not headers (read openai_guard.py).
5. Em-dash breaks PS5.1 parser on BOM-less files. ASCII-only scripts.
6. Bare colon in YAML frontmatter kills skill loading. Quote descriptions.
7. execFile cannot close stdin (node#60077); CLIs wait on open pipes forever.
   Fix: spawn + stdio ignore. CLI legs live because of this line.
8. Clean corpora: p99 shingle counts hit 1.0 — lone max-count rules MUST cap
   corroboration-only. Measured, not guessed (890 texts).
9. SUSPECT never aborts (production ladder passes it). Metrics count CORRUPT only.
10. Truncated texts fake drift flags. FPR probes use full texts.
11. No bulk work without a re-read: phantom --format-json flag died by read-back.
12. Test sentences: count your chars (39 vs 40 floor bit us).
13. Free tiers lie in March lists: llama-3.3 retired, pollinations keyless dead.
    Live catalog pulls before trusting any list. TokenRouter key rejected 401.
14. icacls /grant is flaky here; .NET FileSecurity locks files reliably.
15. Measure-Command swallows scriptblock output. Time with Stopwatch to files.
16. Rite-discipline (2026-09-09, self-conviction x2): ran a recon mission wearing
    the omnibrother name while violating it twice over — wrong roster
    (apex role-names under an omni invocation), no tiers declared, no separate
    Nemesis (graded own homework), and wrong rite entirely (/apex-pantheon is a
    MISSION-driving liturgy: legs+guard+ruling; recon without legs/guard never
    triggers it). Intel survived by brute force, not by rite. Law going forward:
    recon goes /gods-true (seven named gods, declared tiers, blackbox Nemesis);
    missions go /apex-pantheon verbatim (Wave 2 burns real legs, Wave 3 Simurg
    verdicts every output, Wave 4 SPEND/GUARD/TELEMETRY receipt). A pantheon
    that skips its own laws is expensive randomness. Never again.
17. Tier honesty: this harness offers fixed subagent types — declare the actual
    driver model for every god summoned. Fake haiku/opus labels are stolen valor.
