/**
 * `myc callers` — кто зовёт символ, кого зовёт он, и на какую глубину
 * (memory-wrntvzwx8dh0, §4.3 docs/design/05-code-intelligence.md).
 *
 * ЗАЧЕМ. Ради ЭТОГО вопроса в проекте держали graft: «что сломается, если я
 * трону X» не отвечается ни grep-ом (он не знает, кому принадлежит строка),
 * ни `myc code symbol` (он знает, где символ объявлен, и сколько раз имя
 * встречается — числом, без адресов). Недостающее звено — вхождение с
 * ВЛАДЕЛЬЦЕМ; его положили в `code_ref_sites` (миграция 011), и здесь оно
 * впервые становится ответом.
 *
 * ПОЧЕМУ ВЫДАЧА ГРУППИРУЕТСЯ ПО ЗОВУЩЕМУ, А НЕ ПО СТРОКАМ. `listDefs` на этом
 * репозитории даёт 35 вхождений и 5 зовущих. Список из 35 строк — это `grep
 * -n` с лишним столбцом: агент, который спросил «кто зовёт», получает
 * материал для второго вопроса вместо ответа на первый. Список из 5
 * владельцев — это ребро графа, то есть та единица, которой человек думает
 * про правку. Поэтому группа — пара (владелец, файл), а строки живут ВНУТРИ
 * неё: и «кто», и «где» в одном ответе, без второго запроса. Отличие от
 * graft, который на ту же группу печатает ОДНУ строку-образец: у нас внутри
 * группы видно все вхождения, и `refs.test.ts:177,204` не теряются за
 * строкой импорта.
 *
 * ВЕРХНИЙ УРОВЕНЬ ФАЙЛА — НЕ СИМВОЛ. У `import { listDefs }` и у вызова в
 * теле `test(...)` владельца нет: они стоят на верхнем уровне модуля. graft
 * подписывает такую группу ИМЕНЕМ ФАЙЛА и его полным спаном
 * (`refs.test.ts (L1-L267)`), то есть притворяется, что файл — это символ.
 * Мы пишем «верхний уровень», потому что обход графа на этом узле КОНЧАЕТСЯ:
 * у него нет зовущего, и делать вид, что есть, значило бы обещать шаг, которого
 * не будет.
 *
 * ЧЕГО ЭТОТ ОТВЕТ НЕ ЗНАЕТ, СВЕРХ СПИСКА В `refs.ts`. Голова обобщённого типа
 * теряется разбором: в `): DigestLookup<T> {` записывается `T`, а `DigestLookup`
 * — нет, потому что у узла `generic_type` дочернее поле называется `name`, и
 * правило «имя собственного объявления — не ссылка» срабатывает на нём. Замер
 * на этом репозитории: ссылок вида `type` на `Promise`/`Map`/`Record`/`Set` —
 * НОЛЬ при 504 текстовых `Promise<`. Команда об этом говорит в справке; чинить
 * это здесь нельзя (границы задачи не пускают в `refs.ts`), и делать вид, что
 * ответ полон, — тоже.
 *
 * ГЛУБИНА — ЗАМЕР, А НЕ ВЕРА. `--depth all` на этом репозитории (154 360
 * ссылок) стоит 48 мс и приводит в 1766 символов из 2601 владельца. Дёшево по
 * времени и почти бесполезно по смыслу: граф идёт ПО ИМЕНАМ, а имя `run`
 * определено 16 раз, `main` — 16, `close` — 13, и любой путь, прошедший через
 * такое имя, склеивает чужие поддеревья. Поэтому команда печатает и цену
 * (мс, запросы), и состав протечки (какие пройденные имена неоднозначны), и
 * прирост по шагам: решение «доверять ли этому радиусу» принимает читатель,
 * а данных для решения до сих пор не давал никто.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import { flagBool, flagStr, realStoreDeps, type StoreDeps } from "./store.ts";
import { codeRepo, count } from "./code.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

/**
 * Все виды вхождений — они же значения `--kind`. Экспорт — для сверки со
 * схемой инструмента myc_callers (code.parity.test.ts): у MCP своя копия.
 */
export const REF_KINDS = ["call", "new", "type", "import", "read", "prop"] as const;

/** Сколько групп печатается по умолчанию: дальше ответ перестаёт читаться. */
const DEFAULT_LIMIT = 40;

const FLAGS: readonly FlagSpec[] = [
  {
    name: "direction",
    value: "string",
    description: "in — who calls the symbol (default), out — what the symbol calls",
  },
  {
    name: "depth",
    value: "string",
    description: "hops to walk: 1 (default), N, or all (the full blast radius)",
  },
  {
    name: "kind",
    value: "string",
    description:
      `ref kinds to keep, comma-separated or all: ${REF_KINDS.join(",")} ` +
      "(default: every kind for --direction in, call,new for out)",
  },
  { name: "limit", value: "number", description: `groups to print (default ${DEFAULT_LIMIT})` },
  { name: "no-source", description: "do not read files for the source line of each site" },
  {
    name: "max-nodes",
    value: "number",
    description: "stop the walk after this many symbols (default 5000) and say so",
  },
  { name: "repo", value: "string", description: "repo id to search (default: derived from cwd)" },
];

interface SiteOut {
  line: number;
  kind: string;
  /** Строка исходника; отсутствует при --no-source или если файл не прочитан. */
  text?: string;
}

interface EdgeOut {
  depth: number;
  /** Зовущий символ; "" — верхний уровень файла. */
  caller: string;
  callee: string;
  path: string;
  caller_start: number;
  caller_end: number;
  /** Только для --direction out: определено ли зовомое имя в этом репозитории. */
  callee_defined?: boolean;
  sites: SiteOut[];
}

interface CallersData {
  repo: string;
  name: string;
  direction: "in" | "out";
  depth: number | "all";
  kinds: string[];
  defs: {
    path: string;
    kind: string;
    lang: string;
    span_start: number;
    span_end: number;
    exported: boolean;
  }[];
  /**
   * Имя определено больше одного раза — ссылки по имени МЕЖДУ определениями не
   * разделены. Поле есть всегда, а не появляется при беде.
   */
  ambiguous: boolean;
  edges: EdgeOut[];
  shown: number;
  total_edges: number;
  nodes: number;
  levels: number[];
  sites: number;
  kind_counts: Record<string, number>;
  /** Неоднозначные имена, ПРОЙДЕННЫЕ обходом: через них он и протекает. */
  ambiguous_nodes: { name: string; defs: number }[];
  stopped: { reason: string; limit: number } | null;
  searched: { files: number; defs: number; refs: number };
  queries: number;
  files_read: number;
  took_ms: number;
}

function parseDepth(raw: string | undefined): number | "bad" {
  if (raw === undefined || raw.trim().length === 0) return 1;
  const s = raw.trim().toLowerCase();
  if (s === "all") return Number.POSITIVE_INFINITY;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return "bad";
  return n;
}

/**
 * Умолчание вида зависит от направления, и это следствие границы разбора
 * (`refs.ts`, п. 3: локальные имена от глобальных не отличаются).
 *
 * `in` — «кто трогает это имя»: там важна полнота, вхождений обычно единицы, а
 * `read` (символ передан значением) — такое же ребро, просто отложенное.
 * `out` — «что делает это тело»: со всеми видами ответ на 80% состоит из
 * чтений собственных локальных переменных (`d`, `hits`, `db`), то есть из
 * шума, который сам разбор честно объявил неотличимым от ссылок. Поэтому по
 * умолчанию остаются вызовы и конструкторы; `--kind all` возвращает всё.
 */
const OUT_DEFAULT_KINDS: readonly string[] = ["call", "new"];

function parseKinds(raw: string | undefined, direction: "in" | "out"): string[] | "bad" {
  if (raw === undefined || raw.trim().length === 0) {
    return direction === "out" ? [...OUT_DEFAULT_KINDS] : [...REF_KINDS];
  }
  if (raw.trim().toLowerCase() === "all") return [...REF_KINDS];
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  if (parts.length === 0 || parts.some((p) => !(REF_KINDS as readonly string[]).includes(p))) {
    return "bad";
  }
  return parts;
}

/** Читатель строк файла с кешем на один вызов команды. */
function sourceReader(root: string): { line(path: string, n: number): string | undefined; files(): number } {
  const cache = new Map<string, string[] | null>();
  return {
    line(path, n) {
      let lines = cache.get(path);
      if (lines === undefined) {
        try {
          lines = readFileSync(join(root, path), "utf8").split("\n");
        } catch {
          lines = null;
        }
        cache.set(path, lines);
      }
      if (lines === null) return undefined;
      const s = lines[n - 1];
      if (s === undefined) return undefined;
      const t = s.trim();
      return t.length > 140 ? `${t.slice(0, 139)}…` : t;
    },
    files: () => [...cache.values()].filter((v) => v !== null).length,
  };
}

export function createCallersCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "callers",
    summary: "who calls a symbol (and, with --direction out, what it calls): callers <name>",
    help:
      "Reads code_ref_sites built by `myc code index`: every syntactic occurrence of <name> in a " +
      "USE position, grouped by the symbol that owns the line. A group is one edge of the call " +
      "graph — caller, file, and every line inside it — not a list of matches. `--direction out` " +
      "walks the other way (what this symbol references, closures included); `--depth N` or " +
      "`--depth all` walks transitively and prints what that cost and how far it leaked. The " +
      "graph is BY NAME: same-named methods of different classes are one node, import aliases are " +
      "not resolved, and a local variable shadowing a global is not told apart from it — a name " +
      "with more than one definition is reported as ambiguous instead of being picked at random. " +
      "Comments and string literals are not in the index at all, so a mention that lives only in " +
      "a comment will not be found here — and neither is the HEAD of a generic type: `Foo<T>` in " +
      "type position records `T` and loses `Foo` (measured: zero type refs to Promise/Map/Record " +
      "in this repo against 504 textual `Promise<`).",
    flags: FLAGS,
    handler: async (ctx) => {
      const t0 = performance.now();
      const raw = ctx.args[0];
      if (raw === undefined || raw.trim().length === 0) {
        return failure("usage.invalid", "usage: myc callers <name>", ExitCode.USAGE);
      }
      const name = raw.trim();
      const direction = (flagStr(ctx, "direction") ?? "in").trim().toLowerCase();
      if (direction !== "in" && direction !== "out") {
        return failure(
          "usage.invalid",
          `--direction takes in or out, not "${direction}"`,
          ExitCode.USAGE,
        );
      }
      const depth = parseDepth(flagStr(ctx, "depth"));
      if (depth === "bad") {
        return failure(
          "usage.invalid",
          `--depth takes an integer from 1, or all, not "${flagStr(ctx, "depth")}"`,
          ExitCode.USAGE,
        );
      }
      const kinds = parseKinds(flagStr(ctx, "kind"), direction);
      if (kinds === "bad") {
        return failure(
          "usage.invalid",
          `--kind takes all, or comma-separated kinds from: ${REF_KINDS.join(", ")}`,
          ExitCode.USAGE,
        );
      }
      const limitRaw = ctx.flags["limit"];
      const limit = typeof limitRaw === "number" && limitRaw > 0 ? Math.floor(limitRaw) : DEFAULT_LIMIT;
      const maxNodesRaw = ctx.flags["max-nodes"];
      const maxNodes =
        typeof maxNodesRaw === "number" && maxNodesRaw > 0 ? Math.floor(maxNodesRaw) : 5000;

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const { repoId, repoRoot } = await codeRepo(h, flagStr(ctx, "repo"));
        const { callGraph, indexScope, refsIndexed, symbolDefs } = await import(
          "@myc/code-intel/read"
        );
        const db = h.driver.database;
        const scope = indexScope(db, repoId);
        if (scope.files === 0) {
          return failure(
            "precond.no_index",
            `the code index of this repo (${repoId.length > 0 ? repoId : "workspace root"}) is not built: ` +
              "code_files has zero rows — nothing to build the call graph from",
            ExitCode.PRECOND,
            "myc code index",
          );
        }
        const refs = refsIndexed(db, repoId);
        if (refs === 0) {
          return failure(
            "precond.no_refs",
            `the index has zero references across ${count(scope.files, "file")} and ${count(scope.defs, "symbol")}: ` +
              "the code_ref_sites table is empty — \"nobody calls it\" and \"references were never built\" look the same here",
            ExitCode.PRECOND,
            "myc code index",
          );
        }

        const defs = symbolDefs(db, repoId, name);
        if (direction === "out" && defs.length === 0) {
          return failure(
            "notfound.symbol",
            `symbol ${name} is not in code_defs: its body is not in this repo, so there is nothing ` +
              `to ask what it calls (scanned ${count(scope.files, "file")}, ${count(scope.defs, "symbol")})`,
            ExitCode.NOTFOUND,
            "myc callers " + name + "   # who calls it: works for an external name too",
          );
        }

        const graph = callGraph(db, repoId, name, {
          direction,
          depth: depth as number,
          kinds,
          maxNodes,
        });

        // Неоднозначность соседей считается ТОЛЬКО у транзитивного обхода, и
        // это не экономия запроса. На глубине 1 каждое ребро названо путём и
        // спаном владельца — оно ТОЧНО, сколько бы одноимённых символов ни
        // было в репозитории. Неоднозначность начинает вредить ровно тогда,
        // когда имя владельца становится СЛЕДУЮЩИМ запросом: там путь уже
        // потерян, и поддеревья однофамильцев склеиваются. Печатать её на
        // глубине 1 значило бы предупреждать о вреде, которого в этом ответе
        // нет.
        const ambiguousNodes: { name: string; defs: number }[] = [];
        if (graph.nodes.length > 0 && depth > 1) {
          const q = db.query(
            "SELECT name, count(*) AS n FROM code_defs WHERE repo_id = ?1 GROUP BY name HAVING n > 1",
          );
          const multi = new Map(
            (q.all(repoId) as Array<{ name: string; n: number }>).map((r) => [r.name, Number(r.n)]),
          );
          for (const n of graph.nodes) {
            const c = multi.get(n);
            if (c !== undefined) ambiguousNodes.push({ name: n, defs: c });
          }
          ambiguousNodes.sort((a, b) => b.defs - a.defs || a.name.localeCompare(b.name));
        }

        const withSource = !flagBool(ctx, "no-source");
        const src = sourceReader(repoRoot);
        const shownEdges = graph.edges.slice(0, limit);

        // Конец спана зовущего берётся из `code_defs` того же файла: без него
        // ссылка вела бы на строку объявления и молчала о размере символа.
        // Файлов в показанной выдаче не больше `--limit`, и каждый запрос идёт
        // префиксом первичного ключа (repo_id, path).
        const { fileDefs } = await import("@myc/code-intel/read");
        const spanEnd = new Map<string, number>();
        const seenPaths = new Set<string>();
        for (const e of shownEdges) {
          if (e.callerStart === 0 || seenPaths.has(e.path)) continue;
          seenPaths.add(e.path);
          for (const fd of fileDefs(db, repoId, e.path)) {
            spanEnd.set(`${e.path}:${fd.spanStart}:${fd.name}`, fd.spanEnd);
          }
        }
        // Для `--direction out` важно отличить «зовёт своё» от «зовёт чужое»:
        // у импортированного имени тела здесь нет, и следующий шаг обхода по
        // нему невозможен. Один запрос на всю выдачу.
        const defined =
          direction === "out"
            ? new Set(
                (
                  db
                    .query("SELECT DISTINCT name FROM code_defs WHERE repo_id = ?1")
                    .all(repoId) as Array<{ name: string }>
                ).map((r) => r.name),
              )
            : null;

        const edges: EdgeOut[] = shownEdges.map((e) => ({
          depth: e.depth,
          caller: e.caller,
          callee: e.callee,
          path: e.path,
          caller_start: e.callerStart,
          caller_end: spanEnd.get(`${e.path}:${e.callerStart}:${e.caller}`) ?? 0,
          callee_defined: defined === null ? undefined : defined.has(e.callee),
          sites: e.sites.map((s) => {
            const text = withSource ? src.line(e.path, s.line) : undefined;
            return text === undefined ? { line: s.line, kind: s.kind } : { line: s.line, kind: s.kind, text };
          }),
        }));

        const kindCounts: Record<string, number> = {};
        for (const e of graph.edges) {
          for (const s of e.sites) kindCounts[s.kind] = (kindCounts[s.kind] ?? 0) + 1;
        }

        const data: CallersData = {
          repo: repoId,
          name,
          direction,
          depth: depth === Number.POSITIVE_INFINITY ? "all" : (depth as number),
          kinds,
          defs: defs.map((d) => ({
            path: d.path,
            kind: d.kind,
            lang: d.lang,
            span_start: d.spanStart,
            span_end: d.spanEnd,
            exported: d.exported,
          })),
          ambiguous: defs.length > 1,
          edges,
          shown: edges.length,
          total_edges: graph.edges.length,
          nodes: graph.nodes.length,
          levels: [...graph.levels],
          sites: graph.sites,
          kind_counts: kindCounts,
          ambiguous_nodes: ambiguousNodes.slice(0, 10),
          stopped: graph.stopped,
          searched: { files: scope.files, defs: scope.defs, refs },
          queries: graph.queries,
          files_read: src.files(),
          took_ms: 0,
        };
        data.took_ms = Math.round(performance.now() - t0);

        // §6.3: пустой выдачи без причины не бывает. Три разных «пусто» —
        // три разных ответа, и путать их нельзя.
        if (graph.edges.length === 0 && defs.length === 0) {
          return failure(
            "notfound.symbol",
            `name ${name} is in neither definitions nor references: scanned ${count(scope.files, "file")}, ` +
              `${count(scope.defs, "symbol")}, ${count(refs, "reference")}`,
            ExitCode.NOTFOUND,
            "the index may be behind: myc code index",
          );
        }
        if (defs.length === 0) {
          ctx.warn(
            "callers.external",
            `${name} has no definition in this repo — the name is external (an import) or declared ` +
              "in a language without symbol parsing; only occurrences are shown",
          );
        }
        if (data.ambiguous) {
          ctx.warn(
            "callers.ambiguous",
            `name ${name} is defined ${defs.length} times (${defs
              .map((d) => `${d.path}:${d.spanStart}`)
              .slice(0, 4)
              .join(", ")}${defs.length > 4 ? ", …" : ""}) — references by name are NOT split between them`,
          );
        }
        if (graph.stopped !== null) {
          ctx.warn(
            "callers.truncated",
            `the walk stopped at the cap of ${graph.stopped.limit} symbols — the radius is INCOMPLETE`,
          );
        }
        return { ok: true, data, meta: { took_ms: data.took_ms, count: data.total_edges } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as CallersData;
      const out: string[] = [];
      const head =
        d.defs.length > 0
          ? d.defs
              .map(
                (x) =>
                  `${d.name} · ${x.kind} · ${x.path}:${x.span_start}-${x.span_end}` +
                  `${x.exported ? " · exported" : ""}`,
              )
              .join("\n")
          : `${d.name} · no definition in the index (external name)`;
      out.push(head);
      const kindsLabel = d.kinds.length === REF_KINDS.length ? "all kinds" : d.kinds.join(",");
      out.push(
        `${d.direction === "in" ? "callers" : "callees"} · depth ${d.depth} · ${kindsLabel}`,
        "",
      );

      let lastDepth = 0;
      for (const e of d.edges) {
        if (d.depth !== 1 && e.depth !== lastDepth) {
          const added = d.levels[e.depth - 1] ?? 0;
          out.push(`step ${e.depth}  (+${count(added, "symbol")})`);
          lastDepth = e.depth;
        }
        const owner = e.caller.length > 0 ? e.caller : "top level";
        const at =
          e.caller_start > 0
            ? `${e.path}:${e.caller_start}${e.caller_end > 0 ? `-${e.caller_end}` : ""}`
            : e.path;
        const arrow = d.direction === "in" ? "←" : "→";
        const label = d.direction === "in" ? owner : e.callee;
        const tail =
          d.direction === "out"
            ? `${e.callee_defined === false ? "  [external]" : ""}` +
              `${owner !== d.name && owner.length > 0 ? `  (in ${owner})` : ""}`
            : "";
        out.push(`${arrow} ${label}  ${at}${tail}`);
        for (const s of e.sites) {
          out.push(`    ${String(s.line).padStart(5)}  ${s.kind.padEnd(6)} ${s.text ?? ""}`.trimEnd());
        }
      }
      if (d.edges.length === 0) {
        out.push(
          d.direction === "in"
            ? "nobody calls it: the index has no occurrences of this name"
            : "this symbol references nothing: its span has no occurrences",
        );
      }
      if (d.shown < d.total_edges) {
        out.push("", `shown ${d.shown} of ${d.total_edges} groups — the rest is past --limit`);
      }

      const kinds = Object.entries(d.kind_counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k} ${n}`)
        .join(", ");
      out.push(
        "",
        `symbols ${d.nodes}, groups ${d.total_edges}, occurrences ${d.sites}${kinds.length > 0 ? `  [${kinds}]` : ""}`,
      );
      if (d.levels.length > 1) out.push(`growth per step  ${d.levels.join(" → ")}`);
      if (d.ambiguous_nodes.length > 0) {
        out.push(
          `the walk went through ambiguous names: ` +
            d.ambiguous_nodes.map((a) => `${a.name} (${a.defs})`).join(", ") +
            " — their subtrees are merged",
        );
      }
      if (d.stopped !== null) {
        out.push(`WALK CUT OFF: cap of ${d.stopped.limit} symbols, the radius is incomplete`);
      }
      out.push(
        `scanned ${count(d.searched.files, "file")}, ${count(d.searched.defs, "symbol")}, ${count(d.searched.refs, "reference")}; ` +
          `queries ${d.queries}, files read ${d.files_read}  ${d.took_ms} ms`,
      );
      return `${out.join("\n")}\n`;
    },
  };
}
