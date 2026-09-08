/**
 * Приёмка ФОНОВОГО потребителя `jobs(kind='anchor_check')` — §7.5.
 *
 * До этого файла класс работ ставился (хук absorb-session, `myc remember
 * --anchor`), а разбирать его было некому: лестницу §7.2 гонял только ручной
 * `myc anchor check`. Журнал грязных файлов, который пишет хук post-edit,
 * снимался тем же ручным вызовом — то есть рос до первого. Здесь проверяется,
 * что и очередь, и журнал снимаются сами, и что цена этого названа числом.
 *
 * ФОН ПРОВЕРЯЕТСЯ ЧЕРЕЗ drainQueueTail НАПРЯМУЮ, а не только спавном: под
 * `bun test` (NODE_ENV=test) фон выключает себя сам, и это правильно — иначе
 * тест, правящий файлы под собой, получал бы чужой прогон посреди проверки.
 * Отдельным тестом внизу — настоящий процесс, где фон включён по-боевому.
 *
 * МУТАЦИИ, которые этот файл обязан ловить (числа — в отчёте):
 *   1. фон не разбирает очередь (шаг якорей выключен) — ОБЯЗАТЕЛЬНАЯ;
 *   2. дебаунс 2 с снят — якорь объявляется протухшим по недописанному файлу;
 *   3. бюджет прогона не проверяется — батч разбирается целиком за чужой счёт;
 *   4. период 300 с снят — лестница гоняется на КАЖДЫЙ вызов CLI;
 *   5. батч не ограничен 256 — прогон идёт по всей таблице;
 *   6. порядок не `checked_at ASC` — свежепроверенные вытесняют забытые;
 *   7. фон не отличает НЕДОВЯЗАННУЮ привязку (S66) от якоря, который надо
 *      проверить, — лестница объявляет свежесть по mtime и crux не появляется
 *      никогда.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAnchor, checkAnchor } from "@myc/code-intel/anchors";
import { jobs, migrate, migrations, openSqlite } from "@myc/store-sqlite";
import {
  anchorSweepEnabled,
  drainQueueTail,
  ANCHOR_SWEEP_BUDGET_MS,
  ANCHOR_SWEEP_PERIOD_MS,
  ANCHOR_SWEPT_AT_KEY,
} from "./drain.ts";
import {
  ANCHOR_CHECK_BATCH_DEFAULT,
  ANCHOR_DEBOUNCE_MS,
  createAnchorCommand,
  DIRTY_LOG,
} from "./commands/anchor.ts";
import { createRememberCommand } from "./commands/remember.ts";
import { run } from "./index.ts";
import { Registry } from "./registry.ts";

const CLI_ENTRY = join(import.meta.dir, "main.ts");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Ws {
  readonly root: string;
  readonly dbPath: string;
}

/** Воркспейс в форме, которую ждёт фон: `<root>/.myc/myc.db` плюс файлы репо. */
async function workspace(): Promise<Ws> {
  const root = mkdtempSync(join(tmpdir(), "myc-sweep-"));
  dirs.push(root);
  mkdirSync(join(root, ".myc"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  const dbPath = join(root, ".myc", "myc.db");
  const driver = openSqlite(dbPath);
  await migrate(driver.database, { migrations, writable: true });
  driver.close();
  return { root, dbPath };
}

/**
 * Файл СРАЗУ СОСТАРЕН на минуту. Дебаунс §7.5 отсчитывается от mtime, и
 * файл, записанный тестом миллисекунду назад, фон пропустит по построению —
 * без этого пришлось бы спать две секунды в каждом тесте.
 */
function fileWith(ws: Ws, name: string, body: string): string {
  const rel = `src/${name}`;
  writeFileSync(join(ws.root, rel), body);
  age(ws, rel);
  return rel;
}

function age(ws: Ws, rel: string, ms = 60_000): void {
  const t = new Date(Date.now() - ms);
  utimesSync(join(ws.root, rel), t, t);
}

/**
 * Якорь через НАСТОЯЩИЙ bindAnchor: подделанный crux разошёлся бы с тем, что
 * ищет лестница, и тест мерил бы свою копию правила вместо правила.
 */
function seedAnchor(ws: Ws, id: string, rel: string, start: number, end: number, checkedAt: number): void {
  const abs = join(ws.root, rel);
  const source = readFileSync(abs, "utf8");
  const b = bindAnchor(source, "ts", start, end, statSync(abs));
  const driver = openSqlite(ws.dbPath);
  const now = Date.now();
  driver.database
    .prepare(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, status, created_at, updated_at)
       VALUES (?1, 'anchor', 1, '', ?2, ?3, ?4, 'fresh', ?5, ?5)`,
    )
    .run(id, `${rel}:${start}-${end}`, b.crux, `h-${id}`, now);
  driver.database
    .prepare(
      `INSERT INTO anchors (node_id, repo_id, repo_root, path, lang, symbol,
                            span_start, span_end, file_hash, span_hash, crux, crux_norm,
                            state, drift, mtime_ms, size_bytes, bound_at, checked_at)
       VALUES (?1,'',?2,?3,'ts','',?4,?5,?6,?7,?8,?9,'fresh',1.0,?10,?11,?12,?13)`,
    )
    .run(
      id,
      ws.root,
      rel,
      b.spanStart,
      b.spanEnd,
      b.fileHash,
      b.spanHash,
      b.crux,
      b.cruxNorm,
      b.mtimeMs,
      b.sizeBytes,
      now,
      checkedAt,
    );
  driver.close();
}

function anchorRow(ws: Ws, id: string): { state: string; checked_at: number; span_start: number } {
  const driver = openSqlite(ws.dbPath);
  try {
    return driver.database
      .query("SELECT state, checked_at, span_start FROM anchors WHERE node_id = ?1")
      .get(id) as { state: string; checked_at: number; span_start: number };
  } finally {
    driver.close();
  }
}

function jobCount(ws: Ws, kind: string): number {
  const driver = openSqlite(ws.dbPath);
  try {
    return Number(
      (driver.database.query(`SELECT count(*) AS n FROM jobs WHERE kind = ?1`).get(kind) as {
        n: number;
      }).n,
    );
  } finally {
    driver.close();
  }
}

function setSweptAt(ws: Ws, value: number | null): void {
  const driver = openSqlite(ws.dbPath);
  if (value === null) {
    driver.database.prepare("DELETE FROM myc_meta WHERE key = ?1").run(ANCHOR_SWEPT_AT_KEY);
  } else {
    driver.database
      .prepare("INSERT INTO myc_meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2")
      .run(ANCHOR_SWEPT_AT_KEY, String(value));
  }
  driver.close();
}

/** Боевое окружение фона: NODE_ENV не "test", выключатели не выставлены. */
const LIVE = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

const SRC_A = `export function alpha(a: number): number {
  return a + 1;
}
`;

// ---------------------------------------------------------------------------
// Гейт окружения (мутация 1: фон выключен целиком)
// ---------------------------------------------------------------------------

describe("выключатель фона якорей", () => {
  test("под тестом выключен, MYC_ANCHOR_CHECK=0 выключает, по умолчанию включён", () => {
    expect(anchorSweepEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(anchorSweepEnabled({ MYC_ANCHOR_CHECK: "0" })).toBe(false);
    expect(anchorSweepEnabled({ MYC_ANCHOR_CHECK: "off" })).toBe(false);
    expect(anchorSweepEnabled({})).toBe(true);
  });

  test("МУТАЦИЯ 1: фон выключен — очередь anchor_check не разбирается никем", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    seedAnchor(ws, "a1", rel, 1, 3, 0);
    const driver = openSqlite(ws.dbPath);
    jobs.enqueue(driver.database, "anchor_check", { entityId: "a1" });
    driver.close();

    const off = await drainQueueTail({
      dbPath: ws.dbPath,
      env: { ...LIVE, MYC_ANCHOR_CHECK: "0" },
    });
    expect(off.anchor).toBeNull();
    expect(jobCount(ws, "anchor_check")).toBe(1);

    const on = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(on.anchor?.jobs).toBe(1);
    expect(on.anchor?.triggered).toBe("jobs");
    expect(jobCount(ws, "anchor_check")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Период §7.5 (мутация 4)
// ---------------------------------------------------------------------------

describe("период 300 с", () => {
  test("первый вызов прогоняет, второй подряд — нет: отметка в myc_meta", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    seedAnchor(ws, "a1", rel, 1, 3, 0);

    const first = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(first.anchor?.triggered).toBe("period");
    expect(first.anchor?.checked).toBe(1);
    const after = anchorRow(ws, "a1").checked_at;
    expect(after).toBeGreaterThan(0);

    const second = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(second.anchor).toBeNull();
    expect(anchorRow(ws, "a1").checked_at).toBe(after);
  });

  test("период истёк — прогон снова случается", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    seedAnchor(ws, "a1", rel, 1, 3, 0);
    setSweptAt(ws, Date.now() - ANCHOR_SWEEP_PERIOD_MS - 1);

    const r = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(r.anchor?.triggered).toBe("period");
    expect(r.anchor?.checked).toBe(1);
  });

  test("работа в очереди пробивает период: ждать 300 с после правки не надо", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    seedAnchor(ws, "a1", rel, 1, 3, 0);
    setSweptAt(ws, Date.now());

    const driver = openSqlite(ws.dbPath);
    jobs.enqueue(driver.database, "anchor_check", { entityId: "a1", payload: { paths: [rel] } });
    driver.close();

    const r = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(r.anchor?.triggered).toBe("jobs");
    expect(r.anchor?.checked).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Журнал грязных файлов
// ---------------------------------------------------------------------------

describe("журнал грязных файлов", () => {
  test("фон снимает .myc/anchor-dirty.log — он больше не растёт до ручного вызова", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    seedAnchor(ws, "a1", rel, 1, 3, 0);
    const log = join(ws.root, ".myc", DIRTY_LOG);
    writeFileSync(log, `${join(ws.root, rel)}\n`);

    const r = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(existsSync(log)).toBe(false);
    expect(r.anchor?.fromDirty).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Дебаунс 2 с (мутация 2)
// ---------------------------------------------------------------------------

describe("дебаунс §7.5", () => {
  test("МУТАЦИЯ 2: файл, изменённый только что, фон не трогает", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    seedAnchor(ws, "a1", rel, 1, 3, 0);
    // Правка ПРЯМО СЕЙЧАС: агент ещё печатает, содержимое незакончено.
    writeFileSync(join(ws.root, rel), "export function alp");

    const r = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(r.anchor?.skippedDebounce).toBe(1);
    expect(r.anchor?.checked).toBe(0);
    // checked_at не сдвинут: якорь остался первым в очереди следующего прогона.
    expect(anchorRow(ws, "a1").checked_at).toBe(0);
    expect(anchorRow(ws, "a1").state).toBe("fresh");
  });

  test("файл, изменённый давно, проверяется", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    seedAnchor(ws, "a1", rel, 1, 3, 0);
    writeFileSync(join(ws.root, rel), `// новая строка сверху\n${SRC_A}`);
    age(ws, rel);

    const r = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(r.anchor?.skippedDebounce).toBe(0);
    expect(r.anchor?.checked).toBe(1);
    // Уровень 3: код переехал на строку вниз, якорь пере-нацелен по crux.
    expect(anchorRow(ws, "a1").span_start).toBe(2);
    expect(anchorRow(ws, "a1").state).toBe("fresh");
  });
});

// ---------------------------------------------------------------------------
// Батч и бюджет (мутации 3 и 5)
// ---------------------------------------------------------------------------

describe("батч и бюджет", () => {
  test("МУТАЦИЯ 5: батч ограничен 256 якорями, даже когда их больше", async () => {
    const ws = await workspace();
    const N = ANCHOR_CHECK_BATCH_DEFAULT + 40;
    for (let i = 0; i < N; i++) {
      const rel = fileWith(ws, `f${i}.ts`, `export const v${i} = ${i};\n`);
      seedAnchor(ws, `a${i}`, rel, 1, 1, i);
    }
    const r = await drainQueueTail({
      dbPath: ws.dbPath,
      // Бюджет снят, чтобы упереться именно в батч, а не во время.
      env: { ...LIVE, MYC_ANCHOR_BUDGET_MS: "100000" },
    });
    expect(r.anchor?.checked).toBe(ANCHOR_CHECK_BATCH_DEFAULT);
  });

  test("МУТАЦИЯ 6: батч режется по checked_at ASC — забытые якоря идут ПЕРВЫМИ", async () => {
    const ws = await workspace();
    // a0 проверен позже всех, a9 забыт дольше всех.
    for (let i = 0; i < 10; i++) {
      const rel = fileWith(ws, `f${i}.ts`, `export const v${i} = ${i};\n`);
      seedAnchor(ws, `a${i}`, rel, 1, 1, 1_000_000 - i * 1000);
    }
    // Батч меньше числа якорей — только тогда порядок вообще что-то решает.
    const registry = new Registry();
    registry.register(createAnchorCommand());
    const out = await run(["-C", ws.root, "anchor", "check", "--limit", "3", "--json"], {
      registry,
      env: { MYC_ACTOR: "tester" },
    });
    const env = JSON.parse(out.stdout as string) as { data: { checked: number } };
    expect(env.data.checked).toBe(3);

    const moved = [...Array(10).keys()].filter((i) => anchorRow(ws, `a${i}`).checked_at > 1_000_000);
    // Проверены обязаны быть три САМЫХ ЗАБЫТЫХ — a7, a8, a9.
    expect(moved.sort((a, b) => a - b)).toEqual([7, 8, 9]);
  });

  test("МУТАЦИЯ 3: бюджет прекращает прогон, хвост батча остаётся непроверенным", async () => {
    const ws = await workspace();
    const N = 200;
    for (let i = 0; i < N; i++) {
      // Файл побольше: уровень 2 читает и хеширует его целиком.
      const rel = fileWith(ws, `f${i}.ts`, `${"// строка\n".repeat(400)}export const v${i} = ${i};\n`);
      seedAnchor(ws, `a${i}`, rel, 1, 1, i);
      writeFileSync(join(ws.root, rel), `${"// строка\n".repeat(400)}export const v${i} = ${i};\n// хвост\n`);
      age(ws, rel);
    }
    const r = await drainQueueTail({
      dbPath: ws.dbPath,
      env: { ...LIVE, MYC_ANCHOR_BUDGET_MS: "1" },
    });
    expect(r.anchor?.budgetHit).toBe(true);
    expect(r.anchor?.checked).toBeLessThan(N);
    expect(r.anchor?.tookMs).toBeLessThan(200);
  });

  test("бюджет фона не перешагивает остаток бюджета дренажа", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    seedAnchor(ws, "a1", rel, 1, 3, 0);
    const r = await drainQueueTail({ dbPath: ws.dbPath, budgetMs: 5, env: LIVE });
    expect(r.anchor).not.toBeNull();
    expect(r.tookMs).toBeLessThan(ANCHOR_SWEEP_BUDGET_MS + 200);
  });
});

// ---------------------------------------------------------------------------
// Настоящий процесс: фон включён по-боевому
// ---------------------------------------------------------------------------

describe("боевой процесс", () => {
  test("хук post-edit пометил файл — следующий вызов CLI снял журнал сам", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    seedAnchor(ws, "a1", rel, 1, 3, 0);
    const log = join(ws.root, ".myc", DIRTY_LOG);

    const touch = Bun.spawn(
      [process.execPath, CLI_ENTRY, "-C", ws.root, "anchor", "touch", join(ws.root, rel)],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...LIVE } },
    );
    await touch.exited;
    // Прогон после touch уже мог снять журнал — это и есть требуемое поведение;
    // проверяем инвариант, а не порядок: журнала не остаётся, якорь проверен.
    await new Promise((r) => setTimeout(r, 2100));
    setSweptAt(ws, 0);
    writeFileSync(log, `${join(ws.root, rel)}\n`);

    const show = Bun.spawn([process.execPath, CLI_ENTRY, "-C", ws.root, "ready"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...LIVE },
    });
    await show.exited;
    expect(existsSync(log)).toBe(false);
    expect(anchorRow(ws, "a1").checked_at).toBeGreaterThan(0);
  }, 20_000);
});


// ---------------------------------------------------------------------------
// Отложенная привязка (мутация 7, решение S66)
// ---------------------------------------------------------------------------

/**
 * Якорь ставится НАСТОЯЩЕЙ командой с порогом 0 — тогда отложенным становится
 * любой файл, и стенду не нужен файл на 140 КБ. Своя копия недовязанной
 * строки была бы копией правила: разойдись формат метки с тем, что пишет
 * `bindAnchorAt`, — и тест остался бы зелёным на сломанном фоне.
 */
async function deferredAnchor(ws: Ws, rel: string, span: string): Promise<string> {
  const registry = new Registry();
  registry.register(createRememberCommand());
  const prev = process.env.MYC_ANCHOR_INLINE_MAX_BYTES;
  process.env.MYC_ANCHOR_INLINE_MAX_BYTES = "0";
  try {
    const out = await run(
      ["-C", ws.root, "remember", `факт про ${rel}:${span}`, "--anchor", `${rel}:${span}`, "--json"],
      { registry, env: { MYC_ACTOR: "tester", MYC_HOME: join(ws.root, ".home") } },
    );
    const env = JSON.parse(out.stdout as string) as {
      ok: boolean;
      data: { anchors: Array<{ anchor_id?: string; deferred?: boolean }> };
    };
    expect(env.ok).toBe(true);
    const a = env.data.anchors[0]!;
    expect(a.deferred).toBe(true);
    return a.anchor_id!;
  } finally {
    if (prev === undefined) delete process.env.MYC_ANCHOR_INLINE_MAX_BYTES;
    else process.env.MYC_ANCHOR_INLINE_MAX_BYTES = prev;
  }
}

interface FullRow {
  span_hash: string;
  crux: string;
  crux_norm: string;
  checked_at: number;
  state: string;
  lang: string;
  span_start: number;
  span_end: number;
  file_hash: string;
  mtime_ms: number;
  size_bytes: number;
  path: string;
}

function fullRow(ws: Ws, id: string): FullRow {
  const driver = openSqlite(ws.dbPath);
  try {
    return driver.database.query("SELECT * FROM anchors WHERE node_id = ?1").get(id) as FullRow;
  } finally {
    driver.close();
  }
}

function nodeBody(ws: Ws, id: string): string | null {
  const driver = openSqlite(ws.dbPath);
  try {
    return (
      driver.database.query("SELECT body FROM nodes WHERE id = ?1").get(id) as {
        body: string | null;
      }
    ).body;
  } finally {
    driver.close();
  }
}

describe("отложенная привязка §7.5", () => {
  test("фон доводит недовязанный якорь до точного: crux, span_hash, тело узла", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    const id = await deferredAnchor(ws, rel, "1-3");

    // Запись отдала ровно то, что знала даром, и пометила остальное.
    const before = fullRow(ws, id);
    expect(before.span_hash).toBe("");
    expect(before.checked_at).toBe(0);
    expect(before.file_hash).toStartWith("wy:");
    expect(nodeBody(ws, id)).toBeNull();
    expect(jobCount(ws, "anchor_check")).toBe(1);

    const r = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(r.anchor?.triggered).toBe("jobs");
    expect(r.anchor?.bound).toBe(1);
    expect(r.anchor?.checked).toBe(1);
    expect(jobCount(ws, "anchor_check")).toBe(0);

    // Точность догнала: строка стала неотличима от привязанной на месте.
    const after = fullRow(ws, id);
    const truth = bindAnchor(SRC_A, "ts", 1, 3, statSync(join(ws.root, rel)));
    expect(after.span_hash).toBe(truth.spanHash);
    expect(after.crux).toBe(truth.crux);
    expect(after.crux_norm).toBe(truth.cruxNorm);
    expect(after.state).toBe("fresh");
    expect(after.checked_at).toBeGreaterThan(0);
    // Тело узла якоря — тот же crux: без него `show` навсегда показывал бы
    // пустой якорь, а строка была бы права.
    expect(nodeBody(ws, id)).toBe(truth.crux);
  });

  test("второй прогон видит обычный якорь: метки больше нет, привязка не повторяется", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    await deferredAnchor(ws, rel, "1-3");
    const first = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(first.anchor?.bound).toBe(1);

    setSweptAt(ws, Date.now() - ANCHOR_SWEEP_PERIOD_MS - 1);
    const second = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(second.anchor?.checked).toBe(1);
    expect(second.anchor?.bound).toBe(0);
  });

  test("МУТАЦИЯ 7: лестница вместо привязки — свежесть по mtime, crux не появляется", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    const id = await deferredAnchor(ws, rel, "1-3");
    const row = fullRow(ws, id);

    // Ровно то, что сделал бы фон, не отличай он недовязанную строку от
    // обычной: уровень 1 сравнивает mtime и размер, они совпадают (файл с
    // момента записи не менялся), и якорь объявляется свежим БЕЗ crux.
    const asLadder = checkAnchor(
      {
        path: row.path,
        lang: row.lang,
        spanStart: row.span_start,
        spanEnd: row.span_end,
        fileHash: row.file_hash,
        spanHash: row.span_hash,
        cruxNorm: row.crux_norm,
        mtimeMs: row.mtime_ms,
        sizeBytes: row.size_bytes,
      },
      join(ws.root, rel),
    );
    expect(asLadder.state).toBe("fresh");
    expect(asLadder.level).toBe(1);
    expect(asLadder.crux).toBe("");
    expect(asLadder.spanHash).toBe("");

    // А настоящий фон crux снимает.
    const r = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(r.anchor?.bound).toBe(1);
    expect(fullRow(ws, id).crux.length).toBeGreaterThan(0);
  });

  test("дебаунс сильнее привязки: файл правится сейчас — метка цела, очередь ждёт", async () => {
    const ws = await workspace();
    const rel = fileWith(ws, "alpha.ts", SRC_A);
    const id = await deferredAnchor(ws, rel, "1-3");
    // Агент дописывает файл прямо сейчас: снимать с него crux — значит
    // записать в якорь недописанный текст навсегда.
    writeFileSync(join(ws.root, rel), "export function alp");

    const r = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(r.anchor?.skippedDebounce).toBe(1);
    expect(r.anchor?.bound).toBe(0);
    const row = fullRow(ws, id);
    expect(row.span_hash).toBe("");
    expect(row.checked_at).toBe(0);
  });

  test("работа не сгорает в прогоне, который не может её сделать: run_after ждёт дебаунс", async () => {
    const ws = await workspace();
    // Файл НЕ состарен: якорь ставят на то, что правят прямо сейчас, — это и
    // есть типичный случай, а не редкий.
    const rel = "src/hot.ts";
    writeFileSync(join(ws.root, rel), SRC_A);
    const id = await deferredAnchor(ws, rel, "1-3");
    expect(jobCount(ws, "anchor_check")).toBe(1);

    // Прогон случился (период), но дебаунс файл не отдал. Работа обязана
    // ОСТАТЬСЯ в очереди: строки снимаются после прогона независимо от того,
    // что он успел, и без сдвига `run_after` подсказка сгорела бы здесь, а
    // привязка ждала бы периода 300 с.
    const early = await drainQueueTail({ dbPath: ws.dbPath, env: LIVE });
    expect(early.anchor?.skippedDebounce).toBe(1);
    expect(early.anchor?.bound).toBe(0);
    expect(jobCount(ws, "anchor_check")).toBe(1);
    expect(fullRow(ws, id).span_hash).toBe("");

    // Окно дебаунса прошло — та же работа снимается и доводит привязку.
    const later = await drainQueueTail({
      dbPath: ws.dbPath,
      env: LIVE,
      now: () => Date.now() + ANCHOR_DEBOUNCE_MS + 1_000,
    });
    expect(later.anchor?.triggered).toBe("jobs");
    expect(later.anchor?.bound).toBe(1);
    expect(jobCount(ws, "anchor_check")).toBe(0);
    expect(fullRow(ws, id).span_hash).toStartWith("wy:");
  });
});
