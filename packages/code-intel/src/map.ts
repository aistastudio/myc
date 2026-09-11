/**
 * КАРТА РЕПОЗИТОРИЯ — ориентация для того, кто видит это дерево впервые
 * (memory-5nvk1hwcene2).
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ СДЕЛАНО, а не отложено как украшение. Карта не стоит
 * НИЧЕГО в хранении: ни таблицы, ни индекса, ни шага индексации — это
 * агрегат по `code_files`, `code_defs` и `code_ref_sites`, которые уже
 * построены ради `callers`. Единственная её цена — время запроса, и оно
 * названо в `RepoMap.tookMs`. Ради вопроса, которым в CLAUDE.md оправдан
 * `graft map`, платить нечем — поэтому и сделано.
 *
 * ЧТО СЧИТАТЬ ПОЛЕЗНОЙ КАРТОЙ. Не «красивой»: числа `421 файл, 3967
 * символов` агент и так получает от `myc code index`. Ориентации в них нет.
 * Здесь три слоя, и каждый отвечает на свой вопрос:
 *   1. ИТОГИ — масштаб дерева и языки, на которых оно написано;
 *   2. КЛАСТЕРЫ — каталоги по убыванию веса, с ХАБАМИ: символами каталога,
 *      которые импортируют чаще всего. Хаб отвечает «с чего тут начинать
 *      читать»;
 *   3. СВЯЗНОСТЬ — кто от кого зависит: для каждого кластера названы
 *      каталоги, которые импортируют из него чаще прочих. Это единственный
 *      слой, которого нет ни в одной другой команде, и ради него карта и
 *      существует: он превращает список каталогов в граф подсистем.
 *
 * РЁБРА СЧИТАЮТСЯ ТОЛЬКО ПО `import`, И ЭТО ЗАМЕР, А НЕ ОСТОРОЖНОСТЬ.
 * `code_ref_sites` хранит СИНТАКСИЧЕСКОЕ вхождение имени, а не разрешённую
 * ссылку: локальная переменная `path` в чужом файле неотличима от обращения
 * к функции `path`, объявленной где-то ещё. Считать хабы по всем видам
 * вхождений — значит получить вот такой список (проверено на этом
 * репозитории): `id(2050) d(1047) path(588) raw(515) v(418) t(299)`. Это не
 * подсистемы, это счётчики циклов. По одним лишь `import` тот же запрос даёт
 * `migrate(90) ExitCode(65) openSqlite(48) GraphStore(31)` — то же, что
 * показывает graft (`migrate 95<-`, `openSqlite 76<-`), потому что `import`
 * — единственный вид вхождения, который ГАРАНТИРОВАННО называет связывание,
 * пришедшее из другого модуля.
 *
 * Второй фильтр — одноимённость: у имени должно быть ровно одно определение
 * на репозиторий, иначе приписать ребро одному каталогу значит соврать.
 * Отброшенные по этой причине считаются и печатаются (`ambiguousEdges`) —
 * та же подпись источника, что у `fan_in`: завышение, которого не видно,
 * хуже отсутствия.
 *
 * БЮДЖЕТ КОНТЕКСТА — параметр, а не надежда. `top`/`hubs`/`links` режут
 * выдачу; сколько знаков она весит на самом деле, печатает `myc code map`
 * последней строкой — измерить, а не оценить.
 */

import type { Database } from "bun:sqlite";
import { prefixEnd, type RepoRef, stripPrefix, viewOf } from "./view.ts";

export interface MapCluster {
  /** Каталог (POSIX, относительно корня репозитория). */
  readonly dir: string;
  readonly files: number;
  readonly defs: number;
  /** Символы каталога, которые чаще всего ИМПОРТИРУЮТ (см. шапку). */
  readonly hubs: readonly { readonly name: string; readonly path: string; readonly refs: number }[];
  /** Кто импортирует из этого каталога чаще всего. */
  readonly usedBy: readonly { readonly dir: string; readonly refs: number }[];
}

export interface RepoMap {
  readonly repo: string;
  readonly files: number;
  readonly defs: number;
  readonly refs: number;
  /** Вхождений вида `import` — из них и только из них строятся рёбра. */
  readonly imports: number;
  readonly langs: readonly { readonly lang: string; readonly files: number }[];
  readonly clusters: readonly MapCluster[];
  /** Каталогов всего — чтобы срез по `top` был виден как срез. */
  readonly dirs: number;
  /** Рёбер, отброшенных из-за одноимённых определений (см. шапку). */
  readonly ambiguousEdges: number;
  /** Рёбер между разными каталогами, учтённых в `usedBy`. */
  readonly crossEdges: number;
  readonly tookMs: number;
}

export interface RepoMapOptions {
  /** Сколько каталогов показать (по убыванию числа определений). */
  readonly top?: number;
  /** Сколько хабов на каталог. */
  readonly hubs?: number;
  /** Сколько зависящих каталогов на каталог. */
  readonly links?: number;
  /** Глубина группировки путей в каталоги: 3 — `packages/cli/src`. */
  readonly depth?: number;
}

const DEFAULT_TOP = 14;
const DEFAULT_HUBS = 3;
const DEFAULT_LINKS = 3;
/**
 * Глубина кластера. 3 сегмента — это `packages/<pkg>/src`, то есть ПАКЕТ, а
 * не «packages» и не каждый подкаталог по отдельности. Значение по умолчанию
 * выбрано под форму рабочего дерева, а не универсально, и потому вынесено в
 * параметр.
 */
const DEFAULT_DEPTH = 3;

const SQL_TOTALS = `SELECT
  (SELECT COUNT(*) FROM code_files WHERE repo_id = ?1) AS files,
  (SELECT COUNT(*) FROM code_defs  WHERE repo_id = ?1) AS defs,
  (SELECT COUNT(*) FROM code_ref_sites WHERE repo_id = ?1) AS refs,
  (SELECT COUNT(*) FROM code_ref_sites WHERE repo_id = ?1 AND kind = 'import') AS imports`;

const SQL_LANGS = `SELECT lang, COUNT(*) AS files FROM code_files WHERE repo_id = ?1
  GROUP BY lang ORDER BY files DESC, lang`;

const SQL_FILE_DIRS = `SELECT path FROM code_files WHERE repo_id = ?1`;

const SQL_DEF_PATHS = `SELECT path, name FROM code_defs WHERE repo_id = ?1`;

/**
 * Ссылки, сгруппированные по (имя, каталог ссылающегося файла). Группировка в
 * SQL, а не в JS, не косметика: строк 157 тысяч, и вынимать их по одной
 * значило бы протащить через границу процесса весь корпус ссылок ради
 * агрегата, который SQLite считает по индексу.
 */
const SQL_REF_EDGES = `SELECT name, path, COUNT(*) AS n
  FROM code_ref_sites WHERE repo_id = ?1 AND kind = 'import' GROUP BY name, path`;

/**
 * Все пять под префиксом вида (`view.ts`): карта ЧАСТИ индекса корня — это
 * карта вложенного репозитория, с его путями, его кластерами и рёбрами только
 * между его файлами. Импорт имени, определённого в соседнем репозитории,
 * ребром не становится — ровно как у отдельного индекса этого репозитория.
 */
const SQL_TOTALS_IN = `SELECT
  (SELECT COUNT(*) FROM code_files WHERE repo_id = ?1 AND path >= ?2 AND path < ?3) AS files,
  (SELECT COUNT(*) FROM code_defs  WHERE repo_id = ?1 AND path >= ?2 AND path < ?3) AS defs,
  (SELECT COUNT(*) FROM code_ref_sites WHERE repo_id = ?1 AND path >= ?2 AND path < ?3) AS refs,
  (SELECT COUNT(*) FROM code_ref_sites WHERE repo_id = ?1 AND path >= ?2 AND path < ?3 AND kind = 'import') AS imports`;
const SQL_LANGS_IN = `SELECT lang, COUNT(*) AS files FROM code_files WHERE repo_id = ?1 AND path >= ?2 AND path < ?3
  GROUP BY lang ORDER BY files DESC, lang`;
const SQL_FILE_DIRS_IN = `SELECT path FROM code_files WHERE repo_id = ?1 AND path >= ?2 AND path < ?3`;
const SQL_DEF_PATHS_IN = `SELECT path, name FROM code_defs WHERE repo_id = ?1 AND path >= ?2 AND path < ?3`;
const SQL_REF_EDGES_IN = `SELECT name, path, COUNT(*) AS n
  FROM code_ref_sites WHERE repo_id = ?1 AND path >= ?2 AND path < ?3 AND kind = 'import' GROUP BY name, path`;

function dirOf(path: string, depth: number): string {
  const parts = path.split("/");
  if (parts.length <= 1) return ".";
  const dir = parts.slice(0, parts.length - 1);
  return dir.slice(0, Math.max(1, depth)).join("/");
}

export function repoMap(db: Database, repo: RepoRef, opts: RepoMapOptions = {}): RepoMap {
  const t0 = performance.now();
  const top = Math.max(1, Math.floor(opts.top ?? DEFAULT_TOP));
  const hubsN = Math.max(0, Math.floor(opts.hubs ?? DEFAULT_HUBS));
  const linksN = Math.max(0, Math.floor(opts.links ?? DEFAULT_LINKS));
  const depth = Math.max(1, Math.floor(opts.depth ?? DEFAULT_DEPTH));
  const v = viewOf(repo);
  const part = v.prefix.length > 0;
  const args = part ? [v.repoId, v.prefix, prefixEnd(v.prefix)] : [v.repoId];
  // Пути под префиксом вида — в пути вложенного репозитория: кластер
  // `server/src`, а не `messaging-server/server`.
  const rel = (p: string): string => (part ? stripPrefix(v, p) : p);

  const totals = db.query(part ? SQL_TOTALS_IN : SQL_TOTALS).get(...args) as {
    files: number;
    defs: number;
    refs: number;
    imports: number;
  };
  const langs = db.query(part ? SQL_LANGS_IN : SQL_LANGS).all(...args) as Array<{ lang: string; files: number }>;

  const filesPerDir = new Map<string, number>();
  for (const r of db.query(part ? SQL_FILE_DIRS_IN : SQL_FILE_DIRS).all(...args) as Array<{ path: string }>) {
    const d = dirOf(rel(r.path), depth);
    filesPerDir.set(d, (filesPerDir.get(d) ?? 0) + 1);
  }

  // Имя -> определение. Имя, определённое дважды, из рёбер выбывает целиком:
  // см. второй фильтр в шапке.
  const defPath = new Map<string, string | null>();
  const defsPerDir = new Map<string, number>();
  for (const raw of db.query(part ? SQL_DEF_PATHS_IN : SQL_DEF_PATHS).all(...args) as Array<{
    path: string;
    name: string;
  }>) {
    const r = { path: rel(raw.path), name: raw.name };
    defsPerDir.set(dirOf(r.path, depth), (defsPerDir.get(dirOf(r.path, depth)) ?? 0) + 1);
    if (defPath.has(r.name)) {
      const prev = defPath.get(r.name);
      if (prev !== r.path) defPath.set(r.name, null);
    } else {
      defPath.set(r.name, r.path);
    }
  }

  const refsPerName = new Map<string, number>();
  const usedBy = new Map<string, Map<string, number>>();
  let ambiguous = 0;
  let cross = 0;
  for (const raw of db.query(part ? SQL_REF_EDGES_IN : SQL_REF_EDGES).all(...args) as Array<{
    name: string;
    path: string;
    n: number;
  }>) {
    const e = { name: raw.name, path: rel(raw.path), n: raw.n };
    const target = defPath.get(e.name);
    if (target === undefined) continue; // импорт того, что здесь не определено
    if (target === null) {
      ambiguous += e.n;
      continue;
    }
    // Файл, импортирующий сам из себя, ребром не является: это ре-экспорт.
    if (target === e.path) continue;
    refsPerName.set(e.name, (refsPerName.get(e.name) ?? 0) + e.n);
    const to = dirOf(target, depth);
    const from = dirOf(e.path, depth);
    if (to === from) continue;
    cross += e.n;
    let m = usedBy.get(to);
    if (m === undefined) {
      m = new Map();
      usedBy.set(to, m);
    }
    m.set(from, (m.get(from) ?? 0) + e.n);
  }

  const hubsPerDir = new Map<string, Array<{ name: string; path: string; refs: number }>>();
  for (const [name, refs] of refsPerName) {
    const path = defPath.get(name);
    if (path === null || path === undefined) continue;
    const d = dirOf(path, depth);
    let list = hubsPerDir.get(d);
    if (list === undefined) {
      list = [];
      hubsPerDir.set(d, list);
    }
    list.push({ name, path, refs });
  }
  for (const list of hubsPerDir.values()) {
    list.sort((a, b) => b.refs - a.refs || (a.name < b.name ? -1 : 1));
  }

  const dirs = new Set([...filesPerDir.keys(), ...defsPerDir.keys()]);
  const clusters: MapCluster[] = [...dirs]
    .map((dir) => ({
      dir,
      files: filesPerDir.get(dir) ?? 0,
      defs: defsPerDir.get(dir) ?? 0,
      hubs: (hubsPerDir.get(dir) ?? []).slice(0, hubsN),
      usedBy: [...(usedBy.get(dir) ?? new Map()).entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, linksN)
        .map(([d, refs]) => ({ dir: d, refs })),
    }))
    .sort((a, b) => b.defs - a.defs || b.files - a.files || (a.dir < b.dir ? -1 : 1));

  return {
    repo: v.repoId,
    files: totals.files,
    defs: totals.defs,
    refs: totals.refs,
    imports: totals.imports,
    langs,
    clusters: clusters.slice(0, top),
    dirs: dirs.size,
    ambiguousEdges: ambiguous,
    crossEdges: cross,
    tookMs: performance.now() - t0,
  };
}
