/**
 * Воркер переезда (R4) — НАСТОЯЩИЙ отдельный процесс против двух настоящих
 * баз. Однопоточный тест здесь ничего не доказывает: точка фиксации переезда
 * лежит между двумя транзакциями В РАЗНЫХ базах, и единственный способ
 * проверить, что обрыв ровно в ней не теряет записей, — убить процесс там
 * SIGKILL'ом, а потом посмотреть на файлы, пережившие смерть.
 *
 * Режимы:
 *   --mode cli     — боевой путь: та же команда `myc move`, что у человека;
 *   --mode engine  — движок напрямую, чтобы поставить точку обрыва между
 *                    фазами; `--break after-ingest|after-commit` шлёт себе
 *                    SIGKILL сразу после названной фазы.
 *
 * На stdout — одна JSON-строка отчёта; при `--break` её не будет вовсе,
 * процесс умирает раньше, и это ожидаемый исход.
 */

import { executeMove, planMove, type MoveBreakpoint } from "@myc/store-sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createMoveCommand } from "./move.ts";
import { openWorkspaceByDir } from "./store.ts";

interface Args {
  source: string;
  target: string;
  id: string;
  mode: "cli" | "engine";
  brk: MoveBreakpoint | "none";
  withBlockers: boolean;
  go: string | undefined;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const source = get("source");
  const target = get("target");
  const id = get("id");
  if (source === undefined || target === undefined || id === undefined) {
    throw new Error("--source, --target and --id required");
  }
  return {
    source,
    target,
    id,
    mode: get("mode") === "engine" ? "engine" : "cli",
    brk: (get("break") ?? "none") as MoveBreakpoint | "none",
    withBlockers: argv.includes("--with-blockers"),
    go: get("go"),
  };
}

async function waitForBarrier(path: string | undefined): Promise<void> {
  if (path === undefined) return;
  for (let i = 0; i < 600; i++) {
    if (await Bun.file(path).exists()) return;
    await Bun.sleep(10);
  }
  throw new Error(`barrier ${path} never appeared`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  await waitForBarrier(args.go);

  if (args.mode === "cli") {
    const registry = new Registry();
    registry.register(createMoveCommand());
    const result = await run(
      [
        "-C",
        args.source,
        "move",
        args.id,
        "--to",
        args.target,
        ...(args.withBlockers ? ["--with-blockers"] : []),
        "--json",
      ],
      { registry, env: { MYC_ACTOR: "worker" } },
    );
    const out = typeof result.stdout === "string" ? result.stdout : [...result.stdout].join("");
    process.stdout.write(`${JSON.stringify({ code: result.code, out: out.trim() })}\n`);
    return;
  }

  const source = await openWorkspaceByDir(args.source, "worker");
  if (!source.ok) throw new Error(`source: ${source.failure.msg}`);
  const target = await openWorkspaceByDir(args.target, "worker");
  if (!target.ok) throw new Error(`target: ${target.failure.msg}`);

  const plan = planMove(source.handle, args.id, source.handle.scope, target.handle.scope, {
    withBlockers: args.withBlockers,
  });
  if (!plan.ok) {
    process.stdout.write(`${JSON.stringify({ refused: plan.code, msg: plan.msg })}\n`);
    return;
  }
  const result = executeMove(source.handle, target.handle, plan, {
    ...(args.brk === "none" ? {} : { breakpoint: args.brk }),
    onBreakpoint: () => {
      // Никакого graceful shutdown: WAL обеих баз обязан пережить смерть
      // процесса ровно в этой точке, иначе фазы разделены только удачей.
      process.kill(process.pid, "SIGKILL");
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

await main();
