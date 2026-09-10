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

Installation is one command:

```bash
bun install -g @aistastudio/myc   # 3.20 MB, 10 files, no models pulled at install
myc --version                     # myc 0.3.1 (schema 1)
```

The embedding model is **not** downloaded during install. Semantic search is
opt-in and explicit: `myc models fetch` (129 MB, ~7 s). Until then search is
lexical and says so.

To run the newest code instead of the published release, build from source:

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
./dist/myc wire                     # hooks for Claude Code / Codex / opencode / Kimi
./dist/myc ready                    # what can be picked up right now
./dist/myc remember "why X, not Y"  # record a fact or decision
./dist/myc recall "how retrieval works"
./dist/myc prime                    # session context packet (agents call it)
./dist/myc doctor                   # schema, counters, hooks — says "don't know" where it doesn't
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

**A status line with what the agent cannot see.** `myc wire --status-line`
puts one line under Claude Code's prompt — the task queue, the code index, the
project's memory, and how many of this session's calls to myc actually returned
something:

```
myc │ 61 ready · 34 blocked │ 612 files · 4268 symbols · 1h ago │ 101 notes │ 600/653 useful calls
```

"Useful" is counted from the host's own transcript, not guessed: an error, a
refusal or an empty answer is a call, not a useful one. It is opt-in — `wire`
without the flag never touches `statusLine` — and it does not evict a line that
was there before: the previous command (a status line some other tool relies
on) keeps receiving the same input and is never waited on or killed. A render
took 34 ms at the median in the run of 2026-09-10.

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
graph both queues now return the same 152 tasks. They did not always: myc used
to offer 195 against beads' 144, because beads inherits blockers down the
parent chain and myc looked only at a task's own. Those 51 were inside a
still-blocked epic and beads was right to hide them; `memory-atcm254ry6c7` is
closed, `anc_blockers` is materialised by trigger, and the queue now says
`281 blocked (51 through an ancestor)` rather than quietly offering them.

**Guards are proved by mutation.** Every refusal and every invariant is
accompanied by a mutation that removes it; a guard whose removal breaks no test
is treated as absent.

## Roadmap

Numbers are closed/total subtasks per milestone (`myc show <epic-id>`), as of
2026-09-10. Done and not-done are shown the same way on purpose. Totals grow
when work uncovers work: M0 went 33 → 39 because measuring it found four real
defects, not because the plan changed.

| milestone | status |
|---|---|
| **M0** core and tasks | 40 / 43 |
| **M0.5** self-hosting (myc developed through myc) | **4 / 4 — closed** |
| **M1** memory | 22 / 24 |
| **M2** semantics | 20 / 22 |
| **M7** human interface (board, cards, threads, routing panel, status line) | **15 / 15** |
| **M3** code intelligence | 6 / 10 |
| **M4** team: `myc serve`, ACL, network sync, Postgres, containers | 3 / 14 |
| **M5** swarm self-learning: routing by cost and outcome | 0 / 13 |
| **M6** distillation | 0 / 7 |

What that means in practice: **today myc is a single-user local tool over files
in git.** There is no server, no ACL and no team mode. Those are designed
(`docs/design/03…`, `04…`, `05…`) and tracked, not implemented.

Code intelligence is built in, and it is the same engine the alternatives use:
tree-sitter, with grammars fetched on demand rather than shipped (all 36 weigh
49 MB against a 12 MB package). `myc code index` builds it — on this repository,
826 files and 3 949 symbols in 904 ms — and four commands read it:

```
myc code symbol <name>   where it is defined, and what knowledge is anchored there
myc callers <name>       who calls it; --direction out, --depth all
myc code search "…"      by meaning, when you do not know the name
myc code grep "<lit>"    exhaustive, every occurrence; --in <path> narrows it
myc skeleton <file>      the file's API — 26× cheaper than reading it
```

Anchors tie knowledge to a span and follow the code as it moves; that half is
language-agnostic and was verified on Python as well as TypeScript.

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
