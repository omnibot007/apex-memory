# apex-memory

**A write-side custody gate for agent memory. Authority is computed from the source — never claimed by the writer.**

Most agent memory systems store what a model *said*. This one asks a different question
before anything is persisted:

> Can this **source** establish the **authority** this writer is claiming?

If the answer is no, the write is refused at the door.

---

## The problem this solves

Frontier design review named the failure mode **epistemic laundering**:

> an assistant hypothesis becomes a quoted "fact", is retrieved as prior knowledge, then
> gets re-cited until repetition masquerades as independent confirmation

"Cite your sources" does not fix this, for two reasons:

1. **A quote proves a source said something — not that it was true.**
2. **Provenance written into a memory record is forgeable.** This is not theoretical;
   there are published, runnable probes demonstrating it (see [LINEAGE.md](./LINEAGE.md)).

So `apex-memory` never trusts a provenance field, because there is no provenance field
to trust. It derives provenance itself, at admission, from source material the caller
must hand over.

---

## The ceiling table

Every fact declares where it came from. That decides the maximum authority it can ever carry.

| Source kind | Ceiling | Why |
|---|---|---|
| `user-decision` | `policy` | Only the operator sets binding rules. |
| `verified-command` | `fact` | A command ran; its output is held. |
| `code-read` | `observation` | True at a revision. Code moves; needs revalidation. |
| `assistant-claim` | `conjecture` | A model asserting something is not evidence. |
| `repo-content` | `conjecture` | Prompt-injection defence: repository text can never become operator policy. |

Claim more than your source can carry and you get `authority-exceeds-source`. There is
no override, no flag, no escape hatch. That is the entire point.

---

## Four guarantees

**1. Provenance is computed, not accepted.**
`admitCustody` requires the caller to supply the retained `sourceText`, verifies the
quote occurs verbatim inside it, then derives `sourceDigest` and `quoteDigest` with
`node:crypto`. A quote that is not in its source is refused with `quote-not-in-source`.

**2. Nothing is ever overwritten.**
`supersede()` marks a row and writes it back. Superseded decisions and rejected
approaches stay queryable forever — they simply stop carrying authority. Append-only
store, supersession enforced at retrieval.

**3. It abstains rather than guesses.**
With `requireCorroboration`, a claim needs **two distinct non-conjecture sources**. Two
assistant claims never corroborate each other. If the evidence is not there, recall
returns nothing instead of something weak.

**4. Compaction is explicit and never silent.**
A memory store with no compaction does not stay honest — it silently truncates, and
truncation eats the tail, where the newest entries live. `compactProject` archives
duplicates, ages out superseded rows, enforces a live-row budget, **never evicts a
`policy` fact**, and returns a report with a number attached to every eviction.

---

## Install

```bash
npm install @omninbot/apex-memory
```

> **Note the scope.** The unscoped name `apex-memory` on npm belongs to an unrelated
> project by a different author. Installing that will not give you this library.

## Library use

```ts
import { JsonlCustodyStore, record, recallInForce, CustodyRefusedError } from '@omninbot/apex-memory';

const store = new JsonlCustodyStore();

await record(store, {
  project: 'my-service',
  kind: 'decision',
  text: 'retries are capped at three',
  quote: 'cap retries at three',
  sourceText: 'operator: please cap retries at three, we are hammering the upstream',
  sourceKind: 'user-decision',
  claimedAuthority: 'policy',
  sourceLocator: 'session:9f2#41',
  sourceSession: '9f2',
  validFromMs: Date.now(),
  recordedAtMs: Date.now(),
});

const inForce = await recallInForce(store, 'my-service', { requireCorroboration: true });
```

Try to launder a guess and it throws:

```ts
await record(store, {
  ...,
  sourceKind: 'assistant-claim',
  claimedAuthority: 'fact',
});
// CustodyRefusedError: custody refused: authority-exceeds-source
//                      (source 'assistant-claim' tops out at 'conjecture')
```

## MCP server — works in any harness

Claude Code, Codex, Cursor, OpenCode, Windsurf, or anything else that speaks MCP:

```json
{
  "mcpServers": {
    "apex-memory": {
      "command": "npx",
      "args": ["-y", "@omninbot/apex-memory", "apex-memory-mcp"]
    }
  }
}
```

Tools exposed:

| Tool | Does |
|---|---|
| `custody_record` | Persist a fact through the gate. |
| `custody_check` | Dry-run the gate — *would* this be admitted, and at what authority? |
| `custody_recall` | Read in-force memory. Superseded and archived rows never returned. |
| `custody_supersede` | Retire a fact without deleting it. |
| `custody_compact` | Archive duplicates, age out superseded rows, enforce the budget. |

Storage defaults to `~/.apex-memory/custody.jsonl`. Override with `APEX_MEMORY_HOME`.

## Automatic capture across every harness

```bash
apex-memory-distill --dry-run     # see what would be captured
apex-memory-distill               # sweep and write
```

One sweep reads **every** harness on the machine, whichever one triggered it:

| Harness | Store it reads |
|---|---|
| Claude Code | `~/.claude/projects/<slug>/<session>.jsonl` |
| kimi-code | `~/.kimi-code/sessions/**/agents/*/wire.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) |

It is **idempotent** — a second sweep writes nothing — which is why no per-harness hooks
are needed. Wire it to one trigger you already have and every harness is covered.

Two things worth knowing:

**It writes at `observation`, not `policy`.** `user-decision` *permits* `policy`, but
measured over 1,223 real utterances, surface markers cannot separate a standing rule from
a one-off task — "make sure X" is how people phrase both. So the distiller records that
you said something (true, quoted, attributable) and declines to assert that it binds.
Promotion is a deliberate act: `--authority policy`, or a `custody_record` call you make
on purpose. Agents propose; humans promote.

**A live OpenCode locks its database, and SQLite reports that lock as
`SQLITE_NOTADB` — "file is not a database"** — which reads exactly like corruption or
encryption and is neither. The reader snapshots `.db`, `-wal` and `-shm` together to a
temp directory and reads the copy.

---

## What this is not

- **Not a RAG pipeline.** No embeddings, no vector store, no LLM in the read path.
- **Not a benchmark winner.** No scores are claimed here. The agent-memory benchmark
  field has a documented credibility problem, and unverified numbers are exactly the
  kind of thing this library exists to refuse.
- **Not finished.** See "Known limits" below. Honest limits, with paths through.

## Known limits

- Corroboration counts distinct `sourceLocator` values from non-conjecture sources. It
  does not yet detect that two "independent" sources derive from the same upstream.
- No semantic retrieval. Recall is filter-and-order, not ranking. Deliberate for v0.1 —
  the filters are the product; ranking can be layered on top.
- `code-read` facts are capped at `observation` but not automatically revalidated when
  the underlying file changes. The digest is stored; the check is not yet wired.

## Licence

MIT. See [LICENSE](./LICENSE). Credits for every borrowed idea are in
[LINEAGE.md](./LINEAGE.md) — **no donor code was read or copied**, only published
mechanism descriptions.
