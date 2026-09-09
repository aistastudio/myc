/**
 * ЧТЕНИЕ индекса кода — вторая половина `code_index.ts`, которой не было.
 *
 * Индекс писался фоном, а читать его было некому: `code_files`, `code_defs` и
 * `code_refs` не спрашивала ни одна команда (memory-m30yh8swnm1d). Здесь —
 * запросы, на которых стоят читатели: `myc code symbol` (§3.1 «символ →
 * path:span»), `defsInSpan` для якорей (какой символ держит этот участок) и
 * `fanIn` (§4.3, T5) со счётом ПО ТРЕБОВАНИЮ.
 *
 * Почему `fan_in` не считает индексатор: пересчёт по репозиторию — это проход
 * по всему содержимому, несовместимый с бюджетом повторного индекса. Поэтому
 * `code_refs` — КЕШ: индексатор строки изменённых имён удаляет (инвалидация),
 * а считает их первый спросивший, и результат кладётся обратно. Источник в
 * ответе подписан всегда (`text`), потому что текстовый счёт — верхняя
 * оценка: одноимённый символ из другого файла в него попадает (§4.3).
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
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { L1_LANGS } from "./langs.ts";

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

function toDef(r: DefRow): IndexedDef {
  return {
    path: r.path,
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

const SQL_BY_FILE = `SELECT d.path, d.name, d.kind, d.span_start, d.span_end, d.exported, f.lang
  FROM code_defs d LEFT JOIN code_files f ON f.repo_id = d.repo_id AND f.path = d.path
  WHERE d.repo_id = ?1 AND d.path = ?2
  ORDER BY d.span_start`;

/** Определения с этим именем во всём репозитории. Пусто — символ не найден. */
export function symbolDefs(db: Database, repoId: string, name: string): IndexedDef[] {
  return (db.query(SQL_BY_NAME).all(repoId, name) as DefRow[]).map(toDef);
}

/** Все определения одного файла — «скелет» файла в терминах индекса. */
export function fileDefs(db: Database, repoId: string, path: string): IndexedDef[] {
  return (db.query(SQL_BY_FILE).all(repoId, path) as DefRow[]).map(toDef);
}

/**
 * Определения, ПЕРЕСЕКАЮЩИЕ участок — то, чем якорь `file:start-end`
 * превращается в «функция runAnchorStep», а не в пару чисел. Пересечение, а
 * не вложение: якорь ставят и на кусок тела функции, и на блок из нескольких.
 */
export function defsInSpan(
  db: Database,
  repoId: string,
  path: string,
  start: number,
  end: number,
): IndexedDef[] {
  return fileDefs(db, repoId, path).filter((d) => d.spanStart <= end && d.spanEnd >= start);
}

/** Состояние индекса по репозиторию: сколько файлов, символов, на чём написано. */
export function indexScope(db: Database, repoId: string): IndexScope {
  const files = db
    .query("SELECT lang, count(*) AS n, max(indexed_at) AS at FROM code_files WHERE repo_id = ?1 GROUP BY lang")
    .all(repoId) as Array<{ lang: string; n: number; at: number }>;
  const defs = (
    db.query("SELECT count(*) AS n FROM code_defs WHERE repo_id = ?1").get(repoId) as { n: number }
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
 * `fan_in` с обязательной подписью источника (§4.3). `cached` говорит, взяли
 * ли из `code_refs` или считали сейчас: без него «дёшево» и «дорого»
 * неразличимы, а разница здесь — два порядка.
 */
export interface FanInResult {
  readonly n: number;
  readonly files: number;
  readonly source: "text";
  readonly cached: boolean;
  /** Сколько файлов прочитано этим вызовом (0 — попадание в кеш). */
  readonly read: number;
  readonly tookMs: number;
}

/**
 * Число вхождений `\bNAME\b` по L1-файлам репозитория за вычетом строк самих
 * определений. Считается по требованию и кладётся в `code_refs`; индексатор
 * эту строку удалит, как только изменится любой файл, где имя встречалось.
 *
 * Только L1: fan_in символа — это про код, а не про упоминание имени в
 * README, и читать ради него весь L0-реестр (включая бинарники) незачем.
 */
export function fanIn(
  db: Database,
  repoId: string,
  name: string,
  root: string,
  opts: { readonly now?: number; readonly write?: boolean } = {},
): FanInResult {
  const t0 = performance.now();
  const cached = db
    .query("SELECT n_files, n_hits FROM code_refs WHERE repo_id = ?1 AND name = ?2")
    .get(repoId, name) as { n_files: number; n_hits: number } | null;
  if (cached !== null) {
    return {
      n: Number(cached.n_hits),
      files: Number(cached.n_files),
      source: "text",
      cached: true,
      read: 0,
      tookMs: performance.now() - t0,
    };
  }

  // Строки определений вычитаются по (path, span_start): вхождение имени в
  // собственном объявлении — не входящая ссылка.
  const defLines = new Map<string, Set<number>>();
  for (const d of symbolDefs(db, repoId, name)) {
    const set = defLines.get(d.path) ?? new Set<number>();
    set.add(d.spanStart);
    defLines.set(d.path, set);
  }

  const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
  const paths = db
    .query("SELECT path, lang FROM code_files WHERE repo_id = ?1")
    .all(repoId) as Array<{ path: string; lang: string }>;
  let hits = 0;
  let nFiles = 0;
  let read = 0;
  for (const p of paths) {
    if (!L1_LANGS.has(p.lang)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, p.path), "utf8");
    } catch {
      continue; // файл исчез между индексом и вопросом — не повод падать
    }
    read++;
    if (!text.includes(name)) continue;
    const skip = defLines.get(p.path);
    let inFile = 0;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (skip?.has(i + 1) === true) continue;
      word.lastIndex = 0;
      inFile += (lines[i]!.match(word) ?? []).length;
    }
    if (inFile > 0) {
      hits += inFile;
      nFiles++;
    }
  }

  if (opts.write !== false) {
    try {
      db.query(
        `INSERT INTO code_refs (repo_id, name, n_files, n_hits, computed_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (repo_id, name) DO UPDATE SET
           n_files = excluded.n_files, n_hits = excluded.n_hits, computed_at = excluded.computed_at`,
      ).run(repoId, name, nFiles, hits, opts.now ?? Date.now());
    } catch {
      // Кеш — ускорение, а не ответ: база под чужой записью не отменяет счёт.
    }
  }
  return {
    n: hits,
    files: nFiles,
    source: "text",
    cached: false,
    read,
    tookMs: performance.now() - t0,
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

function toRef(r: RefRow): RefSite {
  return {
    path: r.path,
    line: Number(r.line),
    kind: r.kind,
    from: r.from_name,
    fromStart: Number(r.from_start),
  };
}

const SQL_REFS_TO = `SELECT path, line, kind, from_name, from_start FROM code_ref_sites
  WHERE repo_id = ?1 AND name = ?2
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
  repoId: string,
  name: string,
  opts: { readonly kinds?: readonly string[] } = {},
): RefSite[] {
  const rows = (db.query(SQL_REFS_TO).all(repoId, name) as RefRow[]).map(toRef);
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
  repoId: string,
  name: string,
): Array<RefSite & { readonly name: string }> {
  const out: Array<RefSite & { readonly name: string }> = [];
  const q = db.query(
    `SELECT path, line, name, kind, from_name, from_start FROM code_ref_sites
     WHERE repo_id = ?1 AND path = ?2 AND from_start = ?3 ORDER BY line`,
  );
  for (const d of symbolDefs(db, repoId, name)) {
    const rows = q.all(repoId, d.path, d.spanStart) as Array<RefRow & { name: string }>;
    for (const r of rows) {
      if (r.from_name !== name) continue; // чужой символ, начавшийся на той же строке
      out.push({ ...toRef(r), name: r.name });
    }
  }
  return out;
}

/**
 * Сколько ссылок индекс вообще знает по репозиторию. Нужен там же, где
 * `indexScope`: пустая выдача `callers` обязана уметь отличить «никто не
 * зовёт» от «ссылки ещё не построены» (§6.3).
 */
export function refsIndexed(db: Database, repoId: string): number {
  const r = db
    .query("SELECT count(*) AS n FROM code_ref_sites WHERE repo_id = ?1")
    .get(repoId) as { n: number };
  return Number(r.n);
}
