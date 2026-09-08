# myc

A local, fast task-and-memory layer for coding agents: a task queue, an oplog of
facts and decisions, and hybrid (lexical + vector) search over the project's
memory — with no network calls and no mandatory LLM key.

Agents forget. `myc` is the part that doesn't: decisions survive context
compaction, work survives process death, and both survive being moved between
machines through plain git.

Design docs live in `docs/design/` (start with `00-brief.md`); the measurements
quoted below are reproducible from `bench/` and `scripts/`.

**Site: <https://aistastudio.github.io/myc/>** — the same measurements as charts,
in English and Russian, with the command that reproduces each number printed
next to it. Source in `site/`; `bun run site/build.ts` re-checks every figure
against the measurement artefacts in this repository and refuses to build on a
mismatch.

## Requires Bun — this is not fine print

The runtime is bound to `bun:sqlite` (SQLite and `sqlite-vec` ship inside Bun,
with no native bindings on the Node side). **It will not start on plain Node.js
or Deno.** Bun ≥ 1.3.0 is required and pinned in `package.json` → `engines.bun`.

Install Bun: https://bun.sh

## Install

Once published, installation is one command — the package is built and verified
from a tarball today, but nothing has been pushed to the registry yet:

```bash
bun install -g @aistastudio/myc   # 3.17 MB, 10 files, no models pulled at install
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
nodes, 2026-09-07, darwin-arm64-14 (`bun run scripts/bench-latency.ts`):

| operation | p99 | budget |
|---|---|---|
| `prime` (session context) | 0.755 ms | 30 ms |
| read | 0.012 ms | 3 ms |
| search | 10.354 ms | 25 ms |
| write | 0.460 ms | 5 ms |
| cold start | 23.820 ms | 60 ms |

**Ranking is measured, not asserted.** Two labelled corpora with graded
relevance, each containing a *control group that gets worse* when the feature
works — so a gain cannot be manufactured by shaping the corpus:

- boosts (priority, freshness, layer): MRR@10 **0.520 → 0.867** (`bench/boost-eval.ts`)
- graph expansion to 2 hops: MRR@10 **0.193 → 0.422** (`bench/graph-eval.ts`),
  and a query group unreachable in one hop goes 0.000 → 0.333

**Caching that cannot go stale silently.** Result, embedding and hydration
caches are invalidated by `MAX(oplog.seq)` read *from the database*, so a write
by another process invalidates them too. A cache hit is two orders of magnitude
cheaper than a miss — 252× in the run of 2026-09-07, ≈27 000× for embeddings;
the ratio is wall-clock and moves with the machine. The ranking does not: same
MRR to three decimals, zero rank differences.

**Memory survives context compaction.** `myc wire` installs a pre-compact hook,
so the moment before an agent's context is squeezed the session episode is
written to disk — raw, `L0`, `acl private`, secrets masked — and a rescue
packet is printed back into the context that survives. Distillation is queued,
never done on the write path. The episode is on disk before anything else is
attempted, so exceeding the hook's timeout costs the summary, not the record:

```
$ myc absorb-session --reason manual --transcript … --agent claude
# myc: контекст сжимается — вот что нельзя потерять
эпизод sess-5jh8je4g050m сохранён (265 Б)
ДАЛЬШЕ   myc show sess-5jh8je4g050m · myc ready --claim
```

**Memory is separated by session, and the separation is visible.** Every note
carries a reach: `session` (this conversation) or `project` (everyone). The
automatic context packet — `prime` — only carries the current session's notes;
another agent's session does not leak into yours. An explicit `myc recall`
still finds them, because hiding knowledge is not the same as scoping it, and
marks each row for what it is: `ses` own session, `ses*` someone else's, `prj`
project-wide.

```
$ MYC_SESSION_ID=s1 myc recall "ретраи"      $ MYC_SESSION_ID=s2 myc recall "ретраи"
1.30 … ses  сессионное: ретраи…              1.30 … ses* сессионное: ретраи…
1.10 … ses* в сессии один: ретраи…           1.10 … ses* в сессии один: ретраи…
```

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
889 ms: 796 tasks, 972 dependencies, 265 notes, 41 memories — with unknown
issue types carried over verbatim and named, and out-of-range priorities
clamped and named, instead of one odd row aborting the import. On that same
graph `myc ready` offers 195 tasks and `bd ready` offers 144: beads inherits
blockers down the parent chain and myc does not yet, so beads is right about
those 51 (open bug `memory-atcm254ry6c7`).

**Guards are proved by mutation.** Every refusal and every invariant is
accompanied by a mutation that removes it; a guard whose removal breaks no test
is treated as absent.

## Roadmap

Numbers are closed/total subtasks per milestone (`myc show <epic-id>`), as of
2026-09-08. Done and not-done are shown the same way on purpose. Totals grow
when work uncovers work: M0 went 33 → 39 because measuring it found four real
defects, not because the plan changed.

| milestone | status |
|---|---|
| **M0** core and tasks | 35 / 39 |
| **M0.5** self-hosting (myc developed through myc) | **4 / 4 — closed** |
| **M1** memory | 21 / 23 |
| **M2** semantics | 17 / 20 |
| **M7** human interface (board, cards, threads, routing panel) | 13 / 14 |
| **M3** code intelligence | 5 / 9 |
| **M4** team: `myc serve`, ACL, network sync, Postgres, containers | 3 / 14 |
| **M5** swarm self-learning: routing by cost and outcome | 0 / 12 |
| **M6** distillation | 0 / 7 |

What that means in practice: **today myc is a single-user local tool over files
in git.** There is no server, no ACL and no team mode. Those are designed
(`docs/design/03…`, `04…`, `05…`) and tracked, not implemented.

Code↔knowledge anchors now work: `myc task "…" --anchor src/file.ts:10-20`
binds a task to a span, and the anchor follows the code as it moves. The
binding is language-agnostic — it was verified on Python as well as
TypeScript. What is *not* there yet is symbol-level understanding: parsing
functions and classes covers `ts/tsx/js/jsx` only, and the symbol index is
built but not yet wired to any command (tracked, not hidden).

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
Both languages, with charts: <https://aistastudio.github.io/myc/>.
