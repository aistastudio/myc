/**
 * ЧТЕНИЕ индекса кода — вторая половина `code_index.ts`, которой не было.
 *
 * Индекс писался фоном, а читать его было некому: `code_files`, `code_defs` и
 * `code_refs` не спрашивала ни одна команда (memory-m30yh8swnm1d). Здесь —
 * запросы, на которых стоят читатели: `myc code symbol` (§3.1 «символ →
 * path:span»), `defsInSpan` для якорей (какой символ держит этот участок) и
 * `storedFanIn` (§4.3, T5, S9) — чтение готового числа.
 *
 * `fan_in` здесь НЕ СЧИТАЕТСЯ (memory-g79mpkt53yn3): его считает прогон
 * индекса в фоне (`./fanin.ts`) и кладёт в `code_refs`, а читатель берёт
 * строку по первичному ключу — ни одного файла, ни одного прохода по корпусу.
 * Прежде здесь был счёт по требованию с кешем, и «дёшево» было правдой только
 * у второго спросившего. Источник в ответе подписан всегда (`text`), потому
 * что текстовый счёт — верхняя оценка: одноимённый символ из другого файла в
 * него попадает (§4.3).
 *
 * Запросы идут по префиксам первичных ключей `(repo_id, path, …)`, кроме
 * поиска по имени — он полный скан `code_defs` по repo_id, и это осознанно:
 * корпус репозитория — десятки тысяч строк, а второй индекс на (repo, name)
 * стоил бы записи при каждом разборе файла.
 *
 * ССЫЛКИ (`code_ref_sites`, миграция 011, memory-e34bfse29jdw) читаются в
 * конце файла — `refsTo`/`refsFrom`/`refsIndexed`. Там расклад другой и
 * обратный: строк не тысячи, а сотни тысяч, и полный скан по имени
 * недопустим — поэтому у той таблицы индекс по (repo_id, name) есть.
 *
 * ЧАСТЬ ИНДЕКСА (`view.ts`, memory-m0md9fybwrdh). Каждый читатель принимает
 * вместо `repoId` и ВИД — `{repoId, prefix}`: строки берутся из-под префикса,
 * пути наружу уходят без него. Строка `repoId` — прежний вызов, и для него
 * исполняется ровно прежний SQL: ответ из корня не меняется ни запросом, ни
 * планом.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { L1_LANGS } from "./langs.ts";
import { type CodeView, prefixEnd, type RepoRef, refsCacheKey, stripPrefix, viewOf, withPrefix } from "./view.ts";

/** Определение, как оно лежит в `code_defs` (плюс язык из `code_files`). */
export interface IndexedDef {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly exported: boolean;
  readonly lang: string;
}

/** Что индекс вообще видел по этому репозиторию (§6.3: пустая выдача с причиной). */
export interface IndexScope {
  readonly files: number;
  readonly defs: number;
  /** Файлов по языкам, крупные первыми. */
  readonly langs: readonly { readonly lang: string; readonly files: number }[];
  /** Когда последний файл был записан индексом; 0 — индекса нет. */
  readonly indexedAt: number;
  /** Файлов уровня L1 (только у них бывают определения). */
  readonly l1Files: number;
}

interface DefRow {
  path: string;
  name: string;
  kind: string;
  span_start: number;
  span_end: number;
  exported: number;
  lang: string | null;
}

function toDef(r: DefRow, view?: CodeView): IndexedDef {
  return {
    path: view === undefined ? r.path : stripPrefix(view, r.path),
    name: r.name,
    kind: r.kind,
    spanStart: r.span_start,
    spanEnd: r.span_end,
    exported: r.exported === 1,
    lang: r.lang ?? "",
  };
}

const SQL_BY_NAME = `SELECT d.path, d.name, d.kind, d.span_start, d.span_end, d.exported, f.lang
  FROM code_defs d LEFT JOIN code_files f ON f.repo_id = d.repo_id AND f.path = d.path
  WHERE d.repo_id = ?1 AND d.name = ?2
  ORDER BY d.path, d.span_start`;

/**
 * То же под префиксом вида. Отрезок `path` стоит СРАЗУ за `repo_id` в
 * первичном ключе `(repo_id, path, name, span_start)`, поэтому скан идёт
 * только по файлам вложенного репозитория, а не по всему индексу корня:
 * вопрос из репозитория стоит не дороже, чем из корня, а обычно дешевле.
 */
const SQL_BY_NAME_IN = `SELECT d.path, d.name, d.kind, d.span_start, d.span_end, d.exported, f.lang
  FROM code_defs d LEFT JOIN code_files f ON f.repo_id = d.repo_id AND f.path = d.path
  WHERE d.repo_id = ?1 AND d.name = ?2 AND d.path >= ?3 AND d.path < ?4
  ORDER BY d.path, d.span_start`;

const SQL_BY_FILE = `SELECT d.path, d.name, d.kind, d.span_start, d.span_end, d.exported, f.lang
  FROM code_defs d LEFT JOIN code_files f ON f.repo_id = d.repo_id AND f.path = d.path
  WHERE d.repo_id = ?1 AND d.path = ?2
  ORDER BY d.span_start`;

/** Определения с этим именем во всём репозитории. Пусто — символ не найден. */
export function symbolDefs(db: Database, repo: RepoRef, name: string): IndexedDef[] {
  const v = viewOf(repo);
  if (v.prefix.length === 0) return (db.query(SQL_BY_NAME).all(v.repoId, name) as DefRow[]).map((r) => toDef(r));
  return (db.query(SQL_BY_NAME_IN).all(v.repoId, name, v.prefix, prefixEnd(v.prefix)) as DefRow[]).map((r) =>
    toDef(r, v),
  );
}

/** Все определения одного файла — «скелет» файла в терминах индекса. */
export function fileDefs(db: Database, repo: RepoRef, path: string): IndexedDef[] {
  const v = viewOf(repo);
  return (db.query(SQL_BY_FILE).all(v.repoId, withPrefix(v, path)) as DefRow[]).map((r) =>
    toDef(r, v.prefix.length === 0 ? undefined : v),
  );
}

/**
 * Определения, ПЕРЕСЕКАЮЩИЕ участок — то, чем якорь `file:start-end`
 * превращается в «функция runAnchorStep», а не в пару чисел. Пересечение, а
 * не вложение: якорь ставят и на кусок тела функции, и на блок из нескольких.
 */
export function defsInSpan(
  db: Database,
  repo: RepoRef,
  path: string,
  start: number,
  end: number,
): IndexedDef[] {
  return fileDefs(db, repo, path).filter((d) => d.spanStart <= end && d.spanEnd >= start);
}

/** Состояние индекса по репозиторию: сколько файлов, символов, на чём написано. */
export function indexScope(db: Database, repo: RepoRef): IndexScope {
  const v = viewOf(repo);
  const whole = v.prefix.length === 0;
  const range = whole ? [] : [v.prefix, prefixEnd(v.prefix)];
  const files = db
    .query(
      whole
        ? "SELECT lang, count(*) AS n, max(indexed_at) AS at FROM code_files WHERE repo_id = ?1 GROUP BY lang"
        : "SELECT lang, count(*) AS n, max(indexed_at) AS at FROM code_files WHERE repo_id = ?1 AND path >= ?2 AND path < ?3 GROUP BY lang",
    )
    .all(v.repoId, ...range) as Array<{ lang: string; n: number; at: number }>;
  const defs = (
    db
      .query(
        whole
          ? "SELECT count(*) AS n FROM code_defs WHERE repo_id = ?1"
          : "SELECT count(*) AS n FROM code_defs WHERE repo_id = ?1 AND path >= ?2 AND path < ?3",
      )
      .get(v.repoId, ...range) as { n: number }
  ).n;
  const langs = files
    .map((r) => ({ lang: r.lang, files: Number(r.n) }))
    .sort((a, b) => b.files - a.files || a.lang.localeCompare(b.lang));
  return {
    files: langs.reduce((s, l) => s + l.files, 0),
    defs: Number(defs),
    langs,
    indexedAt: files.reduce((mx, r) => Math.max(mx, Number(r.at ?? 0)), 0),
    l1Files: langs.reduce((s, l) => s + (L1_LANGS.has(l.lang) ? l.files : 0), 0),
  };
}

/**
 * `fan_in` символа, как его положил фоновый пересчёт (`./fanin.ts`), с
 * обязательной подписью источника (§4.3).
 */
export interface StoredFanIn {
  /** Вхождений `\bNAME\b` по L1-файлам минус строки определений этого имени. */
  readonly n: number;
  /** В скольких файлах. */
  readonly files: number;
  readonly source: "text";
  /** Когда посчитано (мс эпохи). */
  readonly computedAt: number;
}

/** Строка числа — по первичному ключу `(repo_id, name)`; план пришпилен тестом. */
export const SQL_FAN_IN = "SELECT n_files, n_hits, computed_at FROM code_refs WHERE repo_id = ?1 AND name = ?2";

/**
 * ЧТЕНИЕ `fan_in` — поиск по первичному ключу `code_refs (repo_id, name)` и
 * больше ничего (S9): ни файла, ни прохода по корпусу, ни записи. Это и есть
 * интерфейс для потребителя из горячего пути (отпечаток задачи в рое).
 *
 * null — числа нет: индекс изменился, а фоновый пересчёт ещё не дописал его
 * (или индекс собран сборкой, у которой счёт был по требованию). Считать здесь
 * взамен нельзя — ровно от этого S9 и уводит; читатель называет «ещё не
 * посчитано», а досчитает следующий прогон индекса.
 *
 * Ключ — вида (`refsCacheKey`): из вложенного репозитория число по ЕГО части
 * индекса корня, из корня — по всему индексу.
 */
export function storedFanIn(db: Database, repo: RepoRef, name: string): StoredFanIn | null {
  const row = db.query(SQL_FAN_IN).get(refsCacheKey(viewOf(repo)), name) as {
    n_files: number;
    n_hits: number;
    computed_at: number;
  } | null;
  if (row === null) return null;
  return {
    n: Number(row.n_hits),
    files: Number(row.n_files),
    source: "text",
    computedAt: Number(row.computed_at),
  };
}

// ---------------------------------------------------------------------------
// Ссылки: вхождения с местом и владельцем (`code_ref_sites`, миграция 011)
// ---------------------------------------------------------------------------

/**
 * Одно вхождение имени. `from` пуст — верхний уровень файла (импорт,
 * объявление константы), и это НЕ «владелец не найден»: у строки на верхнем
 * уровне владельца нет, и подставлять сюда имя файла — работа отображения, а
 * не хранения.
 */
export interface RefSite {
  readonly path: string;
  readonly line: number;
  readonly kind: string;
  /** Имя охватывающего определения; "" — верхний уровень файла. */
  readonly from: string;
  /** `span_start` охватывающего определения; 0 — верхний уровень файла. */
  readonly fromStart: number;
}

interface RefRow {
  path: string;
  line: number;
  kind: string;
  from_name: string;
  from_start: number;
}

function toRef(r: RefRow, view?: CodeView): RefSite {
  return {
    path: view === undefined ? r.path : stripPrefix(view, r.path),
    line: Number(r.line),
    kind: r.kind,
    from: r.from_name,
    fromStart: Number(r.from_start),
  };
}

/**
 * `INDEXED BY` — НЕ УКРАШЕНИЕ И НЕ СУЕВЕРИЕ, А ИСПРАВЛЕНИЕ ЗАМЕРЕННОЙ ОШИБКИ
 * ПЛАНИРОВЩИКА. Без него SQLite выбирает первичный ключ по префиксу
 * `repo_id = ?` — то есть СКАН всей таблицы: в воркспейсе `repo_id` один на
 * все 154 360 строк, статистики (`ANALYZE`) в базе нет, и планировщику
 * неоткуда узнать, что префикс не отсекает ничего. Замер на этом
 * репозитории: 7.5 мс на ОДИН вопрос против 0.03 мс с индексом, 300 имён —
 * 2240 мс против 3.7 мс. Транзитивный обход (`callers --depth all`, 1766
 * символов) стоил из-за этого 13.4 с вместо 48 мс.
 *
 * Именно поэтому индекс `ix_code_ref_sites_name` в миграции 011 и заведён;
 * `INDEXED BY` превращает его из «есть в схеме» в «используется», и заодно
 * делает падение видимым: исчезнет индекс — запрос откажет, а не молча
 * замедлится в 250 раз.
 */
export const SQL_REFS_TO = `SELECT path, line, kind, from_name, from_start FROM code_ref_sites
  INDEXED BY ix_code_ref_sites_name
  WHERE repo_id = ?1 AND name = ?2
  ORDER BY path, line`;

/**
 * То же под префиксом вида. Индекс тот же `(repo_id, name)`: имя отсекает
 * почти всё, и отрезок пути проверяется уже на единицах найденных строк.
 */
const SQL_REFS_TO_IN = `SELECT path, line, kind, from_name, from_start FROM code_ref_sites
  INDEXED BY ix_code_ref_sites_name
  WHERE repo_id = ?1 AND name = ?2 AND path >= ?3 AND path < ?4
  ORDER BY path, line`;

/**
 * Кто ссылается на имя — сырьё для `myc callers` (задача memory-wrntvzwx8dh0;
 * саму команду здесь НЕ делаем).
 *
 * Идёт по индексу `ix_code_ref_sites_name`, а не сканом: определений в
 * репозитории тысячи и скан по ним допустим, ссылок — сотни тысяч, и «кто
 * зовёт» это как раз запрос по имени.
 *
 * ОТВЕТ ЗАВЫШАЕТ И ЗАНИЖАЕТ, И ОБА НАПРАВЛЕНИЯ НАДО ЗНАТЬ. Завышает:
 * одноимённые символы разных файлов и классов сливаются в одно имя (`close`
 * есть у всех). Занижает: имя, упомянутое только в комментарии или собранное
 * динамически (`obj[name]()`), сюда не попадает — грамматика их
 * идентификаторами не называет. Полный список того, чего разбор не
 * различает, — в шапке `refs.ts`.
 */
export function refsTo(
  db: Database,
  repo: RepoRef,
  name: string,
  opts: { readonly kinds?: readonly string[] } = {},
): RefSite[] {
  const v = viewOf(repo);
  const rows =
    v.prefix.length === 0
      ? (db.query(SQL_REFS_TO).all(v.repoId, name) as RefRow[]).map((r) => toRef(r))
      : (db.query(SQL_REFS_TO_IN).all(v.repoId, name, v.prefix, prefixEnd(v.prefix)) as RefRow[]).map((r) =>
          toRef(r, v),
        );
  if (opts.kinds === undefined) return rows;
  const want = new Set(opts.kinds);
  return rows.filter((r) => want.has(r.kind));
}

/**
 * На что ссылается символ — обратное направление (`--direction out` у graft).
 *
 * ИДЁТ ЧЕРЕЗ `code_defs`, А НЕ ЧЕРЕЗ ТРЕТИЙ ИНДЕКС. Прямой запрос
 * `WHERE from_name = ?` потребовал бы индекса по (repo_id, from_name) —
 * третьей копии таблицы на сотни тысяч строк (замер: +7 МБ на этом
 * репозитории) ради направления, которое спрашивают реже. Вместо этого:
 * определения символа (их единицы) дают (path, span_start), а по ним ссылки
 * достаются префиксом первичного ключа (repo_id, path) — то есть тем же
 * ключом, которым файл переиндексируется.
 *
 * Возвращаются вхождения, ПРИНАДЛЕЖАЩИЕ телу символа; имя, на которое
 * ссылаются, — в поле `name`, поэтому здесь тип шире, чем у `refsTo`.
 */
export function refsFrom(
  db: Database,
  repo: RepoRef,
  name: string,
): Array<RefSite & { readonly name: string }> {
  const v = viewOf(repo);
  const out: Array<RefSite & { readonly name: string }> = [];
  const q = db.query(
    `SELECT path, line, name, kind, from_name, from_start FROM code_ref_sites
     WHERE repo_id = ?1 AND path = ?2 AND from_start = ?3 ORDER BY line`,
  );
  for (const d of symbolDefs(db, v, name)) {
    const rows = q.all(v.repoId, withPrefix(v, d.path), d.spanStart) as Array<RefRow & { name: string }>;
    for (const r of rows) {
      if (r.from_name !== name) continue; // чужой символ, начавшийся на той же строке
      out.push({ ...toRef(r, v.prefix.length === 0 ? undefined : v), name: r.name });
    }
  }
  return out;
}

/**
 * Сколько ссылок индекс вообще знает по репозиторию. Нужен там же, где
 * `indexScope`: пустая выдача `callers` обязана уметь отличить «никто не
 * зовёт» от «ссылки ещё не построены» (§6.3).
 */
export function refsIndexed(db: Database, repo: RepoRef): number {
  const v = viewOf(repo);
  const r = (
    v.prefix.length === 0
      ? db.query("SELECT count(*) AS n FROM code_ref_sites WHERE repo_id = ?1").get(v.repoId)
      : db
          .query("SELECT count(*) AS n FROM code_ref_sites WHERE repo_id = ?1 AND path >= ?2 AND path < ?3")
          .get(v.repoId, v.prefix, prefixEnd(v.prefix))
  ) as { n: number };
  return Number(r.n);
}

// ---------------------------------------------------------------------------
// Граф вызовов: кто зовёт, кого зовёт, на какую глубину (`myc callers`)
// ---------------------------------------------------------------------------

/**
 * `in` — кто ссылается на символ, `out` — на что ссылается он сам.
 * Два обхода одной таблицы, но РАЗНЫМИ ключами: `in` идёт по (repo, name)
 * через `ix_code_ref_sites_name`, `out` — по префиксу первичного ключа
 * (repo, path) в границах спана определения. Третьего индекса ни один из них
 * не требует (см. `refsFrom`).
 */
export type CallDirection = "in" | "out";

/** Одно вхождение внутри ребра: строка и роль. */
export interface CallSite {
  readonly line: number;
  readonly kind: string;
}

/**
 * РЕБРО, А НЕ СТРОКА — вот в чём разница между `callers` и `grep -n`.
 *
 * Одна пара «зовущий → зовомый» в одном файле собирает ВСЕ свои вхождения в
 * `sites`. Так ответ читается как граф («listDefs зовут measure и spanOf»), а
 * не как список из 35 совпадений, среди которых 33 — повторения одного и того
 * же владельца.
 */
export interface CallEdge {
  /** Зовущий символ; "" — верхний уровень файла (импорт, константа). */
  readonly caller: string;
  /** Зовомое имя. */
  readonly callee: string;
  readonly path: string;
  /** `span_start` зовущего; 0 — верхний уровень файла. */
  readonly callerStart: number;
  readonly sites: readonly CallSite[];
  /** Шаг обхода, на котором ребро найдено; 1 — прямые соседи корня. */
  readonly depth: number;
}

export interface CallGraph {
  readonly root: string;
  readonly direction: CallDirection;
  readonly edges: readonly CallEdge[];
  /** Символы, до которых обход дошёл (без корня), в порядке нахождения. */
  readonly nodes: readonly string[];
  /** Сколько НОВЫХ символов дал каждый шаг. */
  readonly levels: readonly number[];
  /** Фактически пройденная глубина (может быть меньше запрошенной). */
  readonly depthReached: number;
  /** Всего вхождений в рёбрах. */
  readonly sites: number;
  /** Запросов к базе — цена ответа, а не догадка о ней. */
  readonly queries: number;
  /**
   * Почему обход прекратился раньше границы графа. `null` — граф исчерпан;
   * `nodes` — упёрлись в потолок, и ответ НЕПОЛОН («пропущено N, причина»).
   */
  readonly stopped: { readonly reason: "nodes"; readonly limit: number } | null;
  readonly tookMs: number;
}

export interface CallGraphOptions {
  /** Шагов обхода; `Infinity` — до исчерпания. По умолчанию 1. */
  readonly depth?: number;
  /** Роли вхождений (`call`, `new`, `type`, `import`, `read`, `prop`). */
  readonly kinds?: readonly string[];
  /**
   * Потолок числа символов обхода. Не про производительность (полный обход на
   * этом репозитории — 48 мс), а про ЧЕСТНОСТЬ: транзитивное замыкание по
   * ИМЕНАМ протекает через омонимы (`run`, `main`, `index`) и на пятом шаге
   * втягивает почти весь репозиторий. Потолок делает это видимым числом, а не
   * молчаливым дампом.
   */
  readonly maxNodes?: number;
}

const SQL_REFS_IN_SPAN = `SELECT path, line, name, kind, from_name, from_start FROM code_ref_sites
  WHERE repo_id = ?1 AND path = ?2 AND line >= ?3 AND line <= ?4
  ORDER BY line, name`;

/**
 * Ссылки ВНУТРИ спана символа — включая вложенные определения.
 *
 * Отличие от `refsFrom`: тот берёт только вхождения, чей владелец — сам
 * символ, и потому теряет всё, что стоит в замыкании (`const lazy = … =>`
 * внутри `registerAll`). Для вопроса «что зовёт этот символ» замыкание — часть
 * символа, а не чужой код: функция, вызванная из колбэка внутри тела, вызвана
 * телом. Владелец каждого вхождения при этом сохранён в `from`, и читатель
 * видит, где именно ссылка стоит.
 */
export function refsWithin(
  db: Database,
  repo: RepoRef,
  name: string,
  opts: { readonly kinds?: readonly string[]; readonly defs?: readonly IndexedDef[] } = {},
): Array<RefSite & { readonly name: string }> {
  const v = viewOf(repo);
  const q = db.query(SQL_REFS_IN_SPAN);
  const want = opts.kinds === undefined ? null : new Set(opts.kinds);
  const out: Array<RefSite & { readonly name: string }> = [];
  // Определения приходят уже в путях ВИДА (без префикса) — и из
  // `symbolDefs`, и из `defsByName`; в базу идут с префиксом обратно.
  const defs = opts.defs ?? symbolDefs(db, v, name);
  for (const d of defs) {
    const rows = q.all(v.repoId, withPrefix(v, d.path), d.spanStart, d.spanEnd) as Array<
      RefRow & { name: string }
    >;
    for (const r of rows) {
      if (want !== null && !want.has(r.kind)) continue;
      out.push({ ...toRef(r, v.prefix.length === 0 ? undefined : v), name: r.name });
    }
  }
  return out;
}

/** Имена, у которых в этом репозитории есть определение. Один запрос на обход. */
export function definedNames(db: Database, repo: RepoRef): Set<string> {
  const v = viewOf(repo);
  const rows = (
    v.prefix.length === 0
      ? db.query("SELECT DISTINCT name FROM code_defs WHERE repo_id = ?1").all(v.repoId)
      : db
          .query("SELECT DISTINCT name FROM code_defs WHERE repo_id = ?1 AND path >= ?2 AND path < ?3")
          .all(v.repoId, v.prefix, prefixEnd(v.prefix))
  ) as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

/**
 * Имена, определённые в репозитории больше одного раза, с числом определений —
 * то, через что протекает обход по именам (`myc callers --depth`).
 */
export function ambiguousNames(db: Database, repo: RepoRef): Map<string, number> {
  const v = viewOf(repo);
  const rows = (
    v.prefix.length === 0
      ? db
          .query("SELECT name, count(*) AS n FROM code_defs WHERE repo_id = ?1 GROUP BY name HAVING n > 1")
          .all(v.repoId)
      : db
          .query(
            "SELECT name, count(*) AS n FROM code_defs WHERE repo_id = ?1 AND path >= ?2 AND path < ?3 GROUP BY name HAVING n > 1",
          )
          .all(v.repoId, v.prefix, prefixEnd(v.prefix))
  ) as Array<{ name: string; n: number }>;
  return new Map(rows.map((r) => [r.name, Number(r.n)]));
}

/** Все определения репозитория, разложенные по имени. Один запрос на обход. */
function defsByName(db: Database, repo: RepoRef): Map<string, IndexedDef[]> {
  const v = viewOf(repo);
  const whole = v.prefix.length === 0;
  const rows = db
    .query(
      whole
        ? `SELECT d.path, d.name, d.kind, d.span_start, d.span_end, d.exported, f.lang
         FROM code_defs d LEFT JOIN code_files f ON f.repo_id = d.repo_id AND f.path = d.path
        WHERE d.repo_id = ?1 ORDER BY d.path, d.span_start`
        : `SELECT d.path, d.name, d.kind, d.span_start, d.span_end, d.exported, f.lang
         FROM code_defs d LEFT JOIN code_files f ON f.repo_id = d.repo_id AND f.path = d.path
        WHERE d.repo_id = ?1 AND d.path >= ?2 AND d.path < ?3 ORDER BY d.path, d.span_start`,
    )
    .all(v.repoId, ...(whole ? [] : [v.prefix, prefixEnd(v.prefix)])) as DefRow[];
  const map = new Map<string, IndexedDef[]>();
  for (const r of rows) {
    const def = toDef(r, whole ? undefined : v);
    const list = map.get(def.name);
    if (list === undefined) map.set(def.name, [def]);
    else list.push(def);
  }
  return map;
}

/** Ключ ребра: пара «владелец → имя» в одном файле. */
function edgeKey(path: string, caller: string, callerStart: number, callee: string): string {
  return `${path} ${caller} ${callerStart} ${callee}`;
}

/**
 * Обход графа вызовов вширь от одного имени.
 *
 * ГРАФ ЗДЕСЬ — ПО ИМЕНАМ, И ЭТО НЕ УПРОЩЕНИЕ РАДИ КОДА, А ГРАНИЦА РАЗБОРА
 * (`refs.ts`, пункты 1-3): вхождение знает имя, а не то, чей это `close` из
 * тринадцати. Поэтому шаг обхода по неоднозначному имени СЛИВАЕТ несколько
 * символов в один узел, и с каждым шагом доля таких слияний растёт: на этом
 * репозитории `--depth all` от любого символа приходит в одни и те же 1766
 * узлов из 2601 — то есть в две трети всех владельцев. Вызывающая сторона
 * обязана это назвать; данных, чтобы этого избежать, в индексе нет.
 */
export function callGraph(
  db: Database,
  repo: RepoRef,
  name: string,
  opts: CallGraphOptions & { readonly direction?: CallDirection } = {},
): CallGraph {
  const t0 = performance.now();
  return walk(
    db,
    repo,
    name,
    opts.direction ?? "in",
    opts.depth === undefined ? 1 : opts.depth,
    opts.maxNodes ?? 5000,
    opts.kinds,
    t0,
  );
}

function walk(
  db: Database,
  repo: RepoRef,
  root: string,
  direction: CallDirection,
  depth: number,
  maxNodes: number,
  kinds: readonly string[] | undefined,
  t0: number,
): CallGraph {
  const edges = new Map<string, { edge: CallEdge; sites: CallSite[] }>();
  const seen = new Set<string>([root]);
  const nodes: string[] = [];
  const levels: number[] = [];
  let frontier = [root];
  let queries = 0;
  let stopped: CallGraph["stopped"] = null;
  let depthReached = 0;

  // Оба справочника нужны только транзитивному обходу; на глубине 1 их цена
  // (два запроса по всей `code_defs`) была бы платой ни за что.
  const transitive = depth > 1;
  const defined = direction === "out" && transitive ? definedNames(db, repo) : null;
  const spans = direction === "out" && transitive ? defsByName(db, repo) : null;

  for (let d = 1; d <= depth && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const node of frontier) {
      queries++;
      const rows =
        direction === "in"
          ? refsTo(db, repo, node, kinds === undefined ? {} : { kinds }).map((r) => ({
              ...r,
              name: node,
            }))
          : refsWithin(db, repo, node, {
              ...(kinds === undefined ? {} : { kinds }),
              ...(spans === null ? {} : { defs: spans.get(node) ?? [] }),
            });
      for (const r of rows) {
        const caller = r.from;
        const callee = direction === "in" ? node : r.name;
        const key = edgeKey(r.path, caller, r.fromStart, callee);
        const hit = edges.get(key);
        if (hit === undefined) {
          const sites: CallSite[] = [{ line: r.line, kind: r.kind }];
          edges.set(key, {
            sites,
            edge: { caller, callee, path: r.path, callerStart: r.fromStart, sites, depth: d },
          });
        } else hit.sites.push({ line: r.line, kind: r.kind });

        // Кого расширять дальше: для `in` — зовущий символ (у верхнего уровня
        // файла владельца нет, и обход на нём кончается), для `out` — зовомое
        // имя, и только если оно ОПРЕДЕЛЕНО здесь: у импортированного
        // `readFileSync` тела в этом репозитории нет.
        const nextName = direction === "in" ? caller : callee;
        if (nextName === "" || seen.has(nextName)) continue;
        if (direction === "out" && defined !== null && !defined.has(nextName)) continue;
        if (seen.size >= maxNodes) {
          stopped = { reason: "nodes", limit: maxNodes };
          continue;
        }
        seen.add(nextName);
        nodes.push(nextName);
        next.push(nextName);
      }
    }
    depthReached = d;
    levels.push(next.length);
    if (stopped !== null) break;
    frontier = next;
  }

  // Порядок разный по направлениям, и это не косметика. `in` читают как
  // «кто меня трогает» — там единица ответа файл и владелец, поэтому сортируем
  // по ним. `out` читают как «что делает это тело» — там единица ответа
  // ПОРЯДОК ИСПОЛНЕНИЯ, и алфавит по имени зовомого превратил бы разбор
  // функции в словарь.
  const list = [...edges.values()].map((e) => e.edge);
  const firstLine = (e: CallEdge): number => e.sites.reduce((m, s) => Math.min(m, s.line), Infinity);
  list.sort((a, b) =>
    direction === "out"
      ? a.depth - b.depth ||
        a.path.localeCompare(b.path) ||
        firstLine(a) - firstLine(b) ||
        a.callee.localeCompare(b.callee)
      : a.depth - b.depth ||
        a.path.localeCompare(b.path) ||
        a.callerStart - b.callerStart ||
        a.callee.localeCompare(b.callee),
  );
  return {
    root,
    direction,
    edges: list,
    nodes,
    levels,
    depthReached,
    sites: list.reduce((n, e) => n + e.sites.length, 0),
    queries,
    stopped,
    tookMs: performance.now() - t0,
  };
}

// ---------------------------------------------------------------------------
// Скелет файла: API вместо чтения целиком (`myc skeleton`)
// ---------------------------------------------------------------------------

/** Одна строка скелета: определение и его сигнатура из исходника. */
export interface SkeletonEntry {
  readonly name: string;
  readonly kind: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  /**
   * Виден ли символ снаружи файла.
   *
   * СЧИТАЕТСЯ ПО ТЕКСТУ СИГНАТУРЫ, А НЕ ПО `code_defs.exported`, и это не
   * вкусовщина: колонка в индексе ВСЕГДА 0 — вставка прибита константой
   * (`code_index.ts`, `INSERT ... VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)`), и
   * разбор её никогда не заполнял. Читать её значило бы печатать «ничего не
   * экспортировано» про файл, где экспортировано всё. Текст сигнатуры мы к
   * этому моменту уже прочитали, и `export` в его начале — тот же факт из
   * первых рук. Когда индексатор начнёт писать колонку, здесь останется взять
   * её и удалить эту оговорку; пока колонка врёт, врать за ней нельзя.
   */
  readonly exported: boolean;
  /** Вложенность: 0 — верхний уровень файла, 1 — метод класса, и так далее. */
  readonly nesting: number;
  /** Сигнатура из исходника; "" — файла на диске нет. */
  readonly signature: string;
}

export interface FileSkeleton {
  readonly path: string;
  readonly lang: string;
  readonly entries: readonly SkeletonEntry[];
  /** Байт и строк в файле — числитель дроби «дешевле в N раз». */
  readonly fileBytes: number;
  readonly fileLines: number;
  /** Байт в самом скелете (без рамки вывода). */
  readonly skeletonBytes: number;
  /** Файла нет на диске — сигнатур не будет, спаны остаются из индекса. */
  readonly onDisk: boolean;
  /**
   * Содержимое на диске разошлось с тем, что индексировали. Спаны и сигнатуры
   * в таком ответе могут указывать не туда, и молчать об этом нельзя.
   */
  readonly stale: boolean;
  readonly tookMs: number;
}

/** Сколько строк и знаков сигнатуры готовы прочитать; дальше — метка обрыва. */
const SIGNATURE_MAX_LINES = 14;
const SIGNATURE_MAX_CHARS = 200;

/**
 * Сигнатура из спана: строки от начала определения до конца объявления.
 *
 * Режем по ПЕРВОЙ структурной скобке на нулевой глубине круглых, квадратных и
 * угловых — это конец объявления и начало тела у функции, класса, интерфейса
 * и метода разом. Если её нет (тип-псевдоним, поле), режем по `;`. Больше
 * восьми строк не читаем: подпись, растянутая дальше, — уже не подпись.
 */
function signatureAt(lines: readonly string[], start: number, end: number): string {
  const last = Math.min(end, start + SIGNATURE_MAX_LINES - 1, lines.length);
  let round = 0;
  let angle = 0;
  let square = 0;
  const out: string[] = [];
  let closed = false;
  for (let i = start - 1; i < last; i++) {
    const line = lines[i] ?? "";
    let cut = line.length;
    for (let j = 0; j < line.length; j++) {
      const c = line[j]!;
      if (c === "(") round++;
      else if (c === ")") round--;
      else if (c === "[") square++;
      else if (c === "]") square--;
      else if (c === "<") angle++;
      else if (c === ">") angle--;
      else if ((c === "{" || c === ";") && round <= 0 && square <= 0 && angle <= 0) {
        cut = j;
        break;
      }
    }
    out.push(line.slice(0, cut));
    if (cut < line.length) {
      closed = true;
      break;
    }
  }
  // Обрыв обязан быть виден. Сигнатура, которой не хватило потолка строк или
  // ширины, без метки читается как ЗАКОНЧЕННАЯ — и агент строит вызов по
  // половине списка параметров.
  const flat = out.join(" ").replace(/\s+/g, " ").trim();
  if (flat.length > SIGNATURE_MAX_CHARS) return `${flat.slice(0, SIGNATURE_MAX_CHARS - 1)} …`;
  return closed ? flat : `${flat} …`;
}

/**
 * Скелет файла: что в нём объявлено, с какими сигнатурами и на каких строках.
 *
 * Цена ответа — ОДНО чтение файла и один запрос к индексу; смысл — в том, что
 * читателю не нужно втягивать файл целиком, и разница называется числом
 * (`fileBytes` против `skeletonBytes`), а не обещанием.
 */
export function fileSkeleton(
  db: Database,
  repo: RepoRef,
  path: string,
  root: string,
  /**
   * Где читать файл, которого нет под `root`: из git worktree это основная
   * копия (файл не приехал на ветку). Как у якорей `localFile`: путь в
   * репозитории есть, и «файла нет» было бы неправдой.
   */
  fallbackRoot?: string,
): FileSkeleton {
  const t0 = performance.now();
  const v = viewOf(repo);
  const defs = fileDefs(db, v, path);
  const meta = db
    .query("SELECT lang, file_hash FROM code_files WHERE repo_id = ?1 AND path = ?2")
    .get(v.repoId, withPrefix(v, path)) as { lang: string; file_hash: string } | null;
  let source: Buffer | null = null;
  for (const dir of fallbackRoot === undefined ? [root] : [root, fallbackRoot]) {
    try {
      source = readFileSync(join(dir, path));
      break;
    } catch {
      source = null;
    }
  }
  const text = source === null ? "" : source.toString("utf8");
  const lines = text.length === 0 ? [] : text.split("\n");
  const stale =
    source !== null && meta !== null && meta.file_hash !== `wy:${Bun.hash(source).toString(16)}`;

  // Вложенность — по включению спанов: определение внутри чужого спана
  // печатается со сдвигом, и класс перестаёт выглядеть плоским списком
  // функций. Спаны уже отсортированы по началу, поэтому хватает стека.
  const stack: IndexedDef[] = [];
  const entries: SkeletonEntry[] = [];
  for (const d of defs) {
    while (stack.length > 0 && stack[stack.length - 1]!.spanEnd < d.spanStart) stack.pop();
    const signature = source === null ? "" : signatureAt(lines, d.spanStart, d.spanEnd);
    entries.push({
      name: d.name,
      kind: d.kind,
      spanStart: d.spanStart,
      spanEnd: d.spanEnd,
      exported: d.exported || signature.startsWith("export "),
      nesting: stack.length,
      signature,
    });
    stack.push(d);
  }
  const skeletonBytes = entries.reduce(
    (n, e) => n + Buffer.byteLength(`${e.spanStart}-${e.spanEnd} ${e.kind} ${e.signature}\n`),
    0,
  );
  return {
    path,
    lang: meta?.lang ?? "",
    entries,
    fileBytes: source === null ? 0 : source.byteLength,
    fileLines: lines.length,
    skeletonBytes,
    onDisk: source !== null,
    stale,
    tookMs: performance.now() - t0,
  };
}
