/**
 * СТОРОЖ ПОЛНОТЫ подключения S65: место, где может родиться `site_id`, обязано
 * решать его через `ensureSiteId`.
 *
 * Зачем отдельный сторож, а не «просто тесты на каждое место». Мест пять, и
 * они в трёх пакетах. Подключишь четыре из пяти — база откроется то с
 * перевыпуском, то без, смотря КТО открыл первым: `myc ready`, фоновый дренаж
 * или MCP-сервер. Симптом при этом плавающий, воспроизводится через раз и
 * выглядит как что угодно, кроме забытого вызова. Ровно этот класс уже ловил
 * `register.test.ts` («написанное обязано быть подключённым»), и устроен
 * сторож по его образцу: корпус СОБИРАЕТСЯ ИЗ ИСХОДНИКА, а не перечисляется,
 * и намеренно не даёт себе стать пустым.
 *
 * Две половины, и обе обязательны.
 *
 *   1. ПОИСК. Сканируется исходник всех пакетов, и точкой открытия считается
 *      единица кода, где site_id может РОДИТЬСЯ (`mintSiteId(`, либо старая
 *      форма — шаблон `local-${…}`) либо СВЯЗАТЬСЯ С БАЗОЙ (`new GraphStore(`).
 *      Каждая найденная единица обязана звать `ensureSiteId(`. Появится шестое
 *      место — сторож найдёт его сам и потребует того же.
 *
 *   2. ДОКАЗАТЕЛЬСТВО. Текст лжив: `ensureSiteId(` может стоять в мёртвой
 *      ветке. Поэтому у каждой найденной единицы обязан быть прувер — тест,
 *      который гоняет ЭТУ функцию на копии базы и смотрит, что перевыпуск
 *      случился. Реестр пруверов сверяется с результатом поиска в обе
 *      стороны: место без прувера — красный, прувер без места — красный.
 *
 * Мутационная проверка (отчёт): снятие `ensureSiteId` в ЛЮБОМ одном из пяти
 * мест роняет обе половины.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { META_SITE_ID, META_SITE_INSTANCE } from "@myc/store-sqlite";
import { openMcpStore } from "@myc/mcp";
import { run, type RunResult } from "./index.ts";
import { Registry } from "./registry.ts";
import { openDrainHandle } from "./drain.ts";
import { createInitCommand } from "./commands/init.ts";
import { createTaskCommand } from "./commands/tasks.ts";
import { createPersonalWorkspace, openDriver } from "./commands/store.ts";

// ---------------------------------------------------------------------------
// Половина 1: поиск точек открытия
// ---------------------------------------------------------------------------

const PACKAGES = resolve(import.meta.dir, "..", "..");

/**
 * Место, где `site_id` может родиться или связаться с базой. Обе формы минта
 * ищутся нарочно: `mintSiteId(` — сегодняшняя, шаблон `local-${` — та, что
 * стояла до S65 и в которую откатывается любая правка «сделать как было».
 */
const OPENS_DB = /mintSiteId\s*\(|`local-\$\{|new\s+(?:GraphStore|RepoScopedStore)\s*\(/;
const DECIDES = /ensureSiteId\s*\(/;

/**
 * Комментарии из тела вырезаются ДО поиска, и это не косметика. Первая версия
 * сторожа пропускала мутанта в `createPersonalWorkspace`: там в комментарии
 * стояло «решает ensureSiteId (S65)», и регулярка считала это вызовом. Ровно
 * от этого предостерегает `register.test.ts` — «поиск строки по исходнику не
 * отличал бы зарегистрированное от упомянутого в комментарии».
 *
 * `//` внутри строки (`https://…`) не трогается: перед ним стоит двоеточие.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Начало единицы верхнего уровня: с неё и до следующей — одна «функция». */
const TOP_LEVEL =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

/**
 * Файлы, которые исключены из корпуса, и почему — каждый с причиной прямо
 * здесь, как список исключений в register.test.ts.
 *
 *   *.worker.ts — процессы-фикстуры многопроцессных тестов. Site_id приходит
 *     к ним аргументом `--site` от теста, который их запустил; решения об
 *     идентичности базы они не принимают и принимать не должны.
 *   site-identity.ts — сама реализация: там `mintSiteId` определён.
 */
const SKIP_SUFFIX = [".worker.ts", ".d.ts"];
const SKIP_FILE = ["store-sqlite/src/site-identity.ts"];

interface Unit {
  /** путь от packages/, в форме отчёта */
  readonly file: string;
  /** имя единицы верхнего уровня */
  readonly fn: string;
  readonly body: string;
  readonly line: number;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      sourceFiles(p, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.includes(".test.")) continue;
    if (SKIP_SUFFIX.some((s) => entry.name.endsWith(s))) continue;
    const rel = relative(PACKAGES, p);
    if (SKIP_FILE.some((s) => rel.endsWith(s))) continue;
    out.push(p);
  }
  return out;
}

/** Разбить файл на единицы верхнего уровня. Код до первой — «(module)». */
function unitsOf(path: string): Unit[] {
  const rel = relative(PACKAGES, path);
  const lines = readFileSync(path, "utf8").split("\n");
  const units: Unit[] = [];
  let name = "(module)";
  let start = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    units.push({
      file: rel,
      fn: name,
      body: stripComments(lines.slice(start, end).join("\n")),
      line: start + 1,
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = TOP_LEVEL.exec(lines[i]!);
    if (m === null) continue;
    flush(i);
    name = m[1]!;
    start = i;
  }
  flush(lines.length);
  return units;
}

function openingPoints(): Unit[] {
  const found: Unit[] = [];
  for (const file of sourceFiles(PACKAGES)) {
    for (const unit of unitsOf(file)) {
      if (OPENS_DB.test(unit.body)) found.push(unit);
    }
  }
  return found;
}

const key = (u: Unit): string => `${u.file}::${u.fn}`;

// ---------------------------------------------------------------------------
// Половина 2: пруверы — по одному на найденную точку
// ---------------------------------------------------------------------------

/**
 * Прувер получает каталог, где лежит воркспейс-КОПИЯ (site_id уже прописан,
 * site_instance указывает на ЧУЖОЙ инод), гоняет свою точку открытия и
 * возвращает site_id, который эта точка выдала. Перевыпуск — это когда
 * возвращённое отличается от прежнего.
 */
type Prover = (ws: string, dbPath: string) => Promise<string>;

let root: string;
let registry: Registry;

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createTaskCommand());
  return r;
}

function myc(dir: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { ...process.env, MYC_ACTOR: "tester" } });
}

function meta(dbPath: string, key: string): string | undefined {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.query("SELECT value FROM myc_meta WHERE key = ?1").get(key) as
      | { value: string }
      | null)?.value;
  } finally {
    db.close();
  }
}

/** Свежий воркспейс с одной задачей: `site_id` и `site_instance` записаны. */
async function seedWorkspace(name: string): Promise<{ ws: string; dbPath: string }> {
  const ws = join(root, name);
  mkdirSync(ws, { recursive: true });
  await myc(ws, "init");
  await myc(ws, "task", "исходная");
  return { ws, dbPath: join(ws, ".myc", "myc.db") };
}

/** `cp -R` каталога: новый инод, тот же site_id — ровно то, что лечит S65. */
function copyOf(ws: string, name: string): { ws: string; dbPath: string } {
  const dst = join(root, name);
  cpSync(ws, dst, { recursive: true });
  return { ws: dst, dbPath: join(dst, ".myc", "myc.db") };
}

const PROVERS: ReadonlyMap<string, Prover> = new Map<string, Prover>([
  [
    "cli/src/commands/store.ts::openWorkspaceAt",
    // Через настоящую команду CLI: openWorkspaceAt не экспортирован, и это
    // правильно — пользователь до него доходит только так.
    async (ws, dbPath) => {
      await myc(ws, "task", "после копии");
      return meta(dbPath, META_SITE_ID) ?? "";
    },
  ],
  [
    "cli/src/commands/store.ts::createPersonalWorkspace",
    async (ws, dbPath) => {
      // Личный ярус создаётся под своим каталогом; копия ~/.myc — тот же
      // сценарий, что копия проектного воркспейса, и тот же ответ на него.
      const home = join(ws, "..", `${relative(root, ws)}-home`);
      mkdirSync(home, { recursive: true });
      cpSync(join(ws, ".myc"), join(home, ".myc"), { recursive: true });
      const created = await createPersonalWorkspace(home);
      // Прувер обязан отвечать про ТУ базу, которую открывал.
      expect(created.dbPath).toBe(join(home, ".myc", "myc.db"));
      expect(dbPath.endsWith("myc.db")).toBe(true);
      return created.siteId;
    },
  ],
  [
    "cli/src/commands/init.ts::createWorkspaceDb",
    // Минт первого site_id. «Перевыпуск» здесь невозможен по построению —
    // база новая; доказывается другое и не менее важное: вместе с
    // идентификатором записан ЭКЗЕМПЛЯР. Без этой записи копия свежего
    // воркспейса была бы усыновлена обеими сторонами под одним site_id.
    async (ws) => {
      const fresh = join(ws, "..", `${relative(root, ws)}-init`);
      mkdirSync(fresh, { recursive: true });
      await myc(fresh, "init");
      const db = join(fresh, ".myc", "myc.db");
      const instance = meta(db, META_SITE_INSTANCE);
      expect(instance).toBeDefined();
      expect(JSON.parse(instance!).ino).toBe(Number(statSync(db).ino));
      // Возвращаем прежний site_id копии: «перевыпуска не было» — верный
      // ответ для места, которое базу создаёт, а не открывает.
      return meta(join(ws, ".myc", "myc.db"), META_SITE_ID) ?? "";
    },
  ],
  [
    "cli/src/drain.ts::openDrainHandle",
    async (_ws, dbPath) => {
      const driver = openDriver(dbPath);
      try {
        return openDrainHandle(driver, dbPath, { ...process.env, MYC_ACTOR: "tester" }).store
          .siteId;
      } finally {
        driver.close();
      }
    },
  ],
  [
    "mcp/src/store.ts::openMcpStore",
    async (ws) => {
      const opened = await openMcpStore(ws);
      if (!opened.ok) throw new Error(`openMcpStore: ${opened.failure.msg}`);
      try {
        return opened.handle.store.siteId;
      } finally {
        opened.handle.close();
      }
    },
  ],
]);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "myc-s65-wiring-"));
  registry = makeRegistry();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("S65: перевыпуск site_id подключён ВЕЗДЕ, где открывается база", () => {
  test("каждая найденная точка открытия зовёт ensureSiteId", () => {
    const points = openingPoints();

    // Корпус обязан быть непустым и обязан содержать известные пять. Если
    // разбор сломается или файл переименуют, пустой список сойдётся с пустым
    // «нет пропущенных», и сторож станет декорацией — как и предупреждает
    // register.test.ts про свой `seen.length`.
    const names = points.map(key);
    for (const known of [
      "cli/src/commands/store.ts::openWorkspaceAt",
      "cli/src/commands/store.ts::createPersonalWorkspace",
      "cli/src/commands/init.ts::createWorkspaceDb",
      "cli/src/drain.ts::openDrainHandle",
      "mcp/src/store.ts::openMcpStore",
    ]) {
      expect(names).toContain(known);
    }

    const missing = points.filter((u) => !DECIDES.test(u.body)).map((u) => `${key(u)}:${u.line}`);
    expect(missing).toEqual([]);
  });

  test("у каждой найденной точки есть прувер, и лишних пруверов нет", () => {
    const names = new Set(openingPoints().map(key));
    const provers = new Set(PROVERS.keys());
    expect([...names].filter((n) => !provers.has(n))).toEqual([]);
    expect([...provers].filter((p) => !names.has(p))).toEqual([]);
  });

  // Каждая точка — своим тестом: падение называет виновного, а не «одно из
  // пяти мест».
  for (const [name, prove] of PROVERS) {
    test(`${name}: копия каталога получает СВОЙ site_id`, async () => {
      const origin = await seedWorkspace("origin");
      const before = meta(origin.dbPath, META_SITE_ID)!;
      expect(before.length).toBeGreaterThan(0);

      const copy = copyOf(origin.ws, `copy-${name.replace(/[^\w]+/g, "-")}`);
      // До открытия копия несёт ЧУЖУЮ личность — иначе доказывать нечего.
      expect(meta(copy.dbPath, META_SITE_ID)).toBe(before);

      const after = await prove(copy.ws, copy.dbPath);
      const isMintPoint = name.endsWith("createWorkspaceDb");
      if (isMintPoint) {
        expect(after).toBe(before);
      } else {
        expect(after).not.toBe(before);
        expect(after.length).toBeGreaterThan(0);
        // Оригинал не тронут: перевыпускается копия, а не история.
        expect(meta(origin.dbPath, META_SITE_ID)).toBe(before);
      }
    }, 30_000);
  }
});

describe("S65: что перевыпуска НЕ вызывает", () => {
  test("mv каталога воркспейса: site_id прежний", async () => {
    const origin = await seedWorkspace("movable");
    const before = meta(origin.dbPath, META_SITE_ID)!;

    // Настоящий mv в пределах одной ФС: инод сохраняется, путь меняется.
    const moved = join(root, "moved");
    renameSync(origin.ws, moved);

    const r = await myc(moved, "task", "после переезда");
    expect(r.code).toBe(0);
    const dbPath = join(moved, ".myc", "myc.db");
    expect(meta(dbPath, META_SITE_ID)).toBe(before);
    // Запись об экземпляре при этом ОБНОВЛЕНА: путь новый, инод прежний.
    expect(JSON.parse(meta(dbPath, META_SITE_INSTANCE)!).path).toContain("moved");
  }, 30_000);

  test("VACUUM и wal_checkpoint(TRUNCATE): site_id прежний", async () => {
    const origin = await seedWorkspace("vacuumed");
    const before = meta(origin.dbPath, META_SITE_ID)!;
    const inoBefore = Number(statSync(origin.dbPath).ino);

    const db = new Database(origin.dbPath);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    expect(Number(statSync(origin.dbPath).ino)).toBe(inoBefore);

    const r = await myc(origin.ws, "task", "после вакуума");
    expect(r.code).toBe(0);
    expect(meta(origin.dbPath, META_SITE_ID)).toBe(before);
  }, 30_000);

  test("повторное открытие на месте запись об экземпляре не трогает", async () => {
    const origin = await seedWorkspace("stable");
    const instance = meta(origin.dbPath, META_SITE_INSTANCE)!;
    for (let i = 0; i < 3; i++) await myc(origin.ws, "task", `ещё ${i}`);
    expect(meta(origin.dbPath, META_SITE_INSTANCE)).toBe(instance);
  }, 30_000);
});

describe("S65: перевыпуск громкий", () => {
  test("человек видит WARN со СТАРЫМ и НОВЫМ site_id", async () => {
    const origin = await seedWorkspace("loud");
    const before = meta(origin.dbPath, META_SITE_ID)!;
    const copy = copyOf(origin.ws, "loud-copy");

    const written: string[] = [];
    const real = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as unknown as typeof process.stderr.write;
    try {
      await myc(copy.ws, "task", "шумная");
    } finally {
      (process.stderr as unknown as { write: unknown }).write = real;
    }

    const after = meta(copy.dbPath, META_SITE_ID)!;
    const text = written.join("");
    expect(after).not.toBe(before);
    expect(text).toContain("WARN");
    expect(text).toContain(before);
    expect(text).toContain(after);
  }, 30_000);
});

describe("S65: перевыпуск обнуляет last_seq", () => {
  test("копия начинает нумерацию с 1, а не с чужого места", async () => {
    const origin = await seedWorkspace("seq");
    // Несколько операций, чтобы last_seq заведомо был не нулевым.
    for (let i = 0; i < 3; i++) await myc(origin.ws, "task", `узел ${i}`);
    const before = meta(origin.dbPath, META_SITE_ID)!;
    expect(Number(meta(origin.dbPath, "last_seq"))).toBeGreaterThan(3);

    const copy = copyOf(origin.ws, "seq-copy");
    await myc(copy.ws, "task", "первая своя");

    const after = meta(copy.dbPath, META_SITE_ID)!;
    expect(after).not.toBe(before);

    // Первая операция копии подписана НОВЫМ сайтом и имеет seq 1: ключ
    // last_seq тот самый, которым живёт GraphStore, — иначе счётчик поехал бы
    // от унаследованного значения и в op_id образовалась бы дыра.
    const db = new Database(copy.dbPath, { readonly: true });
    try {
      const rows = db
        .query("SELECT op_id FROM oplog WHERE site_id = ?1 ORDER BY seq")
        .all(after) as { op_id: string }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]!.op_id).toBe(`${after}:1`);
    } finally {
      db.close();
    }
  }, 30_000);
});

/** Каталог существует — иначе seedWorkspace молча ничего не проверил бы. */
test("фикстура: копия и оригинал — разные файлы", async () => {
  const origin = await seedWorkspace("sanity");
  const copy = copyOf(origin.ws, "sanity-copy");
  expect(existsSync(copy.dbPath)).toBe(true);
  expect(Number(statSync(copy.dbPath).ino)).not.toBe(Number(statSync(origin.dbPath).ino));
});
