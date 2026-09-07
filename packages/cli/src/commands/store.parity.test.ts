/**
 * S43 (myc-ahy) + myc-qie.12: PRAGMA и предохранитель WAL — один источник для
 * ВСЕХ путей открытия базы, а не только для CLI и полного store-sqlite-пути.
 * Третий путь (MCP, packages/mcp/src/store.ts) отстал от S43 ровно так же,
 * как когда-то CLI отставал от S35: собственный литеральный список PRAGMA
 * под комментарием "тот же набор" — комментарий утверждал соответствие, но
 * соответствия не обеспечивал.
 *
 * Тест здесь бьётся на две задачи:
 *
 *  1. ПАРИТЕТ поведения — сравнивает ЖИВОЕ состояние соединений (PRAGMA,
 *     поведение предохранителя под непрерывной записью) для каждого
 *     зарегистрированного пути. Список путей объявлен один раз в PATHS ниже;
 *     добавление нового пути в PATHS автоматически добавляет его в оба теста.
 *
 *  2. ИСЧЕРПАЕМОСТЬ — гарантирует, что PATHS действительно перечисляет ВСЕ
 *     места, которые могут открыть базу для продолжительной записи через
 *     GraphStore. Сравнивать значения PRAGMA можно только у путей, о которых
 *     тест знает; настоящий риск — путь, о котором никто не знает. Поэтому
 *     tests сканируют исходники на литеральный текст PRAGMA-списка: единственное
 *     место, где ему разрешено существовать литералом, — определение
 *     STORE_PRAGMAS в store-sqlite/index.ts и явно перечисленные одноразовые
 *     bootstrap-писатели (создание файла БД один раз за жизнь воркспейса, не
 *     GraphStore-путь агента). Любой новый файл с собственным литеральным
 *     списком PRAGMA — это ровно тот класс регрессии, что случался трижды
 *     подряд (S43, затем MCP), и тест обязан упасть на нём немедленно, не
 *     дожидаясь, пока кто-то вручную добавит путь в PATHS.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Database } from "bun:sqlite";
import { HlcClock, generateId } from "@myc/core";
import type { DbDriver } from "@myc/core";
import {
  migrate,
  migrations,
  ensureSqliteRuntime,
  openSqlite,
  GraphStore,
  type SqliteDriver,
  type WalGuard,
  type WalGuardStats,
} from "@myc/store-sqlite";
import { openDriver as openCliDriver, type CliDriver } from "./store.ts";
import { internalOpenDriver as openMcpDriver, type McpDriver } from "@myc/mcp";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-store-parity-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1) Реестр путей открытия базы — единственное место, где они перечислены.
// ---------------------------------------------------------------------------

interface WriteDriver extends DbDriver {
  readonly database: Database;
  readonly wal: WalGuard;
  close(): void;
}

interface OpenPath {
  readonly name: string;
  /** Пороги предохранителя передаются явно — тест держит их маленькими. */
  open(path: string, wal: { hardLimitBytes: number; softLimitBytes: number }): WriteDriver;
  walStats(driver: WriteDriver): WalGuardStats;
}

const PATHS: readonly OpenPath[] = [
  {
    name: "store-sqlite (движок, полный рантайм расширений)",
    open: (path, wal) => openSqlite({ path, wal }) as unknown as WriteDriver,
    walStats: (d) => (d as unknown as SqliteDriver).walStats(),
  },
  {
    name: "cli (лёгкий драйвер, packages/cli/src/commands/store.ts)",
    open: (path, wal) => openCliDriver(path, wal) as unknown as WriteDriver,
    walStats: (d) => (d as unknown as CliDriver).wal.stats(),
  },
  {
    name: "mcp (лёгкий драйвер, packages/mcp/src/store.ts)",
    open: (path, wal) => openMcpDriver(path, wal) as unknown as WriteDriver,
    walStats: (d) => (d as unknown as McpDriver).wal.stats(),
  },
];

// PRAGMA, которые определяют бюджет записи И1 (S35/S43) и должны совпадать
// побитово между всеми путями. Не полный список всех PRAGMA SQLite — только
// те, что реально применяются STORE_PRAGMAS.
const CHECKED_PRAGMAS = [
  "journal_mode",
  "synchronous",
  "foreign_keys",
  "busy_timeout",
  "cache_size",
  "mmap_size",
  "temp_store",
  "wal_autocheckpoint",
  "journal_size_limit",
  "analysis_limit",
  "trusted_schema",
] as const;

function readPragmas(db: Database): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of CHECKED_PRAGMAS) {
    const row = db.query(`PRAGMA ${name}`).get() as Record<string, unknown> | null;
    out[name] = row === null ? null : Object.values(row)[0];
  }
  return out;
}

describe("S43/myc-qie.12: паритет PRAGMA между всеми путями открытия базы", () => {
  test(`живые значения PRAGMA совпадают на всех ${PATHS.length} путях`, async () => {
    const opened: { name: string; driver: WriteDriver }[] = [];
    try {
      for (const p of PATHS) {
        const driver = p.open(join(dir, `${p.name.split(" ")[0]}.db`), {
          hardLimitBytes: 32 * 1024 * 1024,
          softLimitBytes: 8 * 1024 * 1024,
        });
        await migrate(driver.database, { migrations, writable: true });
        opened.push({ name: p.name, driver });
      }

      const [reference, ...rest] = opened;
      if (reference === undefined) throw new Error("PATHS пуст");
      const referencePragmas = readPragmas(reference.driver.database);
      for (const other of rest) {
        expect(readPragmas(other.driver.database)).toEqual(referencePragmas);
      }

      // Регрессия S35/S43/myc-qie.12 конкретно: авточекпойнт выключен и WAL
      // не усекается до нуля на КАЖДОМ пути, а не просто "все пути одинаковы,
      // но все сломаны одинаково".
      expect(referencePragmas.wal_autocheckpoint).toBe(0);
      expect(referencePragmas.journal_size_limit).toBe(0);
    } finally {
      for (const { driver } of opened) driver.close();
    }
  });

  test(`предохранитель WAL работает на всех ${PATHS.length} путях: непрерывная запись не растит WAL без предела`, async () => {
    const HARD = 256 * 1024;
    const SOFT = 128 * 1024;

    for (const p of PATHS) {
      const dbPath = join(dir, `${p.name.split(" ")[0]}-guard.db`);
      const driver = p.open(dbPath, { hardLimitBytes: HARD, softLimitBytes: SOFT });
      await migrate(driver.database, { migrations, writable: true });
      const store = new GraphStore(driver, {
        siteId: `site-${p.name.split(" ")[0]}`,
        actor: "tester",
        newId: () => generateId(),
        clock: new HlcClock(),
      });

      try {
        for (let i = 0; i < 400; i++) {
          store.createNode({
            kind: "note",
            scope: "s",
            title: `узел ${i}`,
            body: `тело записи ${i} — достаточно текста, чтобы заметно расти в WAL`,
            attrs: { topic: `t${i % 16}` },
          });
        }
        const walBytes = statSync(`${dbPath}-wal`, { throwIfNoEntry: false })?.size ?? 0;
        expect(p.walStats(driver).checkpoints).toBeGreaterThan(0);
        // Мера честна только при journal_size_limit=0 (без него файл переиспользуется
        // и никогда не усекается — ровно то, из-за чего дефект не был виден по
        // размеру). Допуск rearm+запас против последнего незавершённого цикла.
        expect(walBytes).toBeLessThan(HARD + 512 * 1024);
      } finally {
        driver.close();
      }
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 2) Исчерпаемость: ни один файл вне явного allowlist'а не смеет держать
//    собственный литеральный список PRAGMA. Ловит будущий "четвёртый путь"
//    ДО того, как кто-то забудет добавить его в PATHS.
// ---------------------------------------------------------------------------

// Единственное определение STORE_PRAGMAS + одноразовые bootstrap-писатели,
// которые намеренно НЕ проходят через GraphStore и НЕ являются путём
// продолжительной записи агента (создают файл БД один раз за жизнь
// воркспейса/машины, см. комментарии в самих файлах). Любой другой файл с
// литеральным "PRAGMA journal_mode" — это неучтённый путь.
const ALLOWLISTED_LITERAL_PRAGMA_FILES = new Set<string>([
  "packages/store-sqlite/src/index.ts", // определение STORE_PRAGMAS
  "packages/cli/src/commands/init.ts", // `myc init`: одноразовое создание файла, без GraphStore
  "packages/cli/src/commands/store.ts", // createPersonalWorkspace (S41): одноразовое создание личного яруса
]);

const SCAN_ROOTS = ["packages/cli/src", "packages/mcp/src", "packages/store-sqlite/src"];

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// 1b) Ленивость рантайма расширений — ПАРАМЕТР пути, а не новый путь (S45).
// ---------------------------------------------------------------------------
//
// Реестр PATHS выше намеренно остаётся из трёх записей: `openDriver` с
// `extensions: true` — то же самое соединение той же функции, а не четвёртый
// путь. Утверждение «пути имеют право отличаться только загрузкой рантайма
// расширений» (S43) после S45 стало проверяемым в обе стороны, и здесь оно
// проверяется буквально: включённый рантайм не меняет в соединении НИЧЕГО,
// кроме доступности vec0.

describe("S45: рантайм расширений — параметр открытия, а не четвёртый путь", () => {
  test("openDriver с extensions и без него дают побитово одинаковые PRAGMA", async () => {
    const wal = { hardLimitBytes: 32 * 1024 * 1024, softLimitBytes: 8 * 1024 * 1024 };
    const plain = openCliDriver(join(dir, "plain.db"), wal);
    const withExt = openCliDriver(join(dir, "with-ext.db"), wal, { extensions: true });
    try {
      await migrate(plain.database, { migrations, writable: true });
      await migrate(withExt.database, { migrations, writable: true });
      expect(readPragmas(withExt.database)).toEqual(readPragmas(plain.database));
    } finally {
      plain.close();
      withExt.close();
    }
  });

  test("отличие ровно одно: vec0 доступен только там, где его просили", () => {
    const wal = { hardLimitBytes: 32 * 1024 * 1024, softLimitBytes: 8 * 1024 * 1024 };
    const plain = openCliDriver(join(dir, "plain-vec.db"), wal);
    const withExt = openCliDriver(join(dir, "with-ext-vec.db"), wal, { extensions: true });
    try {
      expect(plain.vec0).toBe(false);
      // В среде без sqlite-vec (CI без расширения) `true` невозможен — тогда
      // утверждение вырождается в «оба false», и это тоже верный исход (И2).
      expect(withExt.vec0).toBe(ensureSqliteRuntime().vec.loaded);
    } finally {
      plain.close();
      withExt.close();
    }
  });
});

describe("myc-qie.12: исчерпаемость реестра путей открытия базы", () => {
  test("PATHS перечисляет все три известных пути записи", () => {
    expect(PATHS.map((p) => p.name).sort()).toEqual(
      [
        "cli (лёгкий драйвер, packages/cli/src/commands/store.ts)",
        "mcp (лёгкий драйвер, packages/mcp/src/store.ts)",
        "store-sqlite (движок, полный рантайм расширений)",
      ].sort(),
    );
  });

  test("ни один production-файл вне allowlist'а не держит собственный литеральный список PRAGMA", () => {
    const repoRoot = resolve4Up(import.meta.dir);
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of listTsFiles(join(repoRoot, root))) {
        const rel = relative(repoRoot, file).split("\\").join("/");
        const text = readFileSync(file, "utf8");
        if (!text.includes('"PRAGMA journal_mode')) continue;
        if (!ALLOWLISTED_LITERAL_PRAGMA_FILES.has(rel)) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});

function resolve4Up(dir: string): string {
  return join(dir, "..", "..", "..", "..");
}
