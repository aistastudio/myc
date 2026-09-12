/**
 * FAN_IN СЧИТАЕТСЯ В ФОНЕ И ХРАНИТСЯ ЧИСЛОМ (memory-g79mpkt53yn3, решение S9).
 *
 * ЗАЧЕМ. Отпечаток задачи в рое (M5, `04` §2.1.4) хотел `callers` символа с
 * таймаутом 2 мс — при цене вызова от 40 мс это невыполнимо, и S9 решил:
 * число считает L1 в фоне, потребитель читает готовое. До этого модуля
 * `fan_in` считался ПО ЗАПРОСУ в `myc code symbol` (проход по всему L1-корпусу,
 * ~90 мс на этом репозитории) и кешировался в `code_refs` до инвалидации, —
 * то есть «ноль внешних вызовов при чтении» было правдой только для второго
 * спросившего.
 *
 * ГДЕ ХРАНИТСЯ. В той же `code_refs (repo_id, name, n_files, n_hits,
 * computed_at)` (миграция 005), ключом `refsCacheKey` вида: корень индекса и
 * каждая часть вложенного репозитория (`view.ts`). Новой колонки нет, и это
 * выбор, а не экономия: колонка `anchors.fan_in` из T5 требовала бы миграции
 * ОСНОВНОЙ схемы — база cherry открывается и сборками 0.3.8, а они на
 * `schema.newer` отказываются работать; и число у якоря пришлось бы
 * переписывать при каждом переезде якоря, хотя fan_in — свойство символа, а
 * не места. Потребитель берёт число поиском по первичному ключу
 * (`storedFanIn` в `read.ts`) — одно чтение, ни одного файла.
 *
 * КОГДА СЧИТАЕТСЯ. В конце прогона индекса (`myc code index` и фоновый
 * `code index --job` из `code_refresh`, `commands/code.ts` → `indexPass`) —
 * если хоть одному определённому имени индекса не хватает строки. Строк не
 * хватает ровно тогда, когда индекс изменился: разбор изменённого файла, скан
 * с удалёнными и сменившими язык файлами снимают ВСЕ строки индекса
 * (`invalidateRefs`, `code_index.ts`) в той же транзакции, что и запись.
 * Отсюда durability без отдельного флага: процесс, умерший между разбором и
 * пересчётом, оставляет строки снятыми, и следующий прогон — даже без единого
 * изменения в дереве — досчитает. Индекс, собранный старой сборкой (у неё
 * строки появлялись только от вопросов), досчитывается так же.
 *
 * ПОЧЕМУ ВСЕ ИМЕНА, А НЕ ТОЛЬКО ТЕ, ЧЬИ УПОМИНАНИЯ ИЗМЕНИЛИСЬ. Счёт текстовый:
 * `\bNAME\b` ловит и комментарии, и строки, а индекс хранит только
 * синтаксические вхождения (`code_ref_sites`). Имя, упомянутое лишь в
 * комментарии старой версии файла, из нынешнего индекса не восстановить —
 * старого текста нет ни на диске, ни в базе, — и «пересчитать изменённые»
 * молча оставило бы его число завышенным. Точный инкремент требовал бы
 * хранить счёт по (файл, имя) — ещё одна таблица на сотни тысяч строк и та же
 * миграция. А полный пересчёт стоит не дороже частичного: цена — прочитать и
 * разбить на слова весь L1-корпус, а сколько имён при этом сверять со
 * словарём, почти не важно. Замер на этом репозитории (504 L1-файла, 7.2 МБ,
 * 3984 имени, p50 из 7): чтение 13 мс, счёт 70 мс, запись 5 мс — 92 мс;
 * проверка «все строки на месте» у прогона без изменений — 3 мс. Прежний
 * вопрос `code symbol` без кеша стоил 13–64 мс на ОДНО имя (0.3.8 на той же
 * базе), то есть все имена разом — как два-три прежних вопроса.
 *
 * СЕМАНТИКА ЧИСЛА — прежняя, байт в байт (тест сверяет с прежним счётом по
 * регулярке): вхождения `\bNAME\b` в L1-файлах индекса минус строки, где
 * начинаются определения этого же имени в этом же файле. Для имени из
 * символов `[A-Za-z0-9_]` вхождение `\bNAME\b` — это ровно отрезок слова,
 * равный имени, поэтому хватает одного прохода по словам; имена с другими
 * символами (`$`, не-ASCII) считаются прежней регуляркой.
 *
 * ГОНКА С СОСЕДОМ. Пересчёт читает файлы вне транзакции. Если за это время
 * другой процесс переразобрал файл (и снял строки), записать своё значило бы
 * положить число по СТАРОМУ тексту поверх индекса, который уже новый, — и
 * больше его никто не снимет. Поэтому до чтения ставится метка (строка
 * `FAN_IN_RECOUNT_MARK` под ключом индекса), а запись идёт, только если метка
 * дожила: `invalidateRefs` соседа сносит её вместе со всеми строками индекса —
 * в том числе у сборок, которые о метке не знают. Не дожила — ничего не
 * пишется, досчитает прогон соседа или следующий.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { L1_LANGS } from "./langs.ts";
import { prefixEnd, refsCacheKey, REFS_VIEW_SEP } from "./view.ts";

/**
 * Имя строки-метки пересчёта. С пробелом: идентификатор с пробелом не
 * бывает ни в одном языке L1, так что с именем символа метка не совпадёт, а
 * читатель по (repo_id, name) её не найдёт никогда.
 */
export const FAN_IN_RECOUNT_MARK = " fan_in recount";

export interface FanInRecountOptions {
  /** `repo_id` индекса (как у `code_files`). */
  readonly repoId: string;
  /** Корень индекса на диске — от него пути `code_files`. */
  readonly root: string;
  /**
   * Вложенные репозитории индекса — пути от `root` (`scan.gitRepos`; `.`
   * пропускается). Каждый даёт ключ вида `refsCacheKey({repoId, prefix})`:
   * из вложенного репозитория `code symbol` спрашивает счёт по ЕГО части.
   * Каталоги первого уровня с `.git` добавляются сами — у прогона части
   * (`subtree`) перечень знает только свою часть, а снимаются ключи всех.
   */
  readonly parts?: readonly string[];
  readonly now?: number;
  /** Пересчитать, даже если все строки на месте (замер, ручная сверка). */
  readonly force?: boolean;
  /**
   * Точка между чтением файлов и записью — для теста гонки. В продукте не
   * задаётся.
   */
  readonly beforeWrite?: () => void;
}

export interface FanInRecount {
  /** Был ли пересчёт (false — все строки на месте или соседу помешали). */
  readonly ran: boolean;
  /**
   * complete — у каждого определённого имени строка есть, читать нечего;
   * missing — строк не хватало, посчитано и записано;
   * forced — посчитано по `force`;
   * raced — пока читали файлы, индекс сменился: ничего не записано.
   */
  readonly reason: "complete" | "missing" | "forced" | "raced";
  /** Сколько пар (ключ, имя) было без строки до пересчёта. */
  readonly missing: number;
  /** Определённых имён в индексе. */
  readonly names: number;
  /** Ключей записано: корень плюс части. */
  readonly keys: number;
  /** Строк записано. */
  readonly rows: number;
  /** L1-файлов прочитано и их размер. */
  readonly files: number;
  readonly bytes: number;
  readonly readMs: number;
  readonly countMs: number;
  readonly writeMs: number;
  readonly tookMs: number;
}

/** Слово в смысле `\b` у регулярки без флага `u`: [A-Za-z0-9_]. */
const WORD_NAME = /^[A-Za-z0-9_]+$/;

function isWordCode(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

/**
 * Каждый отрезок слова текста, который есть в словаре, — +1 в `into`.
 * Проход по кодам символов, без регулярки: на 7 МБ это 40 мс против 47 у
 * `exec` и не создаёт строки для отрезков, которые короче самого короткого
 * имени (их в коде большинство — `i`, `a`, `x`).
 */
function countWords(text: string, dict: ReadonlySet<string>, into: Map<string, number>, minLen: number): void {
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (!isWordCode(text.charCodeAt(i))) {
      i++;
      continue;
    }
    const s = i++;
    while (i < n && isWordCode(text.charCodeAt(i))) i++;
    if (i - s < minLen) continue;
    const w = text.slice(s, i);
    if (dict.has(w)) into.set(w, (into.get(w) ?? 0) + 1);
  }
}

function escapeRe(name: string): RegExp {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
}

/** Вхождения имени в строке — тем же правилом, что и в тексте. */
function countIn(line: string, name: string): number {
  if (WORD_NAME.test(name)) {
    const m = new Map<string, number>();
    countWords(line, new Set([name]), m, name.length);
    return m.get(name) ?? 0;
  }
  return (line.match(escapeRe(name)) ?? []).length;
}

interface View {
  readonly prefix: string;
  readonly key: string;
  /** Имена, определённые в этой части. */
  readonly names: Set<string>;
  readonly totals: Map<string, { files: number; hits: number }>;
}

/**
 * Префиксы частей: переданные прогоном плюс каталоги первого уровня с `.git`
 * (файл или каталог — worktree в индекс не попадают, `langs.ts`).
 */
function partPrefixes(root: string, parts: readonly string[], paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of parts) {
    const clean = p.replace(/^\/+|\/+$/g, "");
    if (clean.length > 0 && clean !== ".") out.add(`${clean}/`);
  }
  const seen = new Set<string>();
  for (const p of paths) {
    const i = p.indexOf("/");
    if (i <= 0) continue;
    const top = p.slice(0, i);
    if (seen.has(top)) continue;
    seen.add(top);
    if (existsSync(join(root, top, ".git"))) out.add(`${top}/`);
  }
  return [...out].sort();
}

const SQL_FILES = "SELECT path, lang FROM code_files WHERE repo_id = ?1";
const SQL_DEFS = "SELECT path, name, span_start FROM code_defs WHERE repo_id = ?1";
/**
 * Сколько определённых имён ключа без строки. Скан `code_defs` по `repo_id`
 * (тысячи строк) и поиск по первичному ключу `code_refs` на каждое — единицы
 * миллисекунд, и только в прогоне индекса, не в горячем пути.
 */
const SQL_MISSING = `SELECT count(*) AS n FROM (SELECT DISTINCT name FROM code_defs WHERE repo_id = ?1) d
  WHERE NOT EXISTS (SELECT 1 FROM code_refs r WHERE r.repo_id = ?2 AND r.name = d.name)`;
const SQL_MISSING_IN = `SELECT count(*) AS n FROM (SELECT DISTINCT name FROM code_defs WHERE repo_id = ?1 AND path >= ?3 AND path < ?4) d
  WHERE NOT EXISTS (SELECT 1 FROM code_refs r WHERE r.repo_id = ?2 AND r.name = d.name)`;

/** Пар (ключ, имя) без строки по индексу `repoId` и его частям. */
export function missingFanIn(db: Database, repoId: string, prefixes: readonly string[]): number {
  let n = Number((db.query(SQL_MISSING).get(repoId, repoId) as { n: number }).n);
  for (const p of prefixes) {
    const key = refsCacheKey({ repoId, prefix: p });
    n += Number((db.query(SQL_MISSING_IN).get(repoId, key, p, prefixEnd(p)) as { n: number }).n);
  }
  return n;
}

/**
 * Пересчитать `fan_in` всех определённых имён индекса и его частей, если
 * хоть одной строки не хватает (или `force`). См. шапку модуля.
 */
export function recountFanIn(db: Database, opts: FanInRecountOptions): FanInRecount {
  const t0 = performance.now();
  const { repoId, root } = opts;
  const now = opts.now ?? Date.now();

  const files = (db.query(SQL_FILES).all(repoId) as Array<{ path: string; lang: string }>).filter((f) =>
    L1_LANGS.has(f.lang),
  );
  const prefixes = partPrefixes(root, opts.parts ?? [], files.map((f) => f.path));
  const missing = missingFanIn(db, repoId, prefixes);
  const idle = (reason: FanInRecount["reason"], names = 0): FanInRecount => ({
    ran: false,
    reason,
    missing,
    names,
    keys: 0,
    rows: 0,
    files: 0,
    bytes: 0,
    readMs: 0,
    countMs: 0,
    writeMs: 0,
    tookMs: performance.now() - t0,
  });
  if (missing === 0 && opts.force !== true) return idle("complete");

  // Метка — ДО чтения файлов: всё, что переразберут после неё, её снесёт.
  const token = Math.floor(Math.random() * 2 ** 31);
  db.query(
    `INSERT INTO code_refs (repo_id, name, n_files, n_hits, computed_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT (repo_id, name) DO UPDATE SET n_files = excluded.n_files, n_hits = excluded.n_hits,
       computed_at = excluded.computed_at`,
  ).run(repoId, FAN_IN_RECOUNT_MARK, process.pid, token, now);

  const all = new Set<string>();
  /** path → строка начала определения → имена, чьи определения там начинаются. */
  const defLines = new Map<string, Map<number, Set<string>>>();
  const views: View[] = prefixes.map((prefix) => ({
    prefix,
    key: refsCacheKey({ repoId, prefix }),
    names: new Set<string>(),
    totals: new Map(),
  }));
  for (const d of db.query(SQL_DEFS).all(repoId) as Array<{ path: string; name: string; span_start: number }>) {
    all.add(d.name);
    let byLine = defLines.get(d.path);
    if (byLine === undefined) defLines.set(d.path, (byLine = new Map()));
    let ns = byLine.get(d.span_start);
    if (ns === undefined) byLine.set(d.span_start, (ns = new Set()));
    ns.add(d.name);
    for (const v of views) if (d.path.startsWith(v.prefix)) v.names.add(d.name);
  }
  const words = new Set<string>();
  /** Имена вне `[A-Za-z0-9_]` (`#private`, `$`, не-ASCII) — прежней регуляркой, собранной один раз. */
  const odd: Array<{ name: string; re: RegExp }> = [];
  let minLen = Number.POSITIVE_INFINITY;
  for (const name of all) {
    if (WORD_NAME.test(name)) {
      words.add(name);
      minLen = Math.min(minLen, name.length);
    } else odd.push({ name, re: escapeRe(name) });
  }

  const totals = new Map<string, { files: number; hits: number }>();
  const add = (into: Map<string, { files: number; hits: number }>, name: string, c: number): void => {
    const t = into.get(name);
    if (t === undefined) into.set(name, { files: 1, hits: c });
    else {
      t.files++;
      t.hits += c;
    }
  };

  let read = 0;
  let bytes = 0;
  let readMs = 0;
  let countMs = 0;
  for (const f of files) {
    const r0 = performance.now();
    let text: string;
    try {
      text = readFileSync(join(root, f.path), "utf8");
    } catch {
      continue; // файл исчез между индексом и пересчётом — его снимет следующий скан
    }
    const c0 = performance.now();
    readMs += c0 - r0;
    read++;
    bytes += text.length;
    const per = new Map<string, number>();
    if (words.size > 0) countWords(text, words, per, minLen);
    for (const { name, re } of odd) {
      if (!text.includes(name)) continue;
      const c = (text.match(re) ?? []).length; // `match` с флагом g сам сбрасывает lastIndex
      if (c > 0) per.set(name, c);
    }
    // Строка, где начинается определение имени, — не входящая ссылка: её
    // вхождения этого имени вычитаются (все, как у прежнего счёта).
    const byLine = defLines.get(f.path);
    if (byLine !== undefined) {
      // Нужны только строки определений — идём по переводам строк до них, не
      // разрезая весь файл на массив строк.
      let line = 1;
      let pos = 0;
      for (const target of [...byLine.keys()].sort((a, b) => a - b)) {
        while (line < target) {
          const nl = text.indexOf("\n", pos);
          if (nl === -1) break;
          pos = nl + 1;
          line++;
        }
        if (line !== target) break; // определение за концом файла — индекс старше диска
        const nl = text.indexOf("\n", pos);
        const at = text.slice(pos, nl === -1 ? text.length : nl);
        for (const name of byLine.get(target)!) {
          const had = per.get(name);
          if (had === undefined) continue;
          const c = countIn(at, name);
          if (c > 0) per.set(name, had - c);
        }
      }
    }
    for (const [name, c] of per) {
      if (c <= 0) continue;
      add(totals, name, c);
      for (const v of views) if (f.path.startsWith(v.prefix) && v.names.has(name)) add(v.totals, name, c);
    }
    countMs += performance.now() - c0;
  }

  opts.beforeWrite?.();

  const w0 = performance.now();
  let rows = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const mark = db
      .query("SELECT n_files, n_hits FROM code_refs WHERE repo_id = ?1 AND name = ?2")
      .get(repoId, FAN_IN_RECOUNT_MARK) as { n_files: number; n_hits: number } | null;
    if (mark === null || Number(mark.n_files) !== process.pid || Number(mark.n_hits) !== token) {
      db.exec("ROLLBACK");
      return { ...idle("raced", all.size), files: read, bytes, readMs, countMs };
    }
    // Замена ЦЕЛИКОМ, тем же отрезком ключей, что снимает `invalidateRefs`:
    // строка имени, которого больше нет, не переживает пересчёт, метка — тоже.
    db.query("DELETE FROM code_refs WHERE repo_id = ?1").run(repoId);
    const lo = `${repoId}${REFS_VIEW_SEP}`;
    db.query("DELETE FROM code_refs WHERE repo_id >= ?1 AND repo_id < ?2").run(lo, prefixEnd(lo));
    const ins = db.query(
      "INSERT INTO code_refs (repo_id, name, n_files, n_hits, computed_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    );
    for (const name of all) {
      const t = totals.get(name);
      ins.run(repoId, name, t?.files ?? 0, t?.hits ?? 0, now);
      rows++;
    }
    for (const v of views) {
      for (const name of v.names) {
        const t = v.totals.get(name);
        ins.run(v.key, name, t?.files ?? 0, t?.hits ?? 0, now);
        rows++;
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  const writeMs = performance.now() - w0;
  return {
    ran: true,
    reason: missing === 0 ? "forced" : "missing",
    missing,
    names: all.size,
    keys: 1 + views.length,
    rows,
    files: read,
    bytes,
    readMs,
    countMs,
    writeMs,
    tookMs: performance.now() - t0,
  };
}
