#!/usr/bin/env bun
/**
 * ПЕРЕИНДЕКСАЦИЯ ВЕКТОРОВ КОРПУСА.
 *
 *   bun run scripts/reindex-vectors.ts [--db <путь>] [--dry-run] [--force] [--rebuild]
 *
 * Зачем это существует. Смена модели эмбеддингов меняет ОТПЕЧАТОК
 * векторного пространства (backend:provider:model:dim:norm). Размерность
 * при переходе на многоязычную модель осталась прежней — 384, схема
 * nodes_vec не тронута, миграций не требуется, — но векторы старой модели
 * и новой лежат в РАЗНЫХ пространствах, и смешивать их нельзя: KNN просто
 * вернёт правдоподобный мусор, и увидят это через месяцы. Поэтому
 * переиндексация не «желательна», а обязательна, и она здесь одна на все
 * поверхности.
 *
 * Что делает:
 *   1. открывает базу с рантаймом расширений (vec0) и накатывает
 *      обязательный и векторный наборы миграций;
 *   2. сверяет отпечаток из myc_meta.embed_fingerprint с отпечатком
 *      текущего эмбеддера;
 *   3. отпечатки РАЗОШЛИСЬ  → чистит nodes_vec и кеш vec_nodes_f32 целиком
 *      и строит заново (частичная переиндексация здесь запрещена: смесь
 *      двух пространств и есть та порча, ради которой всё затевалось);
 *      отпечаток СОВПАЛ  → досчитывает только узлы, которых в индексе нет;
 *      отпечатка НЕТ     → первая индексация корпуса;
 *   4. пишет отпечаток в myc_meta.
 *
 * `--rebuild` перестраивает индекс целиком даже при совпавшем отпечатке:
 * это нужно, когда изменился не отпечаток, а правило выбора текста узла.
 *
 * Индексируются узлы слоёв 1–3, живые, не superseded и не версии
 * (head_id IS NULL). L0 (message/session) в векторный индекс не попадает
 * по §5.1. Текст узла — см. nodeText ниже.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { historyClause } from "@myc/core";
import {
  migrate,
  migrations,
  migrateVectors,
  openSqlite,
} from "@myc/store-sqlite";
import {
  createLocalEmbedder,
  formatEmbedFingerprint,
  quantizeInt8,
  isModelPresent,
  DEFAULT_MODEL_ID,
  getModelSpec,
} from "@myc/embed";

interface Args {
  readonly db: string;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly rebuild: boolean;
  readonly batch: number;
}

function parseArgs(argv: readonly string[]): Args {
  let db = join(resolve("."), ".myc", "myc.db");
  let dryRun = false;
  let force = false;
  let rebuild = false;
  // По умолчанию 1 — см. комментарий у цикла индексации ниже.
  let batch = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--db") db = resolve(argv[++i] ?? "");
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--force") force = true;
    else if (a === "--rebuild") rebuild = true;
    else if (a === "--batch") batch = Math.max(1, Number(argv[++i] ?? "1"));
    else if (a === "-C") db = join(resolve(argv[++i] ?? "."), ".myc", "myc.db");
    else {
      console.error(`неизвестный аргумент ${a}`);
      process.exit(2);
    }
  }
  return { db, dryRun, force, rebuild, batch };
}

interface NodeRow {
  readonly rowid: number;
  readonly id: string;
  readonly scope: string;
  readonly layer: number;
  readonly kind: string;
  readonly title: string | null;
  readonly excerpt: string | null;
  readonly body: string | null;
}

/**
 * Текст узла для эмбеддинга: заголовок плюс тело.
 *
 * У заметок памяти заголовок — это ТО ЖЕ ТЕЛО, обрезанное многоточием, и
 * склейка удваивала бы первые сто символов, перекашивая усреднённый вектор
 * в их сторону. Замер на рабочем корпусе: с удвоением целевая заметка на
 * контрольном русском запросе стояла 12-й, без него — 1-й. Поэтому
 * заголовок-обрезок отбрасывается, а настоящий заголовок задачи остаётся.
 */
function nodeText(n: NodeRow): string {
  const head = (n.title ?? "").trim().replace(/[.…]+$/u, "").trim();
  const body = (n.body ?? n.excerpt ?? "").trim();
  if (head.length === 0) return body;
  if (body.length === 0) return head;
  if (body.startsWith(head)) return body;
  return `${head}\n${body}`;
}

const args = parseArgs(process.argv.slice(2));

if (!existsSync(args.db)) {
  console.error(`нет базы ${args.db} — сначала myc init`);
  process.exit(2);
}
if (!(await isModelPresent(DEFAULT_MODEL_ID))) {
  console.error(`модель ${DEFAULT_MODEL_ID} не скачана → myc models fetch`);
  process.exit(2);
}

const t0 = performance.now();
// openSqlite сам поднимает рантайм расширений ДО первого new Database.
const driver = openSqlite({ path: args.db });
const db: Database = driver.database;

await migrate(db, { migrations, writable: true });
const vec = await migrateVectors(db, { vec0Loaded: true, writable: true });
if (vec.skipped) {
  console.error("vec0 не загружен — векторные миграции не применялись; переиндексация невозможна");
  console.error("проверь myc doctor: расширение sqlite-vec обязано быть доступно");
  driver.close();
  process.exit(3);
}

const spec = getModelSpec(DEFAULT_MODEL_ID);
const embedder = createLocalEmbedder({});
const state = await embedder.warmup();
if (state !== "ok") {
  console.error(`эмбеддер в состоянии ${state} — переиндексация отменена`);
  await embedder.destroy();
  driver.close();
  process.exit(3);
}
const expected = formatEmbedFingerprint(embedder.fingerprint);

const recorded =
  (db.query("SELECT value FROM myc_meta WHERE key = 'embed_fingerprint'").get() as
    | { value: string }
    | null)?.value ?? null;

const indexed = Number(
  (db.query("SELECT count(*) AS n FROM nodes_vec").get() as { n: number }).n,
);

const fingerprintChanged = recorded !== null && recorded !== expected;
/** Полная перестройка: сменилось пространство ИЛИ явно попросили. */
const mismatch = fingerprintChanged || args.rebuild;
console.log(`база       ${args.db}`);
console.log(`модель     ${DEFAULT_MODEL_ID} (${spec.languages}, ${spec.pooling}, dim ${spec.dim})`);
console.log(`отпечаток  ${recorded ?? "(не записан)"} → ${expected}`);
console.log(`в индексе  ${indexed} векторов`);
if (fingerprintChanged) {
  console.log(
    "отпечатки РАЗОШЛИСЬ: старые векторы принадлежат другому пространству, индекс строится заново целиком",
  );
} else if (args.rebuild) {
  console.log("--rebuild: индекс строится заново целиком при том же отпечатке");
} else if (recorded === expected) {
  console.log("отпечаток совпал: досчитываются только узлы, которых нет в индексе");
} else {
  console.log("отпечатка не было: первая индексация корпуса");
}

const rows = db
  .query(
    `SELECT rowid AS rowid, id, scope, layer, kind, title, excerpt, body
       FROM nodes
      WHERE deleted_at IS NULL${historyClause("follow", "nodes")}
        AND status <> 'superseded'
        AND layer >= 1
      ORDER BY rowid`,
  )
  .all() as NodeRow[];

const already = new Set<number>(
  mismatch
    ? []
    : (db.query("SELECT node_rowid AS r FROM nodes_vec").all() as { r: number }[]).map(
        (x) => Number(x.r),
      ),
);
const todo = rows.filter((r) => !already.has(r.rowid) && nodeText(r).length > 0);

console.log(`узлов      ${rows.length} подходящих, ${todo.length} к пересчёту`);
if (args.dryRun) {
  console.log("--dry-run: ничего не записано");
  await embedder.destroy();
  driver.close();
  process.exit(0);
}
if (fingerprintChanged && !args.force) {
  console.log(
    "полная перестройка сотрёт весь векторный индекс; повтори с --force, если это то, что нужно",
  );
  await embedder.destroy();
  driver.close();
  process.exit(4);
}

if (mismatch) {
  // vec_nodes_f32 — кеш переранжирования того же пространства, он тоже мусор.
  db.exec("DELETE FROM nodes_vec");
  db.exec("DELETE FROM vec_nodes_f32");
  console.log("старый индекс очищен");
}

const insertVec = db.prepare(
  `INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding)
   VALUES (?1, ?2, ?3, ?4, 1, vec_int8(?5))`,
);
const deleteVec = db.prepare("DELETE FROM nodes_vec WHERE node_rowid = ?1");

let written = 0;
let failed = 0;
let embedMs = 0;
/**
 * ДОКУМЕНТ КОДИРУЕТСЯ ТЕМ ЖЕ ПУТЁМ, ЧТО И ЗАПРОС — по одному тексту.
 *
 * Замер: один и тот же текст, одна и та же сессия, но прогнанный в пакете
 * из двух, даёт вектор с косинусом 0.9977 к одиночному — и это не паддинг
 * (при РАВНОЙ длине соседа тот же эффект), а разные ядра GEMM под разную
 * форму тензора в onnxruntime. У английской модели то же самое (0.9970),
 * и там это ничего не значило: её различающие зазоры порядка 0.1–0.2.
 * У многоязычной модели косинусы лежат в узком поясе, и зазор между
 * первым и десятым кандидатом — те же 0.005–0.02, то есть шум пакета
 * СРАВНИМ С СИГНАЛОМ. На рабочем корпусе это стоило целевой заметке
 * нескольких позиций.
 *
 * Запрос всегда идёт одиночным (Embedder.embed), поэтому и документ идёт
 * одиночным: сравнивать нужно величины, посчитанные одинаково. `--batch N`
 * оставлен для замеров, но по умолчанию 1.
 */
for (let i = 0; i < todo.length; i += args.batch) {
  const chunk = todo.slice(i, i + args.batch);
  const started = performance.now();
  // Роль "passage": документ, а не запрос. У e5 это разные префиксы, и
  // перепутать их — тихая потеря качества, а не ошибка (см. registry.ts).
  const batch =
    args.batch === 1
      ? {
          results: [await embedder.embed(nodeText(chunk[0]!), "passage")],
        }
      : await embedder.embedBatch(chunk.map(nodeText), "passage");
  embedMs += performance.now() - started;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (let k = 0; k < chunk.length; k++) {
      const node = chunk[k]!;
      const res = batch.results[k]!;
      if (res.vec === null) {
        failed++;
        continue;
      }
      const { q } = quantizeInt8(res.vec);
      // Повтор запуска не должен падать на уникальном ключе.
      deleteVec.run(node.rowid);
      insertVec.run(
        node.rowid,
        node.scope,
        node.layer,
        node.kind,
        Buffer.from(q.buffer, q.byteOffset, q.byteLength),
      );
      written++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  if ((i / args.batch) % 16 === 0 || i + args.batch >= todo.length) {
    process.stdout.write(`\r  ${Math.min(i + args.batch, todo.length)}/${todo.length}   `);
  }
}
if (todo.length > 0) process.stdout.write("\n");

db.prepare(
  "INSERT INTO myc_meta (key, value) VALUES ('embed_fingerprint', ?1) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
).run(expected);

const total = Number(
  (db.query("SELECT count(*) AS n FROM nodes_vec").get() as { n: number }).n,
);
console.log(
  `записано   ${written} векторов${failed > 0 ? `, отказов ${failed}` : ""}; в индексе ${total}`,
);
console.log(
  `время      ${((performance.now() - t0) / 1000).toFixed(1)} с, из них эмбеддинг ${(embedMs / 1000).toFixed(1)} с` +
    (written > 0 ? ` (${(embedMs / written).toFixed(1)} мс/узел)` : ""),
);

await embedder.destroy();
driver.close();
if (failed > 0) process.exitCode = 5;
