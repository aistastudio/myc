/**
 * Приёмка кеша дайджестов НА НАСТОЯЩИХ ПРОЦЕССАХ (memory-eb91mperrr2k):
 * устаревший кеш никогда не отдаётся, и два процесса видят инвалидацию
 * друг друга.
 *
 * Почему Bun.spawn, а не in-process. Кеш лежит в таблице, а его версия
 * читается из оплога — и то, и другое разделяется между процессами. Кеш,
 * который инвалидируется только своими же записями (счётчик в памяти,
 * `myc_meta.last_seq`, кеш в переменной модуля), проходит любой
 * однопоточный тест ЦЕЛИКОМ и ломается ровно там, где живёт продукт:
 * MCP-сервер читает, one-shot CLI пишет. В этом проекте молчаливая потеря
 * записей на гонках дважды находилась только настоящими процессами
 * (S38, S40).
 *
 * Формулировка «устаревший не отдаётся» здесь строгая и без гонки с самим
 * собой: воркер печатает `seq_before` — хвост оплога, прочитанный ДО
 * запуска команды. Если запись уже была в базе на старте процесса
 * (`seq_before >= seq` записи), его ответ ОБЯЗАН её отражать.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { cliTestEnv } from "@myc/core";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createTaskCommand } from "./tasks.ts";

let root: string;
let homeDir: string;
let ws: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createTaskCommand());
  return r;
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-digest-mp-"));
  homeDir = mkdtempSync(join(tmpdir(), "myc-digest-mp-home-"));
  process.env.MYC_HOME = homeDir;
  registry = makeRegistry();
  ws = join(root, "ws");
  Bun.spawnSync(["mkdir", "-p", ws]);
  const init: RunResult = await run(["-C", ws, "init"], {
    registry,
    env: { MYC_ACTOR: "tester" },
  });
  expect(init.code).toBe(ExitCode.OK);
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(root, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
});

interface Report {
  readonly ok: boolean;
  readonly code: number;
  readonly seq_before: number;
  readonly seq_after: number;
  readonly cache?: string;
  readonly blocked?: number;
  readonly in_progress?: number;
  readonly decisions?: readonly string[];
  readonly core?: readonly string[];
  readonly ready?: readonly string[];
  readonly id?: string;
  readonly blocker?: string;
  readonly stderr?: string;
  readonly rows?: ReadonlyArray<{ profile: string; variant: string; seq: number }>;
}

interface WorkerOpts {
  readonly mode: "prime" | "ready" | "note" | "block";
  readonly text?: string;
  readonly session?: string;
  readonly go?: string;
  readonly actor?: string;
}

function spawnWorker(o: WorkerOpts): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn({
    cmd: [
      process.execPath,
      join(import.meta.dir, "digest-cache.worker.ts"),
      "--dir", ws,
      "--mode", o.mode,
      ...(o.text !== undefined ? ["--text", o.text] : []),
      ...(o.session !== undefined ? ["--session", o.session] : []),
      ...(o.go !== undefined ? ["--go", o.go] : []),
    ],
    env: cliTestEnv({ MYC_ACTOR: o.actor ?? "worker", MYC_HOME: homeDir }),
    stdout: "pipe",
    stderr: "pipe",
  }) as Bun.Subprocess<"ignore", "pipe", "pipe">;
}

async function collect(proc: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<Report> {
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = out.trim();
  if (line.length === 0) {
    throw new Error(`воркер молчит, exit=${proc.exitCode}, stderr=${err.slice(0, 800)}`);
  }
  const report = JSON.parse(line) as Report;
  if (!report.ok) {
    throw new Error(`воркер не справился: ${line}\n${err.slice(0, 800)}`);
  }
  return report;
}

/** Один настоящий процесс от начала до конца. */
async function worker(o: WorkerOpts): Promise<Report> {
  return collect(spawnWorker(o));
}

/** Прямой взгляд в таблицу кеша мимо кода команд. */
function cacheTable(): Array<{ profile: string; variant: string; seq: number; payload: string }> {
  const db = new Database(join(ws, ".myc", "myc.db"));
  try {
    return db
      .query(`SELECT profile, variant, seq, payload FROM digest_cache ORDER BY profile, variant`)
      .all() as Array<{ profile: string; variant: string; seq: number; payload: string }>;
  } finally {
    db.close();
  }
}

describe("digest_cache между процессами", () => {
  test("кеш кросс-процессный: прогрел один процесс — попал ДРУГОЙ", async () => {
    await worker({ mode: "note", text: "решение о кеше дайджеста" });

    const first = await worker({ mode: "prime" });
    expect(first.cache).toBe("miss");

    // Другой процесс, своё соединение, своя память — и всё же попадание:
    // кеш живёт в базе, а не в переменной модуля.
    const second = await worker({ mode: "prime" });
    expect(second.cache).toBe("hit");
    expect(second.decisions).toEqual(first.decisions!);

    const rows = cacheTable();
    // Стык S4: prime — это profile='prime', и таблица одна на оба профиля.
    expect(rows.map((r) => r.profile).sort()).toEqual(["prime", "ready"]);
  });

  test("ДВА ПРОЦЕССА видят инвалидацию друг друга (в обе стороны)", async () => {
    // Пустой воркспейс prime не кеширует (считать нечего) — сначала запись.
    await worker({ mode: "note", text: "исходное решение", actor: "seed" });
    const a1 = await worker({ mode: "prime", actor: "A" });
    expect(a1.cache).toBe("miss");
    expect((await worker({ mode: "prime", actor: "A" })).cache).toBe("hit");

    // Сторона 1: пишет B — промахивается A.
    const writeB = await worker({ mode: "note", text: "заметка процесса B", actor: "B" });
    expect(writeB.seq_after).toBeGreaterThan(writeB.seq_before);

    const a2 = await worker({ mode: "prime", actor: "A" });
    expect(a2.cache).toBe("miss");
    // Не просто промах — именно СВЕЖИЙ ответ.
    expect(a2.decisions).toContain(writeB.id!);
    expect((await worker({ mode: "prime", actor: "A" })).cache).toBe("hit");

    // Сторона 2: пишет A — промахивается B. Роли поменялись местами.
    const writeA = await worker({ mode: "note", text: "заметка процесса A", actor: "A" });
    const b2 = await worker({ mode: "prime", actor: "B" });
    expect(b2.cache).toBe("miss");
    expect(b2.decisions).toContain(writeA.id!);
  });

  test("устаревший ответ не отдаётся НИ РАЗУ на 8 циклах запись→чтение", async () => {
    const seen: Array<{ blocked: number; cache: string }> = [];
    for (let i = 1; i <= 8; i++) {
      const w = await worker({ mode: "block", text: `цикл ${i}`, actor: `w${i}` });
      expect(w.seq_after).toBeGreaterThan(w.seq_before);

      const r = await worker({ mode: "prime", actor: `r${i}` });
      // Запись была завершена до старта читателя — его ответ обязан её знать.
      expect(r.seq_before).toBeGreaterThanOrEqual(w.seq_after);
      expect(r.cache).toBe("miss");
      expect(r.blocked).toBe(i);
      seen.push({ blocked: r.blocked!, cache: r.cache! });

      // Повтор без записей — попадание, и то же самое число.
      const again = await worker({ mode: "prime", actor: `r${i}b` });
      expect(again.cache).toBe("hit");
      expect(again.blocked).toBe(i);
    }
    expect(seen.map((s) => s.blocked)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("счётчики подвала (profile='ready') протухают от записи чужого процесса", async () => {
    const first = await worker({ mode: "ready" });
    expect(first.blocked).toBe(0);
    const w = await worker({ mode: "block", text: "блокированная", actor: "writer" });
    expect(w.seq_after).toBeGreaterThan(w.seq_before);

    const second = await worker({ mode: "ready" });
    expect(second.seq_before).toBeGreaterThanOrEqual(w.seq_after);
    expect(second.blocked).toBe(1);
    expect(second.rows!.some((r) => r.profile === "ready")).toBe(true);
  });

  test("вариант ключа держится между процессами: сессия A не получает дайджест сессии B", async () => {
    // Пустой воркспейс prime не кеширует вовсе (считать нечего) — сначала
    // даём ему что показывать, иначе тест проверял бы ветку `empty`.
    await worker({ mode: "note", text: "решение, видимое обеим сессиям" });
    const a = await worker({ mode: "prime", session: "sessionA" });
    expect(a.cache).toBe("miss");
    const b = await worker({ mode: "prime", session: "sessionB" });
    // Другая сессия — другой вариант ключа, и попадания быть не может.
    expect(b.cache).toBe("miss");
    const aAgain = await worker({ mode: "prime", session: "sessionA" });
    expect(aAgain.cache).toBe("hit");

    const variants = cacheTable()
      .filter((r) => r.profile === "prime")
      .map((r) => r.variant)
      .sort();
    expect(variants).toEqual(["v3:sessionA:", "v3:sessionB:"]);
  });

  test("шесть процессов промахиваются ОДНОВРЕМЕННО: запись кеша не рвёт ответ", async () => {
    await worker({ mode: "note", text: "общее решение" });
    const barrier = join(root, "go");
    const procs = Array.from({ length: 6 }, (_, i) =>
      spawnWorker({ mode: "prime", actor: `p${i}`, go: barrier }),
    );
    writeFileSync(barrier, "go");
    const reports = await Promise.all(procs.map(collect));

    // Ни один не упал на блокировке записи и все увидели одно и то же.
    for (const r of reports) expect(r.code).toBe(ExitCode.OK);
    const shapes = new Set(reports.map((r) => JSON.stringify(r.decisions)));
    expect(shapes.size).toBe(1);
    // Хотя бы один посчитал по-настоящему; остальные — как повезло с гонкой.
    expect(reports.some((r) => r.cache === "miss")).toBe(true);
    expect(cacheTable().filter((r) => r.profile === "prime").length).toBe(1);
  }, 30_000);

  test("читатели и писатель вперемешку: свежесть проверяется по seq на старте", async () => {
    const barrier = join(root, "go-mixed");
    const readers = Array.from({ length: 4 }, (_, i) =>
      spawnWorker({ mode: "prime", actor: `mr${i}`, go: barrier }),
    );
    const writers = Array.from({ length: 2 }, (_, i) =>
      spawnWorker({ mode: "block", text: `гонка ${i}`, actor: `mw${i}`, go: barrier }),
    );
    writeFileSync(barrier, "go");
    const [readerReports, writerReports] = await Promise.all([
      Promise.all(readers.map(collect)),
      Promise.all(writers.map(collect)),
    ]);

    // Сколько блокированных задач существовало на момент старта каждого
    // читателя — по seq, а не по надежде: запись, чей seq_after <=
    // seq_before читателя, уже была в базе, когда он открыл её.
    for (const r of readerReports) {
      const committedBefore = writerReports.filter(
        (w) => w.seq_after <= r.seq_before,
      ).length;
      expect(r.blocked!).toBeGreaterThanOrEqual(committedBefore);
    }
    // После гонки — устойчивое согласие: последний читатель видит обе записи.
    const settled = await worker({ mode: "prime", actor: "settled" });
    expect(settled.blocked).toBe(2);
  }, 30_000);
});
