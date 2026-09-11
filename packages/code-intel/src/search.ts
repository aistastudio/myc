/**
 * ПОИСК ПО КОДУ — вопрос, на который `myc code symbol` ответить не мог, потому
 * что требовал ЗНАТЬ ИМЯ (memory-5nvk1hwcene2, эпик «замена graft»).
 *
 * ЧТО ИМЕННО ЗДЕСЬ ПОСТРОЕНО. Ранжированный лексический поиск по корпусу из
 * ОПРЕДЕЛЕНИЙ и ШАПОК ФАЙЛОВ (миграция 012). Не семантический: вектора здесь
 * нет и назван он так не будет — см. «ПОЧЕМУ БЕЗ ВЕКТОРА» ниже. Исчерпывающий
 * поиск произвольного литерала живёт отдельно, в `./grep.ts`, и вместе они
 * закрывают обе половины того, чем в CLAUDE.md оправдан graft: `ask` и `grep`.
 *
 * ЕДИНИЦА КОРПУСА — не файл и не строка. Файл целиком слишком крупен (BM25
 * ставит длинному документу штраф ровно там, где в нём и лежит ответ), строка
 * слишком мелка (у неё нет ни имени, ни объяснения). Единиц две:
 *   `def`  — определение: имя, сигнатура, свой док-комментарий;
 *   `file` — шапка файла: верхний комментарий плюс перечень имён.
 * Обе нужны. Вопрос про охват знания отвечается ШАПКОЙ `core/src/reach.ts`,
 * где лежит трактат про него; «где считается bm25» — СИГНАТУРОЙ функции.
 *
 * (Формулировки размеченных вопросов сюда намеренно не переписываются
 * дословно: корпус включает и этот файл, и совпадение с собственным
 * комментарием портило бы замер.)
 *
 * СВЁРТКА В ФАЙЛЫ — главное решение ранжирования, и оно измерено, а не
 * выбрано. Плоская выдача единиц даёт MRR 0.51 на 12 размеченных вопросах
 * (bench/code-search-queries.json); свёртка единиц в файл суммой RRF-вкладов
 * даёт 0.66, а top-3 растёт с 6/12 до 10/12. Причина простая: у правильного
 * файла совпадает НЕСКОЛЬКО символов сразу, у случайного — один. Ответ при
 * этом остаётся поимённым: файл печатается вместе с символами, которые в нём
 * совпали, то есть `path:line`, а не «посмотрите вон тот файл».
 *
 * ЛЕСТНИЦА ЗАПРОСА — ЧУЖАЯ, И ЭТО НАМЕРЕННО. Разбор пользовательского текста
 * в MATCH-строки берётся у `@myc/retrieval` (`analyzeFtsQuery`, решение S44):
 * тот же парсер, те же префиксные формы, те же ступени ослабления. Свой
 * второй парсер разошёлся бы с первым молча, а лечит он ровно ту же болезнь —
 * отсутствие стемминга для русского.
 *
 * НО ОБЪЕДИНЯЮТСЯ СТУПЕНИ ЗДЕСЬ ИНАЧЕ, чем в памяти, и это тоже замер.
 * `runHybrid` берёт ПЕРВУЮ ступень, которая что-то нашла. На корпусе кода это
 * ломается: строгое «И» находит ОДНО случайное совпадение (у вопроса «как
 * резолв...» — `findMycDir`, в чьём комментарии стоят оба слова), и
 * одна находка закрывает дорогу ступеням, где лежит настоящий ответ. Поэтому
 * здесь ступени не выбираются, а СЛИВАЮТСЯ по RRF — тем же способом, каким
 * гибрид сливает лексику с вектором. Разница на том же наборе: 0.43 против
 * 0.66.
 *
 * ПОЧЕМУ БЕЗ ВЕКТОРА (цена названа замером, как требует задача). Вектор дал бы
 * настоящую семантику, но: (1) `myc code index` обязан работать там, где
 * ONNX-модель не скачана вовсе — это записано в шапке `commands/code.ts` и
 * ломать его ради поиска нельзя; (2) эмбеддинг стоит ~23 мс на документ
 * (memory-4y7devf3y5k8), то есть 4359 единиц этого репозитория — около
 * полутора минут против 0.4 с у лексического корпуса; (3) это второе
 * векторное пространство со своим отпечатком, которое придётся стеречь.
 * Лексика на размеченном наборе даёт top-3 10/12 — этого хватает, чтобы
 * вопрос перестал быть без ответа. Вектор остаётся возможным вторым
 * источником: `searchCode` возвращает ранги, а не скоры, ровно чтобы его
 * можно было слить RRF-ом, не переписывая ранжирование.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { analyzeFtsQuery } from "@myc/retrieval/fts";
import { prefixEnd, type RepoRef, stripPrefix, viewOf } from "./view.ts";

// ---------------------------------------------------------------------------
// Извлечение текста единиц
// ---------------------------------------------------------------------------

/** Сколько строк шапки файла берём в корпус: дальше начинается уже код. */
const HEADER_MAX_LINES = 120;
/** Сколько строк сигнатуры берём в корпус (не путать со `skeleton`). */
const SIGNATURE_MAX_LINES = 3;
/** Сколько имён файла перечисляем в его единице. */
const HEADER_MAX_NAMES = 60;
/** Потолок длины док-комментария единицы: трактат целиком корпусу не нужен. */
const DOC_MAX_CHARS = 4000;

const LINE_COMMENT = /^\s*(\/\/|#|--)\s?/;

/**
 * Комментарий НАД определением. Ищется вверх от строки объявления через пустые
 * строки: между JSDoc и `export function` часто стоит пустая строка, и
 * останавливаться на ней значило бы потерять комментарий у половины символов.
 */
export function docAbove(lines: readonly string[], startLine: number): string {
  let i = startLine - 2;
  while (i >= 0 && (lines[i] ?? "").trim() === "") i--;
  if (i < 0) return "";
  const t = (lines[i] ?? "").trim();
  if (t.endsWith("*/")) {
    const buf: string[] = [];
    let j = i;
    while (j >= 0) {
      buf.unshift(lines[j] ?? "");
      if ((lines[j] ?? "").trim().startsWith("/*")) break;
      j--;
    }
    return stripBlock(buf.join("\n"));
  }
  if (LINE_COMMENT.test(t)) {
    const buf: string[] = [];
    let j = i;
    while (j >= 0 && LINE_COMMENT.test(lines[j] ?? "")) {
      buf.unshift((lines[j] ?? "").replace(LINE_COMMENT, ""));
      j--;
    }
    return buf.join("\n");
  }
  return "";
}

function stripBlock(text: string): string {
  return text
    .replace(/\/\*+/g, " ")
    .replace(/\*+\//g, " ")
    .replace(/^[ \t]*\*[ \t]?/gm, "");
}

/**
 * Шапка файла: ведущие комментарии до первой строки кода. Именно она отвечает
 * на вопрос «где вообще про это написано» — в этом репозитории шапка обычно
 * длиннее и содержательнее любого отдельного символа.
 */
export function fileHeader(lines: readonly string[]): string {
  const out: string[] = [];
  let i = 0;
  let taken = 0;
  while (i < lines.length && taken < HEADER_MAX_LINES) {
    const line = lines[i] ?? "";
    const t = line.trim();
    if (t === "") {
      i++;
      continue;
    }
    if (t.startsWith("/*")) {
      const buf: string[] = [];
      while (i < lines.length && taken < HEADER_MAX_LINES) {
        buf.push(lines[i] ?? "");
        taken++;
        const closed = (lines[i] ?? "").includes("*/");
        i++;
        if (closed) break;
      }
      out.push(stripBlock(buf.join("\n")));
      continue;
    }
    if (LINE_COMMENT.test(line)) {
      out.push(line.replace(LINE_COMMENT, ""));
      taken++;
      i++;
      continue;
    }
    break;
  }
  return out.join("\n");
}

/**
 * `resolveSession` -> `resolve Session`, `code_index.ts` -> `code index ts`.
 *
 * Токенизатор FTS5 разбивает по не-словам, но `camelCase` для него ОДИН
 * токен: без этой развёртки вопрос «session» не находил бы `resolveSession`.
 * Исходное написание при этом сохраняется рядом — поиск по точному имени
 * обязан остаться точным.
 */
export function splitIdent(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_\-./\\]/g, " ");
}

function signatureAt(lines: readonly string[], start: number, end: number): string {
  const last = Math.min(end, start + SIGNATURE_MAX_LINES - 1, lines.length);
  return lines
    .slice(start - 1, last)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

// ---------------------------------------------------------------------------
// Построение корпуса
// ---------------------------------------------------------------------------

export interface BuildSearchResult {
  /** Файлов, у которых единицы перестроены. */
  readonly rebuilt: number;
  /** Файлов, у которых хеш совпал и трогать их не пришлось. */
  readonly reused: number;
  /** Файлов, чьи единицы убраны (файл исчез из индекса). */
  readonly removed: number;
  readonly units: number;
  /** Знаков текста, отданных в FTS5 — числитель «сколько стоит корпус». */
  readonly bytes: number;
  readonly tookMs: number;
  /** Файлов, которых не оказалось на диске: единицы для них не строятся. */
  readonly missing: number;
}

const SQL_FILES = `SELECT f.path AS path, f.lang AS lang, f.file_hash AS file_hash
  FROM code_files f WHERE f.repo_id = ?1 ORDER BY f.path`;
const SQL_UNIT_HASHES = `SELECT path, file_hash, COUNT(*) AS n
  FROM code_units WHERE repo_id = ?1 GROUP BY path, file_hash`;
const SQL_DEFS = `SELECT path, name, kind, span_start, span_end
  FROM code_defs WHERE repo_id = ?1 ORDER BY path, span_start`;

/**
 * Те же три под отрезком путей — для перестройки ЧАСТИ корпуса, когда
 * `myc code index` из вложенного репозитория обновляет его часть индекса
 * корня (memory-m0md9fybwrdh). Пути здесь НЕ срезаются: это запись в индекс
 * корня, и ключ строк — его.
 */
const SQL_FILES_IN = `SELECT f.path AS path, f.lang AS lang, f.file_hash AS file_hash
  FROM code_files f WHERE f.repo_id = ?1 AND f.path >= ?2 AND f.path < ?3 ORDER BY f.path`;
const SQL_UNIT_HASHES_IN = `SELECT path, file_hash, COUNT(*) AS n
  FROM code_units WHERE repo_id = ?1 AND path >= ?2 AND path < ?3 GROUP BY path, file_hash`;
const SQL_DEFS_IN = `SELECT path, name, kind, span_start, span_end
  FROM code_defs WHERE repo_id = ?1 AND path >= ?2 AND path < ?3 ORDER BY path, span_start`;

/**
 * Перестроить корпус поиска по тому, что уже лежит в индексе.
 *
 * ИНКРЕМЕНТАЛЬНОСТЬ ПО ХЕШУ ФАЙЛА, а не по отметке времени: `code_units`
 * хранит `file_hash`, с которым единица записана, и файл перестраивается
 * ровно тогда, когда хеш в `code_files` от него отличается. Отдельной отметки
 * «когда строили» нет намеренно — она допускала бы состояние «отметка свежая,
 * единиц нет», от которого схема `code_files` (версия 3) специально уходила.
 *
 * ЧИТАЕТ ФАЙЛЫ ЗАНОВО, хотя индексатор их только что читал. Это осознанная
 * цена: альтернатива — протащить текст комментариев через воркер разбора, его
 * протокол сообщений и пул, то есть тронуть горячий путь индексации ради
 * холодного пути поиска. Замер: полный проход по 366 файлам с определениями —
 * 0.4 с, повторный (всё совпало) — 3 мс.
 */
export function buildSearchUnits(
  db: Database,
  repoId: string,
  repoRoot: string,
  /**
   * Только файлы под этим префиксом (`R/`): часть корпуса, остальное не
   * трогается — ни перестройкой, ни удалением «исчезнувших». Пусто — весь.
   */
  prefix = "",
): BuildSearchResult {
  const t0 = performance.now();
  const part = prefix.length > 0;
  const args = part ? [repoId, prefix, prefixEnd(prefix)] : [repoId];
  const files = db.query(part ? SQL_FILES_IN : SQL_FILES).all(...args) as Array<{
    path: string;
    lang: string;
    file_hash: string;
  }>;
  const known = new Map<string, string>();
  for (const row of db.query(part ? SQL_UNIT_HASHES_IN : SQL_UNIT_HASHES).all(...args) as Array<{
    path: string;
    file_hash: string;
    n: number;
  }>) {
    known.set(row.path, row.file_hash);
  }
  const defsByPath = new Map<string, Array<{ name: string; kind: string; s: number; e: number }>>();
  for (const d of db.query(part ? SQL_DEFS_IN : SQL_DEFS).all(...args) as Array<{
    path: string;
    name: string;
    kind: string;
    span_start: number;
    span_end: number;
  }>) {
    let list = defsByPath.get(d.path);
    if (list === undefined) {
      list = [];
      defsByPath.set(d.path, list);
    }
    list.push({ name: d.name, kind: d.kind, s: d.span_start, e: d.span_end });
  }

  const delUnits = db.query("DELETE FROM code_units WHERE repo_id = ?1 AND path = ?2");
  const delFtsRow = db.query("DELETE FROM code_fts WHERE rowid = ?1");
  const idsOfFile = db.query("SELECT id FROM code_units WHERE repo_id = ?1 AND path = ?2");
  const insUnit = db.query(
    `INSERT INTO code_units (repo_id, path, unit, name, kind, span_start, span_end, file_hash)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) RETURNING id`,
  );
  const insFts = db.query(
    "INSERT INTO code_fts (rowid, name, sig, doc, path) VALUES (?1, ?2, ?3, ?4, ?5)",
  );

  let rebuilt = 0;
  let reused = 0;
  let removed = 0;
  let units = 0;
  let bytes = 0;
  let missing = 0;

  const dropFile = (path: string): void => {
    for (const row of idsOfFile.all(repoId, path) as Array<{ id: number }>) {
      delFtsRow.run(row.id);
    }
    delUnits.run(repoId, path);
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    const seen = new Set<string>();
    for (const f of files) {
      seen.add(f.path);
      const defs = defsByPath.get(f.path);
      if (defs === undefined || defs.length === 0) {
        // Файл без определений (L0 — markdown, json, lock) в корпус поиска не
        // идёт: искать в нём нечего, а его шапка утопила бы выдачу текстом,
        // который к коду отношения не имеет.
        if (known.has(f.path)) {
          dropFile(f.path);
          removed++;
        }
        continue;
      }
      if (known.get(f.path) === f.file_hash) {
        reused++;
        units += defs.length + 1;
        continue;
      }
      let text: string;
      try {
        text = readFileSync(join(repoRoot, f.path), "utf8");
      } catch {
        // Файл исчез между индексом и этим проходом: старые единицы снимаем,
        // новых не пишем. Молча оставить старые значило бы выдавать
        // `path:line` в файл, которого нет.
        if (known.has(f.path)) {
          dropFile(f.path);
          removed++;
        }
        missing++;
        continue;
      }
      dropFile(f.path);
      const lines = text.split("\n");
      const header = fileHeader(lines).slice(0, DOC_MAX_CHARS);
      const names = defs.slice(0, HEADER_MAX_NAMES).map((d) => d.name).join(" ");
      const base = f.path.slice(f.path.lastIndexOf("/") + 1);
      const pathField = `${f.path} ${splitIdent(f.path)}`;
      const fileRow = insUnit.get(repoId, f.path, "file", base, "file", 1, lines.length, f.file_hash) as {
        id: number;
      };
      insFts.run(fileRow.id, `${base} ${splitIdent(base)}`, `${names} ${splitIdent(names)}`, header, pathField);
      units++;
      bytes += header.length + names.length;
      for (const d of defs) {
        const doc = docAbove(lines, d.s).slice(0, DOC_MAX_CHARS);
        const sig = signatureAt(lines, d.s, d.e);
        const row = insUnit.get(repoId, f.path, "def", d.name, d.kind, d.s, d.e, f.file_hash) as {
          id: number;
        };
        insFts.run(row.id, `${d.name} ${splitIdent(d.name)}`, sig, doc, pathField);
        units++;
        bytes += doc.length + sig.length;
      }
      rebuilt++;
    }
    for (const path of known.keys()) {
      if (seen.has(path)) continue;
      dropFile(path);
      removed++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { rebuilt, reused, removed, units, bytes, tookMs: performance.now() - t0, missing };
}

// ---------------------------------------------------------------------------
// Запрос
// ---------------------------------------------------------------------------

/** Единица, совпавшая внутри файла. */
export interface CodeSearchUnit {
  readonly unit: "file" | "def";
  readonly name: string;
  readonly kind: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  /** Вклад единицы в счёт файла — чтобы порядок символов внутри был объясним. */
  readonly score: number;
}

export interface CodeSearchHit {
  readonly path: string;
  readonly lang: string;
  readonly score: number;
  /** Совпавшие символы файла, лучшие первыми. Пусто — совпала только шапка. */
  readonly units: readonly CodeSearchUnit[];
  /** Совпала ли шапка файла: тогда ответ «про этот файл», а не «про символ». */
  readonly headerMatched: boolean;
  /**
   * Вклад шапки в счёт файла; 0 — шапка не совпала. Выделен отдельно не ради
   * отладки: `score` обязан быть ОБЪЯСНИМ, а объяснить его можно только если
   * видно, что он равен `headerScore` плюс сумма вкладов единиц. Иначе
   * «свёртка складывает» — заявление, которое нечем проверить ни читателю,
   * ни тесту.
   */
  readonly headerScore: number;
}

export interface CodeSearchResult {
  readonly hits: readonly CodeSearchHit[];
  /** Ступени, что-то нашедшие, в порядке применения. Пусто — не нашла ни одна. */
  readonly stages: readonly string[];
  /** Что просмотрено (§6.3: пустой выдачи без причины не бывает). */
  readonly searched: { readonly units: number; readonly files: number };
  readonly tookMs: number;
}

export interface CodeSearchOptions {
  readonly limit?: number;
  /** Сколько единиц берём с каждой ступени лестницы. */
  readonly perStage?: number;
  /** Сколько единиц одного файла складываются в его счёт. */
  readonly unitsPerFile?: number;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_PER_STAGE = 80;
const DEFAULT_UNITS_PER_FILE = 8;
/**
 * Константа RRF. У памяти она 60 (docs/design/02 §2.2); здесь 10, и разница
 * не вкусовая: там сливаются РАЗНЫЕ источники (лексика, вектор, граф), и
 * большой k гасит уверенность каждого. Здесь сливаются ступени ОДНОГО
 * источника, где ранг 1 действительно лучше ранга 20, и большой k стирал бы
 * то единственное, что ступени сообщают.
 */
const RRF_K = 10;
const MAX_LIMIT = 100;

const SQL_STAGE = `SELECT u.id AS id, u.path AS path, u.unit AS unit, u.name AS name,
       u.kind AS kind, u.span_start AS s, u.span_end AS e
  FROM code_fts f JOIN code_units u ON u.id = f.rowid
 WHERE code_fts MATCH ?1 AND u.repo_id = ?2
 ORDER BY bm25(code_fts, 4.0, 1.0, 1.0, 0.5) LIMIT ?3`;

const SQL_SCOPE = `SELECT
  (SELECT COUNT(*) FROM code_units WHERE repo_id = ?1) AS units,
  (SELECT COUNT(DISTINCT path) FROM code_units WHERE repo_id = ?1) AS files`;

const SQL_LANGS = `SELECT path, lang FROM code_files WHERE repo_id = ?1`;

/**
 * Под префиксом вида (`view.ts`). Отрезок пути стоит в ступени ПОСЛЕ MATCH и
 * ДО `LIMIT`: верх берётся уже среди единиц вложенного репозитория, а не
 * срезается из верха всего корня — иначе репозиторий, чьи единицы проигрывают
 * соседу, получал бы пустую выдачу. Статистика bm25 — по всему корпусу, как и
 * из корня: порядок внутри репозитория тот же, что у тех же единиц в выдаче
 * корня.
 *
 * УНАРНЫЙ `+` У ПУТИ — НЕ ОПЕЧАТКА, А ПЛАН. Без него отрезок `(repo_id, path)`
 * делает индекс `ix_code_units_file` привлекательным, и SQLite идёт от
 * единиц репозитория, проверяя MATCH на КАЖДОЙ строке: замер на 462 файлах
 * (4 543 определения) — 188 мс на вопрос против 1.5 мс из корня. `+` снимает
 * столбец с индекса, и план становится планом корня: сначала FTS, потом
 * единица по rowid, потом отрезок пути фильтром.
 */
export const SQL_STAGE_IN = `SELECT u.id AS id, u.path AS path, u.unit AS unit, u.name AS name,
       u.kind AS kind, u.span_start AS s, u.span_end AS e
  FROM code_fts f JOIN code_units u ON u.id = f.rowid
 WHERE code_fts MATCH ?1 AND u.repo_id = ?2 AND +u.path >= ?4 AND +u.path < ?5
 ORDER BY bm25(code_fts, 4.0, 1.0, 1.0, 0.5) LIMIT ?3`;

const SQL_SCOPE_IN = `SELECT
  (SELECT COUNT(*) FROM code_units WHERE repo_id = ?1 AND path >= ?2 AND path < ?3) AS units,
  (SELECT COUNT(DISTINCT path) FROM code_units WHERE repo_id = ?1 AND path >= ?2 AND path < ?3) AS files`;

const SQL_LANGS_IN = `SELECT path, lang FROM code_files WHERE repo_id = ?1 AND path >= ?2 AND path < ?3`;

interface StageRow {
  id: number;
  path: string;
  unit: "file" | "def";
  name: string;
  kind: string;
  s: number;
  e: number;
}

/**
 * Ранжированный поиск по корпусу. Возвращает ФАЙЛЫ с совпавшими символами:
 * см. шапку модуля — свёртка измерена и стоит 0.15 MRR.
 */
export function searchCode(
  db: Database,
  repo: RepoRef,
  query: string,
  opts: CodeSearchOptions = {},
): CodeSearchResult {
  const t0 = performance.now();
  const v = viewOf(repo);
  const part = v.prefix.length > 0;
  const range = part ? [v.prefix, prefixEnd(v.prefix)] : [];
  const scope = db.query(part ? SQL_SCOPE_IN : SQL_SCOPE).get(v.repoId, ...range) as {
    units: number;
    files: number;
  };
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT)), MAX_LIMIT);
  const perStage = Math.max(1, Math.floor(opts.perStage ?? DEFAULT_PER_STAGE));
  const unitsPerFile = Math.max(1, Math.floor(opts.unitsPerFile ?? DEFAULT_UNITS_PER_FILE));

  // Дефис и точка в корпусе — РАЗДЕЛИТЕЛИ (см. токенизатор миграции 012), а
  // `analyzeFtsQuery` держит их частью слова, как правильно для прозы. Не
  // развернуть их здесь значило бы, что вопрос про `code-intel` не находит
  // ничего: такого терма в индексе нет ни у одной единицы.
  const parsed = analyzeFtsQuery(query.replace(/[-.]+/g, " "));
  if (parsed === null || scope.units === 0) {
    return {
      hits: [],
      stages: [],
      searched: { units: scope.units, files: scope.files },
      tookMs: performance.now() - t0,
    };
  }

  const stageQ = db.query(part ? SQL_STAGE_IN : SQL_STAGE);
  const acc = new Map<number, { row: StageRow; score: number }>();
  const stages: string[] = [];
  const seenMatch = new Set<string>();
  for (const [name, match] of [
    ["and", parsed.and],
    ["prefix_and", parsed.prefixAnd],
    ["prefix_relaxed", parsed.prefixRelaxed],
    ["prefix_relaxed2", parsed.prefixRelaxed2],
    ["prefix_or", parsed.prefixOr],
  ] as const) {
    if (match === "" || seenMatch.has(match)) continue;
    seenMatch.add(match);
    let rows: StageRow[];
    try {
      rows = stageQ.all(match, v.repoId, perStage, ...range) as StageRow[];
      if (part) for (const r of rows) r.path = stripPrefix(v, r.path);
    } catch {
      // Ступень, которую FTS5 не разобрал, — не повод уронить весь поиск:
      // остальные ступени того же запроса остаются в силе.
      continue;
    }
    if (rows.length === 0) continue;
    stages.push(name);
    rows.forEach((row, i) => {
      const cur = acc.get(row.id) ?? { row, score: 0 };
      cur.score += 1 / (RRF_K + i + 1);
      acc.set(row.id, cur);
    });
  }

  const byFile = new Map<
    string,
    { score: number; units: CodeSearchUnit[]; header: boolean; headerScore: number }
  >();
  for (const { row, score } of [...acc.values()].sort((a, b) => b.score - a.score)) {
    let g = byFile.get(row.path);
    if (g === undefined) {
      g = { score: 0, units: [], header: false, headerScore: 0 };
      byFile.set(row.path, g);
    }
    if (row.unit === "file") {
      g.score += score;
      g.headerScore += score;
      g.header = true;
      continue;
    }
    // Потолок единиц на файл: без него файл на две тысячи строк выигрывает
    // числом символов, а не тем, что он про это.
    if (g.units.length >= unitsPerFile) continue;
    g.score += score;
    g.units.push({
      unit: row.unit,
      name: row.name,
      kind: row.kind,
      spanStart: row.s,
      spanEnd: row.e,
      score,
    });
  }

  const langs = new Map<string, string>();
  for (const r of db.query(part ? SQL_LANGS_IN : SQL_LANGS).all(v.repoId, ...range) as Array<{
    path: string;
    lang: string;
  }>) {
    langs.set(part ? stripPrefix(v, r.path) : r.path, r.lang);
  }

  const hits: CodeSearchHit[] = [...byFile.entries()]
    .sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1))
    .slice(0, limit)
    .map(([path, g]) => ({
      path,
      lang: langs.get(path) ?? "",
      score: g.score,
      units: g.units,
      headerMatched: g.header,
      headerScore: g.headerScore,
    }));

  return {
    hits,
    stages,
    searched: { units: scope.units, files: scope.files },
    tookMs: performance.now() - t0,
  };
}
