/**
 * `myc doctor` — сверка того, что база УТВЕРЖДАЕТ, с тем, что можно пересчитать.
 *
 * Команда появилась последней из тех, на кого продукт уже ссылался: на неё
 * вели 24 упоминания в 17 файлах — тексты отказов миграции, поля `hint` у
 * `precond.schema`, комментарии счётчиков хуков, — а самой команды не было, и
 * `myc doctor` отвечал «unknown command 'doctor'» ровно в тот момент, когда
 * человеку уже плохо. Поэтому разделов ровно три, и это ровно те три, что
 * назывались в подсказках: `--schema`, `--recount`, `--hooks`.
 *
 * БАЗУ ОТКРЫВАЕМ БЕЗ МИГРАЦИЙ, И ЭТО ГЛАВНОЕ РЕШЕНИЕ ЗДЕСЬ. Обычный путь
 * (`openStore` → `openWorkspaceAt` → `migrate`) на базе НОВЕЕ бинаря бросает
 * `precond.schema` и советует `myc doctor --schema`. Если бы doctor ходил тем
 * же путём, совет вёл бы в ту же самую ошибку: единственный сценарий, ради
 * которого команду звали, оказался бы единственным, где она не работает.
 * Поэтому здесь `openDriver` напрямую — соединение, PRAGMA и ничего больше.
 *
 * ЧЕГО НЕ ДЕЛАЕТ. Не чинит: `--recount` СВЕРЯЕТ, а не пересчитывает в базе.
 * Пересчёт замыкания выполняется настоящей `applyRebuild` внутри транзакции,
 * которая гарантированно откатывается, — так сверка не повторяет продуктовую
 * логику своими словами (две реализации разъехались бы молча), и при этом
 * файл базы остаётся байт в байт прежним.
 *
 * И2 (ГРОМКАЯ ДЕГРАДАЦИЯ) ЗДЕСЬ — НЕ УКРАШЕНИЕ, А СМЫСЛ КОМАНДЫ. У каждого
 * пункта три исхода, а не два: «сходится», «расходится» и «НЕ ПРОВЕРЕНО».
 * Диагностика, печатающая «ок» там, где она ничего не смотрела, вреднее
 * молчания: человек уносит уверенность, которой не было. Ровно поэтому
 * `--hooks` про session-start отвечает «не знаю»: этот хук себя не отмечает,
 * а старт сессии от ручного `myc prime` неотличим (memory-q9k2zxfx2mcm), и
 * написать «не срабатывал» значило бы соврать.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import {
  Q,
  applyRebuild,
  diffSchema,
  dumpParentClosure,
  migrate,
  migrations,
  schemaConverges,
  schemaObjects,
  vectorMigrations,
  VEC_MIGRATIONS_TABLE,
  type ClosureRow,
} from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import type {
  Command,
  CommandContext,
  CommandFailure,
  CommandResult,
  Registry,
} from "../registry.ts";
import { swarmMigrations, BOOKKEEPING_TABLE } from "@myc/swarm";
import { openDriver, type CliDriver } from "./store.ts";
import { findWorkspaceDb } from "./wsfind.ts";
import { readCounters, SELF_REPORTING_HOOKS, type HookCounter } from "../hooks/counters.ts";
import { HOOK_SPECS } from "../hooks/templates.ts";
import { WIRE_JOURNAL } from "./wire.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, ...(hint !== undefined ? { hint } : {}) };
}

// ---------------------------------------------------------------------------
// Трёхзначный вердикт: «сходится» / «расходится» / «не проверено»
// ---------------------------------------------------------------------------

/**
 * Четыре исхода, и каждый отвечает на свой вопрос.
 *
 *   ok      — проверили, сходится.
 *   drift   — проверили, расходится. Только этот исход даёт ненулевой выход.
 *   unknown — НЕ проверили или проверить нечем. Печатать здесь «ok» значило бы
 *             отдать человеку уверенность, которой не было (И2).
 *   n/a     — проверять нечего по устройству ЭТОЙ сборки, а не этой базы:
 *             например, хук на команду, которой в сборке нет, — `myc wire`
 *             его и не ставит. Это не деградация и не расхождение.
 */
export type Verdict = "ok" | "drift" | "unknown" | "n/a";

export interface Check {
  readonly name: string;
  readonly verdict: Verdict;
  /** Одна строка человеку: что именно увидели. Без «ок» там, где не смотрели. */
  readonly detail: string;
  /** Подробности расхождения — имена объектов, узлов, событий. */
  readonly items?: readonly string[];
}

// ---------------------------------------------------------------------------
// --schema
// ---------------------------------------------------------------------------

export interface LedgerReport {
  readonly name: string;
  readonly table: string;
  readonly applied: number | null;
  readonly known: number;
  /** `false` — набор к этой базе неприменим (нет расширения), сверять нечего. */
  readonly applicable: boolean;
  readonly why?: string;
}

export interface SchemaSection {
  readonly ledgers: readonly LedgerReport[];
  readonly checks: readonly Check[];
}

function appliedVersion(db: Database, table: string): number | null {
  try {
    const row = db.query(`SELECT max(version) AS v FROM ${table}`).get() as { v: number | null } | null;
    return row?.v ?? null;
  } catch {
    return null; // таблицы учёта нет — набор не накатывался вовсе
  }
}

/**
 * ТРИ НАБОРА МИГРАЦИЙ, ТРИ ТАБЛИЦЫ УЧЁТА, И ЭТО НЕ СЛУЧАЙНОСТЬ. Базовый набор
 * обязателен; векторный накатывается только при живом vec0 (S26), swarm — своим
 * набором (@myc/swarm). У каждого своя таблица учёта, поэтому «версия схемы» —
 * это три числа, а не одно, и сверять их надо порознь.
 *
 * Для сверки ОБЪЕКТОВ это значит вот что: эталон строится в `:memory:` только
 * базовым набором, поэтому объекты двух других наборов обязаны быть из
 * сравнения ИСКЛЮЧЕНЫ — иначе каждая таблица swarm и каждая теневая таблица
 * vec0 прочиталась бы как «лишний объект», и настоящее расхождение утонуло бы
 * в восьми ложных. Именно это и показал первый живой прогон.
 */
interface Ledger {
  readonly name: string;
  readonly table: string;
  readonly known: number;
  readonly objects: readonly string[];
  readonly applicable: boolean;
  readonly why?: string;
}

function ledgers(driver: CliDriver): Ledger[] {
  const maxOf = (ms: readonly { version: number }[]): number =>
    ms.reduce((m, x) => Math.max(m, x.version), 0);
  return [
    {
      name: "векторы",
      table: VEC_MIGRATIONS_TABLE,
      known: maxOf(vectorMigrations),
      objects: [VEC_MIGRATIONS_TABLE, ...vectorMigrations.flatMap((m) => m.objects)],
      applicable: driver.vec0,
      ...(driver.vec0
        ? {}
        : { why: `vec0 не загружен (${driver.vec0Reason ?? "причина не названа"})` }),
    },
    {
      name: "swarm",
      table: BOOKKEEPING_TABLE,
      known: maxOf(swarmMigrations),
      objects: [BOOKKEEPING_TABLE, ...swarmMigrations.flatMap((m) => m.objects)],
      applicable: true,
    },
  ];
}

/**
 * Объекты, принадлежащие набору: сами объявленные плюс их теневые таблицы
 * (vec0 заводит `<имя>_chunks`, `<имя>_info` и прочие сам, объявить их
 * миграция не может).
 */
function ownedBy(live: ReadonlyMap<string, SchemaObjectLike>, roots: readonly string[]): Set<string> {
  const owned = new Set<string>();
  for (const [key, obj] of live) {
    for (const root of roots) {
      if (obj.name === root || obj.name.startsWith(`${root}_`)) {
        owned.add(key);
        break;
      }
    }
  }
  return owned;
}

interface SchemaObjectLike {
  readonly name: string;
}

async function checkSchema(driver: CliDriver): Promise<SchemaSection> {
  const db = driver.database;
  const known = migrations.reduce((m, x) => Math.max(m, x.version), 0);
  const applied = appliedVersion(db, "schema_migrations");
  const checks: Check[] = [];
  const side = ledgers(driver);

  // 1. Версия базового набора. Три исхода, а не два: база может быть и НОВЕЕ
  //    бинаря — ровно тот случай, из которого сюда и присылают.
  const appliedSet = new Set<number>(
    applied === null
      ? []
      : (db.query("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map(
          (r) => r.version,
        ),
  );
  const pending = migrations.filter((m) => !appliedSet.has(m.version)).map((m) => m.version);
  if (applied === null) {
    checks.push({
      name: "версия",
      verdict: "drift",
      detail: "в базе нет таблицы schema_migrations — схема не накатывалась",
    });
  } else if (applied > known) {
    checks.push({
      name: "версия",
      verdict: "drift",
      detail: `база новее бинаря: схема ${applied}, бинарь знает ${known}`,
    });
  } else if (pending.length > 0) {
    checks.push({
      name: "версия",
      verdict: "drift",
      detail: `не применены миграции: ${pending.join(", ")} (бинарь знает до ${known})`,
      items: pending.map(String),
    });
  } else {
    checks.push({ name: "версия", verdict: "ok", detail: `схема ${applied} из ${known}` });
  }

  // 2. Объекты. Эталон — та же база, построенная миграциями ЭТОГО бинаря;
  //    сравнение — тот же модуль, которым schema-parity.test.ts стережёт
  //    db/schema.sqlite.sql, чтобы «расхождение» значило здесь и там одно.
  if (applied === null) {
    checks.push({ name: "объекты", verdict: "unknown", detail: "сравнивать не с чем: схемы нет" });
  } else {
    const reference = new Database(":memory:");
    try {
      await migrate(reference, { migrations, writable: true });
      const live = schemaObjects(db);
      const ignore = new Map<string, string>();
      for (const l of side) {
        for (const key of ownedBy(live, l.objects)) ignore.set(key, `набор «${l.name}»: своя таблица учёта`);
      }
      const diff = diffSchema(schemaObjects(reference), live, { ignore });
      if (schemaConverges(diff)) {
        checks.push({
          name: "объекты",
          verdict: "ok",
          detail: `${live.size - ignore.size} объектов сходятся с миграциями бинаря`,
        });
      } else {
        const items = [
          ...diff.missing.map((k) => `нет в базе: ${k}`),
          ...diff.extra.map((k) => `лишний в базе: ${k}`),
          ...diff.differing.map((k) => `текст DDL разошёлся: ${k}`),
        ];
        checks.push({
          name: "объекты",
          verdict: "drift",
          detail: `расхождений ${items.length}`,
          items,
        });
      }
    } finally {
      reference.close();
    }
  }

  // 3. Побочные наборы. Неприменимый набор — «не знаю», а не «в порядке».
  const reports: LedgerReport[] = [
    { name: "база", table: "schema_migrations", applied, known, applicable: true },
  ];
  for (const l of side) {
    const a = appliedVersion(db, l.table);
    reports.push({
      name: l.name,
      table: l.table,
      applied: a,
      known: l.known,
      applicable: l.applicable,
      ...(l.why !== undefined ? { why: l.why } : {}),
    });
    if (!l.applicable) {
      checks.push({
        name: l.name,
        verdict: "unknown",
        detail: `${l.why ?? "набор неприменим"} — схема этого набора не проверялась`,
      });
    } else if (a === null) {
      // Ни одной строки учёта — набор к этой базе просто не применяли.
      // Свежий `myc init` выглядит ровно так: векторные и swarm-таблицы
      // создаются по потребности, и звать это расхождением значило бы
      // объявить только что созданный воркспейс больным.
      checks.push({
        name: l.name,
        verdict: "n/a",
        detail: `набор не накатывался — его объекты создаются по потребности (бинарь знает до ${l.known})`,
      });
    } else if (a > l.known) {
      checks.push({
        name: l.name,
        verdict: "drift",
        detail: `в базе ${a}, бинарь знает ${l.known} — база новее бинаря`,
      });
    } else if (a < l.known) {
      checks.push({ name: l.name, verdict: "drift", detail: `в базе ${a}, бинарь знает ${l.known} — набор не догнан` });
    } else {
      checks.push({ name: l.name, verdict: "ok", detail: `${a} из ${l.known}` });
    }
  }

  return { ledgers: reports, checks };
}

// ---------------------------------------------------------------------------
// --recount
// ---------------------------------------------------------------------------

export interface RecountSection {
  readonly checks: readonly Check[];
}

interface DriftRow {
  readonly id: string;
  readonly stored: number;
  readonly actual: number;
}

/** Бросается, чтобы откатить транзакцию сверки. Не ошибка — способ выйти. */
class RollbackProbe extends Error {
  constructor(readonly rows: readonly string[]) {
    super("rollback");
  }
}

function closureKey(r: ClosureRow): string {
  return `${r.ancestor}→${r.descendant}@${r.depth}`;
}

/**
 * Расхождение материализованного `parent_closure` с пересчётом из рёбер.
 *
 * Пересчёт делает НАСТОЯЩАЯ `applyRebuild` — та же функция, что чинит базу, —
 * внутри транзакции, из которой мы выходим броском. Своя копия рекурсивного
 * CTE была бы вторым определением истины, и разошлась бы она молча.
 */
function closureDrift(driver: CliDriver): string[] {
  try {
    driver.tx("immediate", (tx) => {
      const before = new Map(dumpParentClosure(tx).map((r) => [closureKey(r), r]));
      applyRebuild(tx);
      const after = new Map(dumpParentClosure(tx).map((r) => [closureKey(r), r]));
      const rows: string[] = [];
      for (const k of after.keys()) if (!before.has(k)) rows.push(`нет строки ${k}`);
      for (const k of before.keys()) if (!after.has(k)) rows.push(`лишняя строка ${k}`);
      throw new RollbackProbe(rows);
    });
    return []; // недостижимо: тело всегда бросает
  } catch (e) {
    if (e instanceof RollbackProbe) return [...e.rows];
    throw e;
  }
}

function counterCheck(name: string, rows: readonly DriftRow[]): Check {
  if (rows.length === 0) return { name, verdict: "ok", detail: "сходится с пересчётом" };
  return {
    name,
    verdict: "drift",
    detail: `узлов с расхождением: ${rows.length}`,
    items: rows.slice(0, 20).map((r) => `${r.id}: в базе ${r.stored}, пересчёт ${r.actual}`),
  };
}

function checkRecount(driver: CliDriver): RecountSection {
  const checks: Check[] = [];
  try {
    checks.push(counterCheck("open_blockers", driver.all<DriftRow>(Q.open_blockers_drift, [])));
    checks.push(counterCheck("anc_blockers", driver.all<DriftRow>(Q.anc_blockers_drift, [])));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    checks.push({ name: "open_blockers", verdict: "unknown", detail: `не проверено: ${why}` });
    checks.push({ name: "anc_blockers", verdict: "unknown", detail: `не проверено: ${why}` });
  }
  try {
    const rows = closureDrift(driver);
    checks.push(
      rows.length === 0
        ? { name: "parent_closure", verdict: "ok", detail: "сходится с пересчётом из рёбер" }
        : {
            name: "parent_closure",
            verdict: "drift",
            detail: `строк с расхождением: ${rows.length}`,
            items: rows.slice(0, 20),
          },
    );
  } catch (e) {
    checks.push({
      name: "parent_closure",
      verdict: "unknown",
      detail: `не проверено: ${e instanceof Error ? e.message : String(e)}`,
    });
  }
  return { checks };
}

// ---------------------------------------------------------------------------
// --hooks
// ---------------------------------------------------------------------------

export interface HookReport {
  readonly event: string;
  readonly command: string;
  /** Стоит ли хук по журналу `myc wire`. `null` — журнала нет, знать неоткуда. */
  readonly installed: boolean | null;
  readonly verdict: Verdict;
  readonly detail: string;
  readonly count?: number;
  readonly last_at?: number;
}

export interface HooksSection {
  readonly journal: boolean;
  readonly hooks: readonly HookReport[];
  readonly checks: readonly Check[];
}

interface WireJournal {
  readonly events: Set<string>;
  /** Когда `myc wire` записал журнал. NaN — в журнале нет отметки. */
  readonly writtenAt: number;
}

/**
 * Молодость установки — не мелочь оформления. Хук, поставленный минуту назад,
 * ещё не мог сработать: `pre-compact` ждёт сжатия контекста, а оно случается
 * через часы. Объявлять это расхождением значит встречать человека, который
 * только что позвал `myc wire`, ненулевым кодом и словом «РАСХОЖД» — то есть
 * ложной тревогой на ровном месте, ровно в первую минуту знакомства.
 */
export const HOOK_GRACE_MS = 24 * 60 * 60 * 1000;

function wiredEvents(mycDir: string): WireJournal | null {
  const path = join(mycDir, WIRE_JOURNAL);
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as {
      entries?: Array<{ nodes?: string[] }>;
      written_at?: number;
    };
    const events = new Set<string>();
    for (const e of j.entries ?? []) {
      for (const node of e.nodes ?? []) {
        if (node.startsWith("hooks.")) events.add(node.slice("hooks.".length));
      }
    }
    return { events, writtenAt: typeof j.written_at === "number" ? j.written_at : Number.NaN };
  } catch {
    return null; // журнал битый — это «не знаю», а не «не поставлено»
  }
}

function when(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Счётчики привязаны к агенту (`claude:pre-compact`), поэтому одно событие
 * может иметь несколько строк. Складываем и берём самое свежее срабатывание.
 */
function counterFor(
  hooks: Readonly<Record<string, HookCounter>>,
  event: string,
): { count: number; last: HookCounter | undefined; agents: string[] } {
  let count = 0;
  let last: HookCounter | undefined;
  const agents: string[] = [];
  for (const [key, c] of Object.entries(hooks)) {
    if (!key.endsWith(`:${event}`)) continue;
    count += c.count;
    agents.push(key.slice(0, key.length - event.length - 1));
    if (last === undefined || c.last_at > last.last_at) last = c;
  }
  return { count, last, agents };
}

function checkHooks(mycDir: string, registry: Registry, now: number = Date.now()): HooksSection {
  const wired = wiredEvents(mycDir);
  const counters = readCounters(mycDir).hooks;
  const reports: HookReport[] = [];

  for (const spec of HOOK_SPECS) {
    const inBuild = registry.hasTop(spec.command);
    const installed = wired === null ? null : wired.events.has(spec.claudeEvent);
    const selfReporting = SELF_REPORTING_HOOKS.includes(spec.event);
    const { count, last, agents } = counterFor(counters, spec.event);

    // Порядок ветвей — от самого твёрдого знания к самому мягкому.
    // Команды нет в сборке — `myc wire` такой хук и не ставит намеренно
    // («обещание, которое некому исполнить»). Это свойство сборки, а не
    // поломка воркспейса: расхождением его считать нельзя, иначе ни один
    // воркспейс никогда не даст выход 0.
    if (!inBuild) {
      reports.push({
        event: spec.event,
        command: spec.command,
        installed: false,
        verdict: "n/a",
        detail: `не ставится: команды \`myc ${spec.command}\` нет в этой сборке`,
      });
      continue;
    }
    if (count > 0 && last !== undefined) {
      reports.push({
        event: spec.event,
        command: spec.command,
        installed,
        verdict: "ok",
        detail: `срабатывал ${count} раз, последний ${when(last.last_at)} (${last.last_status}, ${last.last_ms} мс)${agents.length > 0 ? `, агенты: ${agents.join(", ")}` : ""}`,
        count,
        last_at: last.last_at,
      });
      continue;
    }
    if (installed === null) {
      reports.push({
        event: spec.event,
        command: spec.command,
        installed: null,
        verdict: "unknown",
        detail: `не знаю: журнала .myc/${WIRE_JOURNAL} нет — поставлен ли хук, отсюда не видно`,
      });
      continue;
    }
    if (!installed) {
      reports.push({
        event: spec.event,
        command: spec.command,
        installed: false,
        verdict: "drift",
        detail: "не поставлен: события нет в журнале `myc wire`",
      });
      continue;
    }
    // Поставлен, счётчика нет. Дальше всё решает ОДНО: отмечает ли себя хук.
    // Для session-start ответ «не знаю» — не осторожность, а факт: хук себя
    // не отмечает, а старт сессии от ручного `myc prime` неотличим.
    // Поставлен недавно — молчание счётчика ещё ничего не значит. Отметку
    // времени берём из журнала `myc wire`; её отсутствие (старый журнал)
    // трактуем как «давно», иначе новое поле само стало бы источником
    // ложного «не знаю» у всех, кто настроился раньше.
    const age = wired === null || Number.isNaN(wired.writtenAt) ? Number.POSITIVE_INFINITY : now - wired.writtenAt;
    const fresh = age < HOOK_GRACE_MS;
    reports.push({
      event: spec.event,
      command: spec.command,
      installed: true,
      verdict: selfReporting && !fresh ? "drift" : "unknown",
      detail: !selfReporting
        ? `не знаю: поставлен, но себя не отмечает — \`myc ${spec.command}\` вызывают и руками, и хуком, и отличить их нечем`
        : fresh
          ? `не знаю: поставлен ${when(wired!.writtenAt)} и ещё не срабатывал — событию просто не было повода случиться`
          : "поставлен, но не срабатывал ни разу",
    });
  }

  const checks: Check[] = reports.map((r) => ({
    name: r.event,
    verdict: r.verdict,
    detail: r.detail,
  }));
  return { journal: wired !== null, hooks: reports, checks };
}

// ---------------------------------------------------------------------------
// Сборка отчёта
// ---------------------------------------------------------------------------

export interface DoctorData {
  readonly db: string;
  readonly sections: readonly string[];
  readonly schema?: SchemaSection;
  readonly recount?: RecountSection;
  readonly hooks?: HooksSection;
  readonly ok: boolean;
  readonly unknown: number;
}

const MARK: Record<Verdict, string> = {
  ok: "ok      ",
  drift: "РАСХОЖД ",
  unknown: "не знаю ",
  "n/a": "н/д     ",
};

function sectionChecks(data: DoctorData, name: string): readonly Check[] {
  if (name === "schema") return data.schema?.checks ?? [];
  if (name === "recount") return data.recount?.checks ?? [];
  return data.hooks?.checks ?? [];
}

const TITLE: Record<string, string> = {
  schema: "схема",
  recount: "счётчики",
  hooks: "хуки",
};

/**
 * Один рендер на два выхода: человеческий вывод успеха и текст отказа, когда
 * что-то разошлось. Два рендера разъехались бы, и «что именно сломано» на
 * ненулевом коде выхода печаталось бы иначе, чем на нулевом.
 */
export function renderReport(data: DoctorData, verbose: boolean): string[] {
  const lines: string[] = [`база ${data.db}`];
  for (const name of data.sections) {
    const checks = sectionChecks(data, name);
    lines.push(`${TITLE[name] ?? name}`);
    for (const c of checks) {
      lines.push(`  ${MARK[c.verdict]} ${c.name}: ${c.detail}`);
      if (!verbose) continue;
      for (const item of c.items ?? []) lines.push(`             ${item}`);
    }
  }
  return lines;
}

function verdictOf(checks: readonly Check[]): { drift: number; unknown: number } {
  let drift = 0;
  let unknown = 0;
  for (const c of checks) {
    if (c.verdict === "drift") drift++;
    else if (c.verdict === "unknown") unknown++;
  }
  return { drift, unknown };
}

function dbPathOf(ctx: CommandContext): { path: string } | CommandFailure {
  const explicit = ctx.globals.db;
  if (explicit !== undefined) return { path: resolve(explicit) };
  const found = findWorkspaceDb(ctx.globals.directory ?? process.cwd());
  if ("dbPath" in found) return { path: found.dbPath };
  return failure(
    "ws.not_initialized",
    `воркспейс не инициализирован: искали ${found.searched.join(", ")}`,
    ExitCode.NOWS,
    "myc init",
  );
}

export function createDoctorCommand(registry: Registry): Command {
  return {
    name: "doctor",
    summary: "check what the database claims against what can be recounted",
    flags: [
      { name: "schema", description: "schema version and object-level diff against this binary" },
      { name: "recount", description: "materialised counters against a recount from the graph" },
      { name: "hooks", description: "when each hook last fired, and which events are not installed" },
      { name: "verbose", description: "list every diverging object, node and row, not just counts" },
    ],
    help:
      "Exit 0 only when every checked item converges. A section that could not be checked is " +
      "reported as 'не знаю' and never as 'ok' — a diagnostic that prints ok where it looked at " +
      "nothing is worse than silence.\n\n" +
      "The database is opened WITHOUT running migrations, on purpose: a database written by a " +
      "newer myc refuses to open on the normal path with `precond.schema`, and that failure is " +
      "exactly what sends people here.\n\n" +
      "--recount only compares. `parent_closure` is compared by running the real rebuild inside " +
      "a transaction that is always rolled back, so the file is left byte-for-byte unchanged " +
      "and the check cannot drift from the repair it mirrors.\n\n" +
      "--hooks distinguishes three states: fired (with when and how long), not installed (with " +
      "why), and 'не знаю' — installed but self-reporting nothing. Only pre-compact marks " +
      "itself today; session-start cannot be told apart from a hand-typed `myc prime`.",
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const want = {
        schema: ctx.flags["schema"] === true,
        recount: ctx.flags["recount"] === true,
        hooks: ctx.flags["hooks"] === true,
      };
      const all = !want.schema && !want.recount && !want.hooks;
      const sections = (["schema", "recount", "hooks"] as const).filter((s) => all || want[s]);
      const verbose = ctx.flags["verbose"] === true || !all;

      const located = dbPathOf(ctx);
      if ("ok" in located) return located;
      const dbPath = located.path;
      if (!existsSync(dbPath)) {
        return failure("ws.not_initialized", `базы нет: ${dbPath}`, ExitCode.NOWS, "myc init");
      }
      const mycDir = dirname(dbPath).split(sep).pop() === ".myc" ? dirname(dbPath) : dirname(dbPath);

      let driver: CliDriver | undefined;
      const needsDb = sections.includes("schema") || sections.includes("recount");
      if (needsDb) {
        try {
          driver = openDriver(dbPath, undefined, { extensions: true });
        } catch (e) {
          return failure(
            "db.open",
            `база не открывается: ${e instanceof Error ? e.message : String(e)}`,
            ExitCode.ERR,
          );
        }
      }

      try {
        const schema = sections.includes("schema") ? await checkSchema(driver!) : undefined;
        const recount = sections.includes("recount") ? checkRecount(driver!) : undefined;
        const hooks = sections.includes("hooks") ? checkHooks(mycDir, registry) : undefined;

        const checks = [
          ...(schema?.checks ?? []),
          ...(recount?.checks ?? []),
          ...(hooks?.checks ?? []),
        ];
        const { drift, unknown } = verdictOf(checks);

        // Каждая находка уходит и в diagnostics: на ненулевом коде выхода
        // конверт отказа несёт только code/msg/hint, и без warn[] агент не
        // узнал бы, ЧТО именно разошлось, — только что «что-то».
        for (const c of checks) {
          if (c.verdict === "drift") ctx.warn("doctor.drift", `${c.name}: ${c.detail}`);
          else if (c.verdict === "unknown") ctx.warn("doctor.unknown", `${c.name}: ${c.detail}`);
        }

        const data: DoctorData = {
          db: dbPath,
          sections: [...sections],
          ...(schema !== undefined ? { schema } : {}),
          ...(recount !== undefined ? { recount } : {}),
          ...(hooks !== undefined ? { hooks } : {}),
          ok: drift === 0,
          unknown,
        };

        if (drift > 0) {
          return failure(
            "precond.drift",
            [`расхождений: ${drift}`, ...renderReport(data, verbose)].join("\n"),
            ExitCode.PRECOND,
          );
        }
        return { ok: true, data, meta: { drift, unknown } };
      } finally {
        driver?.close();
      }
    },
    // Строкой, а не Iterable: чанки отдаются в поток как есть, без разделителя,
    // и список строк слился бы в одну (проверено первым живым прогоном).
    renderHuman: (raw, ctx) => {
      const data = raw as DoctorData;
      const verbose = ctx.flags["verbose"] === true || data.sections.length < 3;
      return `${renderReport(data, verbose).join("\n")}\n`;
    },
  };
}
