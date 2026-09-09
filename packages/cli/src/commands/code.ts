/**
 * `myc code` — вход и читатель встроенного код-индекса (S52, §4.3
 * docs/design/05-code-intelligence.md).
 *
 * ЗАЧЕМ КОМАНДА ВООБЩЕ. Индекс `code_files/code_defs/code_refs` был написан,
 * покрыт тестами и мёртв: `runCodeIndex` звал только стенд замера, а таблицы
 * не читал НИКТО (memory-m30yh8swnm1d). При этом `myc init` печатал «символы и
 * fan_in по тексту» — обещание, которого не выполнял никто. Здесь обе
 * половины: `myc code index` строит, `myc code symbol` читает.
 *
 * ПОЧЕМУ НЕ `myc reindex --code`. `reindex` — про ВЕКТОРНОЕ пространство: он
 * отказывает без vec0 (exit 3), поднимает эмбеддер и сверяет отпечаток
 * пространства ДО первой записи. Код-индексу не нужно ничего из этого: он
 * работает там, где модель не скачана вовсе, и обязан работать — иначе символы
 * репозитория стали бы заложником наличия ONNX-модели. Собрать их в одну
 * команду значит либо провести код-индекс мимо этих проверок (и получить
 * команду, половина флагов которой падает по чужой причине), либо отказывать в
 * символах без модели.
 *
 * ГОРЯЧИЙ ПУТЬ (И1). Команда синхронная и стоит СЕКУНДЫ на большом дереве —
 * поэтому её никто не зовёт из чужого вызова. Фон поднимает её ОТСОЕДИНЁННЫМ
 * процессом (`drain.ts`, шаг `code_index`), ровно как `myc reindex` для класса
 * `embed`: команда, ради которой случился дренаж, не ждёт ничего.
 *
 * ЧИТАТЕЛЬ. `myc code symbol <name>` отвечает на вопрос, которого без индекса
 * задать было нельзя: где определён символ И КАКОЕ ЗНАНИЕ К НЕМУ ПРИВЯЗАНО.
 * Второе — стык, которого нет ни у graft, ни у grep: якорь хранит `file:span`,
 * индекс — `symbol → span`, и пересечение спанов превращает «строки 507-644» в
 * «функция drainQueueTail, и вот три записи про неё».
 */

import { join } from "node:path";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";
import {
  flagBool,
  flagNum,
  flagStr,
  realStoreDeps,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

/**
 * Ключ отметки последнего прогона код-индекса в `myc_meta`. Живёт здесь, у
 * команды, которая её обновляет; фоновый шаг дренажа читает ЭТУ константу, а
 * не свою копию строки — разъехавшиеся копии означали бы период, действующий
 * в одну сторону и не действующий в другую.
 */
export const CODE_INDEXED_AT_KEY = "code_indexed_at";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

/** «2.3 МБ» — тот же формат, что у самого код-интеллекта; одна реализация. */
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/**
 * Ошибка «нет ресурса» — или null, если это что-то другое. Опознаётся по
 * КЛАССУ из @myc/code-intel, а не по тексту сообщения: строку кто-нибудь
 * когда-нибудь перепишет, и опознание сломается молча.
 */
async function missingResource(e: unknown): Promise<{ message: string; hint: string } | null> {
  const { MissingResourceError } = await import("@myc/code-intel/symbols");
  if (e instanceof MissingResourceError) return { message: e.message, hint: e.hint };
  return null;
}

/**
 * Репозиторий и его корень на диске — те же правила, что у якорей (S59,
 * `anchorRepo`): `repo_root` машинозависим и выводится из каталога вызова, а
 * не приезжает из базы. Дублировать логику нельзя: индекс и якоря обязаны
 * писать ОДИН И ТОТ ЖЕ `repo_id`, иначе `defsInSpan` не найдёт ничего.
 */
export async function codeRepo(
  h: StoreHandle,
  explicit: string | undefined,
): Promise<{ repoId: string; repoRoot: string }> {
  const { anchorRepo } = await import("./anchor.ts");
  const derived = anchorRepo(h);
  if (explicit === undefined || explicit.trim().length === 0) return derived;
  const repoId = explicit.trim();
  return { repoId, repoRoot: repoId.length === 0 ? h.wsDir : join(h.wsDir, repoId) };
}

// ---------------------------------------------------------------------------
// myc code index — вход
// ---------------------------------------------------------------------------

interface CodeIndexData {
  repo: string;
  root: string;
  dry_run: boolean;
  scan: {
    files: number;
    unchanged: number;
    touched: number;
    dirty: number;
    enqueued: number;
    removed: number;
    excluded: number;
    scan_ms: number;
  };
  drain: {
    claimed: number;
    parsed: number;
    written: number;
    cleaned: number;
    failed: number;
    batches: number;
    /**
     * Разобрано ПУЛОМ воркеров (остальное — в этом же потоке). Число здесь не
     * для красоты: пул, который молча не завёлся, от пула, который отработал,
     * по `parsed` неотличим — и ровно так он год не работал в бинаре.
     */
    pooled: number;
    /** Файлы, пропущенные из-за отсутствующей грамматики (символов не будет). */
    skipped: number;
    parse_ms: number;
    drain_ms: number;
  };
  /**
   * Каких грамматик не хватило. Поле есть ВСЕГДА (пустым списком), а не
   * появляется при беде: потребитель `--json` не должен угадывать, значит ли
   * его отсутствие «всё хорошо» или «старая версия myc».
   */
  missing_grammars: { grammar: string; langs: string[]; bytes: number; files: number; fetch: string }[];
  /** Состояние индекса ПОСЛЕ прогона — то, ради чего команда и звалась. */
  files: number;
  defs: number;
  langs: { lang: string; files: number }[];
  took_ms: number;
}

const INDEX_FLAGS: readonly FlagSpec[] = [
  { name: "dry-run", description: "count what would be indexed, write nothing" },
  { name: "batch", value: "number", description: "jobs per claim/transaction (default 256)" },
  { name: "repo", value: "string", description: "repo id to index (default: derived from cwd)" },
];

function buildCodeIndex(deps: StoreDeps): Command {
  return {
    name: "index",
    summary: "build the code index of this repo: files, symbols, spans",
    help:
      "Walks the repo, enqueues changed files as jobs(kind='code_index') and drains them into " +
      "code_files/code_defs. Incremental on two levels — (mtime,size), then content hash — so a " +
      "repeat run over an unchanged tree reads nothing. Costs seconds on a large tree: this is a " +
      "background job class, and the drain step spawns this very command detached rather than " +
      "running it inline (И1). Symbols are parsed for ts/tsx/js/jsx/py (L1); every other file is " +
      "registered by path, language and hash (L0) and gets no symbols. A L1 language whose " +
      "tree-sitter grammar is not staged is SKIPPED and NAMED — indexing never goes to the " +
      "network, not even in the background; `myc code fetch` does, and only when a human asks.",
    flags: INDEX_FLAGS,
    handler: async (ctx) => {
      const t0 = performance.now();
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const { repoId, repoRoot } = await codeRepo(h, flagStr(ctx, "repo"));
        const { scanCodeIndex, drainCodeIndex } = await import("@myc/code-intel/code-index");
        const { indexScope } = await import("@myc/code-intel/read");
        const db = h.driver.database;
        const opts = { repoId, root: repoRoot };
        const dryRun = flagBool(ctx, "dry-run");
        const scan = scanCodeIndex(db, opts, !dryRun);
        const batchRaw = flagNum(ctx, "batch");
        let drain;
        try {
          drain = dryRun
            ? { claimed: 0, parsed: 0, written: 0, cleaned: 0, failed: 0, batches: 0, pooled: 0, skipped: 0, missing: [], parseMs: 0, drainMs: 0 }
            : await drainCodeIndex(db, opts, {
                holder: `code-index-${process.pid}`,
                ...(batchRaw !== undefined && batchRaw > 0 ? { batch: Math.floor(batchRaw) } : {}),
              });
        } catch (e) {
          // Нехватка РЕСУРСА — не сбой программы. Раньше рантайм, которого нет
          // в опубликованном пакете, доезжал сюда голым Error и печатался как
          // `internal.unexpected`: агент, ветвящийся на коде, читал это как
          // «myc сломан», а сломан был не myc, а установка.
          const miss = await missingResource(e);
          if (miss !== null) {
            return failure("precond.runtime_missing", miss.message, ExitCode.PRECOND, miss.hint);
          }
          throw e;
        }
        const scope = indexScope(db, repoId);
        const data: CodeIndexData = {
          repo: repoId,
          root: repoRoot,
          dry_run: dryRun,
          scan: {
            files: scan.files,
            unchanged: scan.unchanged,
            touched: scan.touched,
            dirty: scan.dirty,
            enqueued: scan.enqueued,
            removed: scan.removed,
            excluded: scan.excluded,
            scan_ms: Math.round(scan.scanMs),
          },
          drain: {
            claimed: drain.claimed,
            parsed: drain.parsed,
            written: drain.written,
            cleaned: drain.cleaned,
            failed: drain.failed,
            batches: drain.batches,
            pooled: drain.pooled,
            skipped: drain.skipped,
            parse_ms: Math.round(drain.parseMs),
            drain_ms: Math.round(drain.drainMs),
          },
          missing_grammars: drain.missing.map((m) => ({
            grammar: m.grammar,
            langs: [...m.langs],
            bytes: m.bytes,
            files: m.files,
            fetch: `myc code fetch ${m.langs[0] ?? m.grammar}`,
          })),
          files: scope.files,
          defs: scope.defs,
          langs: scope.langs.slice(0, 8).map((l) => ({ lang: l.lang, files: l.files })),
          took_ms: Math.round(performance.now() - t0),
        };
        // Отметка «индекс этого воркспейса свежий» — её же читает фоновый шаг
        // дренажа, чтобы не поднимать воркер чаще периода.
        if (!dryRun) {
          try {
            const { Q } = await import("@myc/store-sqlite");
            h.driver.run(Q.meta_set, [CODE_INDEXED_AT_KEY, String(Date.now())]);
          } catch {
            // Отметка не записалась — фон просто прогонит снова.
          }
        }
        if (drain.failed > 0) {
          ctx.warn("code_index.failed", `файлов не разобрано: ${drain.failed} (см. jobs.last_error)`);
        }
        if (data.missing_grammars.length > 0) {
          const total = data.missing_grammars.reduce((n, m) => n + m.files, 0);
          const named = data.missing_grammars
            .map((m) => `${m.langs.join("/")} (${m.files} файлов, ${fmtBytes(m.bytes)})`)
            .join("; ");
          // Ни одного символа И были пропуски — команда не выполнила того, о
          // чём её просили, и говорить «готово» здесь нельзя.
          if (scope.defs === 0) {
            return failure(
              "precond.grammar_missing",
              `грамматик tree-sitter нет: ${named}. Пропущено файлов: ${total}, ` +
                `символов в индексе: 0. Реестр файлов построен (${scope.files})`,
              ExitCode.PRECOND,
              data.missing_grammars.map((m) => m.fetch).join(" && "),
            );
          }
          ctx.warn(
            "code_index.grammar_missing",
            `пропущено файлов ${total} — нет грамматик: ${named}. Добыть: ` +
              data.missing_grammars.map((m) => m.fetch).join(", "),
          );
        }
        if (scope.l1Files === 0 && data.missing_grammars.length === 0) {
          ctx.warn(
            "code_index.no_l1",
            `файлов ts/tsx/js/jsx нет — символов не будет, реестр файлов построен (${scope.files})`,
          );
        }
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as CodeIndexData;
      const langs = d.langs.map((l) => `${l.lang} ${l.files}`).join(", ");
      const lines = [
        `репозиторий ${d.repo.length > 0 ? d.repo : "(корень воркспейса)"}  ${d.root}`,
        `скан      файлов ${d.scan.files}, без изменений ${d.scan.unchanged}, тач ${d.scan.touched}, ` +
          `в работу ${d.scan.enqueued}, убрано ${d.scan.removed}  ${d.scan.scan_ms} мс`,
        `разбор    взято ${d.drain.claimed}, разобрано ${d.drain.parsed} (пулом ${d.drain.pooled}), ` +
          `записано ${d.drain.written}, пропущено ${d.drain.skipped}, отказов ${d.drain.failed}  ` +
          `${d.drain.drain_ms} мс`,
        ...d.missing_grammars.map(
          (m) =>
            `без грамматики  ${m.langs.join("/")}: ${m.files} файлов не разобрано ` +
            `(${fmtBytes(m.bytes)}) — \`${m.fetch}\``,
        ),
        `индекс    ${d.files} файлов, ${d.defs} символов${langs.length > 0 ? `  [${langs}]` : ""}`,
        `${d.dry_run ? "dry-run: ничего не записано  " : ""}${d.took_ms} мс`,
      ];
      return `${lines.join("\n")}\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// myc code symbol — читатель
// ---------------------------------------------------------------------------

interface SymbolData {
  repo: string;
  name: string;
  defs: {
    path: string;
    kind: string;
    lang: string;
    span_start: number;
    span_end: number;
    exported: boolean;
    /** Узлы, чьи якоря пересекают спан этого определения. */
    knowledge: { id: string; kind: string; status: string; title: string; anchor: string; state: string }[];
  }[];
  fan_in?: { n: number; files: number; source: string; cached: boolean; took_ms: number };
  /** Что просмотрено — §6.3: пустой выдачи без причины не бывает. */
  searched: { files: number; l1_files: number; defs: number; langs: string[] };
  took_ms: number;
}

const SQL_ANCHORS_IN_SPAN = `
SELECT a.node_id AS node_id, a.path AS path, a.span_start AS s, a.span_end AS e, a.state AS state
  FROM anchors a
 WHERE a.repo_id = ?1 AND a.path = ?2 AND a.span_start <= ?4 AND a.span_end >= ?3
 ORDER BY (a.span_end - a.span_start), a.span_start`;

const SQL_ANCHOR_OWNERS = `
SELECT g.src AS id, n.kind AS kind, n.title AS title, n.status AS status
  FROM edges g JOIN nodes n ON n.id = g.src
 WHERE g.dst = ?1 AND g.type = 'touches' AND g.deleted_at IS NULL AND n.deleted_at IS NULL
 ORDER BY n.priority, n.id`;

const SYMBOL_FLAGS: readonly FlagSpec[] = [
  { name: "repo", value: "string", description: "repo id to search (default: derived from cwd)" },
  { name: "no-fan-in", description: "skip the text fan_in count (it reads the L1 corpus)" },
];

function buildCodeSymbol(deps: StoreDeps): Command {
  return {
    name: "symbol",
    summary: "where a symbol is defined and what knowledge is anchored to it: code symbol <name>",
    help:
      "Reads code_defs built by `myc code index`: every definition of <name> in this repo with its " +
      "path, kind and span — and, for each span, the tasks and memories whose anchors fall inside it. " +
      "That last part is the answer no code index alone can give: anchors know file:span, the index " +
      "knows symbol→span, and the overlap turns 'lines 507-644' into 'function drainQueueTail, and " +
      "here is what is known about it'. fan_in is a TEXT count (upper bound, `\\bNAME\\b` over the L1 " +
      "corpus minus the definition lines) and is always labelled with its source; it is computed on " +
      "demand and cached in code_refs until the indexer invalidates it.",
    flags: SYMBOL_FLAGS,
    handler: async (ctx) => {
      const t0 = performance.now();
      const name = ctx.args[0];
      if (name === undefined || name.trim().length === 0) {
        return failure("usage.invalid", "нужно: myc code symbol <name>", ExitCode.USAGE);
      }
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const { repoId, repoRoot } = await codeRepo(h, flagStr(ctx, "repo"));
        const { symbolDefs, defsInSpan, indexScope, fanIn } = await import("@myc/code-intel/read");
        const db = h.driver.database;
        const scope = indexScope(db, repoId);
        if (scope.files === 0) {
          return failure(
            "precond.no_index",
            `код-индекс этого репозитория (${repoId.length > 0 ? repoId : "корень воркспейса"}) не построен: ` +
              `в code_files ноль строк — символ искать негде`,
            ExitCode.PRECOND,
            "myc code index",
          );
        }
        const defs = symbolDefs(db, repoId, name.trim());
        const anchorsQ = db.query(SQL_ANCHORS_IN_SPAN);
        const ownersQ = db.query(SQL_ANCHOR_OWNERS);
        const data: SymbolData = {
          repo: repoId,
          name: name.trim(),
          defs: defs.map((d) => {
            const knowledge: SymbolData["defs"][number]["knowledge"] = [];
            const rows = anchorsQ.all(repoId, d.path, d.spanStart, d.spanEnd) as Array<{
              node_id: string;
              path: string;
              s: number;
              e: number;
              state: string;
            }>;
            for (const a of rows) {
              for (const o of ownersQ.all(a.node_id) as Array<{
                id: string;
                kind: string;
                title: string;
                status: string;
              }>) {
                knowledge.push({
                  id: o.id,
                  kind: o.kind,
                  status: o.status,
                  title: o.title,
                  anchor: `${a.path}:${a.s}-${a.e}`,
                  state: a.state,
                });
              }
            }
            return {
              path: d.path,
              kind: d.kind,
              lang: d.lang,
              span_start: d.spanStart,
              span_end: d.spanEnd,
              exported: d.exported,
              knowledge,
            };
          }),
          searched: {
            files: scope.files,
            l1_files: scope.l1Files,
            defs: scope.defs,
            langs: scope.langs.slice(0, 6).map((l) => l.lang),
          },
          took_ms: 0,
        };
        if (defs.length > 0 && !flagBool(ctx, "no-fan-in")) {
          const f = fanIn(db, repoId, name.trim(), repoRoot);
          data.fan_in = {
            n: f.n,
            files: f.files,
            source: f.source,
            cached: f.cached,
            took_ms: Math.round(f.tookMs),
          };
        }
        data.took_ms = Math.round(performance.now() - t0);
        if (defs.length === 0) {
          return failure(
            "notfound.symbol",
            `символа ${name.trim()} нет в индексе: просмотрено ${scope.files} файлов ` +
              `(${scope.l1Files} с определениями, ${scope.defs} символов), языки ${data.searched.langs.join(", ")}`,
            ExitCode.NOTFOUND,
            scope.l1Files === 0
              ? "в репозитории нет файлов ts/tsx/js/jsx — символов не будет"
              : "индекс мог отстать: myc code index",
          );
        }
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as SymbolData;
      const out: string[] = [];
      for (const def of d.defs) {
        const flags = [def.kind, def.lang, def.exported ? "exported" : ""].filter((s) => s.length > 0);
        out.push(`${def.path}:${def.span_start}-${def.span_end}  ${flags.join(" ")}`);
        for (const k of def.knowledge) {
          out.push(`    ${k.id}  ${k.kind}  ${k.status}  ${k.title}  [${k.anchor} ${k.state}]`);
        }
        if (def.knowledge.length === 0) out.push("    знания на этом участке нет");
      }
      if (d.fan_in !== undefined) {
        out.push(
          `fan_in ${d.fan_in.n} (${d.fan_in.source}, ${d.fan_in.files} файлов` +
            `${d.fan_in.cached ? ", из кеша" : `, ${d.fan_in.took_ms} мс`})`,
        );
      }
      out.push(
        `просмотрено ${d.searched.files} файлов, ${d.searched.defs} символов  ${d.took_ms} мс`,
      );
      return `${out.join("\n")}\n`;
    },
  };
}

// ---------------------------------------------------------------------------
// myc code fetch / myc code grammars — грамматики по требованию
// ---------------------------------------------------------------------------

/**
 * ПОЧЕМУ ОТДЕЛЬНАЯ КОМАНДА, А НЕ `myc models fetch <грамматика>`.
 *
 * Механизм у них общий (url + sha256 + идемпотентный кеш), а НАМЕЧЕННОЕ —
 * разное, и именно намеченное видит человек. `myc models` объявлен как
 * «manage local embedding models», его идентификаторы выглядят как
 * `multilingual-e5-small-q8`, а `models list` печатает размерность вектора,
 * которой у грамматики нет. Всунуть туда `python` значит завести в одной
 * команде два вида сущностей с разными полями — то есть ту самую «одну
 * поверхность, два ответа», которую этот репозиторий ловил шесть раз.
 *
 * Против общей команды `myc fetch <что угодно>` довод тот же и ещё один:
 * грамматика нужна ровно тому, кто зовёт `myc code index`, и отказ этой
 * команды должен называть команду СОСЕДНЮЮ, на расстоянии одного слова, а не
 * из другого раздела справки. `myc code index` -> `myc code fetch` читается
 * без справки вовсе.
 *
 * Общим остаётся МЕХАНИЗМ, и его дублирование — временное: одинаковые по
 * смыслу `packages/embed/src/fetch.ts` и `packages/code-intel/src/grammars.ts`
 * должны сойтись в `@myc/core`. Границы этой задачи в `@myc/core` не пускают,
 * поэтому здесь честная вторая реализация того же контракта, а не
 * притворство, что её нет.
 */

interface FetchData {
  requested: string[];
  fetched: { grammar: string; langs: string[]; bytes: number; ms: number; already: boolean }[];
  dir: string;
  downloaded_bytes: number;
  took_ms: number;
}

const FETCH_FLAGS: readonly FlagSpec[] = [
  { name: "repo", value: "string", description: "repo id to scan for languages (default: from cwd)" },
];

function buildCodeFetch(deps: StoreDeps): Command {
  return {
    name: "fetch",
    summary: "download tree-sitter grammars for this repo's languages (sha256-verified, idempotent)",
    help:
      "Grammars are NOT shipped in the package: all 36 weigh 49MB against a 12MB package, and a " +
      "given repo needs two of them. `myc code fetch` with no arguments walks the repo and " +
      "downloads exactly the grammars its L1 files need; with arguments it takes language ids " +
      "(ts, tsx, js, jsx, py) or grammar names (typescript, tsx, javascript, python). Repeating " +
      "the call touches no network: an intact file is not re-downloaded. This is the ONLY place " +
      "in the code index that opens a socket — indexing never does (see `myc code index`).",
    flags: FETCH_FLAGS,
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const {
        GRAMMARS,
        GRAMMAR_BY_LANG,
        FetchGrammarError,
        fetchGrammar,
        grammarsCacheDir,
      } = await import("@myc/code-intel/grammars");
      type GName = keyof typeof GRAMMARS;

      const wanted = new Set<GName>();
      const requested: string[] = [];
      for (const raw of ctx.args) {
        const a = raw.trim().toLowerCase();
        if (a.length === 0) continue;
        requested.push(a);
        if (a === "all") {
          for (const g of Object.keys(GRAMMARS) as GName[]) wanted.add(g);
          continue;
        }
        const byLang = (GRAMMAR_BY_LANG as Record<string, GName | undefined>)[a];
        if (byLang !== undefined) {
          wanted.add(byLang);
          continue;
        }
        if (a in GRAMMARS) {
          wanted.add(a as GName);
          continue;
        }
        return failure(
          "usage.invalid",
          `не знаю языка или грамматики "${raw}"; языки: ${Object.keys(GRAMMAR_BY_LANG).join(", ")}; ` +
            `грамматики: ${Object.keys(GRAMMARS).join(", ")}`,
          ExitCode.USAGE,
          "myc code fetch      # без аргументов — по языкам этого репозитория",
        );
      }

      // Без аргументов — по ЯЗЫКАМ РЕПОЗИТОРИЯ, а не «все 36». Дерево читается
      // напрямую, а не из реестра code_files: файла, чья грамматика не
      // скачана, в реестре нет по построению (см. drainBatch), и спросить у
      // индекса, каких языков ему не хватает, было бы замкнутым кругом.
      if (wanted.size === 0) {
        const opened = await deps.openStore(ctx);
        if (!opened.ok) return opened.failure;
        const h = opened.handle;
        try {
          const { repoRoot } = await codeRepo(h, flagStr(ctx, "repo"));
          const { L1_LANGS, langOf, walkFiles } = await import("@myc/code-intel/langs");
          for (const rel of walkFiles(repoRoot)) {
            const lang = langOf(rel);
            if (!L1_LANGS.has(lang)) continue;
            const g = (GRAMMAR_BY_LANG as Record<string, GName | undefined>)[lang];
            if (g !== undefined) wanted.add(g);
          }
        } finally {
          h.close();
        }
        if (wanted.size === 0) {
          return failure(
            "notfound.lang",
            "в этом репозитории нет файлов ts/tsx/js/jsx/py — грамматики не нужны ни одной",
            ExitCode.NOTFOUND,
            "myc code fetch ts   # если нужна конкретная",
          );
        }
      }

      const showProgress =
        process.stdout.isTTY === true && !ctx.globals.json && !ctx.globals.ndjson && !ctx.globals.quiet;
      const data: FetchData = {
        requested,
        fetched: [],
        dir: grammarsCacheDir(),
        downloaded_bytes: 0,
        took_ms: 0,
      };
      for (const name of [...wanted].sort()) {
        try {
          const r = await fetchGrammar(name, {
            onProgress: showProgress
              ? (p) => {
                  const pct =
                    p.totalBytes !== null
                      ? ` ${Math.min(100, Math.round((p.loadedBytes / p.totalBytes) * 100))}%`
                      : "";
                  process.stdout.write(`\r${p.grammar}${pct} ${fmtBytes(p.loadedBytes)}\x1b[K`);
                }
              : undefined,
          });
          if (showProgress) process.stdout.write("\r\x1b[K");
          data.fetched.push({
            grammar: r.grammar,
            langs: [...GRAMMARS[name].langs],
            bytes: r.bytes,
            ms: Math.round(r.tookMs),
            already: r.alreadyPresent,
          });
          if (!r.alreadyPresent) data.downloaded_bytes += r.bytes;
        } catch (e) {
          if (showProgress) process.stdout.write("\r\x1b[K");
          if (e instanceof FetchGrammarError) {
            return failure(
              FETCH_GRAMMAR_CODE[e.code] ?? "internal.unexpected",
              e.message,
              e.code === "unknown_grammar" ? ExitCode.NOTFOUND : ExitCode.ERR,
              e.code === "network_error"
                ? "нужен доступ к cdn.jsdelivr.net; в закрытом контуре положите .wasm в MYC_GRAMMARS_DIR"
                : undefined,
            );
          }
          throw e;
        }
      }
      data.took_ms = Math.round(performance.now() - t0);
      return { ok: true, data, meta: { took_ms: data.took_ms } };
    },
    renderHuman: (data) => {
      const d = data as FetchData;
      const lines = d.fetched.map(
        (f) =>
          `${f.already ? "уже есть " : "скачано  "}${f.grammar} (${f.langs.join("/")})  ` +
          `${fmtBytes(f.bytes)}  ${f.ms} мс`,
      );
      lines.push(
        `каталог  ${d.dir}`,
        `${d.downloaded_bytes > 0 ? `из сети ${fmtBytes(d.downloaded_bytes)}  ` : "сеть не использовалась  "}${d.took_ms} мс`,
      );
      return `${lines.join("\n")}\n`;
    },
  };
}

/** Коды отказа загрузки — отражение FetchGrammarErrorCode в словарь myc. */
const FETCH_GRAMMAR_CODE: Record<string, string> = {
  checksum_mismatch: "internal.checksum_mismatch",
  network_error: "internal.network",
  http_error: "internal.http",
  fs_error: "internal.fs",
  unknown_grammar: "notfound.grammar",
};

interface GrammarsData {
  runtime: { file: string; path: string | null; status: string };
  grammars: { grammar: string; langs: string[]; status: string; size: string; path: string | null }[];
  cache_dir: string;
  search_path: string[];
}

function buildCodeGrammars(): Command {
  return {
    name: "grammars",
    summary: "which tree-sitter grammars are staged locally, and where",
    help:
      "Reports the runtime (tree-sitter.wasm, shipped inside the package) and every grammar in the " +
      "catalogue: present, corrupt (on disk but the bytes disagree with the pinned sha256) or " +
      "absent. corrupt is not absent — a half-written file has to name itself rather than look " +
      "like something nobody downloaded yet.",
    handler: async (): Promise<CommandResult> => {
      const { RUNTIME_WASM, findRuntime, formatBytes, grammarSearchPath, grammarStates, grammarsCacheDir } =
        await import("@myc/code-intel/grammars");
      const runtimePath = findRuntime();
      const states = await grammarStates();
      const data: GrammarsData = {
        runtime: {
          file: RUNTIME_WASM,
          path: runtimePath,
          status: runtimePath === null ? "absent" : "present",
        },
        grammars: states.map((g) => ({
          grammar: g.grammar,
          langs: [...g.langs],
          status: g.status,
          size: formatBytes(g.bytes),
          path: g.path,
        })),
        cache_dir: grammarsCacheDir(),
        search_path: grammarSearchPath(),
      };
      return { ok: true, data, meta: { count: data.grammars.length } };
    },
    renderHuman: (data) => {
      const d = data as GrammarsData;
      const out = [`рантайм   ${d.runtime.file}  ${d.runtime.status}  ${d.runtime.path ?? "-"}`];
      for (const g of d.grammars) {
        out.push(
          `${g.status.padEnd(8)}  ${g.grammar.padEnd(11)} ${g.langs.join("/").padEnd(7)} ${g.size.padStart(9)}  ${g.path ?? "-"}`,
        );
      }
      out.push(`кеш       ${d.cache_dir}`);
      const absent = d.grammars.filter((g) => g.status !== "present");
      if (absent.length > 0) {
        out.push(`добыть    myc code fetch ${absent.map((g) => g.langs[0]).join(" ")}`);
      }
      return `${out.join("\n")}\n`;
    },
  };
}

export function createCodeCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "code",
    summary: "built-in code index: build it (code index), read it (code symbol), stage grammars (code fetch)",
    subcommands: [
      buildCodeIndex(deps),
      buildCodeSymbol(deps),
      buildCodeFetch(deps),
      buildCodeGrammars(),
    ],
  };
}
