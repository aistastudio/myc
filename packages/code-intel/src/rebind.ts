/**
 * СТУПЕНЬ 3 РЕ-ПРИВЯЗКИ (docs/design/01-core-data-model.md §7.3,
 * memory-5c03r9t5n472): код переехал в ДРУГОЙ файл — функцию вынесли,
 * файл переименовали, модуль разбили.
 *
 * ПОЧЕМУ НЕ graft. По спеке кандидатов давал `graft grep/ask`, но graft из
 * проекта снят (эпик memory-x20k85amw3z9), и ступень 3 была мертва: якорь,
 * чей код уехал в соседний файл, получал `stale` и оставался им навсегда.
 * Всё, что спрашивалось у graft, теперь лежит в той же базе: `code_files`
 * (реестр с хешами), `code_units` + `code_fts` (корпус определений и шапок).
 * Внешнего процесса нет, таймаута 200 мс и лимита вызовов §7.4 — тоже; цена
 * — несколько индексных запросов и чтение до пяти файлов, и платит её только
 * фон (`myc anchor check` и дренаж), никогда — `touch`, `of`, `show`, `prime`.
 *
 * КАНДИДАТЫ — по рангу улики, не больше пяти (§7.3):
 *   0 rename — файла якоря нет, а git знает, куда он переименован (`git mv`
 *              в индексе или последний коммит, тронувший путь), или в реестре
 *              есть файл с ТЕМ ЖЕ хешем содержимого;
 *   1 symbol — определения с тем же именем в файлах, изменённых ПОСЛЕ прошлой
 *              проверки якоря. Имя — из `anchors.symbol` (его ставит привязка
 *              по индексу или пользователь), из индекса по старому спану (если
 *              индекс ещё помнит старую версию файла) и из объявления в голове
 *              crux;
 *   2 text   — слова crux по корпусу `code_fts` в тех же изменённых файлах: код
 *              уехал вместе с переименованием, и по имени его уже не найти;
 *   3, 4     — то же в файлах, которые с прошлой проверки не менялись: там
 *              живут старые дубли того же кода, а не место, куда он уехал.
 * Файл самого якоря в кандидаты не входит: в нём ступени 1–2 уже искали, и
 * порог 0.60 там строже. Пропустить его сюда с порогом 0.50 значило бы
 * тихо ослабить порог шага 2.
 *
 * ПРОВЕРКА — ОТПЕЧАТКОМ, НЕ ИМЕНЕМ. Кандидат читается с диска (не из
 * индекса: индекс мог отстать), и в нём ищется лучшее окно — точный crux
 * рядом с кандидатом и окно по отпечатку высоты span ± 40 %. Якорем становится
 * кандидат НАИМЕНЬШЕГО ранга со сходством не меньше 0.50 (порог §7.3), внутри
 * ранга — самый похожий: так в спеке («по убыванию ранга»), и замер на истории
 * это подтвердил — «лучший по сходству среди всех» уводил якорь к старым
 * дублям и случайным похожим кускам. Кандидат ТОЛЬКО по словам crux — самая
 * слабая улика: ему нужно 0.65 (`REBIND_TEXT_MIN`) и окно, которое код, а не
 * скелет шаблона (`REBIND_MIN_CODE_SHARE`). Ложная привязка хуже потери: якорь,
 * указывающий на чужой код, читается как факт, а потерянный — видно.
 *
 * `lost` ПРОТИВ `stale` — вопрос о том, ВИДЕЛ ЛИ ИНДЕКС ИЗМЕНЕНИЕ. Индекс
 * обновляется фоном раз в 15 минут; не найдя код в индексе, отстающем от
 * правки, объявить его удалённым значило бы потерять якорь навсегда (`lost`
 * фон больше не проверяет, §7.5). Поэтому:
 *   файла нет  — индекс видел удаление, если строки файла в реестре уже нет
 *                (и индекс обновлялся после привязки);
 *   файл есть  — индекс видел правку, если хеш в реестре равен хешу на диске
 *                (или строки нет, а индекс обновлялся после правки).
 * Видел и не нашёл — `lost`. Не видел — `stale`: следующий прогон после
 * обновления индекса спросит снова. Индекса нет вовсе — тоже `stale`, это
 * прямой наследник «graft недоступен» из спеки. Пока индекс не видел
 * изменения, кандидатам, кроме переименования, не верим вовсе: имена и слова
 * у него старые, и лучшим «из того, что есть» оказывается старый дубль.
 */

import type { Database } from "bun:sqlite";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type AnchorBinding,
  bestWindow,
  bindingAt,
  codeShare,
  CRUX_MAX_LINES,
  type CheckIo,
  findNormalized,
  fingerprint,
  jaccardFp,
  normalizeStream,
  realCheckIo,
  REBIND_MIN_CODE_SHARE,
  spanNormText,
} from "./anchors.ts";
import { indexFreshness, indexRepos } from "./refresh.ts";

/** Порог ре-привязки в другом файле (§7.3, таблица порогов §11). */
export const REBIND_ELSEWHERE_MIN = 0.5;

/**
 * ПОРОГ САМОЙ СЛАБОЙ УЛИКИ — кандидата, найденного только по словам crux (ранги
 * 2 и 4): ни переименования, ни имени символа за ним нет, есть лишь отпечаток.
 * Выбран замером (bench/rebind-eval.json, 77 коммитов): удалённый `grammarDir`
 * уходил по словам в grammars.ts на окно через три чужие функции со сходством
 * 0.594 (независимая мера — 0.24), а все верные находки по словам — 0.688 и
 * выше (переименованные `schemaObjects` 0.688, `tableColumns` 0.781,
 * `normalizeDdl` 0.813, `probeJitter` 0.844). 0.65 — посередине: 0.60 отсекал
 * бы ложную на 0.006, 0.70 терял бы `schemaObjects`. Требовать совпадения имени
 * вместо порога нельзя: все четыре верные находки — переименования.
 */
export const REBIND_TEXT_MIN = 0.65;

/** Сколько кандидатов проверяется чтением файла (§7.3: «до 5 кандидатов»). */
export const REBIND_MAX_CANDIDATES = 5;

/** Из скольких кандидатов по имени символа выбирается — ближайшие по каталогу. */
const SYMBOL_CANDIDATES = 3;
/** Сколько имён символа пробуется (хранимое, из индекса, из crux). */
const SYMBOL_NAMES = 3;
/** Сколько слов crux уходит в поиск по корпусу. */
const TEXT_TERMS = 8;
/** Сколько единиц корпуса берётся на свёртку в файлы. */
const TEXT_UNITS = 40;
/** RRF-константа свёртки единиц в файлы — та же, что у `searchCode`. */
const RRF_K = 10;
/** Без отпечатка якорь проверяется по crux; короткий crux — не улика. */
const LEGACY_CRUX_MIN_CHARS = 40;

/**
 * Язык файла для нормализации — ТО ЖЕ правило, что у `langOf` в
 * commands/anchor.ts (расширение имени в нижнем регистре): отпечаток якоря
 * снят с нормализацией его языка, и кандидат обязан нормализоваться так же.
 */
export function anchorLang(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : "";
}

export interface ElsewhereAnchor {
  /** Путь файла якоря от корня воркспейса (личность файла, `wsPathOfKey`). */
  readonly wsPath: string;
  readonly symbol: string;
  readonly spanStart: number;
  readonly spanEnd: number;
  /** Хеш, с которым якорь сверен последним (до этой проверки). */
  readonly fileHash: string;
  readonly crux: string;
  readonly cruxNorm: string;
  readonly fp: Uint32Array | null;
  readonly boundAt: number;
  /**
   * Когда якорь проверяли в прошлый раз. Код, уехавший с тех пор, лежит в
   * файле, изменённом ПОСЛЕ этого момента, — это и отличает место, куда он
   * переехал, от старого дубля того же кода в нетронутом файле.
   */
  readonly checkedAt?: number;
  /** Файл якоря на диске сейчас — хеш и mtime; undefined — файла нет. */
  readonly disk?: { readonly hash: string; readonly mtimeMs: number };
}

export type CandidateSource = "rename" | "symbol" | "text";

export interface RebindCandidate {
  readonly wsPath: string;
  /** Строка, возле которой искать: начало определения или прежнее начало спана. */
  readonly near: number;
  readonly via: CandidateSource;
  /**
   * Ранг улики, 0 — сильнейшая: переименование файла; 1–2 — то же имя / те же
   * слова в файле, изменённом ПОСЛЕ последней проверки якоря; 3–4 — то же в
   * файле, который с тех пор не менялся (дубль, живший там и раньше).
   */
  readonly rank: number;
  /** Что привело: имя символа, слова crux, «тот же хеш». */
  readonly why: string;
  /** Сходство лучшего окна; -1 — файл не прочитан, 0 — ничего похожего. */
  readonly score: number;
}

export interface ElsewhereFound {
  readonly wsPath: string;
  readonly binding: AnchorBinding;
  readonly score: number;
  readonly via: CandidateSource;
  readonly why: string;
}

export interface ElsewhereResult {
  readonly found: ElsewhereFound | null;
  readonly candidates: readonly RebindCandidate[];
  /** Код-индекс в базе есть. */
  readonly indexed: boolean;
  /** Индекс видел изменение файла якоря: ненайденное — `lost`, иначе `stale`. */
  readonly indexSaw: boolean;
  readonly reason: string;
  readonly tookMs: number;
}

export interface ElsewhereOptions {
  /** Корень воркспейса: пути реестра считаются от него через `repo_id`. */
  readonly wsDir: string;
  readonly io?: CheckIo;
  /** Порог; по умолчанию 0.50. Мутация приёмки: 0 — «любой кандидат годится». */
  readonly minScore?: number;
  /**
   * Порог кандидата по словам crux; по умолчанию `REBIND_TEXT_MIN` (0.65), и не
   * ниже `minScore`. Мутация приёмки: 0.50 — прежнее поведение, 0 — порога нет.
   */
  readonly textMin?: number;
  /** Доля кода в окне кандидата по словам; по умолчанию `REBIND_MIN_CODE_SHARE`. Мутация: 0. */
  readonly minCodeShare?: number;
  readonly maxCandidates?: number;
  readonly now?: number;
  /** Индексы воркспейса, если вызывающий уже спросил (батч фона спрашивает один раз). */
  readonly repos?: readonly string[];
  /**
   * Куда git переименовал пропавший файл — кеш на один прогон (путь от корня
   * воркспейса → новые пути). Все якоря одного переименованного файла
   * спрашивают git один раз. false — не спрашивать git вовсе.
   */
  readonly gitRenames?: Map<string, readonly string[]> | false;
}

/** Путь файла от корня воркспейса по ключу индекса — то же правило, что у якорей. */
function wsOf(repoId: string, path: string): string {
  return repoId.length === 0 ? path : `${repoId}/${path}`;
}

/** Ключи, под которыми индекс может держать файл воркспейса. */
function keysIn(repos: readonly string[], ws: string): Array<{ repoId: string; path: string }> {
  const out: Array<{ repoId: string; path: string }> = [];
  for (const r of repos) {
    if (r.length === 0) out.push({ repoId: "", path: ws });
    else if (ws.startsWith(`${r}/`)) out.push({ repoId: r, path: ws.slice(r.length + 1) });
  }
  return out;
}

function dirOf(ws: string): string {
  const i = ws.lastIndexOf("/");
  return i < 0 ? "" : ws.slice(0, i);
}

/** Сколько общих сегментов каталога — «ближе по дереву». */
function closeness(a: string, b: string): number {
  const x = dirOf(a).split("/");
  const y = dirOf(b).split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Имена символа
// ---------------------------------------------------------------------------

const DECL_RE =
  /\b(?:function\*?|class|interface|type|enum|def|fn|func|struct|trait|impl|module|namespace)\s+([A-Za-z_$][\w$]*)/;
const BINDING_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=/;
const METHOD_RE =
  /^\s*(?:(?:public|private|protected|static|async|readonly|override|export|default|get|set|abstract)\s+)*\*?([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(/;
const NOT_A_NAME = new Set(["if", "for", "while", "switch", "catch", "return", "function", "new", "await", "typeof"]);

/**
 * Имя, объявленное в голове crux: `export function fuseRRF(`, `class Store`,
 * `const x = …`, метод `foo(…) {`. Это подсказка для выбора кандидатов, а не
 * разбор определений: ошибка здесь стоит одного лишнего кандидата, которого
 * всё равно отсеет отпечаток.
 */
export function declaredNames(crux: string): string[] {
  const out: string[] = [];
  for (const line of crux.split("\n").slice(0, 3)) {
    for (const re of [DECL_RE, BINDING_RE, METHOD_RE]) {
      const m = re.exec(line);
      const name = m?.[1];
      if (name !== undefined && !NOT_A_NAME.has(name) && !out.includes(name)) out.push(name);
    }
    if (out.length > 0) break;
  }
  return out;
}

/** Слова хранимого `symbol` (`Foo.bar` → `bar`, `Foo`): пользователь пишет его как угодно. */
function symbolNames(symbol: string): string[] {
  return symbol
    .split(/[^A-Za-z0-9_$]+/)
    .filter((s) => s.length >= 2)
    .reverse();
}

const SQL_DEFS_OF_FILE = `SELECT name, span_start AS s, span_end AS e FROM code_defs
 WHERE repo_id = ?1 AND path = ?2 ORDER BY span_start`;
const SQL_FILE_ROW = `SELECT file_hash AS hash FROM code_files WHERE repo_id = ?1 AND path = ?2`;

/**
 * Имена, на которых стоял якорь, по индексу — если индекс ещё помнит ту
 * версию файла, с которой якорь сверен последним (хеш реестра равен
 * `fileHash` якоря). Иначе определения в этих строках — уже другие, и имя
 * было бы чужим.
 */
function indexNames(db: Database, repos: readonly string[], a: ElsewhereAnchor): string[] {
  const out: string[] = [];
  for (const k of keysIn(repos, a.wsPath)) {
    const row = db.query(SQL_FILE_ROW).get(k.repoId, k.path) as { hash: string } | null;
    if (row === null || row.hash !== a.fileHash) continue;
    const defs = db.query(SQL_DEFS_OF_FILE).all(k.repoId, k.path) as Array<{ name: string; s: number; e: number }>;
    // Сначала определения, НАЧИНАЮЩИЕСЯ в спане (якорь на функцию), потом
    // самое тесное, накрывающее его начало (якорь на кусок тела).
    for (const d of defs) if (d.s >= a.spanStart && d.s <= a.spanEnd && !out.includes(d.name)) out.push(d.name);
    const cover = defs
      .filter((d) => d.s <= a.spanStart && d.e >= a.spanStart)
      .sort((x, y) => x.e - x.s - (y.e - y.s));
    for (const d of cover) if (!out.includes(d.name)) out.push(d.name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Кандидаты
// ---------------------------------------------------------------------------

const SQL_SAME_HASH = `SELECT repo_id, path FROM code_files WHERE file_hash = ?1 LIMIT 16`;

/**
 * Определения по имени — через корпус `code_fts` (колонка `name`), а не
 * сканом `code_defs`: у `code_defs` нет индекса по имени, и на индексе в
 * сотню тысяч определений скан стоил бы десятки миллисекунд на имя. Точное
 * имя (FTS сворачивает регистр) проверяется после.
 */
const SQL_DEFS_BY_NAME = `SELECT u.repo_id AS repo_id, u.path AS path, u.span_start AS s, u.name AS name
  FROM code_fts f JOIN code_units u ON u.id = f.rowid
 WHERE code_fts MATCH ?1 AND u.unit = 'def'
 LIMIT 64`;

const SQL_TEXT = `SELECT u.repo_id AS repo_id, u.path AS path, u.span_start AS s
  FROM code_fts f JOIN code_units u ON u.id = f.rowid
 WHERE code_fts MATCH ?1
 ORDER BY bm25(code_fts, 4.0, 1.0, 1.0, 0.5) LIMIT ?2`;

/**
 * Те же слова — только среди файлов, которые индекс ПЕРЕЧИТАЛ после прошлой
 * проверки якоря (`code_files.indexed_at`): место, куда код уехал, изменено
 * после неё. Без этого второго запроса маленькое определение из общих слов
 * (`interface Obj { type; name; sql }`) тонуло в сотне единиц со словом
 * `name` и до проверки не доходило (замер на истории: `Obj` → `SchemaObject`).
 */
const SQL_TEXT_RECENT = `SELECT u.repo_id AS repo_id, u.path AS path, u.span_start AS s
  FROM code_fts f JOIN code_units u ON u.id = f.rowid
  JOIN code_files cf ON cf.repo_id = u.repo_id AND cf.path = u.path
 WHERE code_fts MATCH ?1 AND cf.indexed_at > ?3
 ORDER BY bm25(code_fts, 4.0, 1.0, 1.0, 0.5) LIMIT ?2`;

/** Слова, которые есть в любом TS/JS/Python файле: в поиске кандидатов они шум. */
const STOP = new Set(
  (
    "abstract any array as async await boolean break case catch class const constructor continue " +
    "declare def default delete do else elif enum export extends false final finally for from func " +
    "function get if implements import in instanceof interface is keyof let lambda map module namespace " +
    "never new null number object of override pass private protected public readonly record return self " +
    "set static string super switch symbol this throw true try type typeof undefined unknown var void " +
    "while with yield length push slice value values keys"
  ).split(" "),
);

/** Слова crux для поиска: идентификаторы от трёх знаков, длинные — первыми (они реже). */
export function cruxTerms(cruxNorm: string): string[] {
  const seen = new Set<string>();
  for (const m of cruxNorm.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    const w = m[0];
    if (!STOP.has(w.toLowerCase())) seen.add(w);
  }
  return [...seen].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, TEXT_TERMS);
}

/** FTS5-строка: каждое слово в кавычках — ни одно не читается оператором. */
function ftsOr(terms: readonly string[], column?: string): string {
  const col = column === undefined ? "" : `${column}:`;
  return terms.map((t) => `${col}"${t.replace(/"/g, "")}"`).join(" OR ");
}

/** Одна строка вывода git (или null — git нет, не репозиторий, ошибка). */
function gitOut(cwd: string, args: readonly string[]): string | null {
  try {
    const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString() : null;
  } catch {
    return null;
  }
}

/** Переименования из `--name-status -z`: пары старый → новый путь (от корня репозитория). */
function renamesIn(z: string | null): Array<[string, string]> {
  if (z === null) return [];
  const parts = z.split("\0");
  const out: Array<[string, string]> = [];
  for (let i = 0; i < parts.length; ) {
    const st = parts[i] ?? "";
    if (st.startsWith("R") || st.startsWith("C")) {
      out.push([parts[i + 1] ?? "", parts[i + 2] ?? ""]);
      i += 3;
    } else {
      i += st.length === 0 ? 1 : 2;
    }
  }
  return out;
}

/**
 * КУДА GIT ПЕРЕИМЕНОВАЛ ПРОПАВШИЙ ФАЙЛ. Переименование с правкой (`git mv` и
 * затем изменения) не находится по хешу содержимого, а по имени символа
 * проигрывает старым дублям того же кода. Git знает ответ точно: переименование
 * в индексе (`git mv` без коммита) или в последнем коммите, тронувшем старый
 * путь. Три вызова git — только для файла, которого нет на диске, и один раз
 * на файл за прогон (кеш у вызывающего).
 */
export function gitRenameTargets(wsDir: string, wsPath: string): string[] {
  // Корень — настоящим путём: git отдаёт `--show-toplevel` через realpath, и
  // под симлинком (/var → /private/var на macOS) относительный путь от него
  // уходил бы в `../`, то есть переименование не находилось бы никогда.
  let root: string;
  try {
    root = realpathSync(resolve(wsDir));
  } catch {
    return [];
  }
  const abs = join(root, wsPath);
  let dir = dirname(abs);
  while (!existsSync(dir)) {
    const up = dirname(dir);
    if (up === dir) return [];
    dir = up;
  }
  if (dir !== root && !dir.startsWith(`${root}${sep}`)) return [];
  const top = gitOut(dir, ["rev-parse", "--show-toplevel"])?.trim();
  if (top === undefined || top.length === 0) return [];
  const rel = relative(top, abs).split(sep).join("/");
  if (rel.startsWith("../")) return [];
  const pairs = renamesIn(gitOut(top, ["diff", "--cached", "--name-status", "-M50%", "-z"]));
  const sha = gitOut(top, ["log", "-1", "--format=%H", "--", rel])?.trim();
  if (sha !== undefined && sha.length > 0) {
    pairs.push(...renamesIn(gitOut(top, ["diff", "--name-status", "-M50%", "-z", `${sha}^`, sha])));
  }
  const out: string[] = [];
  for (const [from, to] of pairs) {
    if (from !== rel || to.length === 0) continue;
    const ws = relative(root, join(top, to)).split(sep).join("/");
    if (!ws.startsWith("../") && !out.includes(ws)) out.push(ws);
  }
  return out;
}

function gatherCandidates(
  db: Database,
  repos: readonly string[],
  a: ElsewhereAnchor,
  limit: number,
  opts: ElsewhereOptions,
  io: CheckIo,
  indexCurrent: boolean,
): Array<Omit<RebindCandidate, "score">> {
  // Изменён ли файл после прошлой проверки якоря: код уехал с тех пор, значит
  // лежит в изменённом файле. mtime — С ДИСКА, а не из реестра: реестр
  // отставшего индекса назвал бы свежий файл нетронутым. Один stat на файл.
  const since = a.checkedAt ?? 0;
  const mtimes = new Map<string, number>();
  const changed = (ws: string): boolean => {
    let m = mtimes.get(ws);
    if (m === undefined) {
      m = io.stat(join(opts.wsDir, ws))?.mtimeMs ?? 0;
      mtimes.set(ws, m);
    }
    return since > 0 && m > since;
  };
  const pool: Array<Omit<RebindCandidate, "score">> = [];

  // rename: файла нет, а git знает, куда он переименован, или его содержимое
  // лежит под другим путём.
  if (a.disk === undefined) {
    if (opts.gitRenames !== false) {
      const cache = opts.gitRenames;
      let targets = cache?.get(a.wsPath);
      if (targets === undefined) {
        targets = gitRenameTargets(opts.wsDir, a.wsPath);
        cache?.set(a.wsPath, targets);
      }
      for (const t of targets) pool.push({ wsPath: t, near: a.spanStart, via: "rename", rank: 0, why: "git rename" });
    }
    if (a.fileHash.length > 0) {
      for (const r of db.query(SQL_SAME_HASH).all(a.fileHash) as Array<{ repo_id: string; path: string }>) {
        pool.push({ wsPath: wsOf(r.repo_id, r.path), near: a.spanStart, via: "rename", rank: 0, why: "same file content" });
      }
    }
  }

  // symbol: то же имя в других файлах; изменённые с прошлой проверки — первыми,
  // затем ближайшие по дереву.
  const names: string[] = [];
  for (const n of [...symbolNames(a.symbol), ...indexNames(db, repos, a), ...declaredNames(a.crux)]) {
    if (!names.includes(n)) names.push(n);
  }
  const bySymbol: Array<Omit<RebindCandidate, "score">> = [];
  for (const name of names.slice(0, SYMBOL_NAMES)) {
    let rows: Array<{ repo_id: string; path: string; s: number; name: string }>;
    try {
      rows = db.query(SQL_DEFS_BY_NAME).all(ftsOr([name], "name")) as typeof rows;
    } catch {
      continue; // имя, которое FTS5 не разобрал, — не повод уронить поиск
    }
    for (const r of rows) {
      if (r.name !== name) continue;
      const ws = wsOf(r.repo_id, r.path);
      if (ws === a.wsPath) continue;
      bySymbol.push({ wsPath: ws, near: r.s, via: "symbol", rank: changed(ws) ? 1 : 3, why: name });
    }
  }
  bySymbol.sort(
    (x, y) => x.rank - y.rank || closeness(y.wsPath, a.wsPath) - closeness(x.wsPath, a.wsPath) || (x.wsPath < y.wsPath ? -1 : 1),
  );
  const seenSymbol = new Set<string>();
  for (const c of bySymbol) {
    if (seenSymbol.has(c.wsPath)) continue;
    seenSymbol.add(c.wsPath);
    if (seenSymbol.size > SYMBOL_CANDIDATES) break;
    pool.push(c);
  }

  // text: слова crux по корпусу, единицы свёрнуты в файлы суммой RRF.
  const terms = cruxTerms(a.cruxNorm);
  if (terms.length > 0) {
    const files = new Map<string, { score: number; near: number }>();
    const fold = (rows: ReadonlyArray<{ repo_id: string; path: string; s: number }>): void => {
      rows.forEach((r, i) => {
        const ws = wsOf(r.repo_id, r.path);
        const f = files.get(ws);
        if (f === undefined) files.set(ws, { score: 1 / (RRF_K + i + 1), near: r.s });
        else f.score += 1 / (RRF_K + i + 1);
      });
    };
    try {
      fold(db.query(SQL_TEXT).all(ftsOr(terms), TEXT_UNITS) as Array<{ repo_id: string; path: string; s: number }>);
      if (since > 0) {
        fold(
          db.query(SQL_TEXT_RECENT).all(ftsOr(terms), TEXT_UNITS, since) as Array<{
            repo_id: string;
            path: string;
            s: number;
          }>,
        );
      }
    } catch {
      // Строку, которую FTS5 не разобрал, пропускаем: кандидаты по имени остаются.
    }
    const why = terms.slice(0, 3).join(" ");
    for (const [ws, f] of [...files.entries()].sort((x, y) => y[1].score - x[1].score || (x[0] < y[0] ? -1 : 1))) {
      pool.push({ wsPath: ws, near: f.near, via: "text", rank: changed(ws) ? 2 : 4, why });
    }
  }

  // Порядок проверки — по рангу, внутри ранга — как собраны; файл один раз.
  // Индекс НЕ ВИДЕЛ изменения — верим только переименованию (git и тот же
  // хеш в реестре; сверка всё равно по диску): у отставшего индекса нет файла, куда код уехал, и
  // лучшим «из того, что есть» оказывается старый дубль того же кода. Замер
  // (вариант stale-index): `percentile` уходил в bench-ort-native.ts, а потом,
  // когда нетронутым файлам верить перестали, — в federation.latency.test.ts,
  // изменённый тем же коммитом, но со СВОИМ старым `percentile`. Имена и слова
  // изменённого файла индекс помнит старые, поэтому и им не верим: такой якорь
  // остаётся `stale` и спрашивается снова после обновления индекса.
  const out: Array<Omit<RebindCandidate, "score">> = [];
  const seen = new Set<string>([a.wsPath]);
  for (const c of [...pool].sort((x, y) => x.rank - y.rank)) {
    if (out.length >= limit) break;
    if (!indexCurrent && c.rank > 0) continue;
    if (seen.has(c.wsPath)) continue;
    seen.add(c.wsPath);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Проверка кандидата
// ---------------------------------------------------------------------------

interface Verified {
  readonly score: number;
  /** Доля кода в найденном окне (`codeShare`): у шаблона и комментария она мала. */
  readonly share: number;
  readonly binding: AnchorBinding;
}

/**
 * Лучшее окно кандидата: точный crux возле `near` и окно по отпечатку — что
 * похоже сильнее. Якорь без отпечатка сравнивается по отпечатку crux (голова
 * спана), и тогда новый спан — прежней высоты от найденного начала.
 */
function verify(
  wsDir: string,
  io: CheckIo,
  a: ElsewhereAnchor,
  c: Omit<RebindCandidate, "score">,
): Verified | null | "unread" {
  const abs = join(wsDir, c.wsPath);
  const st = io.stat(abs);
  if (st === undefined) return "unread";
  let source: string;
  try {
    source = io.read(abs);
  } catch {
    return "unread";
  }
  const legacy = a.fp === null || a.fp.length === 0;
  if (legacy && a.cruxNorm.length < LEGACY_CRUX_MIN_CHARS) return null;
  const fp = legacy ? fingerprint(a.cruxNorm) : a.fp!;
  if (fp.length === 0) return null;
  const lines = source.split("\n");
  const stream = normalizeStream(source, anchorLang(c.wsPath));
  const height = a.spanEnd - a.spanStart + 1;
  const probe = legacy ? Math.min(height, CRUX_MAX_LINES) : height;
  const span = (start: number, end: number): [number, number] =>
    legacy ? [start, Math.min(lines.length, start + height - 1)] : [start, end];

  let best: { start: number; end: number; score: number } | null = null;
  if (a.cruxNorm.length > 0) {
    const hit = findNormalized(stream, a.cruxNorm, c.near);
    if (hit !== 0) {
      const end = Math.min(lines.length, hit + probe - 1);
      const score = jaccardFp(fingerprint(spanNormText(stream, hit, end)), fp);
      const [s, e] = span(hit, end);
      best = { start: s, end: e, score };
    }
  }
  const w = bestWindow(stream, lines.length, fp, probe, c.near);
  if (w !== null && (best === null || w.score > best.score)) {
    const [s, e] = span(w.start, w.end);
    best = { start: s, end: e, score: w.score };
  }
  if (best === null) return null;
  return {
    score: best.score,
    share: codeShare(stream, lines, best.start, best.end),
    binding: bindingAt(source, lines, stream, best.start, best.end, st),
  };
}

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------

/** Видел ли индекс изменение файла якоря — см. шапку модуля. */
function indexSawChange(db: Database, repos: readonly string[], a: ElsewhereAnchor, now: number): boolean {
  const rows = keysIn(repos, a.wsPath)
    .map((k) => db.query(SQL_FILE_ROW).get(k.repoId, k.path) as { hash: string } | null)
    .filter((r): r is { hash: string } => r !== null);
  const refreshedAt = indexFreshness(db, now, 0).refreshedAt;
  if (a.disk === undefined) return rows.length === 0 && refreshedAt >= a.boundAt;
  if (rows.length > 0) return rows.some((r) => r.hash === a.disk!.hash);
  return refreshedAt >= a.disk.mtimeMs;
}

/**
 * Найти код якоря в других файлах воркспейса. Никогда не пишет: решение, что
 * делать с найденным (новый ключ, строка, узел, рёбра), — у вызывающего.
 */
export function rebindElsewhere(db: Database, a: ElsewhereAnchor, opts: ElsewhereOptions): ElsewhereResult {
  const t0 = performance.now();
  const io = opts.io ?? realCheckIo;
  const min = opts.minScore ?? REBIND_ELSEWHERE_MIN;
  const limit = opts.maxCandidates ?? REBIND_MAX_CANDIDATES;
  const now = opts.now ?? Date.now();
  const done = (r: Omit<ElsewhereResult, "tookMs">): ElsewhereResult => ({
    ...r,
    tookMs: Math.round((performance.now() - t0) * 1000) / 1000,
  });

  const repos = opts.repos ?? indexRepos(db);
  if (repos.length === 0) {
    return done({
      found: null,
      candidates: [],
      indexed: false,
      indexSaw: false,
      reason: "no code index — cannot look in other files (myc code index)",
    });
  }
  if (a.cruxNorm.length === 0 && (a.fp === null || a.fp.length === 0)) {
    return done({
      found: null,
      candidates: [],
      indexed: true,
      indexSaw: indexSawChange(db, repos, a, now),
      reason: "the anchor has no text to look for",
    });
  }

  // ВЫБОР — ПО РАНГУ УЛИКИ, как в спеке («по убыванию ранга»), а внутри ранга —
  // по сходству. Определение с тем же именем, изменённое при переезде,
  // проигрывает по сходству случайному похожему куску, найденному по словам;
  // «лучший по сходству среди всех» уводил бы такой якорь в чужой файл (замер на
  // истории: `DefsOptions`, переехавший в symbols.ts, уходил в lex.ts по тексту).
  const saw = indexSawChange(db, repos, a, now);
  const raw = gatherCandidates(db, repos, a, limit, opts, io, saw);
  const candidates: RebindCandidate[] = [];
  let found: (ElsewhereFound & { rank: number }) | null = null;
  // Кандидат только по словам crux — самая слабая улика: за ним нет ни
  // переименования, ни имени, и отпечаток обязан быть и сильнее, и
  // содержательнее (окно — код, а не скелет шаблона).
  const textMin = Math.max(min, opts.textMin ?? REBIND_TEXT_MIN);
  const minShare = opts.minCodeShare ?? REBIND_MIN_CODE_SHARE;
  let weak = 0;
  for (const c of raw) {
    const v = verify(opts.wsDir, io, a, c);
    const score = v === "unread" ? -1 : v === null ? 0 : v.score;
    candidates.push({ ...c, score: Math.round(score * 1000) / 1000 });
    if (v === "unread" || v === null || v.score < min) continue;
    if (c.via === "text" && (v.score < textMin || v.share < minShare)) {
      weak++;
      continue;
    }
    if (found === null || c.rank < found.rank || (c.rank === found.rank && v.score > found.score)) {
      found = { wsPath: c.wsPath, binding: v.binding, score: v.score, via: c.via, why: c.why, rank: c.rank };
    }
  }
  if (found !== null) {
    return done({
      found,
      candidates,
      indexed: true,
      indexSaw: saw,
      reason: `moved to ${found.wsPath}:${found.binding.spanStart} (similarity ${Math.round(found.score * 1000) / 1000}, via ${found.via} ${found.why})`,
    });
  }
  const best = candidates.reduce((m, c) => Math.max(m, c.score), 0);
  const tried =
    candidates.length === 0
      ? "no candidates in the code index"
      : `${candidates.length} candidate(s), best similarity ${best}, needed ${min}` +
        (weak > 0
          ? ` — ${textMin} and a window of code, not strings/comments, for the ${weak} found only by crux words`
          : "");
  return done({
    found: null,
    candidates,
    indexed: true,
    indexSaw: saw,
    reason: saw
      ? `not found in other files: ${tried}`
      : `not found in other files yet: ${tried}; the code index has not seen this change — it will be asked again after it refreshes`,
  });
}
