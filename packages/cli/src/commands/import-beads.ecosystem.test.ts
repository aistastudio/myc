/**
 * `myc import-beads` в экосистеме из многих репозиториев (memory-aewndwjjxa5e).
 *
 * Форма — как у `~/src/cherry`: один воркспейс в корне и несколько beads —
 * корневой и по одному во вложенных git-репозиториях. Вопросы, на которые
 * здесь отвечают тесты:
 *  - какой воркспейс найдёт импорт из вложенного репозитория (подъём, R1);
 *  - какой beads прочитает (свой — bd зовётся в каталоге вызова);
 *  - какой охват репозитория (S59) получат узлы (репозитория, а не корня);
 *  - не трогают ли повторные импорты корня и репозитория задачи друг друга;
 *  - что будет, если два beads дадут одинаковые external_ref;
 *  - что будет, если у beads нет базы или она пуста, а issues.jsonl — есть.
 *
 * НАСТОЯЩИЙ ПРОЦЕСС myc, ПОДДЕЛЬНЫЙ bd. Импорт без аргумента зовёт `bd`
 * через Bun.spawnSync, а тот ищет исполняемый файл по PATH, СНЯТОМУ при старте
 * процесса: подмена process.env.PATH внутри тестового процесса до него не
 * доходит (проверено). Поэтому myc запускается отдельным процессом с PATH, в
 * начале которого лежит поддельный `bd`. Он отвечает на две команды, которые
 * зовёт импорт, — `export --include-memories` и `where --json` — из файлов в
 * `$PWD/.beads`, а формы ответов и тексты ошибок сняты с bd 1.0.5 на
 * настоящем cherry (miniapp-swap: `Error: no beads database found`;
 * `bd where --json` → `{"path": ".../.beads", ...}`).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { cliTestEnv } from "@myc/core";
import { migrate, migrations } from "@myc/store-sqlite";
import type { Envelope } from "../envelope.ts";
import { ExitCode } from "../exit.ts";

const BUN = process.execPath;
const MAIN = join(import.meta.dir, "..", "main.ts");

const FAKE_BD = `#!/bin/sh
# Поддельный bd: отвечает из файлов в $PWD/.beads (см. шапку теста).
b="$PWD/.beads"
case "$1" in
  export)
    if [ ! -d "$b" ] || [ -e "$b/fake-nodb" ]; then
      echo "Error: no beads database found" >&2
      echo "Hint: run 'bd where' to inspect the resolved workspace, or 'bd init' to create a new database" >&2
      exit 1
    fi
    if [ -e "$b/fake-export.jsonl" ]; then cat "$b/fake-export.jsonl"; fi
    exit 0 ;;
  where)
    if [ ! -d "$b" ]; then
      printf '{"error":"no_beads_directory","message":"No active beads workspace found.","schema_version":1}\\n'
      exit 1
    fi
    printf '{"path":"%s","schema_version":1}\\n' "$b"
    exit 0 ;;
esac
echo "fake bd: unsupported: $*" >&2
exit 2
`;

let root: string;
let eco: string;
let home: string;
let fakeBin: string;

type Row = Record<string, unknown>;

function issue(id: string, extra: Row = {}): Row {
  return {
    _type: "issue",
    id,
    title: `Задача ${id}`,
    status: "open",
    priority: 2,
    issue_type: "task",
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-07-02T10:00:00Z",
    ...extra,
  };
}

function memory(key: string, value: string): Row {
  return { _type: "memory", key, value };
}

function jsonl(rows: readonly Row[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** Живой beads репозитория: то, что отдаст `bd export` в его каталоге. */
function beads(dir: string, rows: readonly Row[]): void {
  mkdirSync(join(dir, ".beads"), { recursive: true });
  writeFileSync(join(dir, ".beads", "fake-export.jsonl"), jsonl(rows));
}

function repo(name: string): string {
  const dir = join(eco, name);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "myc-import-eco-")));
  eco = join(root, "eco");
  home = join(root, "home");
  fakeBin = join(root, "bin");
  mkdirSync(join(eco, ".myc"), { recursive: true });
  mkdirSync(home);
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "bd"), FAKE_BD);
  chmodSync(join(fakeBin, "bd"), 0o755);
  writeFileSync(join(eco, ".myc", "workspace.toml"), 'slug = "eco"\n');
  const db = new Database(join(eco, ".myc", "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  db.close();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** `cd <dir> && myc --json <args…>` отдельным процессом, с поддельным bd в PATH. */
function mycIn(dir: string, ...args: string[]): { readonly code: number; readonly env: Envelope } {
  const r = Bun.spawnSync([BUN, MAIN, "--json", ...args], {
    cwd: dir,
    env: cliTestEnv({ PATH: `${fakeBin}:${process.env.PATH ?? ""}`, MYC_HOME: home, MYC_ACTOR: "tester" }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = r.stdout.toString();
  let env: Envelope;
  try {
    env = JSON.parse(out) as Envelope;
  } catch {
    throw new Error(`myc ${args.join(" ")} in ${dir}: not JSON (exit ${r.exitCode}): ${out}\n${r.stderr.toString()}`);
  }
  return { code: r.exitCode ?? -1, env };
}

interface NodeRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly title: string;
  readonly updated_at: number;
  readonly open_blockers: number;
  readonly ref: string | null;
  readonly repo: string | null;
}

/** Узлы общей базы корня — прямым чтением, мимо myc. */
function nodes(): NodeRow[] {
  const db = new Database(join(eco, ".myc", "myc.db"), { readonly: true });
  try {
    return db
      .query(
        `SELECT id, kind, status, title, updated_at, open_blockers,
                json_extract(attrs, '$.external_ref') AS ref, json_extract(attrs, '$.repo') AS repo
           FROM nodes WHERE deleted_at IS NULL`,
      )
      .all() as NodeRow[];
  } finally {
    db.close();
  }
}

function byRef(): Map<string, NodeRow> {
  return new Map(nodes().filter((n) => n.ref !== null).map((n) => [n.ref!, n]));
}

function oplogCount(): number {
  const db = new Database(join(eco, ".myc", "myc.db"), { readonly: true });
  try {
    return (db.query("SELECT count(*) AS n FROM oplog").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const ROOT_ROWS: readonly Row[] = [
  issue("eco-1", { title: "Общая задача экосистемы" }),
  issue("eco-2", { status: "closed", closed_at: "2026-07-03T10:00:00Z", close_reason: "готово" }),
  memory("root-key", "Память корня."),
];

const SVC_ROWS: readonly Row[] = [
  issue("svc-1", { notes: "Заметка к svc-1." }),
  issue("svc-2", {
    status: "deferred",
    defer_until: "2026-07-27T00:00:00Z",
    dependencies: [{ issue_id: "svc-2", depends_on_id: "svc-1", type: "parent-child" }],
  }),
  issue("svc-3", { dependencies: [{ issue_id: "svc-3", depends_on_id: "svc-2", type: "blocks" }] }),
  memory("svc-key", "Память репозитория svc."),
];

describe("импорт из вложенного репозитория в общий воркспейс (memory-aewndwjjxa5e)", () => {
  /**
   * Мутация «охват репозитория = корень» (узлы импорта получают attrs.repo
   * пустым) роняет проверку охвата: у всех узлов svc ждём 'svc'.
   */
  test("воркспейс — корневой (подъём вверх), beads — свой, охват узлов — репозиторий", () => {
    const svc = repo("svc");
    beads(eco, ROOT_ROWS);
    beads(svc, SVC_ROWS);

    const r = mycIn(svc, "import-beads");
    expect(r.code).toBe(ExitCode.OK);
    const d = r.env.data as Record<string, unknown>;
    expect(d["snapshot"]).toBe(`bd (${svc})`);
    // прочитан СВОЙ beads: три задачи svc, ни одной задачи корня
    expect(d["tasks_created"]).toBe(3);
    expect(d["statuses_mapped"]).toEqual(["svc-2: deferred→blocked"]);
    // второго воркспейса во вложенном репозитории не появилось
    expect(existsSync(join(svc, ".myc"))).toBe(false);

    const all = nodes();
    const refs = all.map((n) => n.ref).filter((x): x is string => x !== null).sort();
    expect(refs).toEqual(["bd-remember:svc-key", "svc-1", "svc-1#notes", "svc-2", "svc-3"]);
    // охват — репозиторий у КАЖДОГО узла импорта: задач, заметки и памяти
    for (const n of all) expect({ ref: n.ref, repo: n.repo }).toEqual({ ref: n.ref, repo: "svc" });

    // очередь из репозитория: отложенной нет, заблокированной ею тоже
    const ready = mycIn(svc, "ready", "-n", "50");
    expect(ready.env.ok).toBe(true);
    const refOf = new Map(all.map((n) => [n.id, n.ref]));
    const queue = (ready.env.data as { items: { id: string }[]; repo: string }).items.map((i) => refOf.get(i.id));
    expect((ready.env.data as { repo: string }).repo).toBe("svc");
    expect(queue).toEqual(["svc-1"]);
  });

  test("корень и репозиторий не трогают задачи друг друга; повторный импорт — ноль операций", () => {
    const svc = repo("svc");
    beads(eco, ROOT_ROWS);
    beads(svc, SVC_ROWS);

    expect(mycIn(eco, "import-beads").env.ok).toBe(true);
    expect(mycIn(svc, "import-beads").env.ok).toBe(true);
    const first = byRef();
    expect(first.get("eco-1")!.repo).toBe("");
    expect(first.get("bd-remember:root-key")!.repo).toBe("");
    expect(first.get("svc-1")!.repo).toBe("svc");
    // префиксы разных beads дают непересекающиеся ссылки
    const rootRefs = [...first.values()].filter((n) => n.repo === "").map((n) => n.ref);
    const svcRefs = [...first.values()].filter((n) => n.repo === "svc").map((n) => n.ref);
    expect(rootRefs.filter((x) => svcRefs.includes(x))).toEqual([]);

    const ops = oplogCount();
    for (const dir of [eco, svc]) {
      const again = mycIn(dir, "import-beads").env.data as Record<string, unknown>;
      expect(again["tasks_created"]).toBe(0);
      expect(again["tasks_updated"]).toBe(0);
      expect(again["skipped"]).toEqual([]);
    }
    expect(oplogCount()).toBe(ops);

    // правка в корневом beads доезжает только до задачи корня
    beads(eco, [issue("eco-1", { title: "Общая задача экосистемы", status: "closed", closed_at: "2026-07-05T00:00:00Z" }), ...ROOT_ROWS.slice(1)]);
    const sync = mycIn(eco, "import-beads").env.data as Record<string, unknown>;
    expect(sync["tasks_updated"]).toBe(1);
    const after = byRef();
    expect(after.get("eco-1")!.status).toBe("closed");
    for (const ref of svcRefs) expect(after.get(ref!)!.updated_at).toBe(first.get(ref!)!.updated_at);
  });

  /**
   * Два beads с ОДНИМ префиксом в одном воркспейсе: external_ref уникален в
   * воркспейсе, а не в репозитории. Мутация «чужих нет» (foreignRefs отдаёт
   * пустую карту) роняет тест: импорт pay переписывает dup-1 из svc своим
   * заголовком и статусом, а одноимённая память молча числится «уже ввезённой».
   */
  test("одинаковый префикс в двух репозиториях: чужие записи не синхронизируются, а названы", () => {
    const svc = repo("svc");
    const pay = repo("pay");
    beads(svc, [issue("dup-1", { title: "Задача svc" }), memory("same-key", "Память svc.")]);
    beads(pay, [
      issue("dup-1", { title: "Задача pay", status: "closed", closed_at: "2026-07-04T00:00:00Z" }),
      issue("dup-2", { dependencies: [{ issue_id: "dup-2", depends_on_id: "dup-1", type: "blocks" }] }),
      memory("same-key", "Память pay."),
    ]);

    expect(mycIn(svc, "import-beads").env.ok).toBe(true);
    const before = byRef().get("dup-1")!;

    const r = mycIn(pay, "import-beads");
    expect(r.env.ok).toBe(true);
    const d = r.env.data as Record<string, unknown>;
    const skipped = d["skipped"] as string[];
    expect(skipped.some((s) => s.startsWith(`dup-1: task not imported — myc already has ${before.id}`))).toBe(true);
    expect(skipped.some((s) => s.includes("repo 'svc'") && s.includes("repo 'pay'"))).toBe(true);
    expect(skipped.some((s) => s.startsWith("bd-remember:same-key: memory not imported"))).toBe(true);
    expect(d["memories_existing"]).toBe(0);
    expect((r.env.warn ?? []).some((w) => w.code === "import.skipped")).toBe(true);

    const after = byRef();
    // задача svc не тронута ни заголовком, ни статусом
    expect(after.get("dup-1")).toEqual(before);
    // своя задача pay ввезена, но ребро на чужую одноимённую НЕ протянуто
    expect(after.get("dup-2")!.repo).toBe("pay");
    expect(after.get("dup-2")!.open_blockers).toBe(0);
    expect(d["missing_refs"]).toEqual(["dup-2 → dup-1"]);
  });
});

describe("beads без базы или с пустой базой, но с issues.jsonl (memory-aewndwjjxa5e)", () => {
  function passive(dir: string, rows: readonly Row[]): string {
    mkdirSync(join(dir, ".beads"), { recursive: true });
    const p = join(dir, ".beads", "issues.jsonl");
    writeFileSync(p, jsonl(rows));
    return p;
  }

  /**
   * miniapp-swap: базы Dolt нет, в issues.jsonl 5 закрытых задач июня.
   * Мутация «без разбора пассивного экспорта» оставляет голое `no beads
   * database found` без файла и без подсказки — тест краснеет на подсказке.
   */
  test("базы нет: отказ называет файл, число и дату, подсказка — точная команда; по ней ввоз проходит", () => {
    const swap = repo("swap");
    const p = passive(swap, [
      issue("swap-a", { status: "closed", closed_at: "2026-06-10T00:00:00Z" }),
      issue("swap-b", { status: "closed", closed_at: "2026-06-11T00:00:00Z" }),
    ]);
    writeFileSync(join(swap, ".beads", "fake-nodb"), "");

    const r = mycIn(swap, "import-beads");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.env.error?.code).toBe("precond.bd");
    expect(r.env.error?.msg).toContain("no beads database found");
    expect(r.env.error?.msg).toContain(`${p} with 2 tasks (closed 2), written `);
    expect(r.env.error?.hint).toBe(`myc import-beads ${p}`);
    expect(nodes()).toHaveLength(0);

    const ok = mycIn(swap, "import-beads", p);
    expect(ok.code).toBe(ExitCode.OK);
    expect((ok.env.data as Record<string, unknown>)["tasks_created"]).toBe(2);
    expect(nodes().map((n) => n.repo)).toEqual(["swap", "swap"]);
  });

  /**
   * cherry-developer-portal: база есть, но пуста; в issues.jsonl — 293 задачи.
   * Мутация «пустой экспорт не проверяется» даёт ok и «tasks 0» — ровно то
   * молчаливое «0 задач», которого быть не должно.
   */
  test("база пуста, а в issues.jsonl задачи есть: отказ precond.bd_empty; пусто и там — честный ноль", () => {
    const portal = repo("portal");
    const p = passive(portal, [
      issue("portal-1"),
      issue("portal-2", { status: "deferred" }),
      issue("portal-3", { status: "closed", closed_at: "2026-08-01T00:00:00Z" }),
    ]);

    const r = mycIn(portal, "import-beads");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.env.error?.code).toBe("precond.bd_empty");
    expect(r.env.error?.msg).toContain(`bd export returned no tasks from ${join(portal, ".beads")}`);
    // статусы — как в ИСТОЧНИКЕ: deferred, а не сопоставленный blocked
    expect(r.env.error?.msg).toContain(`${p} with 3 tasks (closed 1, deferred 1, open 1)`);
    expect(r.env.error?.hint).toBe(`myc import-beads ${p}`);

    rmSync(p);
    const empty = mycIn(portal, "import-beads");
    expect(empty.code).toBe(ExitCode.OK);
    expect((empty.env.data as Record<string, unknown>)["issues_total"]).toBe(0);
  });

  /**
   * Файл, который не разбирается, — всё равно данные: отказ называет его и
   * причину. Мутация «неразбираемый файл = файла нет» возвращает молчаливые
   * «tasks 0» с кодом 0.
   */
  test("база пуста, а issues.jsonl не разбирается: отказ называет файл, число строк и причину", () => {
    const broken = repo("broken");
    const p = passive(broken, [issue("b-1"), issue("b-2", { priority: "P1" })]);

    const r = mycIn(broken, "import-beads");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.env.error?.code).toBe("precond.bd_empty");
    expect(r.env.error?.msg).toContain(`${p} with 2 lines, written `);
    expect(r.env.error?.msg).toContain("does not parse as a snapshot (issues[1] (b-2): priority is not an integer)");
  });

  /** Имя файла экспорта задаёт metadata.json (`jsonl_export`), а не догадка. */
  test("файл экспорта с другим именем из metadata.json тоже найден и назван", () => {
    const old = repo("old");
    mkdirSync(join(old, ".beads"), { recursive: true });
    writeFileSync(join(old, ".beads", "metadata.json"), JSON.stringify({ jsonl_export: "beads.jsonl" }));
    const p = join(old, ".beads", "beads.jsonl");
    writeFileSync(p, jsonl([issue("old-1")]));
    writeFileSync(join(old, ".beads", "fake-nodb"), "");

    const r = mycIn(old, "import-beads");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.env.error?.msg).toContain(`${p} with 1 task (open 1)`);
    expect(r.env.error?.hint).toBe(`myc import-beads ${p}`);
  });
});
