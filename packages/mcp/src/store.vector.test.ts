/**
 * myc-6lc: векторная ветка обязана быть ДОСТИЖИМА С ПОВЕРХНОСТИ MCP.
 *
 * Дефект был не в отдельной функции, а в порядке событий долгоживущего
 * процесса. `Database.setCustomSQLite` работает только до первого
 * `new Database`, а MCP-сервер открывал свой стор (и прогонял `bootstrap`
 * для initialize.instructions) раньше, чем кто-либо просил вектор. Дальше
 * подъём рантайма отказывал ПО ОПРЕДЕЛЕНИЮ: `nodes_vec` не создавалась
 * никогда, и весь слой семантики на этой поверхности был недоступен. При
 * этом всё вело себя корректно — recall не падал и честно называл причину,
 * — поэтому ни один тест половин ничего не замечал.
 *
 * Здесь проверяется СТЫК: наблюдаемое состояние базы после открытия стора
 * так, как его открывает сервер.
 *
 * Среда без sqlite-vec — не пропуск, а второй проверяемый исход: там
 * обязан держаться S26 (никаких векторных объектов вовсе), и утверждения
 * ниже это разделение делают явным.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ensureSqliteRuntime, migrate, migrations } from "@myc/store-sqlite";
import { openMcpStore, openDriver } from "./store.ts";
import { raiseVectorRuntime, vectorNeeded } from "./command.ts";
import { AGENT_TOOLS, toolsForProfile } from "./tools.ts";

/** Факт среды, а не догадка: тот же источник, которым пользуется продукт. */
const VEC0 = ensureSqliteRuntime().vec.loaded;

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-mcp-vec-"));
  mkdirSync(join(dir, ".myc"));
  // База создаётся БЕЗ расширений — так её оставляет любая обычная команда.
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function vecObjects(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .query(
          "SELECT name FROM sqlite_master WHERE name LIKE '%vec%' OR name = 'schema_migrations_vec' ORDER BY name",
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
  } finally {
    db.close();
  }
}

describe("MCP: потребность в векторе объявлена инструментами", () => {
  test("профиль agent содержит инструмент, которому нужен вектор", () => {
    expect(vectorNeeded(toolsForProfile("agent"))).toBe(true);
    // Именно myc_recall, а не «какой-нибудь»: список не зашит в сервере.
    expect(AGENT_TOOLS.filter((t) => t.needsVector === true).map((t) => t.name)).toEqual([
      "myc_recall",
    ]);
  });

  test("профиль без векторных инструментов не поднимает рантайм", () => {
    const noVector = AGENT_TOOLS.filter((t) => t.needsVector !== true);
    expect(vectorNeeded(noVector)).toBe(false);
    expect(raiseVectorRuntime(noVector)).toBeUndefined();
  });
});

describe("MCP: стор с расширениями", () => {
  test("открытие без extensions не создаёт ни одного векторного объекта (S26)", async () => {
    const opened = await openMcpStore(dir);
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.handle.vec0).toBe(false);
    opened.handle.close();
    expect(vecObjects(join(dir, ".myc", "myc.db"))).toEqual([]);
  });

  test("открытие с extensions доводит векторные миграции до существующей базы", async () => {
    // Так открывает сервер, когда профиль просит вектор.
    const opened = await openMcpStore(dir, { extensions: true });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const { handle } = opened;
    try {
      if (VEC0) {
        // Ровно то, чего на этой поверхности не было никогда.
        expect(handle.vec0).toBe(true);
        expect(handle.vec0Reason).toBeUndefined();
        expect(vecObjects(join(dir, ".myc", "myc.db"))).toContain("nodes_vec");
        // Таблица не просто есть — она рабочая в ЭТОМ соединении.
        const n = handle.driver.database
          .query("SELECT count(*) AS n FROM nodes_vec")
          .get() as { n: number };
        expect(Number(n.n)).toBe(0);
      } else {
        // Без vec0 инвариант S26: база полноценна, векторных объектов нет.
        expect(handle.vec0).toBe(false);
        expect(vecObjects(join(dir, ".myc", "myc.db"))).toEqual([]);
      }
    } finally {
      handle.close();
    }
  });

  test("данные существующей базы переживают доведение векторного набора", async () => {
    const first = await openMcpStore(dir);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const node = first.handle.store.createNode({ kind: "task", scope: "", title: "до вектора" });
    first.handle.close();

    const second = await openMcpStore(dir, { extensions: true });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    try {
      const row = second.handle.driver.database
        .query("SELECT title FROM nodes WHERE id = ?1")
        .get(node.id) as { title: string } | null;
      expect(row?.title).toBe("до вектора");
    } finally {
      second.handle.close();
    }
  });

  test("повторное открытие не накатывает векторный набор второй раз", async () => {
    const a = await openMcpStore(dir, { extensions: true });
    expect(a.ok).toBe(true);
    if (a.ok) a.handle.close();
    const before = vecObjects(join(dir, ".myc", "myc.db"));
    const b = await openMcpStore(dir, { extensions: true });
    expect(b.ok).toBe(true);
    if (b.ok) b.handle.close();
    expect(vecObjects(join(dir, ".myc", "myc.db"))).toEqual(before);
  });

  test("отказ подъёма не убивает открытие: причина названа, работа идёт (И2)", () => {
    // Прямой драйвер с расширениями на несуществующей библиотеке: подъём
    // отказывает, соединение всё равно открывается и говорит почему.
    const dbPath = join(dir, ".myc", "myc.db");
    const saved = process.env.MYC_SQLITE;
    process.env.MYC_SQLITE = join(dir, "нет-такой-библиотеки.dylib");
    try {
      const d = openDriver(dbPath, undefined, { extensions: true });
      try {
        // Рантайм в этом процессе уже закеширован ensureSqliteRuntime() выше,
        // поэтому подмена переменной ничего не ломает — важно, что открытие
        // прошло и драйвер сообщает факт, а не намерение.
        expect(typeof d.vec0).toBe("boolean");
        expect(d.database.query("SELECT count(*) AS n FROM nodes").get()).toBeTruthy();
      } finally {
        d.close();
      }
    } finally {
      if (saved === undefined) delete process.env.MYC_SQLITE;
      else process.env.MYC_SQLITE = saved;
    }
  });

  /**
   * ГОНКА ПЕРВОГО ОТКРЫТИЯ НА ПОВЕРХНОСТИ MCP (memory-dm7p05hyskv9).
   *
   * Векторные миграции идут БЕЗ транзакции, поэтому проверка «версия
   * отстаёт» и сам накат не атомарны: два процесса, открывшие свежую базу
   * одновременно, оба видят «набор не применён», и проигравший получает
   * `table nodes_vec already exists`. На CLI это измерено (15 отказов на 36
   * одновременных `recall`) и закрыто ожиданием; MCP-путь звал `migrateVectors`
   * своей копией того же ожидания, и копии уже разошлись — имя таблицы учёта
   * писалось строкой мимо `VEC_MIGRATIONS_TABLE`. Теперь обе поверхности
   * зовут одну `ensureVectorSchema` из store-sqlite, и этот тест держит её
   * со стороны MCP.
   *
   * Настоящие процессы, а не имитация: гонка живёт между процессами.
   *
   * Мутация, которую тест обязан ловить: заменить в openMcpStore вызов
   * `ensureVectorSchema(driver.database)` на голый
   * `migrateVectors(driver.database, { vec0Loaded: true, writable: true })`.
   * Проверено тремя прогонами: 10, 12 и 12 отказов `already exists` из 12
   * процессов. С ожиданием — пять прогонов подряд по 0.
   */
  test("двенадцать одновременных открытий стора: ни одного отказа, набор накатан один раз", async () => {
    const WORKER = join(import.meta.dir, "store.vector.worker.ts");
    const WORKERS = 12;
    // Общий момент старта: без него процессы доходят до открытия по
    // очереди и гонки не выходит вовсе — см. комментарий в воркере.
    const startAt = Date.now() + 1500;
    const procs = Array.from({ length: WORKERS }, () =>
      Bun.spawn([process.execPath, WORKER, dir, String(startAt)], {
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, NODE_ENV: "test", MYC_ACTOR: "tester" },
      }),
    );
    const codes = await Promise.all(procs.map((p) => p.exited));
    const errors = await Promise.all(procs.map((p) => new Response(p.stderr).text()));
    expect(errors.filter((e) => e.includes("already exists"))).toEqual([]);
    expect(codes).toEqual(Array.from({ length: WORKERS }, () => 0));

    if (VEC0) {
      // Ровно один комплект записей учёта: победитель накатил, проигравшие
      // дождались и перечитали, а не накатили поверх.
      const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
      try {
        const rows = db
          .query("SELECT version, count(*) AS n FROM schema_migrations_vec GROUP BY version")
          .all() as Array<{ version: number; n: number }>;
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.filter((r) => r.n !== 1)).toEqual([]);
      } finally {
        db.close();
      }
    }
  }, 60_000);
});
