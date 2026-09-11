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
 * есть те же правила исключения, что у самой индексации (перечень git с
 * .gitignore, SKIP_DIRS поверх, см. `listFiles`), и ту же границу
 * репозитория. Дерево здесь НЕ обходится: собственный обход мимо реестра
 * вернул бы в выдачу игнорируемое — тестовые ключи, данные, кеши, — ровно
 * то, что перечень отсёк. Всё остальное — чтение с диска, поэтому выдача не
 * может отстать от кода: она и есть код. Цена названа замером: 834 файла,
 * 63 МБ — 140-330 мс на литерал. У `graft grep` на этом же репозитории
 * 170-280 мс, и он ищет по своему индексу, то есть по 424 файлам вместо 834.
 *
 * ВЛАДЕЛЕЦ СТРОКИ — то, что отличает ответ от `grep -n`. Каждое вхождение
 * относится к охватывающему определению из `code_defs` (самый тесный спан,
 * содержащий строку), и выдача группируется по нему. Без этого список
 * вхождений остаётся списком строк; с ним видно, ЧТО именно придётся править.
 *
 * ОБЛАСТЬ (`--in`, memory-3jkvs7g5hkdw) — то, что было у `graft grep` для
 * монорепо. Путь считается ОТ КОРНЯ РЕПОЗИТОРИЯ, как у `myc skeleton` и как
 * пути в самой выдаче: скопированное из ответа вставляется обратно без правки,
 * а у инструмента MCP, у которого нет «текущего каталога», тот же вопрос
 * значит то же самое. Область называется в ответе: ответ, суженный молча,
 * читался бы как ответ про весь репозиторий. Путь, которого нет, путь за
 * корнем и путь, под которым нет ни одного файла реестра, — отказы, а не
 * «0 вхождений»: пустой успех там был бы неправдой (И2).
 *
 * БИНАРНЫЕ ФАЙЛЫ пропускаются по СОДЕРЖИМОМУ, а не по расширению — признак
 * git: NUL в первых 8000 байтах (xdiff FIRST_FEW_BYTES). Реестр `code_files`
 * — это перечень файлов, а не список исходников: в нём бывают отслеживаемые
 * картинки, шрифты, архивы (а в не-git дереве — всё подряд); их «строки» в
 * выдаче — мусор.
 * Пропуск считается и называется числом, как пропуск по размеру. Файл и так
 * читается целиком, поэтому признак — один memchr по уже прочитанному буферу.
 *
 * СЕКРЕТНЫЕ ПО ИМЕНИ ФАЙЛЫ (`.env`, ключи, учётные данные — `secret-paths.ts`)
 * не читаются ни в каком режиме (memory-wpr1x91jp8fm). В реестр их не кладёт
 * перечень; явный `--in` на такой файл — отказ `denied.secret`, до чтения; а
 * строка, оставшаяся в реестре, собранном до запрета, пропускается, пока
 * ближайший `code index` её не удалит.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Database } from "bun:sqlite";
import { isSecretPath, SECRET_NAMES_LABEL } from "./secret-paths.ts";

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
  /** Файлов пропущено как бинарные (NUL в начале) — в `searched` не входят. */
  readonly binary: number;
  /** Файлов, которых нет на диске (индекс отстал). */
  readonly missing: number;
  /** Область, к которой ответ СУЖЕН (метки `GrepScope.label`); null — весь репозиторий. */
  readonly scope: readonly string[] | null;
  readonly truncated: boolean;
  readonly tookMs: number;
}

/** Одна область `--in`, уже проверенная `resolveGrepScope`. */
export interface GrepScope {
  /** Как область названа в ответе: каталог — со слэшем на конце, корень — ".". */
  readonly label: string;
  /** Путь файла — точно; каталог — префикс со слэшем; "" — весь репозиторий. */
  readonly path: string;
  readonly dir: boolean;
}

export interface GrepOptions {
  readonly ignoreCase?: boolean;
  /** Только эти языки (расширения без точки). Пусто — все файлы индекса. */
  readonly langs?: readonly string[];
  /** Только под этими путями (объединение). Пусто — весь репозиторий. */
  readonly scopes?: readonly GrepScope[];
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
/** Окно признака «бинарный» — ровно git (xdiff-interface.c, FIRST_FEW_BYTES). */
export const BINARY_PROBE_BYTES = 8000;

const SQL_FILES = `SELECT path, lang, size_bytes FROM code_files WHERE repo_id = ?1 ORDER BY path`;
const SQL_PATHS = `SELECT path FROM code_files WHERE repo_id = ?1`;
const SQL_DEFS = `SELECT path, name, kind, span_start, span_end FROM code_defs
  WHERE repo_id = ?1 ORDER BY path, span_start`;

/** NUL в первых BINARY_PROBE_BYTES байтах — признак git, не расширение имени. */
export function looksBinary(buf: Uint8Array): boolean {
  return buf.subarray(0, BINARY_PROBE_BYTES).indexOf(0) !== -1;
}

function inScope(path: string, scopes: readonly GrepScope[]): boolean {
  for (const s of scopes) {
    if (s.dir ? path.startsWith(s.path) : path === s.path) return true;
  }
  return false;
}

export type GrepScopeRefusal = {
  readonly ok: false;
  readonly code: "usage.invalid" | "usage.outside_repo" | "notfound.path" | "notfound.scope" | "denied.secret";
  readonly msg: string;
  readonly hint?: string;
};

/**
 * Разбор `--in`: пути от корня репозитория → области поиска, или ОТКАЗ.
 *
 * Отказов четыре, и ни один не превращается в пустой ответ: нет пути
 * (`notfound.path`); путь за корнем (`usage.outside_repo`, как у `anchor
 * add`); путь есть, но под ним нет ни одного файла реестра — индекс туда не
 * заходит (node_modules, .git) или отстал (`notfound.scope`): «0 вхождений»
 * там значило бы «не искали»; пустой `--in` (`usage.invalid`). Путь, под
 * которым файлы реестра есть, а вхождений нет, — обычный пустой ответ.
 * Пятый отказ — файл с секретным именем (`denied.secret`): он решается по
 * имени, до реестра и без чтения файла, чтобы устаревший реестр, ещё
 * держащий `.env`, не открыл его явным путём.
 *
 * `cwd` нужен только подсказке: из подкаталога легко написать путь от себя, а
 * не от корня, и отказ тогда называет, как было бы правильно.
 */
export function resolveGrepScope(
  db: Database,
  repoId: string,
  repoRoot: string,
  inputs: readonly string[],
  cwd?: string,
): { readonly ok: true; readonly scopes: readonly GrepScope[] } | GrepScopeRefusal {
  const wanted = inputs.map((x) => x.trim()).filter((x) => x.length > 0);
  if (wanted.length === 0) {
    return { ok: false, code: "usage.invalid", msg: "--in without a path: give a path from the repo root" };
  }
  const toRel = (abs: string): string => relative(repoRoot, abs).split(sep).join("/");
  const outside = (rel: string): boolean => rel === ".." || rel.startsWith("../") || isAbsolute(rel);
  let registry: string[] | null = null;
  const scopes: GrepScope[] = [];
  for (const input of wanted) {
    const posix = input.replaceAll("\\", "/");
    const abs = isAbsolute(posix) ? posix : resolve(repoRoot, posix);
    const rel = toRel(abs);
    if (outside(rel)) {
      return {
        ok: false,
        code: "usage.outside_repo",
        msg: `--in ${input}: the path leads outside the repo root — search works only inside it`,
      };
    }
    let dir: boolean;
    try {
      dir = statSync(abs).isDirectory();
    } catch {
      let hint = "the path is relative to the repo root — the same as paths in grep output";
      if (cwd !== undefined && !isAbsolute(posix)) {
        const fromCwd = toRel(resolve(cwd, posix));
        if (fromCwd !== rel && !outside(fromCwd) && fromCwd.length > 0) {
          try {
            statSync(join(repoRoot, fromCwd));
            hint += `; from the current directory that is --in ${fromCwd}`;
          } catch {
            // и от текущего каталога такого пути нет — подсказать нечего
          }
        }
      }
      return { ok: false, code: "notfound.path", msg: `--in ${input}: no such path in the repo`, hint };
    }
    if (!dir && isSecretPath(rel)) {
      return {
        ok: false,
        code: "denied.secret",
        msg: `--in ${input}: a secret-named file — code grep never reads it, and the index never lists it`,
        hint: `secret-named files: ${SECRET_NAMES_LABEL}`,
      };
    }
    const path = dir ? (rel.length === 0 ? "" : `${rel}/`) : rel;
    const scope: GrepScope = { label: dir ? (rel.length === 0 ? "." : `${rel}/`) : rel, path, dir };
    registry ??= (db.query(SQL_PATHS).all(repoId) as Array<{ path: string }>).map((r) => r.path);
    if (!registry.some((p) => inScope(p, [scope]) && !isSecretPath(p))) {
      return {
        ok: false,
        code: "notfound.scope",
        msg: dir
          ? `--in ${input}: the directory exists, but the file registry has no files under it — nothing to search there`
          : `--in ${input}: the file exists, but it is not in the file registry — nothing to search`,
        hint:
          "the index skips files git ignores, secret-named files (.env, keys, credentials), " +
          "and node_modules, .git, dist and the like; for new files run myc code index",
      };
    }
    if (!scopes.some((s) => s.path === scope.path)) scopes.push(scope);
  }
  return { ok: true, scopes };
}

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
  const scopes = opts.scopes === undefined || opts.scopes.length === 0 ? null : opts.scopes;
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
  let binary = 0;
  let missing = 0;

  for (const f of db.query(SQL_FILES).all(repoId) as Array<{
    path: string;
    lang: string;
    size_bytes: number;
  }>) {
    // Реестр, собранный до запрета, может ещё держать секретный файл — до
    // ближайшего `code index`, который строку удалит. Читать его нельзя и тогда.
    if (isSecretPath(f.path)) continue;
    // Область — до потолка размера: файл вне области не «пропущен», его не спрашивали.
    if (scopes !== null && !inScope(f.path, scopes)) continue;
    if (wanted !== null && !wanted.has(f.lang)) continue;
    if (f.size_bytes > maxBytes) {
      skipped.push({ path: f.path, bytes: f.size_bytes });
      continue;
    }
    let buf: Buffer;
    try {
      buf = readFileSync(join(repoRoot, f.path));
    } catch {
      missing++;
      continue;
    }
    if (looksBinary(buf)) {
      binary++;
      continue;
    }
    const text = buf.toString("utf8");
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
    binary,
    missing,
    scope: scopes === null ? null : scopes.map((s) => s.label),
    truncated,
    tookMs: performance.now() - t0,
  };
}
