<!-- myc:start -->
## myc — project memory and tasks

`myc_*` tools (MCP) or the `myc` CLI. Order: `myc prime` → `myc ready --claim`
→ `myc recall` before a decision → `myc remember` after a finding → `myc close --reason`.
Code, before reading whole files: `myc code map`, `myc code search`, `myc code grep`,
`myc skeleton <file>`, `myc callers <name>`.
Heavy commands (the full test suite, a build): `myc run -- <cmd>`, one machine-wide queue.
Full instructions: `myc --help`, `.claude/skills/myc/SKILL.md`.
<!-- myc:end -->

## This repository

This is myc itself: a Bun + TypeScript monorepo (`packages/*`) — the SQLite store, the
`myc` CLI, the MCP server, code intelligence, the web UI. Its own tasks and memory live in
myc (`.myc/`); beads is retired — its issues were imported into myc, and nothing here uses
`bd` any more.

- **Build and test.** `bun install`; `bun test` — the full suite is heavy, run it as
  `myc run -- bun test`; `bun run typecheck`; `bun run build` builds `dist/myc` and
  smoke-tests its background work before replacing it; `bun run pack:npm` packs
  `dist/aistastudio-myc-<version>.tgz` (on macOS it needs `bun scripts/build-sqlite.ts` first).
- **Design is the source of truth:** `docs/design/00…05` and `docs/design/ARCHITECTURE.md`
  (numbered decisions). Open the section a task names before implementing it. Agents'
  reports go to `docs/reports/`.
- **Conventions.** Code comments in Russian are normal; everything a person sees from the
  CLI, the MCP server and the web UI is English, and tests guard it. A guard is proven by a
  mutation: remove it, and a test must fail. Timing tests use `@myc/bench` (median over
  independent trials), never a single run.
- **Working databases.** Never run a development build with new schema migrations against
  a working database — this repository's `.myc/myc.db` or another project's — before the
  release that carries them; use copies and temporary directories.
