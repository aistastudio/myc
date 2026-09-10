/**
 * memory-5h06ty5sz38c: команды кода в терминале и инструменты кода в MCP —
 * один вопрос, две двери. Тест гоняет ОДИН сценарий через обе и сверяет
 * четыре вещи: конверт ответа, человеческий текст, отказы и ИТОГОВОЕ
 * СОСТОЯНИЕ БАЗЫ.
 *
 * ЗАЧЕМ ТАК, А НЕ «ИНСТРУМЕНТ ЗОВЁТ КОМАНДУ, ЗНАЧИТ СОВПАДАЕТ». Расхождение
 * CLI и MCP в этом репозитории ловили шесть раз, и каждый раз совпадение
 * обещалось устройством кода, а не проверялось. Здесь устройство то же —
 * инструмент прогоняет команду, — и ровно поэтому всё, что может разойтись,
 * живёт в переводе аргументов во флаги: забытый `direction`, лимит, зажатый
 * молча, литерал `--limit`, съеденный разбором флагов, отказ, превращённый в
 * пустоту. Сценарий пишет argv терминала РУКАМИ, как набрал бы человек, а не
 * выводит его из диспетчера — иначе тест сверял бы диспетчер с самим собой.
 *
 * ПОЧЕМУ ДВА ВОРКСПЕЙСА, А НЕ ОДИН. Чтения кода пишут в базу: `code symbol`
 * кладёт fan_in в кеш `code_refs`. В общей базе второй проход читал бы кеш
 * первого, и сравнение «состояния после» ничего бы не значило. Дерево и
 * индекс детерминированы (ID не генерируются, пути относительные), поэтому
 * два одинаковых воркспейса дают точное сравнение: A отвечает терминалу, B —
 * инструментам, и после одинаковых вопросов их базы обязаны совпасть.
 *
 * Реестр боевой (registerAll): тест обязан упасть и тогда, когда команда
 * написана, но не подключена.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { CODE_REF_KINDS, CODE_TOOLS, createDispatcher, type Dispatch } from "@myc/mcp";
import { ExitCode } from "../exit.ts";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { registerAll } from "../register.ts";
import { REF_KINDS } from "./callers.ts";

const CHAIN = `export function leaf(n: number): number {
  return n + 1; // --limit: литерал, похожий на флаг
}

export function mid(n: number): number {
  const a = leaf(n);
  const b = leaf(a);
  return leaf(b);
}

export function top(n: number): number {
  return mid(n);
}
`;

const TWINS = `export class Left {
  close(): number {
    return 1;
  }
}

export class Right {
  close(): number {
    return 2;
  }
}
`;

const USE = `import { leaf, top } from "../core/chain.ts";
import { Left } from "../core/twins.ts";

export function useChain(n: number): number {
  const label = String(n);
  return top(leaf(n)) + label.length + new Left().close();
}
`;

const README = "# fixture\n\nleaf — листовая функция; LEAF заглавными тоже leaf.\n";

/**
 * Шестнадцать каталогов по пять функций, каждая зовёт leaf. Нужны не для
 * смысла, а для УМОЛЧАНИЙ: у поиска потолок 10 файлов, у grep 60 групп, у
 * callers 40, у карты 14 каталогов. Пока фикстура меньше любого потолка,
 * лимит, зажатый диспетчером молча, отвечает то же самое, что честный, — и
 * мутация «лимит зажат» выживала (проверено). Здесь каждый потолок превышен,
 * и сценарий это проверяет сам, а не верит числам в этом комментарии.
 */
const MANY_DIRS = 16;
const MANY_FUNCS = 5;

function manyModule(d: number): string {
  const fns = Array.from(
    { length: MANY_FUNCS },
    (_, k) => `export function f${d}_${k}(): number {\n  return leaf(${k});\n}\n`,
  );
  return `import { leaf } from "../../core/chain.ts";\n\n${fns.join("\n")}`;
}

let root: string;
let cliDir: string;
let mcpDir: string;
let home: string;
let registry: Registry;
let mcp: Dispatch;

function out(value: string | Iterable<string>): string {
  return typeof value === "string" ? value : [...value].join("");
}

async function workspace(name: string): Promise<string> {
  const dir = join(root, name);
  mkdirSync(join(dir, ".myc"), { recursive: true });
  mkdirSync(join(dir, "src", "core"), { recursive: true });
  mkdirSync(join(dir, "src", "app"), { recursive: true });
  writeFileSync(join(dir, "src", "core", "chain.ts"), CHAIN);
  writeFileSync(join(dir, "src", "core", "twins.ts"), TWINS);
  writeFileSync(join(dir, "src", "app", "use.ts"), USE);
  writeFileSync(join(dir, "README.md"), README);
  for (let d = 0; d < MANY_DIRS; d++) {
    const sub = join(dir, "src", "many", `d${String(d).padStart(2, "0")}`);
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "mod.ts"), manyModule(d));
  }
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  return dir;
}

function env(): Record<string, string> {
  return { MYC_ACTOR: "parity", MYC_HOME: home };
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "myc-code-parity-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  cliDir = await workspace("cli");
  mcpDir = await workspace("mcp");
  registry = new Registry();
  registerAll(registry);
  mcp = createDispatcher({
    runCli: async (argv) => {
      const r = await run(["-C", mcpDir, ...argv], { registry, env: env() });
      return { code: r.code, stdout: out(r.stdout), stderr: r.stderr };
    },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Сценарий: вопрос = argv терминала + вызов инструмента, написанные порознь
// ---------------------------------------------------------------------------

interface Question {
  readonly what: string;
  readonly cli: readonly string[];
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/** Все шесть инструментов, все их параметры, успехи и отказы. */
function scenario(): Question[] {
  return [
    // поиск по вопросу
    { what: "поиск", cli: ["code", "search", "leaf", "mid"], tool: "myc_code_search", args: { query: "leaf mid" } },
    { what: "поиск, один файл", cli: ["code", "search", "chain", "--limit", "1"], tool: "myc_code_search", args: { query: "chain", limit: 1 } },
    { what: "поиск шире умолчания", cli: ["code", "search", "leaf", "--limit", "15"], tool: "myc_code_search", args: { query: "leaf", limit: 15 } },
    { what: "поиск без находок", cli: ["code", "search", "zzqqxx"], tool: "myc_code_search", args: { query: "zzqqxx" } },
    // все вхождения литерала
    { what: "grep", cli: ["code", "grep", "leaf("], tool: "myc_code_grep", args: { literal: "leaf(" } },
    { what: "grep без регистра", cli: ["code", "grep", "LEAF", "--ignore-case"], tool: "myc_code_grep", args: { literal: "LEAF", ignore_case: true } },
    { what: "grep по языку", cli: ["code", "grep", "leaf", "--lang", "md"], tool: "myc_code_grep", args: { literal: "leaf", lang: ["md"] } },
    { what: "grep по двум языкам", cli: ["code", "grep", "leaf", "--lang", "md,ts"], tool: "myc_code_grep", args: { literal: "leaf", lang: ["md", "ts"] } },
    { what: "grep урезан лимитом", cli: ["code", "grep", "leaf", "--limit", "1"], tool: "myc_code_grep", args: { literal: "leaf", limit: 1 } },
    { what: "grep шире умолчания", cli: ["code", "grep", "leaf(", "--limit", "70"], tool: "myc_code_grep", args: { literal: "leaf(", limit: 70 } },
    { what: "grep литерала-флага", cli: ["code", "grep", "--", "--limit"], tool: "myc_code_grep", args: { literal: "--limit" } },
    // где определён
    { what: "symbol", cli: ["code", "symbol", "leaf"], tool: "myc_code_symbol", args: { name: "leaf" } },
    { what: "symbol нет", cli: ["code", "symbol", "нетакого"], tool: "myc_code_symbol", args: { name: "нетакого" } },
    // кто зовёт и что зовёт
    { what: "callers", cli: ["callers", "leaf"], tool: "myc_callers", args: { name: "leaf" } },
    { what: "callers out", cli: ["callers", "mid", "--direction", "out"], tool: "myc_callers", args: { name: "mid", direction: "out" } },
    { what: "callers глубина 2, вызовы", cli: ["callers", "leaf", "--depth", "2", "--kind", "call"], tool: "myc_callers", args: { name: "leaf", depth: 2, kind: ["call"] } },
    { what: "callers вызовы и импорты", cli: ["callers", "leaf", "--kind", "call,import"], tool: "myc_callers", args: { name: "leaf", kind: ["call", "import"] } },
    { what: "callers радиус", cli: ["callers", "leaf", "--depth", "all"], tool: "myc_callers", args: { name: "leaf", depth: "all" } },
    { what: "callers неоднозначный", cli: ["callers", "close"], tool: "myc_callers", args: { name: "close" } },
    { what: "callers внешний", cli: ["callers", "String"], tool: "myc_callers", args: { name: "String" } },
    { what: "callers урезан", cli: ["callers", "leaf", "--limit", "1"], tool: "myc_callers", args: { name: "leaf", limit: 1 } },
    { what: "callers шире умолчания", cli: ["callers", "leaf", "--limit", "50"], tool: "myc_callers", args: { name: "leaf", limit: 50 } },
    { what: "callers плохое направление", cli: ["callers", "leaf", "--direction", "вбок"], tool: "myc_callers", args: { name: "leaf", direction: "вбок" } },
    { what: "callers плохая глубина", cli: ["callers", "leaf", "--depth", "0"], tool: "myc_callers", args: { name: "leaf", depth: 0 } },
    { what: "callers out без тела", cli: ["callers", "нетакого", "--direction", "out"], tool: "myc_callers", args: { name: "нетакого", direction: "out" } },
    // API файла
    { what: "skeleton", cli: ["skeleton", "src/core/chain.ts"], tool: "myc_skeleton", args: { path: "src/core/chain.ts" } },
    { what: "skeleton экспорт", cli: ["skeleton", "src/core/twins.ts", "--exported"], tool: "myc_skeleton", args: { path: "src/core/twins.ts", exported: true } },
    { what: "skeleton нет файла", cli: ["skeleton", "src/нет.ts"], tool: "myc_skeleton", args: { path: "src/нет.ts" } },
    // карта
    { what: "map", cli: ["code", "map"], tool: "myc_code_map", args: {} },
    { what: "map, один каталог", cli: ["code", "map", "--top", "1"], tool: "myc_code_map", args: { top: 1 } },
    { what: "map шире умолчания", cli: ["code", "map", "--top", "20"], tool: "myc_code_map", args: { top: 20 } },
  ];
}

/** Нормализованный ответ: без времени и без состояния кеша — только то, что обязано совпасть. */
interface Outcome {
  readonly what: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly msg?: string;
  readonly hint?: string;
  readonly data?: unknown;
  readonly warn?: string[];
  readonly text?: string;
}

/**
 * Время и попадание в кеш — цена ответа, а не ответ: `fan_in` второго прогона
 * читается из кеша первого, и в двух дверях порядок прогонов разный.
 */
function stripVolatile(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatile);
  if (typeof value !== "object" || value === null) return value;
  const outObj: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (k === "took_ms" || k.endsWith("_ms") || k === "cached") continue;
    outObj[k] = stripVolatile(v);
  }
  return outObj;
}

function stripVolatileText(text: string): string {
  return text.replace(/\d+ мс/g, "N мс").replace(/из кеша/g, "N мс");
}

/** `--json` встаёт ДО `--`: после разделителя он был бы литералом. */
function withJson(argv: readonly string[]): string[] {
  const sep = argv.indexOf("--");
  return sep < 0 ? [...argv, "--json"] : [...argv.slice(0, sep), "--json", ...argv.slice(sep)];
}

interface EnvelopeOut {
  ok: boolean;
  data: Record<string, unknown> | null;
  meta: Record<string, unknown>;
  warn: { code: string; msg: string }[];
  error?: { code: string; msg: string; hint?: string; exit: number };
}

async function viaCli(q: Question): Promise<Outcome & { exit: number }> {
  const human = await run(["-C", cliDir, ...q.cli], { registry, env: env() });
  const json = await run(["-C", cliDir, ...withJson(q.cli)], { registry, env: env() });
  const e = JSON.parse(out(json.stdout)) as EnvelopeOut;
  if (!e.ok) {
    return {
      what: q.what,
      ok: false,
      code: e.error!.code,
      msg: e.error!.msg,
      ...(e.error!.hint !== undefined ? { hint: e.error!.hint } : {}),
      exit: e.error!.exit,
    };
  }
  return {
    what: q.what,
    ok: true,
    data: stripVolatile(e.data),
    warn: e.warn.map((w) => w.code),
    text: stripVolatileText(out(human.stdout)),
    exit: json.code,
  };
}

async function viaMcp(q: Question): Promise<Outcome> {
  const r = await mcp(q.tool, q.args);
  const raw = r.content[0]!.text;
  if (r.isError === true) {
    // WARN-строки деградации стоят перед отказом; отказ — `myc: code: msg[\nhint: h]`
    const body = raw.split("\n").filter((l) => !l.startsWith("WARN ")).join("\n");
    const [head, hint] = body.split("\nhint: ");
    const m = /^myc: ([^:]+): ([\s\S]*)$/.exec(head!);
    return {
      what: q.what,
      ok: false,
      code: m![1]!,
      msg: m![2]!,
      ...(hint !== undefined ? { hint } : {}),
    };
  }
  const s = r.structuredContent as Record<string, unknown> & { meta: { degraded: string[] } };
  const { meta, ...data } = s;
  return {
    what: q.what,
    ok: true,
    data: stripVolatile(data),
    warn: meta.degraded,
    text: stripVolatileText(raw),
  };
}

/**
 * Состояние базы после сценария: код-индекс и всё, что чтения могли в него
 * дописать. Время (mtime, computed_at) выброшено: файлы двух воркспейсов
 * записаны в разные мгновения.
 */
function dbState(dir: string): Record<string, unknown> {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    const count = (table: string): number =>
      Number((db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n);
    return {
      code_files: db.query("SELECT path, lang, size_bytes, file_hash FROM code_files ORDER BY path").all(),
      code_defs: count("code_defs"),
      code_ref_sites: count("code_ref_sites"),
      code_units: count("code_units"),
      fan_in_cache: db.query("SELECT name, n_files, n_hits FROM code_refs ORDER BY name").all(),
      nodes: count("nodes"),
      edges: count("edges"),
      jobs: db.query("SELECT kind, count(*) AS n FROM jobs GROUP BY kind ORDER BY kind").all(),
    };
  } finally {
    db.close();
  }
}

async function index(dir: string): Promise<void> {
  const r = await run(["-C", dir, "code", "index"], { registry, env: env() });
  expect(r.code).toBe(ExitCode.OK);
}

// ---------------------------------------------------------------------------

describe("команды кода и инструменты кода: один вопрос на две поверхности", () => {
  test("без индекса обе двери говорят, что делать, — одними словами, а не пустотой", async () => {
    // Вопрос к каждому инструменту — в свежем воркспейсе, где индекс не строили.
    const asked = new Map<string, Question>();
    for (const q of scenario()) if (!asked.has(q.tool)) asked.set(q.tool, q);
    expect([...asked.keys()].sort()).toEqual(CODE_TOOLS.map((t) => t.name).sort());

    const cli: Outcome[] = [];
    const tool: Outcome[] = [];
    for (const q of asked.values()) {
      const { exit, ...c } = await viaCli(q);
      // «индекс не построен» — PRECOND (5), а не NOTFOUND (3): разные ответы.
      expect({ what: q.what, exit }).toEqual({ what: q.what, exit: ExitCode.PRECOND });
      cli.push(c);
      tool.push(await viaMcp(q));
    }
    expect(cli).toEqual(tool);
    for (const o of tool) {
      expect({ what: o.what, code: o.code, hint: o.hint }).toEqual({
        what: o.what,
        code: "precond.no_index",
        hint: "myc code index",
      });
    }
    // Ни одна дверь не построила индекс молча вместо ответа.
    expect(dbState(cliDir)["code_files"]).toEqual([]);
    expect(dbState(mcpDir)["code_files"]).toEqual([]);
  });

  test("один сценарий, оба прогона: конверт, текст, отказы и база совпадают", async () => {
    await index(cliDir);
    await index(mcpDir);
    // Индексы близнецы — иначе сравнивать ответы бессмысленно.
    expect(dbState(cliDir)).toEqual(dbState(mcpDir));

    const steps = scenario();
    const cli: Outcome[] = [];
    for (const q of steps) {
      const { exit: _exit, ...c } = await viaCli(q);
      cli.push(c);
    }
    const tool: Outcome[] = [];
    for (const q of steps) tool.push(await viaMcp(q));

    expect(cli).toEqual(tool);

    // Сценарий обязан быть содержательным: список из одних отказов сошёлся
    // бы точно так же и не доказал бы ничего.
    expect(cli.filter((o) => o.ok).length).toBeGreaterThanOrEqual(22);

    // Умолчание каждого лимита НАБЛЮДАЕМО: вопрос без лимита упирается в
    // потолок команды, а вопрос с лимитом выше потолка — нет. Иначе лимит,
    // подменённый диспетчером, был бы невидим для сравнения выше.
    const got = (what: string): Record<string, unknown> =>
      cli.find((o) => o.what === what)!.data as Record<string, unknown>;
    expect((got("поиск")["hits"] as unknown[]).length).toBe(10);
    expect((got("поиск шире умолчания")["hits"] as unknown[]).length).toBeGreaterThan(10);
    expect(got("grep")["truncated"]).toBe(true);
    expect((got("grep")["groups"] as unknown[]).length).toBe(60);
    expect((got("grep шире умолчания")["groups"] as unknown[]).length).toBeGreaterThan(60);
    expect(got("callers")["shown"]).toBe(40);
    expect(got("callers шире умолчания")["shown"]).toBeGreaterThan(40);
    expect((got("map")["clusters"] as unknown[]).length).toBe(14);
    expect((got("map шире умолчания")["clusters"] as unknown[]).length).toBeGreaterThan(14);
    expect(new Set(cli.filter((o) => !o.ok).map((o) => o.code))).toEqual(
      new Set(["notfound.symbol", "notfound.file", "usage.invalid"]),
    );
    // WARN доезжают в обе стороны — и в конверт, и в текст.
    const warned = new Set(cli.flatMap((o) => o.warn ?? []));
    for (const code of ["callers.ambiguous", "callers.external", "code_grep.truncated", "code_search.empty"]) {
      expect(warned.has(code)).toBe(true);
    }
    const ambiguous = tool.find((o) => o.what === "callers неоднозначный")!;
    expect(ambiguous.text).toContain("WARN callers.ambiguous");

    // Итоговая база: те же строки индекса, тот же кеш fan_in, ни одного
    // узла и ни одной работы, которых не было бы у соседа.
    const a = dbState(cliDir);
    const b = dbState(mcpDir);
    expect(a).toEqual(b);
    expect((a["fan_in_cache"] as unknown[]).length).toBeGreaterThan(0);
    expect(a["code_defs"]).toBeGreaterThan(0);
  });

  test("каждый параметр каждого инструмента проходит через сценарий", () => {
    // Параметр, добавленный в схему без вопроса в сценарии, — дверь, которую
    // никто не сверял. Сторож на это: объединение ключей вызовов по
    // инструменту равно набору свойств его схемы.
    const used = new Map<string, Set<string>>();
    for (const q of scenario()) {
      const set = used.get(q.tool) ?? new Set<string>();
      for (const k of Object.keys(q.args)) set.add(k);
      used.set(q.tool, set);
    }
    for (const t of CODE_TOOLS) {
      const props = Object.keys((t.inputSchema as { properties: Record<string, unknown> }).properties);
      expect({ tool: t.name, params: [...(used.get(t.name) ?? [])].sort() }).toEqual({
        tool: t.name,
        params: props.sort(),
      });
    }
  });

  test("схемы инструментов сходятся с командами: виды вхождений и умолчания", async () => {
    // Виды `--kind` — поэлементно, как типы связей у myc_link.
    expect([...CODE_REF_KINDS]).toEqual([...REF_KINDS]);
    const callers = CODE_TOOLS.find((t) => t.name === "myc_callers")!;
    const kind = (callers.inputSchema as { properties: { kind: { items: { enum: string[] } } } }).properties.kind;
    expect(kind.items.enum).toEqual([...REF_KINDS, "all"]);

    // Умолчание, объявленное агенту в схеме, — то же, что у флага команды:
    // иначе агент думает, что видит 10 файлов, а видит 20.
    await registry.materializeAll();
    const cases: [string, string, string[]][] = [
      ["myc_code_search", "limit", ["code", "search"]],
      ["myc_code_grep", "limit", ["code", "grep"]],
      ["myc_callers", "limit", ["callers"]],
      ["myc_code_map", "top", ["code", "map"]],
    ];
    for (const [toolName, param, path] of cases) {
      const t = CODE_TOOLS.find((x) => x.name === toolName)!;
      const def = (t.inputSchema as { properties: Record<string, { default?: unknown }> }).properties[param]!
        .default;
      const flag = registry.resolve(path)!.flags!.find((f) => f.name === param)!;
      expect({ toolName, flag: flag.description }).toEqual({
        toolName,
        flag: expect.stringContaining(`default ${String(def)}`),
      });
    }
  });
});
