/**
 * Приёмка `myc code` (memory-m30yh8swnm1d): ВХОД и ЧИТАТЕЛЬ код-индекса.
 *
 * До этой задачи `code_files`/`code_defs` не заполняла ни одна команда и не
 * читала ни одна строка кода: пакет был написан, покрыт тестами и мёртв. Оба
 * теста ниже — приёмочные в буквальном смысле мутаций:
 *
 *   МУТАЦИЯ «вход отключён» — убрать `scanCodeIndex`/`drainCodeIndex` из
 *   обработчика `code index` (или вернуть ему `dry_run` всегда): краснеет
 *   «index строит», потому что в таблицах остаются нули.
 *
 *   МУТАЦИЯ «читатель отключён» — заставить `code symbol` не спрашивать
 *   `code_defs` (вернуть пустой список определений): краснеет «symbol
 *   отвечает», причём именно на связке символ↔знание, ради которой читатель
 *   и делался.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { grammarPath } from "@myc/code-intel/symbols";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createCodeCommand } from "./code.ts";
import { createAnchorCommand } from "./anchor.ts";
import { createTaskCommand } from "./tasks.ts";

const FUSE = `// заголовок файла
import { x } from "./x.ts";

export function fuseRRF(a: number[], b: number[], k = 60): number[] {
  const out: number[] = [];
  for (const v of a) out.push(v / (k + 1));
  return out;
}

export function callsFuse(): number[] {
  return fuseRRF([1], [2]);
}
`;

let dir: string;
let home: string;
let registry: Registry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-code-cli-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "fuse.ts"), FUSE);
  writeFileSync(join(dir, "README.md"), "fuseRRF описан здесь\n");
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createCodeCommand());
  registry.register(createAnchorCommand());
  registry.register(createTaskCommand());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  const r = await myc(...args, "--json");
  const env = JSON.parse(r.stdout as string) as { ok: boolean; data: Record<string, unknown> };
  expect(env.ok).toBe(true);
  return env.data;
}

function db(): Database {
  return new Database(join(dir, ".myc", "myc.db"));
}

function count(table: string): number {
  const d = db();
  try {
    return Number((d.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    d.close();
  }
}

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------

describe("myc code index — вход, которого не было", () => {
  test("в чистом TS-репозитории после команды code_files и code_defs непусты", async () => {
    expect(count("code_files")).toBe(0);
    expect(count("code_defs")).toBe(0);

    const d = await data("code", "index");
    expect(d["files"]).toBeGreaterThan(0);
    expect(d["defs"]).toBeGreaterThan(0);

    // Не «команда сказала», а «в базе лежит»: обещание проверяется таблицей.
    expect(count("code_files")).toBeGreaterThan(0);
    expect(count("code_defs")).toBeGreaterThan(0);

    const rows = db();
    try {
      const names = (
        rows.query("SELECT name, span_start FROM code_defs ORDER BY span_start").all() as Array<{
          name: string;
          span_start: number;
        }>
      ).map((r) => r.name);
      expect(names).toContain("fuseRRF");
      expect(names).toContain("callsFuse");
    } finally {
      rows.close();
    }
  });

  test("L0-файлы в реестре есть, определений у них нет (§5)", async () => {
    await data("code", "index");
    const d = db();
    try {
      const md = d.query("SELECT lang FROM code_files WHERE path = 'README.md'").get() as {
        lang: string;
      } | null;
      expect(md?.lang).toBe("md");
      expect(
        d.query("SELECT count(*) AS n FROM code_defs WHERE path = 'README.md'").get(),
      ).toMatchObject({ n: 0 });
    } finally {
      d.close();
    }
  });

  test("повторный прогон ничего не разбирает: инкрементальность видна в отчёте", async () => {
    await data("code", "index");
    const again = (await data("code", "index"))["drain"] as Record<string, number>;
    expect(again["parsed"]).toBe(0);
    expect(again["claimed"]).toBe(0);
  });

  /**
   * Главное решение этой задачи — «молчаливого пропуска быть не должно» — не
   * было защищено ничем: снятие `ctx.warn` целиком не роняло ни одного теста.
   * Файл, который не разобрали, ничем не отличается от файла без символов, и
   * человек узнаёт об этом только когда `myc code symbol` не находит того, что
   * точно есть.
   *
   * Каталог грамматик подменяется на пустой — это единственный способ увидеть
   * пропуск, не удаляя ничего из пользовательского кеша.
   */
  test("часть языков без грамматики — пропуск НАЗВАН, а не проглочен", async () => {
    // Каталог, где есть ТОЛЬКО typescript: ts разбирается, python — нет.
    // Это и есть интересный случай: пустой каталог даёт другую ветку (отказ
    // «ни одного символа»), и мутация в предупреждении на нём не видна.
    const partial = mkdtempSync(join(tmpdir(), "myc-partial-grammars-"));
    const real = grammarPath("ts");
    copyFileSync(real, join(partial, real.split("/").pop()!));
    writeFileSync(join(dir, "app.py"), "def fuse(a):\n    return a + 1\n");
    const saved = process.env["MYC_TREE_SITTER_GRAMMAR_DIR"];
    process.env["MYC_TREE_SITTER_GRAMMAR_DIR"] = partial;
    try {
      // Проверяется МАШИНОЧИТАЕМЫЙ канал: человеческий рендер печатает ту же
      // строку отдельно, и утверждение по тексту зеленело бы даже со снятым
      // `ctx.warn` — то есть агент, читающий конверт, о пропуске не узнал бы,
      // а тест бы этого не заметил.
      const r = await myc("code", "index", "--json");
      const env = JSON.parse(String(r.stdout ?? "")) as {
        warn?: Array<{ code: string; msg: string }>;
        data?: { missing_grammars?: Array<{ langs: string[]; fetch: string }> };
      };
      const warn = (env.warn ?? []).find((w) => w.code === "code_index.grammar_missing");
      expect(warn).toBeDefined();
      expect(warn!.msg).toContain("py");
      expect(warn!.msg).toContain("myc code fetch");
      // И то же — в данных, чтобы агент не разбирал текст предупреждения.
      expect(env.data?.missing_grammars?.some((m) => m.langs.includes("py"))).toBe(true);
      // При этом TS разобран: пропуск одного языка не отменяет остальных.
      expect(count("code_defs")).toBeGreaterThan(0);
    } finally {
      if (saved === undefined) delete process.env["MYC_TREE_SITTER_GRAMMAR_DIR"];
      else process.env["MYC_TREE_SITTER_GRAMMAR_DIR"] = saved;
      rmSync(partial, { recursive: true, force: true });
    }
  });

  test("--dry-run считает и не пишет", async () => {
    const d = await data("code", "index", "--dry-run");
    expect((d["scan"] as Record<string, number>)["dirty"]).toBeGreaterThan(0);
    expect(count("code_files")).toBe(0);
    expect(count("code_defs")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Читатель
// ---------------------------------------------------------------------------

describe("myc code symbol — читатель, ради которого индекс и строится", () => {
  test("symbol отвечает спаном И знанием, привязанным к этому участку", async () => {
    const task = (await data("task", "Переписать слияние RRF"))["id"] as string;
    await data("anchor", "add", task, "src/fuse.ts:5-6");
    await data("code", "index");

    const d = await data("code", "symbol", "fuseRRF");
    const defs = d["defs"] as Array<Record<string, unknown>>;
    expect(defs.length).toBe(1);
    expect(defs[0]!["path"]).toBe("src/fuse.ts");
    expect(defs[0]!["span_start"]).toBe(4);

    // Вот ответ, которого без индекса не было: якорь знает file:span, индекс —
    // symbol→span, и пересечение превращает «строки 5-6» в имя функции.
    const knowledge = defs[0]!["knowledge"] as Array<Record<string, unknown>>;
    expect(knowledge.length).toBe(1);
    expect(knowledge[0]!["id"]).toBe(task);
    expect(knowledge[0]!["title"]).toBe("Переписать слияние RRF");
  });

  /**
   * Знание о символе — то же, что отдаёт выдача: отменённое, заменённое,
   * отозванное (HIDDEN_STATUSES) и кандидат хука сжатия сюда не доезжают,
   * закрытое — история сделанного — остаётся. МУТАЦИЯ: без термов
   * `liveStatusPredicate`/`notPendingPredicate` в SQL_ANCHOR_OWNERS — пять
   * узлов вместо двух.
   */
  test("знание о символе — без скрытых статусов и без кандидатов", async () => {
    const ids: Record<string, string> = {};
    // Спаны разные: узел якоря адресуется содержимым, а все пять пересекают fuseRRF.
    const spans = { open: "5-6", closed: "4-5", cancelled: "6-7", superseded: "5", candidate: "7" };
    for (const [k, span] of Object.entries(spans)) {
      ids[k] = (await data("task", `Слияние RRF: ${k}`))["id"] as string;
      await data("anchor", "add", ids[k]!, `src/fuse.ts:${span}`);
    }
    const d = db();
    try {
      for (const st of ["closed", "cancelled", "superseded"]) {
        d.query("UPDATE nodes SET status = ?2 WHERE id = ?1").run(ids[st]!, st);
      }
      d.query(`UPDATE nodes SET attrs = json_set(attrs, '$.state', 'pending_review') WHERE id = ?1`).run(ids["candidate"]!);
    } finally {
      d.close();
    }
    await data("code", "index");
    const defs = (await data("code", "symbol", "fuseRRF"))["defs"] as Array<Record<string, unknown>>;
    const got = (defs[0]!["knowledge"] as Array<{ id: string }>).map((k) => k.id).sort();
    expect(got).toEqual([ids["open"]!, ids["closed"]!].sort());
  });

  test("fan_in подписан источником и считается по L1-корпусу", async () => {
    await data("code", "index");
    const d = await data("code", "symbol", "fuseRRF");
    const fan = d["fan_in"] as Record<string, unknown>;
    // README.md упоминает имя, но он L0 — в счёт не идёт; в fuse.ts остаётся
    // один вызов внутри callsFuse (строка определения не в счёт).
    expect(fan["source"]).toBe("text");
    expect(fan["n"]).toBe(1);
    expect(fan["files"]).toBe(1);
  });

  test("--no-fan-in не считает вовсе: чтение корпуса — плата, а не умолчание без выбора", async () => {
    await data("code", "index");
    const d = await data("code", "symbol", "fuseRRF", "--no-fan-in");
    expect(d["fan_in"]).toBeUndefined();
  });

  test("несуществующий символ — отказ, называющий просмотренное (§6.3)", async () => {
    await data("code", "index");
    const r = await myc("code", "symbol", "нетТакого");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.stderr).toContain("scanned");
    expect(r.stderr).toContain("files");
  });

  test("индекс не построен — это ДРУГОЙ ответ, а не «символа нет»", async () => {
    const r = await myc("code", "symbol", "fuseRRF");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("is not built");
    expect(r.stderr).toContain("myc code index");
  });

  test("без имени — usage, а не пустая выдача", async () => {
    const r = await myc("code", "symbol");
    expect(r.code).toBe(ExitCode.USAGE);
  });
});

// ---------------------------------------------------------------------------
// Поиск, исчерпывающий откат и карта (memory-5nvk1hwcene2)
// ---------------------------------------------------------------------------
//
//   МУТАЦИЯ «корпус не строится» — убрать `buildSearchUnits` из обработчика
//   `code index`: краснеет «search отвечает», потому что `code_units` пуст и
//   команда честно отказывает по precond.
//
//   МУТАЦИЯ «grep читает индекс» — заменить чтение файлов на выборку из
//   `code_ref_sites`: краснеет «grep находит литерал в markdown», потому что
//   в индексе символов markdown нет вовсе.
//
//   МУТАЦИЯ «рёбра по любому вхождению» — убрать `kind = 'import'` из
//   `SQL_REF_EDGES`: краснеет map-тест в `code-intel/src/map.test.ts`.

describe("myc code search — вопрос без знания имени", () => {
  test("search отвечает файлом и символом, назвав ступени и объём просмотра", async () => {
    await data("code", "index");
    const d = (await data("code", "search", "слияние рангов rrf")) as unknown as {
      hits: { path: string; units: { name: string; line: number }[] }[];
      stages: string[];
      searched: { units: number; files: number };
    };
    expect(d.hits.length).toBeGreaterThan(0);
    expect(d.hits[0]!.path).toBe("src/fuse.ts");
    expect(d.hits[0]!.units.some((u) => u.name === "fuseRRF")).toBe(true);
    expect(d.stages.length).toBeGreaterThan(0);
    expect(d.searched.units).toBeGreaterThan(0);
  });

  test("корпуса нет — это ДРУГОЙ ответ, а не «ничего не нашлось»", async () => {
    const r = await myc("code", "search", "слияние рангов");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("myc code index");
  });

  test("ничего не нашлось — предупреждение называет просмотренное и откат", async () => {
    await data("code", "index");
    const r = await myc("code", "search", "квазистеллар");
    expect(r.code).toBe(ExitCode.OK);
    // В человекочитаемом режиме предупреждения печатаются в stdout — вместе
    // с выдачей, к которой относятся; в stderr они уходят только при --json.
    expect(r.stdout as string).toContain("scanned");
    expect(r.stdout as string).toContain("myc code grep");
  });

  test("без вопроса — usage", async () => {
    const r = await myc("code", "search");
    expect(r.code).toBe(ExitCode.USAGE);
  });
});

describe("myc code grep — исчерпывающий откат", () => {
  test("находит литерал там, где индекса символов нет вовсе (markdown)", async () => {
    await data("code", "index");
    const d = (await data("code", "grep", "fuseRRF")) as unknown as {
      hits: number;
      files: number;
      searched: number;
      groups: { path: string; symbol: string; hits: { line: number }[] }[];
    };
    expect(d.groups.some((g) => g.path === "README.md")).toBe(true);
    expect(d.groups.some((g) => g.symbol === "callsFuse")).toBe(true);
    expect(d.hits).toBeGreaterThanOrEqual(3);
    expect(d.searched).toBeGreaterThanOrEqual(2);
  });

  test("вхождения относятся к охватывающему определению, а не к файлу целиком", async () => {
    await data("code", "index");
    const d = (await data("code", "grep", "out.push")) as unknown as {
      groups: { symbol: string; kind: string }[];
    };
    expect(d.groups.some((g) => g.symbol === "fuseRRF" && g.kind === "function")).toBe(true);
  });

  test("реестра файлов нет — precond, а не ноль вхождений", async () => {
    const r = await myc("code", "grep", "fuseRRF");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("myc code index");
  });

  test("без литерала — usage", async () => {
    const r = await myc("code", "grep");
    expect(r.code).toBe(ExitCode.USAGE);
  });
});

/**
 * Секретные по имени файлы (memory-wpr1x91jp8fm): индекс их не берёт и
 * говорит об этом ЧИСЛОМ, не называя имён; grep их не читает, а явный путь к
 * такому файлу — отказ DENIED. Дерево здесь не git — перечень идёт запасным
 * обходом, где .gitignore не спасает вовсе.
 */
describe("myc code — секретные по имени файлы", () => {
  const SECRET = "CLISECRET-2e9f";
  const TEMPLATE = "CLI-TEMPLATE-5a1c";

  beforeEach(() => {
    writeFileSync(join(dir, ".env"), `API_KEY=${SECRET}\n`);
    mkdirSync(join(dir, "deploy"));
    writeFileSync(join(dir, "deploy", "server.pem"), `${SECRET}\n`);
    writeFileSync(join(dir, ".env.example"), `API_KEY=${TEMPLATE}\n`);
  });

  test("index: счёт в --json и в строке scan, без имён файлов", async () => {
    const d = await data("code", "index");
    expect((d["scan"] as Record<string, number>)["secret_skipped"]).toBe(2);
    const human = await myc("code", "index");
    expect(human.code).toBe(ExitCode.OK);
    const out = human.stdout as string;
    expect(out).toMatch(/^scan .*secret-named skipped 2/m);
    expect(out).not.toContain(".env");
    expect(out).not.toContain("server.pem");
    expect(count("code_files")).toBe((d["scan"] as Record<string, number>)["files"]!);
  });

  test("grep: строка секрета не находится, шаблон — находится, --in на секрет — denied.secret", async () => {
    await data("code", "index");
    expect((await data("code", "grep", SECRET))["hits"]).toBe(0);
    expect((await data("code", "grep", SECRET, "--in", "deploy/.."))["hits"]).toBe(0);
    expect((await data("code", "grep", TEMPLATE))["hits"]).toBe(1);

    for (const target of [".env", "deploy/server.pem"]) {
      const r = await myc("code", "grep", SECRET, "--in", target, "--json");
      expect({ target, exit: r.code }).toEqual({ target, exit: ExitCode.DENIED });
      const env = JSON.parse(String(r.stdout ?? "")) as { ok: boolean; error?: { code: string } };
      expect(env.ok).toBe(false);
      expect(env.error?.code).toBe("denied.secret");
      // Отказ не читает файл — и ни строки его содержимого не печатает.
      expect(String(r.stdout ?? "") + String(r.stderr ?? "")).not.toContain("API_KEY=");
    }
  });
});

describe("myc code map — ориентация в незнакомом дереве", () => {
  test("карта печатает итоги, кластеры и СВОЙ размер в знаках", async () => {
    await data("code", "index");
    const d = (await data("code", "map")) as unknown as {
      files: number;
      defs: number;
      imports: number;
      clusters: { dir: string; files: number; defs: number }[];
      render_bytes: number;
    };
    expect(d.files).toBeGreaterThan(0);
    expect(d.defs).toBeGreaterThan(0);
    expect(d.clusters.length).toBeGreaterThan(0);
    // Бюджет контекста назван числом, а не обещанием: без этого карта
    // «помещается» ровно до первого большого репозитория.
    expect(d.render_bytes).toBeGreaterThan(0);
    const human = await myc("code", "map");
    expect(Buffer.byteLength(human.stdout as string, "utf8")).toBeGreaterThanOrEqual(d.render_bytes);
  });

  test("реестра файлов нет — precond, а не пустая карта", async () => {
    const r = await myc("code", "map");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr).toContain("myc code index");
  });
});

/**
 * Возраст индекса в ответе (memory-es8qwd555cjt, И2): строка статуса говорит
 * «9h ago» — ровно так же обязан говорить и ответ, собранный по этому
 * индексу. Один вход (`warnWorktree` → `warnFreshness`) у всех читателей:
 * symbol, search, grep, map здесь; skeleton и callers зовут тот же вход.
 */
describe("возраст индекса в ответе код-команд", () => {
  const HOUR = 3_600_000;

  function sql(text: string, ...params: Array<string | number>): void {
    const d = db();
    try {
      d.prepare(text).run(...params);
    } finally {
      d.close();
    }
  }
  const stamp = (at: number): void =>
    sql("INSERT INTO myc_meta (key, value) VALUES ('code_indexed_at', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", String(at));
  /** Строка фонового обновления; возвращает её id. */
  const refreshRow = (o: { lease?: number; attempts?: number; runAfter?: number; error?: string } = {}): number => {
    const d = db();
    try {
      const row = d
        .query(
          `INSERT INTO jobs(kind, entity_id, run_after, attempts, lease_holder, lease_expires, last_error, created_at)
           VALUES ('code_refresh', '.', ?1, ?2, ?3, ?4, ?5, 0) RETURNING id`,
        )
        .get(o.runAfter ?? 0, o.attempts ?? 0, (o.lease ?? 0) > 0 ? "code-refresh-1" : "", o.lease ?? 0, o.error ?? null) as { id: number };
      return row.id;
    } finally {
      d.close();
    }
  };

  async function warns(...args: string[]): Promise<Array<{ code: string; msg: string }>> {
    const r = await myc(...args, "--json");
    return ((JSON.parse(r.stdout as string) as { warn?: Array<{ code: string; msg: string }> }).warn ?? []).filter((w) =>
      w.code.startsWith("code_index.") && (w.code.endsWith("stale") || w.code.endsWith("refreshing")),
    );
  }

  beforeEach(async () => {
    await data("code", "index");
  });

  test("свежий индекс — ни слова о возрасте", async () => {
    expect(await warns("code", "symbol", "fuseRRF")).toEqual([]);
    expect(await warns("code", "search", "fuse")).toEqual([]);
  });

  test("старше порога и обновления нет — WARN code_index.stale у каждого читателя, с давностью и советом", async () => {
    stamp(Date.now() - 9 * HOUR);
    for (const args of [
      ["code", "symbol", "fuseRRF"],
      ["code", "search", "fuse"],
      ["code", "grep", "fuseRRF"],
      ["code", "map"],
    ]) {
      const w = await warns(...args);
      expect({ args, codes: w.map((x) => x.code) }).toEqual({ args, codes: ["code_index.stale"] });
      expect(w[0]!.msg).toContain("last refreshed 9h ago");
      expect(w[0]!.msg).toContain("older than 15m");
      expect(w[0]!.msg).toContain("no refresh is queued yet");
      expect(w[0]!.msg).toContain("`myc code index` refreshes it now");
    }
  });

  test("обновление в очереди, идёт, ждёт повтора, бросило — сказано, что именно", async () => {
    stamp(Date.now() - 9 * HOUR);
    refreshRow();
    expect((await warns("code", "symbol", "fuseRRF"))[0]!.msg).toContain("a refresh is queued");

    sql("DELETE FROM jobs WHERE kind = 'code_refresh'");
    refreshRow({ lease: Date.now() + 60_000 });
    const running = await warns("code", "symbol", "fuseRRF");
    expect(running.map((x) => x.code)).toEqual(["code_index.refreshing"]);
    expect(running[0]!.msg).toContain("being refreshed in the background right now");

    sql("DELETE FROM jobs WHERE kind = 'code_refresh'");
    refreshRow({ attempts: 2, runAfter: Date.now() + 60_000, error: "disk full" });
    expect((await warns("code", "symbol", "fuseRRF"))[0]!.msg).toContain("failed 2 times and retries at");

    sql("DELETE FROM jobs WHERE kind = 'code_refresh'");
    refreshRow({ attempts: 5, error: "disk full" });
    const dead = (await warns("code", "symbol", "fuseRRF"))[0]!.msg;
    expect(dead).toContain("gave up after 5 attempts (last error: disk full)");
    expect(dead).toContain("`myc code index` shows why and restarts it");
  });

  test("ручной `myc code index` не говорит о возрасте, ставит отметку и снимает брошенную работу фона", async () => {
    stamp(Date.now() - 9 * HOUR);
    refreshRow({ attempts: 5, error: "disk full" });
    const r = await myc("code", "index", "--json");
    const env = JSON.parse(r.stdout as string) as { warn?: Array<{ code: string }> };
    expect((env.warn ?? []).map((w) => w.code)).not.toContain("code_index.stale");
    expect(count("jobs")).toBe(0);
    expect(await warns("code", "symbol", "fuseRRF")).toEqual([]);
  });

  test("`--job` чужой или снятой работы дерево не читает и выходит", async () => {
    stamp(Date.now() - 9 * HOUR);
    const id = refreshRow({ lease: Date.now() + 60_000 });
    const d = await data("code", "index", "--job", String(id), "--holder", "не-тот");
    expect(d["taken"]).toBe(false);
    expect(String(d["reason"])).toContain("not under this holder's live lease");
    // Работа на месте, отметка прежняя: этот процесс ничего не делал.
    expect(count("jobs")).toBe(1);
    expect((await warns("code", "symbol", "fuseRRF")).map((x) => x.code)).toEqual(["code_index.refreshing"]);
  });

  test("`--job` своей работы: индекс сверен, отметка поставлена, работа снята", async () => {
    stamp(Date.now() - 9 * HOUR);
    const id = refreshRow({ lease: Date.now() + 60_000 });
    writeFileSync(join(dir, "src", "late.ts"), "export function lateArrival(): number {\n  return 3;\n}\n");
    const d = await data("code", "index", "--job", String(id), "--holder", "code-refresh-1");
    expect(d["taken"]).toBe(true);
    expect((d["runs"] as unknown[]).length).toBe(1);
    expect(count("jobs")).toBe(0);
    const sym = await data("code", "symbol", "lateArrival");
    expect(JSON.stringify(sym)).toContain("src/late.ts");
    expect(await warns("code", "symbol", "lateArrival")).toEqual([]);
  });
});
