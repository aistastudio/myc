---
name: myc
description: Project memory, tasks and links. Use it when you need to learn
  the state of the project, take the next task, recall a past decision, record
  a finding, see which tasks relate to the file you are editing, or find where
  code lives and who calls it. Only in projects with a myc workspace (a .myc
  directory here, in a parent, or in the main tree of this git worktree).
---

# myc

One graph: tasks with dependencies, project memory, links to code.

## Workflow

1. `myc prime` — what is going on (the hook does this itself at session start).
2. `myc ready --claim` — take work atomically.
3. `myc recall "<question>"` — before inventing: maybe this was already solved.
4. `myc remember "<finding>"` — after every non-trivial finding.
5. `myc close <id> --reason "<what and why>"` — when closing, explain.

## Rules

- One fact = one `remember`. Don't write paragraphs.
- Don't record code or secrets — record findings.
- A contradiction does not overwrite the old note: `myc link A supersedes B --reason "..."`.
- A `WARN degraded.*` line in a response means part of the index is not working
  and the search is incomplete — don't treat an empty answer as proof of absence.
- Heavy commands (the full test suite, a build) go through `myc run -- <cmd>`:
  agents on one machine take turns instead of fighting for the cores; `myc queue` shows who is ahead.
  `myc run` runs what it is given, so Claude Code asks about it unless your rules allow the command itself.

## Code

Ask the code index before grepping or reading whole files:

- `myc code map` — orientation: directory clusters, their hubs, who depends on them.
- `myc code search "<question>"` — ranked, by meaning; `myc code symbol <name>` — where it is defined.
- `myc code grep "<literal>"` — every occurrence with its owner; `--in <dir>` narrows it.
- `myc skeleton <file>` — a file's API in a fraction of its bytes.
- `myc callers <name>` — who calls it; run it before renaming or changing a signature.

After large changes refresh the index: `myc code index` (incremental).

## Context compaction

Before compaction the `pre-compact` hook writes an episode itself and returns a rescue
packet. If you see a block starting with "# myc:" that says the context is being
compacted — that is exactly what must not be lost; everything else can be restored
with `myc show <episode>`.
