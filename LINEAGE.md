# Knowledge lineage

Every mechanism in this library is credited below to the project whose **published
description** taught it.

## The one thing to be clear about

**No source file from any project listed here was read, opened, copied, adapted, or
vendored.** This library was written clean-room in TypeScript from each project's own
one-line public capability description, as published in the curated survey
[`TeleAI-UAGI/Awesome-Agent-Memory`](https://github.com/TeleAI-UAGI/Awesome-Agent-Memory).

Mechanisms and architectural ideas are not copyrightable; expression is, and none was
taken. Credit is given anyway, because the ideas are theirs and a credit line costs
nothing.

## Credits

| Idea implemented here | Credited to | Their published description |
|---|---|---|
| Write-side admission boundary | [kenwalger/memory-stack-patterns](https://github.com/kenwalger/memory-stack-patterns) (MIT, © Ken Walger) | "an admission boundary that decides whether a source may establish the authority a writer claims" |
| Provenance is forgeable; corroborate at retrieval | **inspeximus** (formerly mnemo) | "provenance written into a memory record is forgeable... a retrieval-time corroboration gate raises the cost of memory-poisoning attacks" |
| Serve only in-force knowledge after validity + supersession checks | **Data Olympus** | "agents propose learnings, humans promote them, and MCP retrieval serves only in-force knowledge after validity and supersession checks" |
| Bitemporal storage, deterministic supersession, point-in-time recall | **Lians agent memory**; [getzep/graphiti](https://github.com/getzep/graphiti) | "bitemporal... deterministic supersession, point-in-time recall"; "bi-temporal tracking with automatic fact invalidation" |
| Immutable store where superseded decisions stay queryable | **kgai** | "superseded decisions and rejected approaches stay queryable" |
| Append-only, nothing overwritten | [mem0ai/mem0](https://github.com/mem0ai/mem0) (Apache-2.0, © Mem0 AI) | "single-pass ADD-only extraction — one LLM call, no UPDATE/DELETE. Memories accumulate; nothing is overwritten." |
| Abstention when evidence is insufficient | **RE-call** | "provenance, trust verdicts... and abstention when evidence is insufficient" |
| Budget guard against silent truncation | **claude-memory-tidy** | "deterministic budget guard... guarding against silent truncation" |
| Health linting / never mass-delete | **Verified Memory Vault** | "deterministic health-score linter... plus a git pre-commit hook refusing mass deletions" |
| Write-time screening as a security control | **Agent Memory Guard** (OWASP) | "screens agent memory writes for poisoning: multi-layer validation with semantic anomaly detection, entropy scoring, and provenance verification" |
| Source-kind authority tiers; the "epistemic laundering" framing | GPT-6-Astra design review, 2026-09-09 | "an assistant hypothesis becomes a quoted 'fact', is retrieved as prior knowledge, then gets re-cited until repetition masquerades as independent confirmation" |

## Licence status of the donors

MIT verified for `kenwalger/memory-stack-patterns`. Apache-2.0 verified for `mem0ai/mem0`.
Licences for Data Olympus, inspeximus, Lians, kgai, RE-call, claude-memory-tidy,
Verified Memory Vault and Agent Memory Guard were **not read** — they did not need to be,
because nothing was taken from them.

**Standing order:** if code is ever ported from any of these projects, its LICENSE must
be read first and a holder / year / licence line added to this file before that port
ships.

## Prior art this does not claim to beat

The agent-memory field is crowded and several of the projects above implement parts of
this design more completely. What is combined here — a computed-authority ceiling table,
digest-verified quotes, append-only supersession, and weighted corroboration with
abstention, in one small dependency-light package with an MCP front door — is the
contribution. The parts are not novel and are not presented as such.

No benchmark scores are claimed. The field has a documented credibility problem with
self-reported memory benchmarks, and publishing unverified numbers would contradict the
entire premise of this library.
