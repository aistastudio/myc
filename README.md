# myc

A local, fast task-and-memory layer for coding agents: a task queue, an oplog of
facts and decisions, and hybrid (lexical + vector) search over the project's
memory — with no network calls and no mandatory LLM key.

Agents forget. `myc` is the part that doesn't: decisions survive context
compaction, work survives process death, and both survive being moved between
machines through plain git.

Design docs live in `docs/design/` (start with `00-brief.md`); the measurements
quoted below are reproducible from `bench/` and `scripts/`.

## Requires Bun — this is not fine print

The runtime is bound to `bun:sqlite` (SQLite and `sqlite-vec` ship inside Bun,
with no native bindings on the Node side). **It will not start on plain Node.js
or Deno.** Bun ≥ 1.3.0 is required and pinned in `package.json` → `engines.bun`.

Install Bun: https://bun.sh

## Install

Once published, installation is one command — the package is built and verified
from a tarball today, but nothing has been pushed to the registry yet:

```bash
bun add @aistastudio/myc     # 3.16 MB, 9 files, no models pulled at install
bunx myc --version
```

The embedding model is **not** downloaded during install. Semantic search is
opt-in and explicit: `myc models fetch` (129 MB, ~7 s). Until then search is
lexical and says so.

Until it is published, build from source:

```bash
git clone <repo> && cd myc
bun install
bun run build          # produces a single binary: dist/myc
./dist/myc --version
```

Put the binary somewhere `myc wire` can find it — `MYC_BIN`, `node_modules/.bin`,
`~/.myc/bin/myc`, or `PATH`. If it can't, `wire` says so out loud instead of
writing a config that silently won't start.

## Quick start

```bash
./dist/myc init                     # .myc/ + SQLite + migrations in this repo
./dist/myc wire                     # hooks for Claude Code / Codex / opencode
./dist/myc ready                    # what can be picked up right now
./dist/myc remember "why X, not Y"  # record a fact or decision
./dist/myc recall "how retrieval works"
./dist/myc prime                    # session context packet (agents call it)
```

Full command list: `./dist/myc --help`.

## What makes it different

**Speed is a constraint, not an optimisation.** Every hot path has a budget
enforced in CI; a p95 regression over 15% fails the build. Measured on 100 000
nodes (`bun run scripts/bench-latency.ts`):

| operation | p99 | budget |
|---|---|---|
| `prime` (session context) | 0.70 ms | 30 ms |
| read | 0.011 ms | 3 ms |
| search | 9.1 ms | 25 ms |
| write | 0.5 ms | 5 ms |
| cold start | 24 ms | 60 ms |

**Ranking is measured, not asserted.** Two labelled corpora with graded
relevance, each containing a *control group that gets worse* when the feature
works — so a gain cannot be manufactured by shaping the corpus:

- boosts (priority, freshness, layer): MRR@10 **0.520 → 0.867** (`bench/boost-eval.ts`)
- graph expansion to 2 hops: MRR@10 **0.193 → 0.422** (`bench/graph-eval.ts`),
  and a query group unreachable in one hop goes 0.000 → 0.333

**Caching that cannot go stale silently.** Result, embedding and hydration
caches are invalidated by `MAX(oplog.seq)` read *from the database*, so a write
by another process invalidates them too. A cache hit is 162–198× cheaper than a
miss (≈25 000× for embeddings) and the ranking is bit-identical: same MRR to
three decimals, zero rank differences.

**Memory has three independent axes**, and the surface says what it hid:
tier (project vs personal), session reach, repository reach. `prime` prints
`N notes from other repositories hidden` rather than quietly narrowing results.

**Degradation is loud.** No silent fallbacks: when the vector branch is
unavailable the output says so and marks the answer as lexical-only; when a
budget is exceeded it is named with the number. The invariant is that a
degraded answer must never be indistinguishable from a healthy one.

**Multi-machine sync through plain git, merged per field.** Only the oplog is
committed. Two machines editing the same node converge: one changes title and
priority, the other title and tags — after exchange both show the later title,
the first machine's priority and the second's tags. Nothing is lost to
last-writer-wins over whole records.

**Migration from beads is real, not a demo.** A working project imported in
684 ms: 796 tasks, 972 dependencies, 265 notes, 41 memories — with unknown
issue types carried over verbatim and named, and out-of-range priorities
clamped and named, instead of one odd row aborting the import.

**Guards are proved by mutation.** Every refusal and every invariant is
accompanied by a mutation that removes it; a guard whose removal breaks no test
is treated as absent.

## Roadmap

Numbers are closed/total subtasks per milestone (`myc show <epic-id>`), as of
2026-09-07. Done and not-done are shown the same way on purpose.

| milestone | status |
|---|---|
| **M0** core and tasks | 30 / 33 |
| **M0.5** self-hosting (myc developed through myc) | **4 / 4 — closed** |
| **M1** memory | 20 / 23 |
| **M2** semantics | 15 / 19 |
| **M7** human interface (board, cards, threads, routing panel) | 11 / 13 |
| **M3** code intelligence | 0 / 7 |
| **M4** team: `myc serve`, ACL, network sync, Postgres, containers | 0 / 11 |
| **M5** swarm self-learning: routing by cost and outcome | 0 / 12 |
| **M6** distillation | 0 / 7 |

What that means in practice: **today myc is a single-user local tool over files
in git.** There is no server, no ACL, no team mode, and no code↔knowledge
anchors yet. Those are designed (`docs/design/03…`, `04…`, `05…`) and tracked,
not implemented.

## Syncing between machines

Only the oplog goes to git (`myc export` → `.myc/graph`, `myc import` on
clone) — never derived projections or caches. `.myc/workspace.toml` and the
oplog are committed deliberately; `.myc/myc.db*` and local state are not.

Register the merge driver once per clone:

```bash
git config merge.myc-oplog.driver "myc merge-driver %O %A %B %L %P"
```

## License

MIT — see [`LICENSE`](LICENSE). Chosen for the lowest possible friction for
anyone embedding or forking this; every runtime dependency (Bun, ONNX Runtime,
sqlite-vec) is permissive too.

---

Russian version of this document: [`docs/README.ru.md`](docs/README.ru.md).
