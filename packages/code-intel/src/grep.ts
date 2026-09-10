/**
 * ИСЧЕРПЫВАЮЩИЙ ПОИСК ЛИТЕРАЛА — тот самый откат, которого у myc не было
 * вовсе (memory-5nvk1hwcene2).
 *
 * ЧЕМ ОН ОТЛИЧАЕТСЯ ОТ ВСЕГО ОСТАЛЬНОГО В КОД-ИНТЕЛЛЕКТЕ. `code symbol`,
 * `callers`, `code search` — все они спрашивают ИНДЕКС, и потому находят
 * ровно то, что индекс успел разобрать: имя в позиции ссылки, определение,
 * единицу корпуса. Литерал в строковой константе, кусок SQL, имя поля в
 * JSON, ключ в конфиге — ничего этого в индексе нет и не будет. Ранжированный
 * поиск такой вопрос тоже не закрывает: там ответ ЛУЧШИЙ, а нужен ПОЛНЫЙ.
 *
 * ПОЭТОМУ ЗДЕСЬ ЧИТАЮТСЯ ФАЙЛЫ, А НЕ БАЗА, и это главное решение модуля.
 * Индекс участвует ровно одним: он даёт СПИСОК файлов (`code_files`) — то
 * есть те же правила исключения каталогов, что у самой индексации, и ту же
 * границу репозитория. Всё остальное — чтение с диска, поэтому выдача не
 * может отстать от кода: она и есть код. Цена названа замером: 834 файла,
 * 63 МБ — 140-330 мс на литерал. У `graft grep` на этом же репозитории
 * 170-280 мс, и он ищет по своему индексу, то есть по 424 файлам вместо 834.
 *
 * ВЛАДЕЛЕЦ СТРОКИ — то, что отличает ответ от `grep -n`. Каждое вхождение
 * относится к охватывающему определению из `code_defs` (самый тесный спан,
 * содержащий строку), и выдача группируется по нему. Без этого список
 * вхождений остаётся списком строк; с ним видно, ЧТО именно придётся править.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

export interface GrepHit {
  readonly line: number;
  /** Строка целиком, обрезанная по потолку ширины. */
  readonly text: string;
  /** Сколько раз литерал встретился в этой строке. */
  readonly count: number;
}

export interface GrepGroup {
  readonly path: string;
  readonly lang: string;
  /** Имя охватывающего определения; "" — верхний уровень файла. */
  readonly symbol: string;
  readonly kind: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  readonly hits: readonly GrepHit[];
}

export interface GrepResult {
  readonly literal: string;
  readonly groups: readonly GrepGroup[];
  readonly files: number;
  readonly hits: number;
  /** Файлов просмотрено — знаменатель честности «искали везде». */
  readonly searched: number;
  /** Файлов пропущено по потолку размера, с именами: молчать о них нельзя. */
  readonly skipped: readonly { readonly path: string; readonly bytes: number }[];
  /** Файлов, которых нет на диске (индекс отстал). */
  readonly missing: number;
  readonly truncated: boolean;
  readonly tookMs: number;
}

export interface GrepOptions {
  readonly ignoreCase?: boolean;
  /** Только эти языки (расширения без точки). Пусто — все файлы индекса. */
  readonly langs?: readonly string[];
  /** Потолок групп в выдаче; вхождения считаются все и без потолка. */
  readonly limit?: number;
  /** Файлы крупнее — пропускаются и НАЗЫВАЮТСЯ. */
  readonly maxFileBytes?: number;
  readonly maxLineChars?: number;
}

const DEFAULT_LIMIT = 60;
/**
 * Потолок размера файла. 2 МБ — это `bun.lock` и минифицированные бандлы:
 * литерал в них есть почти всегда и не значит ничего. Пропуск не молчаливый:
 * пропущенные файлы возвращаются поимённо (И2).
 */
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_LINE_CHARS = 240;

const SQL_FILES = `SELECT path, lang, size_bytes FROM code_files WHERE repo_id = ?1 ORDER BY path`;
const SQL_DEFS = `SELECT path, name, kind, span_start, span_end FROM code_defs
  WHERE repo_id = ?1 ORDER BY path, span_start`;

interface OwnerDef {
  name: string;
  kind: string;
  s: number;
  e: number;
}

/** Самый ТЕСНЫЙ спан, накрывший строку: метод, а не класс, в котором он лежит. */
function ownerOf(defs: readonly OwnerDef[] | undefined, line: number): OwnerDef | null {
  if (defs === undefined) return null;
  let best: OwnerDef | null = null;
  for (const d of defs) {
    if (d.s > line) break;
    if (d.e < line) continue;
    if (best === null || d.e - d.s <= best.e - best.s) best = d;
  }
  return best;
}

export function grepCode(
  db: Database,
  repoId: string,
  repoRoot: string,
  literal: string,
  opts: GrepOptions = {},
): GrepResult {
  const t0 = performance.now();
  const limit = Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT));
  const maxBytes = Math.max(1, Math.floor(opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  const maxLine = Math.max(20, Math.floor(opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS));
  const wanted = opts.langs === undefined || opts.langs.length === 0 ? null : new Set(opts.langs);
  const needle = opts.ignoreCase === true ? literal.toLowerCase() : literal;

  const defsByPath = new Map<string, OwnerDef[]>();
  for (const d of db.query(SQL_DEFS).all(repoId) as Array<{
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

  const groups: GrepGroup[] = [];
  const skipped: { path: string; bytes: number }[] = [];
  let files = 0;
  let hits = 0;
  let searched = 0;
  let missing = 0;

  for (const f of db.query(SQL_FILES).all(repoId) as Array<{
    path: string;
    lang: string;
    size_bytes: number;
  }>) {
    if (wanted !== null && !wanted.has(f.lang)) continue;
    if (f.size_bytes > maxBytes) {
      skipped.push({ path: f.path, bytes: f.size_bytes });
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(repoRoot, f.path), "utf8");
    } catch {
      missing++;
      continue;
    }
    searched++;
    const hay = opts.ignoreCase === true ? text.toLowerCase() : text;
    if (!hay.includes(needle)) continue;
    files++;
    // Строки режутся ОДИН раз на файл, а не на каждое вхождение: файл в
    // мегабайт и сотня вхождений иначе стоили бы сотню разрезаний.
    const lines = text.split("\n");
    const hayLines = opts.ignoreCase === true ? hay.split("\n") : lines;
    const perOwner = new Map<string, GrepGroup & { hits: GrepHit[] }>();
    for (let i = 0; i < hayLines.length; i++) {
      const hl = hayLines[i] ?? "";
      let count = 0;
      let at = hl.indexOf(needle);
      while (at >= 0) {
        count++;
        at = hl.indexOf(needle, at + needle.length);
      }
      if (count === 0) continue;
      hits += count;
      const line = i + 1;
      const owner = ownerOf(defsByPath.get(f.path), line);
      const key = owner === null ? "" : `${owner.name} ${owner.s}`;
      let g = perOwner.get(key);
      if (g === undefined) {
        g = {
          path: f.path,
          lang: f.lang,
          symbol: owner?.name ?? "",
          kind: owner?.kind ?? "",
          spanStart: owner?.s ?? 0,
          spanEnd: owner?.e ?? lines.length,
          hits: [],
        };
        perOwner.set(key, g);
      }
      const raw = (lines[i] ?? "").trim();
      g.hits.push({
        line,
        text: raw.length > maxLine ? `${raw.slice(0, maxLine - 1)}...` : raw,
        count,
      });
    }
    for (const g of perOwner.values()) groups.push(g);
  }

  groups.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.spanStart - b.spanStart));
  const truncated = groups.length > limit;
  return {
    literal,
    groups: truncated ? groups.slice(0, limit) : groups,
    files,
    hits,
    searched,
    skipped,
    missing,
    truncated,
    tookMs: performance.now() - t0,
  };
}
