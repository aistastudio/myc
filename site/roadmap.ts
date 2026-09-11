#!/usr/bin/env bun
/**
 * Счёт вех для сайта: переписывает `roadmap` в site/measurements.json по
 * живому myc ЭТОГО репозитория.
 *
 * Раньше done/total стояли в measurements.json вписанными руками, и сверяло
 * их только `0 ≤ done ≤ total` в site/build.ts. Так на странице одновременно
 * жили «M3 — 6 из 10» в дорожной карте и «M3 стоит на 5 из 10» в разделе
 * «чего нет», а три новых эпика (очередь, английский вывод, замена graft) не
 * попали на сайт вовсе. Число о вехе — такое же измерение, как p99, и у него
 * должна быть команда, которая его повторяет. Вот она.
 *
 * ЧТО СЧИТАЕТСЯ. Ровно то, что печатает `myc show <эпик>` в строке
 * `children  N of M closed`: done — прямые дети со статусом closed, total —
 * все прямые дети, отменённые включительно (отменённая задача — не сделанная
 * работа, show складывает их так же). Под-эпик (замена graft внутри M3, пул
 * статистики внутри M5) считается у родителя одним ребёнком и получает свою
 * строку. Для раздела «что запланировано» записываются незакрытые дети каждой
 * вехи — id, статус, приоритет и заголовок, как он стоит в myc: страница
 * показывает ВСЕ открытые задачи, у которых нет своего описания на сайте, —
 * заголовком из трекера, а site/build.ts не пропускает описание задачи, которая
 * в снимке уже не открыта.
 *
 * ПОЧЕМУ НЕ В build.ts. В CI базы myc нет (в git лежит оплог, а не база), и
 * сборка Pages этого числа посчитать не может. Поэтому скрипт запускает
 * человек или координатор перед релизом — как bench, — а build.ts его вывод
 * только проверяет на форму.
 *
 * НОВЫЙ ЭПИК НЕ ПРОПАДАЕТ МОЛЧА. Список эпиков берётся у myc, и эпик, которого
 * нет в таблице EPICS ниже, роняет скрипт: у него нет английского заголовка и
 * ключа, а выдумывать их скрипт не должен. Эпик из таблицы, которого нет в
 * myc, роняет тоже.
 *
 *   bun run site/roadmap.ts            пересчитать и записать
 *   bun run site/roadmap.ts --check    сверить с measurements.json, ничего не писать
 *   bun run site/roadmap.ts --myc ./dist/myc    каким бинарём спрашивать (или MYC_BIN)
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const measurementsPath = join(repoRoot, "site", "measurements.json");
const checkOnly = process.argv.includes("--check");
const mycBin = flagValue("--myc") ?? process.env.MYC_BIN ?? "myc";

/** Заголовки для страницы. В myc эпики названы по-русски и длинно; ключ — то, что видно в колонке вех. */
type EpicMeta = { id: string; key: string; title_en: string; title_ru: string };

/** Порядок строк = порядок вех на странице: закрытое и почти закрытое сверху, не начатое снизу. */
const EPICS: readonly EpicMeta[] = [
  { id: "memory-5xravkn0anzk", key: "M0", title_en: "core and tasks", title_ru: "ядро и задачи" },
  { id: "memory-ancs66k238nv", key: "M0.5", title_en: "self-hosting: myc developed through myc", title_ru: "самохостинг: myc разрабатывается через myc" },
  { id: "memory-kh9wpqkwj1dm", key: "M1", title_en: "memory", title_ru: "память" },
  { id: "memory-vtvz9sdjekgx", key: "M2", title_en: "semantics", title_ru: "семантика" },
  { id: "memory-cmg64b6vrw0b", key: "M7", title_en: "human interface: board, cards, threads", title_ru: "человек в интерфейсе: доска, карточки, нити" },
  { id: "memory-4ez67f48fcdv", key: "M3", title_en: "code intelligence: anchors code <-> knowledge", title_ru: "код: якоря код ↔ знание" },
  { id: "memory-x20k85amw3z9", key: "graft", title_en: "replacing graft: built-in code intelligence on tree-sitter", title_ru: "замена graft: свой код-интеллект на tree-sitter" },
  { id: "memory-rc2s0m1e9kpz", key: "EN", title_en: "all CLI and MCP output in English", title_ru: "весь вывод CLI и MCP — на английском" },
  { id: "memory-14qyv1gmacef", key: "queue", title_en: "a machine-wide queue for heavy commands", title_ru: "очередь тяжёлых команд на машине" },
  { id: "memory-aw5d21x3wa87", key: "M4", title_en: "team: myc serve, ACL, network sync, Postgres", title_ru: "команда: myc serve, ACL, сетевая синхронизация, Postgres" },
  { id: "memory-0dm3hdvdmr5c", key: "M5", title_en: "swarm self-learning: routing by cost and outcome", title_ru: "самообучение роя: роутинг по цене и результату" },
  { id: "memory-d64pv4dw3m1j", key: "pool", title_en: "a shared pool of agent statistics", title_ru: "общий пул статистики агентов" },
  { id: "memory-6dzxkzwbsc9g", key: "M6", title_en: "distillation", title_ru: "дистилляция" },
];

type Child = { id: string; status: string; priority: number; title: string };
type Row = EpicMeta & {
  status: string;
  parent?: string;
  done: number;
  total: number;
  cancelled: number;
  in_progress: number;
  open: Child[];
};

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`site-roadmap: ${msg}`);
  process.exit(1);
}

/** Один вызов myc с конвертом --json. Деградация — не повод врать числом: она роняет скрипт. */
function myc(args: readonly string[]): any {
  let p: ReturnType<typeof Bun.spawnSync>;
  try {
    p = Bun.spawnSync([mycBin, "-C", repoRoot, ...args, "--json"], { stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    fail(`не запускается «${mycBin}»: ${e instanceof Error ? e.message : String(e)} — укажите бинарь через --myc или MYC_BIN`);
  }
  const out = new TextDecoder().decode(p.stdout);
  if (p.exitCode !== 0) {
    fail(`myc ${args.join(" ")} → код ${p.exitCode}\n${new TextDecoder().decode(p.stderr)}${out}`);
  }
  const env = JSON.parse(out);
  if (env.ok !== true) fail(`myc ${args.join(" ")} ответил ok=false: ${out}`);
  const degraded: unknown[] = env.meta?.degraded ?? [];
  if (degraded.length > 0) fail(`myc ${args.join(" ")} ответил с деградацией ${JSON.stringify(degraded)} — число с неё не снимается`);
  return env.data;
}

// ── Таблица сама по себе ────────────────────────────────────────────────────
{
  const ids = new Set(EPICS.map((e) => e.id));
  const keys = new Set(EPICS.map((e) => e.key));
  if (ids.size !== EPICS.length || keys.size !== EPICS.length) fail("в EPICS повторяется id или ключ");
}

// ── Состав эпиков: таблица обязана совпасть с myc ───────────────────────────
const listed = myc(["list", "--kind", "epic", "-n", "1000"]);
if (listed.truncated === true) fail(`myc list --kind epic обрезан (${listed.shown} из ${listed.total}) — поднимите -n`);
const live = new Map<string, { status: string; title: string }>(
  listed.rows.map((r: any) => [r.id, { status: r.status, title: r.title }]),
);
const unknown = [...live.keys()].filter((id) => !EPICS.some((e) => e.id === id));
const gone = EPICS.filter((e) => !live.has(e.id));
if (unknown.length > 0) {
  fail(
    `в myc есть эпики, которых нет в EPICS (site/roadmap.ts):\n` +
      unknown.map((id) => `  ${id}  ${live.get(id)!.title}`).join("\n") +
      `\nДобавьте каждому ключ и заголовки en/ru — сайт не должен молча терять веху.`,
  );
}
if (gone.length > 0) fail(`эпиков из EPICS нет в myc: ${gone.map((e) => `${e.key} ${e.id}`).join(", ")}`);

// ── Счёт: одним пакетным show, как его печатает человек ─────────────────────
const shown = myc(["show", EPICS.map((e) => e.id).join(",")]);
const nodes: any[] = shown.nodes ?? [shown];
const byId = new Map(nodes.map((n) => [n.id, n]));

const rows: Row[] = EPICS.map((meta) => {
  const n = byId.get(meta.id);
  if (n === undefined) fail(`myc show не вернул ${meta.id}`);
  const children: any[] = n.children ?? [];
  const open: Child[] = children
    .filter((c) => c.status !== "closed" && c.status !== "cancelled")
    .map((c) => ({ id: c.id, status: c.status, priority: c.priority, title: c.title }));
  return {
    ...meta,
    status: n.status,
    ...(n.parent?.id !== undefined ? { parent: n.parent.id } : {}),
    done: children.filter((c) => c.status === "closed").length,
    total: children.length,
    cancelled: children.filter((c) => c.status === "cancelled").length,
    in_progress: children.filter((c) => c.status === "in_progress").length,
    open,
  };
});

const version = new TextDecoder().decode(Bun.spawnSync([mycBin, "--version"], { stdout: "pipe" }).stdout).trim();
const roadmap = {
  command: "bun run site/roadmap.ts",
  as_of: new Date().toISOString().slice(0, 10),
  source: `${version} · ${EPICS.length} epics of this repository's workspace`,
  rows,
};

for (const r of rows) {
  const state = r.total > 0 && r.done === r.total ? "all closed" : r.done === 0 ? "not started" : `${r.total - r.done} not done`;
  const tail = r.in_progress > 0 ? ` · ${r.in_progress} in progress` : "";
  console.log(`  ${r.key.padEnd(6)} ${String(r.done).padStart(3)} / ${String(r.total).padEnd(3)} ${r.status.padEnd(7)} ${state}${tail}`);
}

// ── Запись: заменить ровно значение ключа roadmap, остальной файл — байт в байт ──
const text = readFileSync(measurementsPath, "utf8");
const before = JSON.parse(text);

if (checkOnly) {
  // Дата снимка не сравнивается: число то же — снимок тот же.
  if (isDeepStrictEqual(before.roadmap?.rows, rows)) {
    console.log(`\nroadmap в site/measurements.json совпадает с myc (снят ${before.roadmap?.as_of ?? "без даты"}).`);
    process.exit(0);
  }
  console.error(`\nroadmap в site/measurements.json разошёлся с myc — перезапишите: bun run site/roadmap.ts`);
  process.exit(1);
}

const span = topLevelValueSpan(text, "roadmap");
if (span === undefined) fail(`в ${measurementsPath} нет ключа верхнего уровня "roadmap"`);
// Незакрытый ребёнок — одна строка: полсотни трёхстрочных объектов утопили бы
// в диффе сами числа, ради которых скрипт запускают.
const body = JSON.stringify(roadmap, null, 2).replace(
  /\{\n\s+"id": ("[^"]+"),\n\s+"status": ("[^"]+"),\n\s+"priority": (\d+),\n\s+"title": ("(?:[^"\\]|\\.)*")\n\s+\}/g,
  "{ \"id\": $1, \"status\": $2, \"priority\": $3, \"title\": $4 }",
);
const next = text.slice(0, span[0]) + body.replace(/\n/g, "\n  ") + text.slice(span[1]);
const after = JSON.parse(next);
for (const key of Object.keys(before)) {
  if (key !== "roadmap" && !isDeepStrictEqual(before[key], after[key])) fail(`запись задела ключ ${key} — файл не тронут`);
}
writeFileSync(measurementsPath, next, "utf8");
console.log(`\nsite/measurements.json: roadmap переписан (${rows.length} вех, ${roadmap.as_of}, ${version}). Дальше: bun run site/build.ts`);

/**
 * Где в тексте JSON лежит значение ключа верхнего уровня: [начало, конец).
 * Разбор со строками и экранированием, а не поиск скобки регуляркой: в
 * заголовках вех бывают и скобки, и кавычки.
 */
function topLevelValueSpan(src: string, key: string): [number, number] | undefined {
  let depth = 0;
  let i = 0;
  const readString = (at: number): number => {
    let j = at + 1;
    while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
    return j + 1;
  };
  while (i < src.length) {
    const c = src[i]!;
    if (c === '"') {
      const end = readString(i);
      if (depth === 1 && JSON.parse(src.slice(i, end)) === key && /^\s*:/.test(src.slice(end))) {
        let v = end + src.slice(end).indexOf(":") + 1;
        while (/\s/.test(src[v]!)) v++;
        if (src[v] !== "{" && src[v] !== "[") return undefined;
        let d = 0;
        let k = v;
        do {
          const ch = src[k]!;
          if (ch === '"') { k = readString(k); continue; }
          if (ch === "{" || ch === "[") d++;
          else if (ch === "}" || ch === "]") d--;
          k++;
        } while (d > 0 && k < src.length);
        return [v, k];
      }
      i = end;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") depth--;
    i++;
  }
  return undefined;
}
