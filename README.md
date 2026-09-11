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
myc --version                     # myc 0.3.3 (schema 1)
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
./dist/myc wire --scope user        # the same for agents in git worktrees (Claude Code's user layer)
./dist/myc ready                    # what can be picked up right now
./dist/myc remember "why X, not Y"  # record a fact or decision
./dist/myc recall "how retrieval works"
./dist/myc prime                    # session context packet (agents call it)
./dist/myc doctor                   # schema, counters, hooks — says "don't know" where it doesn't
```

Full command list: `./dist/myc --help`.

**Agents in git worktrees.** `myc wire` writes into the project:
`.claude/settings.json`, `.mcp.json`. An agent that orca starts in a git
worktree of a nested repository (`~/orca/workspaces/<repo>/<branch>`) lives in
the team's tree, where those files are not, even though `myc` itself finds the
main copy's workspace from there. `myc wire --scope user` puts the same into
Claude Code's user layer, which every session reads:
`~/.claude/helpers/myc-hooks.mjs`, SessionStart/PreCompact/PostToolUse hooks and
`Bash(myc <command>:*)` rules in `~/.claude/settings.json` (merged node by node;
the hooks of orca, herdr and other tools stay byte for byte), the skill in
`~/.claude/skills/myc`, and the MCP server through `claude mcp add --scope user`.
Before anything else the helper checks, without starting myc, whether there is
a workspace here (a git worktree is resolved through its main copy), and stays
silent when there is none or the project wires myc itself: in a project without
myc the hook costs one node start, and prime never arrives twice. Outside a
workspace the MCP server offers zero tools and no instructions. The user's
`statusLine` is never touched (it belongs to orca), and `--hook-mode replace`
is refused here. The journal is `~/.myc/wire-user.json`; `myc unwire --scope
user` restores the settings node by node and removes the MCP server.

## Heavy commands take turns

Several agents on one machine — in one tree or in neighbouring projects — each
run the heavy things: the full test suite, builds, benchmarks. Run at once, they
get in each other's way: full runs take twice as long, and latency budgets fail
because of the neighbour, not the code. `myc run` puts such a command into one
queue shared by every repository of the machine user (`~/.myc/queue.db`), waits
for a free slot (first come, first served) and then runs it with the terminal
and the exit code left alone:

```bash
myc run -- bun test              # waits its turn (--max-wait 5m by default), then runs
myc run --max-wait 15m -- make   # a longer wait for a longer tool timeout
myc queue                        # who is running, who is waiting, for how long
```

```
$ myc queue
heavy · slots 1 · 1 running · 1 waiting · ~/.myc/queue.db
  running #1      4s  bun test  ~/src/api  session 6468c59d · orca term_efe4850f · pid 44815 · command pid 44827
  waiting #2      3s  bun run build  ~/src/web  session 6468c59d · orca term_efe4850f · pid 44850 (#1 in line)
```

A waiting command says on stderr whom it waits for; past `--max-wait` it gives
up with exit code 9 and names what is ahead:

```
myc run: waiting for a 'heavy' slot (1/1 busy, 1 waiting ahead), waited 0.0s of max 3s — held by 'bun test' in ~/src/api, session 6468c59d, orca term_efe4850f, pid 44815, running 13s
```

A holder that dies — even by `SIGKILL` — frees its slot; a `myc run` nested
inside another one runs at once, in its parent's slot. One slot per lane by
default, `MYC_HEAVY_SLOTS=2` for two.

**Agents don't have to remember it.** `myc wire --queue-hook` installs a Claude
Code `PreToolUse` hook that rewrites a heavy Bash command into
`myc run -- <the same command>` before it runs. Heavy means a full test run or a
build: `bun test` with no paths, `bun run build` / `typecheck`, `npm` / `pnpm` /
`yarn` `test` and `build`, `cargo test` / `build`, `go test ./...`, `pytest`
with no paths, `make`. A targeted `bun test path/file.test.ts`, a command already
under `myc run`, a background one and a nested one pass untouched.
`MYC_QUEUE_HEAVY` replaces the list (`+…` adds to it, `off` turns the hook off).
It is opt-in: `wire` without the flag writes no such hook, and `unwire` removes
it. It is cheap, because it runs on every Bash call: a command that is not heavy
is let through by the host's own shell without starting bun or node — 3.4 ms at
the median and 4.3 ms at p99 in the run of 2026-09-11, against 30 ms for the
prime hook (`bun test packages/cli/src/hooks/queue-hook.multiprocess.test.ts`).

**`myc run` is not a way around permissions.** It runs whatever it is given, so
a queued command goes through without a question only when your own rules would
let the original command through — `Bash(bun test:*)` keeps `bun test` silent
under the queue as well. Otherwise Claude Code asks, and the question shows the
whole command; a deny or ask rule on the original command still holds. The same
goes for a `myc run -- <cmd>` an agent types itself. For the same reason `wire`
no longer writes the broad `Bash(myc:*)`: it allows myc's subcommands one by
one, and `run`, `statusline --then`, `wire` and `unwire` ask.

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
# myc: context is being compacted — here is what must not be lost
episode sess-5jh8je4g050m saved (265 B)
NEXT     myc show sess-5jh8je4g050m · myc ready --claim
```

**A status line with what the agent cannot see.** `myc wire --status-line`
puts one line under Claude Code's prompt — how full the context is, the task
queue, the code index, the project's memory, and how many of this session's
calls to myc actually returned something:

```
myc │ ctx 42% │ 61 ready · 34 blocked │ 612 files · 4268 symbols · 1h ago │ 101 notes │ 600/653 useful calls
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
$ MYC_SESSION_ID=s1 myc recall "retries"        $ MYC_SESSION_ID=s2 myc recall "retries"
… prj  project note: retries use jitter          … prj  project note: retries use jitter
… ses  session note: retries back off…           … ses* session note: retries back off…
3 of 3 · bm25 only                               3 of 3 · bm25 only · 2 from other sessions
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
tree-sitter, with grammars fetched on demand rather than shipped. Symbols,
callers and code search work for TypeScript, TSX, JavaScript (js, jsx, mjs,
cjs) and Python — the languages myc has definition rules for. The grammar
package holds 36; a language is added as a pair, a rule and a catalog entry,
so a grammar that would yield no symbols is never offered. Every other file
still gets `code grep`, anchors and staleness. `myc code index` builds it — on this repository,
826 files and 3 949 symbols in 904 ms — and four commands read it:

```
myc code symbol <name>   where it is defined, and what knowledge is anchored there
myc callers <name>       who calls it; --direction out, --depth all
myc code search "…"      by meaning, when you do not know the name
myc code grep "<lit>"    exhaustive, every occurrence; --in <path> narrows it
myc skeleton <file>      the file's API — 26× cheaper than reading it
```

The file list is git's own (`git ls-files`, so `.gitignore` applies; a tree
without git is walked, and the command says so). On top of any list,
secret-named files are never indexed, whatever `.gitignore` says: `.env` and
`.env.*` (templates like `.env.example` are indexed), `*.pem`, `*.key`,
keystores, private SSH keys, `.npmrc`, `.netrc` and other credential files —
`code index` counts them without naming them, and `code grep` refuses to read one.

**Nested repositories and git worktrees.** A workspace can be an ecosystem: a
root that is a git repository with independent repositories inside it (not
submodules). It has one code index, built from the root — one row per file,
paths like `messaging-server/server/src/x.ts`. From inside a nested
repository every code command answers from that repository's part of the
root index, with paths relative to the repository you are in; from the root
the answers do not change. `myc code index` run inside a nested repository
refreshes its part of the root index instead of building a second copy of the
same files, and so does the background refresh. A git worktree — even one
outside the workspace tree — is answered from the index of the main checkout:
there is no index per branch. When the worktree is on another commit, or has
uncommitted changes to tracked files, every answer carries
`WARN code_index.worktree_divergent` naming both branches, because lines and
spans may not match your files. `code grep` reads the worktree's files (the
line numbers are yours, the owning symbols come from the index); `skeleton`
shows the main copy's declarations when your copy differs from what the index
saw, and says so. When nothing covers the repository, the hint is the command
for the workspace root (`myc -C <root> code index`), not one that would build a
duplicate. Anchors set from the root and from inside a repository are stored
under different keys; `code symbol` reads both.

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
