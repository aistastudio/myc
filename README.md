# myc

A local, fast task-and-memory layer for coding agents: a task queue, an oplog of
facts and decisions, hybrid (lexical + vector) search over the project's
memory, and a built-in code index — with no network calls of its own and no
mandatory LLM key. The network is reached only when you ask: `myc models
fetch`, `myc code fetch`, `myc version --check` (or `MYC_UPDATE_CHECK=1`, a
background version check at most once a day from `init` and `wire`).

Agents forget. `myc` is the part that doesn't: decisions survive context
compaction, work survives process death, and both survive being moved between
machines through plain git.

Design docs live in `docs/design/` (start with `00-brief.md`); the measurements
quoted below are reproducible from `bench/` and `scripts/`.

**Site: <https://aistastudio.github.io/myc/>** — every capability with the
release it arrived in and a command that shows it, the roadmap, and the
measurements as charts, in English and Russian, with the command that
reproduces each number printed next to it. It is the one source of numbers:
`bun run site/build.ts` checks every figure on the site against the measurement
artefacts in this repository, the figures in this README and in the Russian one
against the site's `site/measurements.json`, and every `myc` command and flag
on the site and in both READMEs against this build's `--help`; a mismatch fails
the build.

## Requires Bun — this is not fine print

The runtime is bound to `bun:sqlite` (SQLite and `sqlite-vec` ship inside Bun,
with no native bindings on the Node side). **It will not start on plain Node.js
or Deno.** Bun ≥ 1.3.0 is required and pinned in `package.json` → `engines.bun`.

Install Bun: https://bun.sh

## Install

Installation is one command:

```bash
bun install -g @aistastudio/myc   # 3.41 MB compressed, 12.57 MB unpacked, 13 files; no models pulled
myc --version                     # myc 0.3.8 (schema 1)
```

It runs on macOS and Linux. On Windows, use WSL and install Bun and myc inside
it: the `myc` launcher does not start in cmd or PowerShell, and an npm install
on Windows says so.

The embedding model is **not** downloaded during install. Semantic search is
opt-in and explicit: `myc models fetch` (129 MB, ~7 s). Until then search is
lexical and says so on every answer (`WARN degraded.embeddings`). The grammars
for the code index are fetched the same way, once: `myc code fetch`.

To run the newest code instead of the published release, build from source:

```bash
git clone https://github.com/aistastudio/myc && cd myc
bun install
bun run build          # produces a single binary: dist/myc
./dist/myc --version
```

Put the binary somewhere `myc wire` can find it — `MYC_BIN`, `node_modules/.bin`,
`~/.myc/bin/myc`, or `PATH`. If it can't, `wire` says so out loud instead of
writing a config that silently won't start.

## Quick start

Two commands set a project up; the rest is the loop an agent lives in. (From a
source build, `./dist/myc` instead of `myc`.)

```bash
myc init                     # .myc/ + SQLite + migrations in this repo
myc wire                     # hooks + MCP for Claude Code, Codex, opencode and Kimi
myc ready --claim            # take the next task
myc show <id>                # all that is known about it
myc close <id>
myc remember "why X, not Y"  # record a fact or decision
myc recall "how retrieval works"
myc prime                    # session context packet (agents call it)
myc code fetch               # grammars for this repo's languages, once
myc code index               # symbols, callers, code search
myc doctor                   # schema, counters, hooks — says "don't know" where it doesn't
```

Full command list: `myc --help`; details of each: `myc <command> --help`.

## Wiring agents

`myc wire` writes only its own files in full and merges JSON configs node by
node with a `.myc.bak` alongside; `CLAUDE.md` is never touched. Running it twice
changes nothing. Everything past the plain `wire` is opt-in:

```bash
myc wire --dry-run              # show every change, write nothing
myc wire --agents claude,codex  # only some of the agents
myc wire --status-line          # + myc's status line under Claude Code's prompt
myc wire --queue-hook           # + heavy commands take turns (below)
myc wire --agents-md            # + the myc block in AGENTS.md
myc wire --scope user           # the same for agents in git worktrees (Claude Code's user layer)
myc unwire                      # remove what wire put in
```

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
workspace the MCP server offers zero tools and no instructions. `--hook-mode
replace` is refused here. The journal is `~/.myc/wire-user.json`; `myc unwire
--scope user` restores the settings node by node and removes the MCP server.

With `--status-line` the user layer also gets myc's status line, `myc
statusline --scope user`: in a myc workspace — a git worktree of one included —
it is the full line, outside one it prints nothing of its own. The line that was
there (orca's, which prints nothing and posts the input to orca) is kept in the
journal, not in our command, and gets the same stdin on every redraw, never
waited on: orca takes a line whose command mentions its
`agent-hooks/claude-statusline.sh` for its own and removes it when it
uninstalls (a foreign line it leaves alone), so ours never carries the word
`claude-statusline`. A project with its own myc line keeps it, and that line
hands the input to the same recorded line. If another tool replaces the user
line after wire, `myc doctor --hooks` says so; `myc wire --scope user
--status-line` puts ours back and makes the new line the previous one, and `myc
unwire --scope user` puts the previous line back byte for byte. `myc doctor
--hooks` checks the whole user layer against the journal: myc's hook entries and
rules still in `~/.claude/settings.json`, the helpers exactly what this build
writes (a stale one is named with the build that wrote it), the status line, the
MCP server.

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
default, `MYC_HEAVY_SLOTS=2` for two. myc does not load the project's `.env` or
`bunfig.toml`: the command gets the caller's environment as is.

**Agents don't have to remember it.** `myc wire --queue-hook` installs a Claude
Code `PreToolUse` hook that rewrites a heavy Bash command into
`myc run -- <the same command>` before it runs. Heavy means a full test run or a
build: `bun test` with no paths, `bun run build` / `typecheck`, `npm` / `pnpm` /
`yarn` `test` and `build`, `cargo test` / `build`, `go test ./...`, `pytest`
with no paths, `make`. A targeted `bun test <path>`, a command already
under `myc run`, a background one and a nested one pass untouched.
`MYC_QUEUE_HEAVY` replaces the list (`+…` adds to it, `off` turns the hook off).
It is opt-in: `wire` without the flag writes no such hook, and `unwire` removes
it. It is cheap, because it runs on every Bash call: a command that is not heavy
is let through by the host's own shell without starting bun or node — 3.4 ms at
the median and 4.3 ms at p99 in the run of 2026-09-11, against the prime hook's
30 ms p99 budget (`bun test packages/cli/src/hooks/queue-hook.multiprocess.test.ts`).

**`myc run` is not a way around permissions.** It runs whatever it is given, so
a queued command goes through without a question only when your own rules would
let the original command through — `Bash(bun test:*)` keeps `bun test` silent
under the queue as well. Otherwise Claude Code asks, and the question shows the
whole command; a deny or ask rule on the original command still holds. The same
goes for a `myc run -- <cmd>` an agent types itself. For the same reason `wire`
does not write the broad `Bash(myc:*)`: it allows myc's subcommands one by one,
and `run`, `statusline --then`, `wire` and `unwire` ask.

## Code intelligence

Code intelligence is built in, and it is the same engine the alternatives use:
tree-sitter, with grammars fetched on demand rather than shipped. Symbols,
callers and code search work for TypeScript, TSX, JavaScript (js, jsx, mjs,
cjs) and Python — the languages myc has definition rules for. The grammar
package holds 36; a language is added as a pair, a rule and a catalog entry,
so a grammar that would yield no symbols is never offered. Every other file
still gets `code grep`, anchors and staleness.

`myc code fetch` downloads exactly the grammars this repository's files need,
checked by sha256 — the only step that goes to the network; indexing never does,
and a language whose grammar is missing is skipped and named. `myc code index`
builds the index, incrementally: a repeat run over an unchanged tree reads
nothing, and after that the index is refreshed in the background. These read it,
from the CLI and over MCP alike:

```
myc code symbol <name>   where it is defined, and what knowledge is anchored there
myc callers <name>       who calls it; --direction out, --depth all
myc code search "…"      by meaning, when you do not know the name
myc code grep "<lit>"    exhaustive, every occurrence; --in <path> narrows it
myc code map             orientation: directory clusters, their hubs, who depends on them
myc skeleton <file>      the file's API, and how many times cheaper that was than reading it
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
same files. The index also keeps itself fresh: after any myc command, when its
last run is older than 15 minutes (`MYC_CODE_INDEX_PERIOD_MS`), one background
`code index` per workspace is queued and runs detached at low priority, never
delaying the command; the status line and the code commands say when it is
refreshing, queued or stale. A git worktree — even one
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

## Migration from beads

```bash
cd <beads-project>
myc init
myc import-beads --dry-run   # count what would come over, change nothing
myc import-beads             # collects the snapshot itself: bd export --include-memories
```

Run it again later and it is a sync, not a second copy: fields changed in beads
(status, priority, labels, close reason, parent, blockers) are applied as normal
graph changes, and local myc edits are never silently overwritten — one-sided
local changes are kept and named, two-sided ones are named as conflicts and left
alone. A snapshot file moves the same between machines:
`bd export --include-memories > snapshot.json`, then
`myc import-beads snapshot.json`.

**It is real, not a demo.** A working project imported into an empty workspace
in 889 ms: 796 tasks, 972 dependencies, 265 notes, 41 memories — with unknown
issue types carried over verbatim and named, and out-of-range priorities
clamped and named, instead of one odd row aborting the import. Those numbers are
from the first release (0.1.1, 2026-09-07), and that run silently dropped the
export's comments while reporting every note as imported; it was found the next
day on a real project and fixed in 0.2.0 (`git show aac5d1f`). What the import
carries now:

- comments, into the node's thread with their authors; unknown top-level
  fields are named instead of dropped (0.2.0);
- acceptance criteria and design, into the task body between managed markers,
  and the source's own dates, author and owner (0.3.3);
- statuses myc has no name for, such as `deferred`, as `blocked` with the
  original word kept — never as `open` (0.3.3);
- sub-repositories of a shared workspace, each with its own repository reach;
  an empty source is a refusal with a hint, not a silent zero (0.3.3).

On that same graph both ready queues now return the same 152 tasks. They did
not always: myc used to offer 195 against beads' 144, because beads inherits
blockers down the parent chain and myc looked only at a task's own. Those 51
were inside a still-blocked epic and beads was right to hide them;
`memory-atcm254ry6c7` is closed, `anc_blockers` is materialised by trigger, and
the queue now says `281 blocked (51 through an ancestor)` rather than quietly
offering them.

## What makes it different

**Speed is a constraint, not an optimisation.** Every hot path has a budget,
and a budget test makes three kinds of claims: structural (the query plan, the
prefilter), relative (the healthy path against a deliberately degraded rival,
measured alternately, so the hardware cancels out) and absolute. On every push
CI checks the first two. The absolute budgets and the 15% p95 regression line
are calibrated on darwin-arm64-14 and bind there; CI and the nightly run use
GitHub's 4-core runners, which are not that machine and are declared
uncalibrated (`MYC_BENCH_ABSOLUTE=0`), so there the absolute numbers are printed
and logged, not enforced. Measured on 100 000 nodes on 2026-09-11,
darwin-arm64-14, myc 0.3.6, not re-measured since
(`bun run scripts/bench-latency.ts`):

| operation | p99 | budget |
|---|---|---|
| `prime` (session context) | 0.608 ms | 30 ms |
| read | 0.010 ms | 3 ms |
| search | 8.215 ms | 25 ms |
| write | 0.327 ms | 5 ms |
| cold start | 21.337 ms | 60 ms |

**Ranking is measured, not asserted.** Two labelled corpora with graded
relevance, each containing a *control group that gets worse* when the feature
works — so a gain cannot be manufactured by shaping the corpus (both re-measured
2026-09-10):

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

**Decisions pulled from a compaction are candidates, not facts.** The same hook
lifts "we decided / because" lines out of the transcript and stores them as
candidates (`state pending_review`); recall, search, prime and MCP do not
return them until someone confirms. `prime` names them in its footer —
`N pending review hidden — myc review` — and `myc review` lists them, this
session's first, for a person or an agent to settle. Confirming makes the
candidate knowledge the way a new note is born (embedding and absorb
classification queued); rejecting retracts it with the reason kept in the node.
An agent does the same through MCP: `myc_ready` with `review` lists,
`myc_update` with `confirm` or `reject` settles; the web knowledge base puts
the two buttons on the candidate's row.

```
$ myc review
PENDING REVIEW 2 · 1 in this session's prime · 1 from other sessions · session 3f9c21aa
$ myc review confirm memory-6k2x…
$ myc review reject memory-9x1q… --reason "restates the task, not a decision"
```

A retracted note — a rejected candidate among them — is out of every retrieval
path, not only replaced versions: superseded, retracted and cancelled are one
list shared by recall, prime and the status line.

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
3 of 3 · bm25 only · …                           3 of 3 · bm25 only · … · 2 from other sessions
```

**Memory has three independent axes**, and the surface says what it hid:
tier (project vs personal), session reach, repository reach. `prime` prints
`N from other sessions hidden` and `N notes from other repos hidden` rather
than quietly narrowing results.

**Degradation is loud.** No silent fallbacks: when the vector branch is
unavailable the output says so and marks the answer as lexical-only; when a
budget is exceeded it is named with the number. The invariant is that a
degraded answer must never be indistinguishable from a healthy one. With
`--strict` a degraded answer also exits with code 6 instead of 0, and the
`WARN` line still prints.

**Multi-machine sync through plain git, merged per field.** Only the oplog is
committed. Two machines editing the same node converge: one changes title and
priority, the other title and tags — after exchange both show the later title,
the first machine's priority and the second's tags. Nothing is lost to
last-writer-wins over whole records.

**Guards are proved by mutation.** Every refusal and every invariant is
accompanied by a mutation that removes it; a guard whose removal breaks no test
is treated as absent. The full suite: 3625 pass / 0 fail / 16 skip
(`bun test`, 2026-09-11).

## What myc does

Tasks with leases, dependencies and blockers inherited down the parent chain;
memory that survives compaction and is scoped by session and repository;
ranked hybrid search; the code index above; hooks and MCP for four agents;
the machine-wide queue for heavy commands; the status line; import from beads;
a local web interface (`myc viz`: graph, queue, board, cards, search, health —
edits go through the same write path as the CLI); git worktrees and nested
repositories; sync through git and a `doctor` that compares claims with a
recount.

The full list — each capability with the release it arrived in and a command
that shows it on your machine, every command checked against this build's
`--help` when the site is built — is on the site:
<https://aistastudio.github.io/myc/#features>.

## Roadmap

Where each milestone stands — closed/total subtasks of every epic in the
project's own tracker, and every task still open inside it, with no dates — is
on the site: <https://aistastudio.github.io/myc/#planned>. The counts are not
typed in: `bun run site/roadmap.ts` reads them from myc before a release, and
the site build refuses a plan that describes a task the tracker no longer has
open.

In short: the core, memory, semantics and the human interface (M0–M2, M7) are
done or nearly done, and so is English output for every CLI and MCP line; code
intelligence (M3, including the built-in replacement for graft) and the
heavy-command queue have shipped, with tasks still open; the team milestone
(M4: `myc serve`, ACL, network sync, Postgres) is mostly design; swarm
self-learning (M5: routing by cost and outcome, with a shared pool of agent
statistics) and distillation (M6) have not started.

What that means in practice: **today myc is a single-user local tool over files
in git.** There is no server, no ACL and no team mode. Those are designed
(`docs/design/03-interfaces-and-integration.md`,
`docs/design/04-swarm-learning-and-routing.md`) and tracked, not implemented.

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
