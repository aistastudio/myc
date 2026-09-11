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
 * молчания: человек уносит уверенность, которой не было.
 *
 * `--hooks` отвечает на два разных вопроса, и оба здесь. СРАБАТЫВАЛ ЛИ хук —
 * по счётчику `.myc/hooks.json`; отметку ставит только вызов, объявивший себя
 * через `MYC_HOOK` (helper объявляет, человек — нет), поэтому «session-start
 * срабатывал N раз» означает ровно старт сессии, а не «кто-нибудь запускал
 * `myc prime`» (memory-q9k2zxfx2mcm). ТОТ ЛИ ХУК СТОИТ — сверкой хеша
 * установленного файла с тем, что дала бы эта сборка: устаревший helper тикал
 * исправно и печатался как `ok`, пока молча не передавал `--session`
 * (memory-h12hjebzr0he).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
import {
  HOLLOW_STATUS,
  readCounters,
  SELF_REPORTING_HOOKS,
  type HookCounter,
} from "../hooks/counters.ts";
import { HOOK_SPECS, type HookEvent } from "../hooks/templates.ts";
import { CLI_VERSION } from "../index.ts";
import {
  isOurStatusLine,
  orcaClaimsStatusLine,
  ourUserStatusLineCommand,
  statusLineCommand,
} from "../statusline-config.ts";
import {
  generatedFiles,
  isUserHookEntry,
  mycPermissions,
  readUserJournal,
  readUserMcp,
  readWireJournal,
  userGeneratedFiles,
  userPaths,
  wireHash,
  WIRE_JOURNAL,
  type Journal,
  type UserJournal,
  type UserPaths,
} from "./wire.ts";

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
      name: "vectors",
      table: VEC_MIGRATIONS_TABLE,
      known: maxOf(vectorMigrations),
      objects: [VEC_MIGRATIONS_TABLE, ...vectorMigrations.flatMap((m) => m.objects)],
      applicable: driver.vec0,
      ...(driver.vec0
        ? {}
        : { why: `vec0 not loaded (${driver.vec0Reason ?? "no reason given"})` }),
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
      name: "version",
      verdict: "drift",
      detail: "no schema_migrations table in the database — the schema was never applied",
    });
  } else if (applied > known) {
    checks.push({
      name: "version",
      verdict: "drift",
      detail: `database is newer than the binary: schema ${applied}, the binary knows ${known}`,
    });
  } else if (pending.length > 0) {
    checks.push({
      name: "version",
      verdict: "drift",
      detail: `migrations not applied: ${pending.join(", ")} (the binary knows up to ${known})`,
      items: pending.map(String),
    });
  } else {
    checks.push({ name: "version", verdict: "ok", detail: `schema ${applied} of ${known}` });
  }

  // 2. Объекты. Эталон — та же база, построенная миграциями ЭТОГО бинаря;
  //    сравнение — тот же модуль, которым schema-parity.test.ts стережёт
  //    db/schema.sqlite.sql, чтобы «расхождение» значило здесь и там одно.
  if (applied === null) {
    checks.push({ name: "objects", verdict: "unknown", detail: "nothing to compare against: no schema" });
  } else {
    const reference = new Database(":memory:");
    try {
      await migrate(reference, { migrations, writable: true });
      const live = schemaObjects(db);
      const ignore = new Map<string, string>();
      for (const l of side) {
        for (const key of ownedBy(live, l.objects)) ignore.set(key, `set "${l.name}": has its own bookkeeping table`);
      }
      const diff = diffSchema(schemaObjects(reference), live, { ignore });
      if (schemaConverges(diff)) {
        checks.push({
          name: "objects",
          verdict: "ok",
          detail: `${live.size - ignore.size} objects match the binary's migrations`,
        });
      } else {
        const items = [
          ...diff.missing.map((k) => `missing from the database: ${k}`),
          ...diff.extra.map((k) => `extra in the database: ${k}`),
          ...diff.differing.map((k) => `DDL text differs: ${k}`),
        ];
        checks.push({
          name: "objects",
          verdict: "drift",
          detail: `${items.length} differences`,
          items,
        });
      }
    } finally {
      reference.close();
    }
  }

  // 3. Побочные наборы. Неприменимый набор — «не знаю», а не «в порядке».
  const reports: LedgerReport[] = [
    { name: "base", table: "schema_migrations", applied, known, applicable: true },
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
        detail: `${l.why ?? "set not applicable"} — this set's schema was not checked`,
      });
    } else if (a === null) {
      // Ни одной строки учёта — набор к этой базе просто не применяли.
      // Свежий `myc init` выглядит ровно так: векторные и swarm-таблицы
      // создаются по потребности, и звать это расхождением значило бы
      // объявить только что созданный воркспейс больным.
      checks.push({
        name: l.name,
        verdict: "n/a",
        detail: `set never applied — its objects are created on demand (the binary knows up to ${l.known})`,
      });
    } else if (a > l.known) {
      checks.push({
        name: l.name,
        verdict: "drift",
        detail: `database has ${a}, the binary knows ${l.known} — the database is newer than the binary`,
      });
    } else if (a < l.known) {
      checks.push({ name: l.name, verdict: "drift", detail: `database has ${a}, the binary knows ${l.known} — the set is behind` });
    } else {
      checks.push({ name: l.name, verdict: "ok", detail: `${a} of ${l.known}` });
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
      for (const k of after.keys()) if (!before.has(k)) rows.push(`missing row ${k}`);
      for (const k of before.keys()) if (!after.has(k)) rows.push(`extra row ${k}`);
      throw new RollbackProbe(rows);
    });
    return []; // недостижимо: тело всегда бросает
  } catch (e) {
    if (e instanceof RollbackProbe) return [...e.rows];
    throw e;
  }
}

function counterCheck(name: string, rows: readonly DriftRow[]): Check {
  if (rows.length === 0) return { name, verdict: "ok", detail: "matches the recount" };
  return {
    name,
    verdict: "drift",
    detail: `nodes that differ: ${rows.length}`,
    items: rows.slice(0, 20).map((r) => `${r.id}: stored ${r.stored}, recount ${r.actual}`),
  };
}

function checkRecount(driver: CliDriver): RecountSection {
  const checks: Check[] = [];
  try {
    checks.push(counterCheck("open_blockers", driver.all<DriftRow>(Q.open_blockers_drift, [])));
    checks.push(counterCheck("anc_blockers", driver.all<DriftRow>(Q.anc_blockers_drift, [])));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    checks.push({ name: "open_blockers", verdict: "unknown", detail: `not checked: ${why}` });
    checks.push({ name: "anc_blockers", verdict: "unknown", detail: `not checked: ${why}` });
  }
  try {
    const rows = closureDrift(driver);
    checks.push(
      rows.length === 0
        ? { name: "parent_closure", verdict: "ok", detail: "matches the recount from edges" }
        : {
            name: "parent_closure",
            verdict: "drift",
            detail: `rows that differ: ${rows.length}`,
            items: rows.slice(0, 20),
          },
    );
  } catch (e) {
    checks.push({
      name: "parent_closure",
      verdict: "unknown",
      detail: `not checked: ${e instanceof Error ? e.message : String(e)}`,
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

/**
 * Сверка ОДНОГО сгенерированного нами файла с тем, что дала бы эта сборка.
 * Три исхода, и они отвечают на разные вопросы: `ok` — файл нынешний,
 * `устарел` — файл ровно тот, что записал `wire`, но шаблон с тех пор изменился
 * (виноват не человек, а версия), `изменён` — на диске не то, что мы писали, и
 * не то, что пишем сейчас (файл правили руками или подменили).
 */
export interface GeneratedReport {
  readonly path: string;
  readonly verdict: Verdict;
  readonly detail: string;
  /** Хеш, записанный `myc wire`. */
  readonly recorded?: string;
  /** Хеш того, что сгенерировала бы нынешняя сборка. */
  readonly expected?: string;
  /** Хеш файла на диске сейчас. */
  readonly actual?: string;
}

export interface HooksSection {
  readonly journal: boolean;
  readonly hooks: readonly HookReport[];
  /** Сгенерированные нами файлы: устарел / подменён / актуален. */
  readonly generated: readonly GeneratedReport[];
  readonly checks: readonly Check[];
  /** Каталог, откуда читался счётчик срабатываний: он принадлежит базе. */
  readonly countersDir: string;
  /** Каталог, откуда читался журнал `myc wire`: он принадлежит дереву. */
  readonly journalDir: string;
  /**
   * Непусто, когда эти два каталога РАЗНЫЕ (git worktree). Тогда вердикт
   * собран из двух источников, и промолчать об этом нельзя (И2).
   */
  readonly split?: string;
  /** Пользовательский слой Claude Code (`myc wire --scope user`); его пункты — и в `checks`. */
  readonly user: UserLayerSection;
}

/**
 * Пользовательский слой Claude Code: то, что поставил `myc wire --scope user`,
 * против того, что лежит в `~/.claude` сейчас и что записала бы эта сборка.
 */
export interface UserLayerSection {
  /** Журнал `~/.myc/wire-user.json`; null — его нет (слой не проведён, или журнал не здесь). */
  readonly journal: string | null;
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

/**
 * События, которые обслуживает НАШ файл-обработчик (плагин opencode, helper
 * Kimi): в журнале у него нет узлов, поэтому они выводятся из самого факта
 * его установки. Список совпадает с тем, что эти файлы умеют, — расширять
 * его вслепую нельзя: `stop` они не обслуживают ни один.
 */
const HELPER_FILE_EVENTS = HOOK_SPECS.filter((s) => s.event !== "stop").map((s) => s.claudeEvent);

function wiredEvents(j: Journal | null): WireJournal | null {
  if (j === null) return null;
  {
    const events = new Set<string>();
    let ownHelper = false;
    for (const e of j.entries ?? []) {
      for (const node of e.nodes ?? []) {
        if (node.startsWith("hooks.")) events.add(node.slice("hooks.".length));
      }
      // Харнессы делятся на два рода, и журнал это отражает. У Claude Code
      // хуки — УЗЛЫ чужого JSON (`hooks.SessionStart`), и они перечислены. У
      // opencode и Kimi весь обработчик — НАШ ФАЙЛ целиком (плагин, helper), и
      // узлов у него нет по устройству: `unwire` удаляет такой файл как раз по
      // признаку `nodes.length === 0`, и дописать туда узлы значило бы
      // превратить его в конфиг, из которого вычёркивают ключи.
      //
      // Читая только узлы, doctor объявлял «не поставлен: события нет в
      // журнале» про поставленные хуки — ложная тревога в проекте, где стоит
      // один opencode. Наличие нашего файла с обработчиками — такое же
      // свидетельство установки, как имя узла.
      if ((e.nodes ?? []).length === 0 && /myc(-hooks)?\.(ts|mjs)$/.test(e.path ?? "")) {
        ownHelper = true;
      }
    }
    if (ownHelper) for (const ev of HELPER_FILE_EVENTS) events.add(ev);
    return { events, writtenAt: j.written_at };
  }
}

function fileTextOrNull(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/**
 * Устаревший сгенерированный файл — самая тихая из поломок хуков, и до этой
 * сверки её нечем было заметить. Установленный `.claude/helpers/myc-hooks.mjs`
 * был собран ДО того, как шаблон начал передавать `--session`; хук исправно
 * тикал, `doctor` печатал `ok`, а `prime` при этом всегда работал с «сессия не
 * указана», то есть принятая функция БЕЗДЕЙСТВОВАЛА (memory-h12hjebzr0he).
 * `myc wire` про это не говорил — он просто перезаписывал по требованию.
 *
 * Сверять есть с чем без новых сущностей: журнал `wire.json` хранит хеш
 * каждого записанного файла, а содержимое, которое дала бы НЫНЕШНЯЯ сборка,
 * собирают те же планировщики, что и запись (`generatedFiles`).
 */
function checkGenerated(
  root: string,
  journalDir: string,
  journal: Journal | null,
  events: readonly HookEvent[],
): GeneratedReport[] {
  if (journal === null) {
    return [
      {
        path: WIRE_JOURNAL,
        verdict: "unknown",
        detail:
          `unknown: the journal ${join(journalDir, WIRE_JOURNAL)} is missing or unreadable — ` +
          "nothing to check the installed files against this build",
      },
    ];
  }
  // `--hook-output` — выбор человека, а не признак свежести. В журнале он есть
  // начиная с этой версии; у прежних журналов поля нет, и тогда подходит любой
  // из двух вариантов — иначе половина установок объявлялась бы устаревшей на
  // ровном месте.
  const outputs: readonly ("json" | "text")[] =
    journal.hook_output !== undefined ? [journal.hook_output] : ["json", "text"];
  const variants = outputs.map((o) => generatedFiles(root, events, o));
  const out: GeneratedReport[] = [];

  for (const entry of journal.entries) {
    const expected = variants.map((v) => v.get(entry.path)).filter((c): c is string => c !== undefined);
    if (expected.length === 0) continue; // конфиг харнесса, а не наш файл целиком
    const expectedHashes = expected.map(wireHash);
    const text = fileTextOrNull(join(root, entry.path));
    if (text === null) {
      out.push({
        path: entry.path,
        verdict: "drift",
        detail: "gone: the `myc wire` journal remembers it, but the file is not on disk — the hook has nothing to run; `myc wire`",
        recorded: entry.hash,
        expected: expectedHashes[0]!,
      });
      continue;
    }
    const actual = wireHash(text);
    if (expectedHashes.includes(actual)) {
      out.push({
        path: entry.path,
        verdict: "ok",
        detail: `up to date: matches what this build generates (${actual})`,
        recorded: entry.hash,
        expected: actual,
        actual,
      });
      continue;
    }
    if (actual === entry.hash) {
      out.push({
        path: entry.path,
        verdict: "drift",
        detail:
          `stale: the file is exactly what \`myc wire\` wrote (${entry.hash}), but this build's ` +
          `template produces a different one (${expectedHashes[0]}) — rerun \`myc wire\``,
        recorded: entry.hash,
        expected: expectedHashes[0]!,
        actual,
      });
      continue;
    }
    out.push({
      path: entry.path,
      verdict: "drift",
      detail:
        `changed after we wrote it: on disk (${actual}) is neither what \`myc wire\` wrote (${entry.hash}) ` +
        `nor what this build produces (${expectedHashes[0]}) — \`myc wire\` restores our file, ` +
        "the current one goes to .myc.bak",
      recorded: entry.hash,
      expected: expectedHashes[0]!,
      actual,
    });
  }
  return out;
}

/** `1 time`, `3 times`. */
function times(n: number): string {
  return `${n} time${n === 1 ? "" : "s"}`;
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

/**
 * Две стороны, и `--hooks` нужны ОБЕ — это не недосмотр, а состав вопроса.
 *
 * СЧЁТЧИК (`hooks.json`) принадлежит БАЗЕ и читается из её каталога. «Сколько
 * раз хук сработал» — свойство воркспейса, а не ветки: сжатие контекста,
 * случившееся в git worktree, сохраняет память в общую базу, и не увидеть его
 * из основного дерева значило бы раздвоить сам счётчик, на котором строится
 * вердикт.
 *
 * ЖУРНАЛ `myc wire` (`wire.json`) принадлежит РАБОЧЕМУ ДЕРЕВУ и читается из
 * cwd. «Поставлен ли хук» — свойство именно того дерева, в котором мы сейчас:
 * конфиги харнесса (`.claude/`, `.mcp.json`) `wire` ставит в своё дерево,
 * потому что Claude Code читает `.claude` из своего. Читай мы журнал рядом с
 * базой — doctor в worktree отвечал бы про установку в ЧУЖОМ дереве.
 */
function checkHooks(
  countersDir: string,
  journalDir: string,
  registry: Registry,
  env: NodeJS.ProcessEnv,
  now: number = Date.now(),
): HooksSection {
  const journal = readWireJournal(join(journalDir, WIRE_JOURNAL));
  const wired = wiredEvents(journal);
  const counters = readCounters(countersDir).hooks;
  const reports: HookReport[] = [];
  // Те же события, что поставил бы `myc wire` из этой сборки: сверять
  // содержимое helper'а с шаблоном, который эта сборка не ставит, значило бы
  // объявлять расхождением собственный отказ.
  const buildEvents = HOOK_SPECS.filter((sp) => registry.hasTop(sp.command)).map((sp) => sp.event);

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
        detail: `not wired: this build has no \`myc ${spec.command}\` command`,
      });
      continue;
    }
    if (count > 0 && last !== undefined) {
      // «Срабатывал» и «работал» — разные вещи. Хук pre-compact пишет статус
      // `empty`, когда сохранять было нечего: эпизод не создан, память сжатие
      // НЕ пережила. Считать это здоровьем — то же самое, что считать
      // здоровьем пустой ответ поиска.
      //
      // Поймано на живом проекте (docs-rag): 11 срабатываний подряд, все
      // `empty`, ни одного узла kind='session' в базе — плагин opencode зовёт
      // `absorb-session` без транскрипта. doctor при этом печатал `ok`, то
      // есть подтверждал ровно то обещание, которое не выполнялось.
      const hollow = HOLLOW_STATUS[last.last_status];
      reports.push({
        event: spec.event,
        command: spec.command,
        installed,
        verdict: hollow !== undefined ? "drift" : "ok",
        detail:
          hollow !== undefined
            ? `fired ${times(count)}, but did no work last time ` +
              `(${when(last.last_at)}, status ${last.last_status}${agents.length > 0 ? `, agents: ${agents.join(", ")}` : ""}): ${hollow}`
            : `fired ${times(count)}, last ${when(last.last_at)} (${last.last_status}, ${last.last_ms} ms)${agents.length > 0 ? `, agents: ${agents.join(", ")}` : ""}`,
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
        detail:
          `unknown: no journal ${join(journalDir, WIRE_JOURNAL)} — ` +
          "whether the hook is installed cannot be seen from here",
      });
      continue;
    }
    if (!installed) {
      reports.push({
        event: spec.event,
        command: spec.command,
        installed: false,
        verdict: "drift",
        detail: "not installed: the event is not in the `myc wire` journal",
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
        ? `unknown: installed, but does not report itself — \`myc ${spec.command}\` is called both by hand and by the hook, and nothing tells them apart`
        : fresh
          ? `unknown: installed ${when(wired!.writtenAt)} and has not fired yet — the event simply had no occasion to happen`
          : "installed, but never fired",
    });
  }

  const generated = checkGenerated(dirname(journalDir), journalDir, journal, buildEvents);
  const user = checkUserLayer(env, registry);

  const checks: Check[] = [
    ...reports.map((r) => ({ name: r.event, verdict: r.verdict, detail: r.detail })),
    ...generated.map((g) => ({ name: g.path, verdict: g.verdict, detail: g.detail })),
    ...user.checks,
  ];
  // Каталоги разошлись — значит команду позвали из git worktree, и вердикт
  // собран из ДВУХ мест. Назвать это обязаны: молчащий диагност, который
  // смешал два источника, хуже молчания.
  const split =
    countersDir === journalDir
      ? undefined
      : `counter from ${countersDir} (it belongs to the database), install journal from ` +
        `${journalDir} (it belongs to the working tree)`;
  if (split !== undefined) {
    checks.unshift({ name: "sources", verdict: "ok", detail: split });
  }
  return {
    journal: wired !== null,
    hooks: reports,
    generated,
    checks,
    countersDir,
    journalDir,
    ...(split !== undefined ? { split } : {}),
    user,
  };
}

// ---------------------------------------------------------------------------
// --hooks: пользовательский слой (memory-qnyz6bawx19v)
// ---------------------------------------------------------------------------
//
// ЗАЧЕМ. `myc wire --scope user` ставит хуки, правила, helper'ы, скилл, MCP и
// (с `--status-line`) строку статуса в `~/.claude` — слой, который правят
// ещё orca, Claude Code (`/config`, «always allow») и человек. Проектная сверка
// выше этого слоя не видит вовсе: журнал у него свой (`~/.myc/wire-user.json`),
// и снятый кем-то хук или helper, записанный прежней сборкой, молчали бы до
// тех пор, пока агент в worktree не остался бы без prime.
//
// Сверяется ТРИ стороны, как у проектного слоя: журнал (что ставили), файлы на
// диске (что стоит) и эта сборка (что она записала бы). `~/.claude.json`
// только читается: его переписывают работающие сессии.

/** Файл JSON целиком, без записи; broken — не разобрать. */
function readJsonFile(path: string): { readonly value: Record<string, unknown> | null; readonly broken: boolean } {
  const text = fileTextOrNull(path);
  if (text === null) return { value: null, broken: false };
  try {
    const v = JSON.parse(text) as unknown;
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? { value: v as Record<string, unknown>, broken: false }
      : { value: null, broken: true };
  } catch {
    return { value: null, broken: true };
  }
}

function recordOf(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function listOf(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Команда для отчёта: целиком не печатаем — у orca она на две тысячи знаков. */
function shortCmd(cmd: string): string {
  const one = cmd.replace(/\s+/g, " ").trim();
  return one.length <= 60 ? one : `${one.slice(0, 59)}…`;
}

/** Чья строка: команда коротко и «(orca's line)», если orca сочтёт её своей. */
function whoseLine(v: unknown): string {
  const cmd = statusLineCommand(v);
  if (cmd === null) return "a line without a command";
  return `"${shortCmd(cmd)}"${orcaClaimsStatusLine(cmd) ? " (orca's line)" : ""}`;
}

/** Путь для человека: домашний каталог — `~`. */
function tildeOf(path: string, home: string): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** myc, вшитый в helper (`const WIRED_BIN = "…";`) — для журналов без поля `bin`. */
function wiredBinOf(helperText: string): string | undefined {
  const m = /^const WIRED_BIN = (".*");$/m.exec(helperText);
  if (m === null) return undefined;
  try {
    const v = JSON.parse(m[1]!) as unknown;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

export function checkUserLayer(env: NodeJS.ProcessEnv, registry: Registry): UserLayerSection {
  const paths = userPaths(env);
  if (paths === null) {
    return { journal: null, checks: [{ name: "user layer", verdict: "n/a", detail: "HOME is not set — no user layer of Claude Code to check" }] };
  }
  const show = (p: string): string => tildeOf(p, paths.home);
  const j = readUserJournal(paths.journal);
  if (j === null) {
    // Без журнала сверять не с чем, и `~/.claude` тогда не читается вовсе:
    // журнал — единственное свидетельство, что этот слой проводил myc.
    return {
      journal: null,
      checks: [
        {
          name: "user layer",
          verdict: "n/a",
          detail:
            `not wired: no ${show(paths.journal)} (\`myc wire --scope user\` wires Claude Code's user layer for agents in git ` +
            "worktrees; if myc's entries are in ~/.claude/settings.json anyway, it writes the journal again)",
        },
      ],
    };
  }
  const settings = readJsonFile(paths.settings);

  const checks: Check[] = [];
  const helpers = j.settings?.helpers ?? [paths.helper, paths.queueHelper];
  const rerun = "`myc wire --scope user`";

  // --- настройки: наши записи хуков и правила ------------------------------
  if (settings.broken) {
    checks.push({ name: "user:settings", verdict: "unknown", detail: `${show(paths.settings)} is not valid JSON — can't see myc's entries in it` });
  } else {
    const value = settings.value ?? {};
    const hooks = recordOf(value["hooks"]);
    const buildEvents = HOOK_SPECS.filter((s) => registry.hasTop(s.command)).map((s) => s.claudeEvent);
    const expected = j.events ?? buildEvents;
    const hasOurs = (event: string, marks: readonly string[]): boolean => listOf(hooks[event]).some((e) => isUserHookEntry(e, marks));
    const missing = expected.filter((ev) => !hasOurs(ev, helpers)).map((ev) => `hooks.${ev}`);
    const queueWired = j.files.some((f) => f.path === paths.queueHelper);
    if (queueWired && !hasOurs("PreToolUse", [paths.queueHelper])) missing.push("hooks.PreToolUse (the queue hook)");
    const where = `${expected.join(", ")}${queueWired ? " + the queue hook on PreToolUse" : ""}`;
    checks.push(
      missing.length === 0
        ? { name: "user:hooks", verdict: "ok", detail: `myc's entries in place: ${where}` }
        : {
            name: "user:hooks",
            verdict: "drift",
            detail:
              `gone from ${show(paths.settings)}: ${missing.join(", ")} — removed after wire (by hand or by another tool), ` +
              `so nothing runs myc there; ${rerun} puts them back`,
            items: missing,
          },
    );

    const allow = listOf(recordOf(value["permissions"])["allow"]);
    const recorded = new Set(j.settings?.permissions ?? []);
    const absent = mycPermissions(registry).filter((r) => !allow.includes(r));
    const gone = absent.filter((r) => recorded.has(r));
    const fresh = absent.filter((r) => !recorded.has(r));
    checks.push(
      absent.length === 0
        ? { name: "user:permissions", verdict: "ok", detail: "every Bash(myc <command>:*) rule of this build is in permissions.allow" }
        : {
            name: "user:permissions",
            verdict: "drift",
            detail:
              [
                gone.length > 0 ? `${gone.length} rules wire added are gone` : "",
                fresh.length > 0 ? `${fresh.length} rules of this build were never added (commands newer than the wire run)` : "",
              ]
                .filter((s) => s.length > 0)
                .join("; ") + ` — Claude Code asks before those myc commands; ${rerun} adds them`,
            items: absent,
          },
    );
  }

  // --- helper'ы и скилл: против того, что записала бы ЭТА сборка -------------
  checks.push(...checkUserFiles(paths, j, registry, env, show));

  // --- строка статуса ---------------------------------------------------------
  checks.push(checkUserStatusLine(paths, j, settings, show));

  // --- MCP ----------------------------------------------------------------------
  checks.push(checkUserMcp(paths, j, show));

  return { journal: paths.journal, checks };
}

function checkUserFiles(
  paths: UserPaths,
  j: UserJournal,
  registry: Registry,
  env: NodeJS.ProcessEnv,
  show: (p: string) => string,
): Check[] {
  const events = HOOK_SPECS.filter((s) => registry.hasTop(s.command)).map((s) => s.event);
  const helperOnDisk = fileTextOrNull(paths.helper);
  // myc, вшитый при wire: из журнала, у старых журналов — из самого helper'а.
  const bin = j.bin ?? (helperOnDisk !== null ? wiredBinOf(helperOnDisk) : undefined) ?? "myc";
  const gen = userGeneratedFiles(paths, events, j.hook_output, bin);
  const expectedByPath = new Map<string, string>([
    [paths.helper, gen.helper],
    [paths.queueHelper, gen.queueHelper],
    [paths.skill, gen.skill],
  ]);
  const writtenBy = j.version !== undefined ? `myc ${j.version}` : "an earlier myc";
  const out: Check[] = [];
  for (const f of j.files) {
    const expected = expectedByPath.get(f.path);
    if (expected === undefined) continue; // .myc.bak и файлы, которых эта сборка не пишет
    const name = `user:${show(f.path)}`;
    const text = fileTextOrNull(f.path);
    if (text === null) {
      out.push({
        name,
        verdict: "drift",
        detail:
          "gone: the journal remembers it, but the file is not on disk — the hooks that call it exit quietly, so myc " +
          "does nothing there; `myc wire --scope user`",
      });
      continue;
    }
    const actual = wireHash(text);
    const want = wireHash(expected);
    if (actual === want) {
      out.push({ name, verdict: "ok", detail: `up to date: matches what this build (myc ${CLI_VERSION}) writes (${actual})` });
    } else if (actual === f.hash) {
      out.push({
        name,
        verdict: "drift",
        detail:
          `stale: exactly what \`myc wire --scope user\` wrote (${writtenBy}, ${f.hash}), but this build (myc ${CLI_VERSION}) ` +
          `writes a different one (${want}) — rerun \`myc wire --scope user\``,
      });
    } else {
      out.push({
        name,
        verdict: "drift",
        detail:
          `changed after we wrote it: on disk (${actual}) is neither what wire wrote (${f.hash}) nor what this build writes ` +
          `(${want}) — \`myc wire --scope user\` restores ours, the current one goes to .myc.bak`,
      });
    }
  }
  return out;
}

function checkUserStatusLine(
  paths: UserPaths,
  j: UserJournal,
  settings: { readonly value: Record<string, unknown> | null; readonly broken: boolean },
  show: (p: string) => string,
): Check {
  const name = "user:statusLine";
  if (settings.broken) return { name, verdict: "unknown", detail: `${show(paths.settings)} is not valid JSON — can't see the status line` };
  const current = settings.value?.["statusLine"];
  const rec = j.status_line;
  if (rec === undefined) {
    if (isOurStatusLine(current)) {
      return {
        name,
        verdict: "drift",
        detail:
          `myc's line is in ${show(paths.settings)} with no record in ${show(paths.journal)} of the line it replaced — ` +
          "that line gets no input; `myc wire --scope user --status-line` records what is known",
      };
    }
    return { name, verdict: "n/a", detail: "not installed (`myc wire --scope user --status-line` puts myc's line there)" };
  }
  const previous = statusLineCommand(rec.previous) !== null ? `the previous line ${whoseLine(rec.previous)} gets the same input` : "there was no previous line";
  if (current === undefined) {
    return {
      name,
      verdict: "drift",
      detail:
        `gone: myc's line was removed from ${show(paths.settings)} after wire, and the line it replaced gets no input either; ` +
        "`myc wire --scope user --status-line` puts it back, `myc wire --scope user` forgets it",
    };
  }
  if (!isOurStatusLine(current)) {
    return {
      name,
      verdict: "drift",
      detail:
        `no longer myc's: now ${whoseLine(current)} — replaced after wire. \`myc wire --scope user --status-line\` puts ours ` +
        "back and keeps this one as the previous line (it keeps getting the same input); `myc wire --scope user` accepts it and forgets ours",
    };
  }
  // Наша на месте. Её myc должен существовать: иначе строка пуста, и прежняя
  // (orca) не получает ввода — при том что всё «стоит».
  const cmd = statusLineCommand(current) ?? "";
  if (j.bin !== undefined && cmd === ourUserStatusLineCommand({ command: j.bin }) && j.bin.startsWith("/") && !existsSync(j.bin)) {
    return {
      name,
      verdict: "drift",
      detail:
        `myc's line runs ${j.bin}, which is not there — the line is empty and the previous line gets no input; ` +
        "`myc wire --scope user --status-line` with a myc that exists",
    };
  }
  return { name, verdict: "ok", detail: `myc's line (${shortCmd(cmd)}); ${previous}` };
}

function checkUserMcp(paths: UserPaths, j: UserJournal, show: (p: string) => string): Check {
  const name = "user:mcp";
  const m = j.mcp;
  const config = m?.config ?? paths.claudeJson;
  const current = readUserMcp(config);
  if (current.broken) return { name, verdict: "unknown", detail: `${show(config)} is not valid JSON — can't see whether myc is registered` };
  const add = "`myc wire --scope user` (it runs `claude mcp add --scope user myc -- <myc> mcp --profile agent`)";
  if (m === null) {
    if (current.value !== undefined) {
      return { name, verdict: "n/a", detail: `a server named myc is registered in ${show(config)}, not by wire — not checked` };
    }
    return { name, verdict: "drift", detail: `not registered in the user layer (wire could not do it): agents in git worktrees get no myc tools; ${add}` };
  }
  if (current.value === undefined) {
    return { name, verdict: "drift", detail: `gone: the MCP server myc wire registered is not in ${show(config)} any more — agents in git worktrees get no myc tools; ${add}` };
  }
  const command = current.value["command"];
  const args = listOf(current.value["args"]);
  if (command !== m.command || JSON.stringify(args) !== JSON.stringify(m.args)) {
    return {
      name,
      verdict: "drift",
      detail: `changed after wire registered it: now ${[command, ...args].map(String).join(" ")}, wire registered ${[m.command, ...m.args].join(" ")}; ${add}`,
    };
  }
  if (m.command.startsWith("/") && !existsSync(m.command)) {
    return { name, verdict: "drift", detail: `registered, but ${m.command} is not there — the server does not start; ${add}` };
  }
  return { name, verdict: "ok", detail: `registered: ${[m.command, ...m.args].join(" ")}` };
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
  drift: "DRIFT   ",
  unknown: "unknown ",
  "n/a": "n/a     ",
};

function sectionChecks(data: DoctorData, name: string): readonly Check[] {
  if (name === "schema") return data.schema?.checks ?? [];
  if (name === "recount") return data.recount?.checks ?? [];
  return data.hooks?.checks ?? [];
}

const TITLE: Record<string, string> = {
  schema: "schema",
  recount: "counters",
  hooks: "hooks",
};

/**
 * Один рендер на два выхода: человеческий вывод успеха и текст отказа, когда
 * что-то разошлось. Два рендера разъехались бы, и «что именно сломано» на
 * ненулевом коде выхода печаталось бы иначе, чем на нулевом.
 */
export function renderReport(data: DoctorData, verbose: boolean): string[] {
  const lines: string[] = [`database ${data.db}`];
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
    `workspace not initialized: looked in ${found.searched.join(", ")}`,
    ExitCode.NOWS,
    "myc init",
  );
}

/**
 * `env` — откуда брать пользовательский слой (HOME, CLAUDE_CONFIG_DIR,
 * MYC_HOME): тесты подменяют его, чтобы сверка никогда не читала настоящий
 * `~/.claude`.
 */
export function createDoctorCommand(registry: Registry, overrides: { readonly env?: NodeJS.ProcessEnv } = {}): Command {
  const env = overrides.env ?? process.env;
  return {
    name: "doctor",
    summary: "check what the database claims against what can be recounted",
    flags: [
      { name: "schema", description: "schema version and object-level diff against this binary" },
      { name: "recount", description: "materialised counters against a recount from the graph" },
      {
        name: "hooks",
        description: "when each hook last fired, which events are not installed, and the user layer myc wire --scope user put in ~/.claude",
      },
      { name: "verbose", description: "list every diverging object, node and row, not just counts" },
    ],
    help:
      "Exit 0 only when every checked item converges. A section that could not be checked is " +
      "reported as 'unknown' and never as 'ok' — a diagnostic that prints ok where it looked at " +
      "nothing is worse than silence.\n\n" +
      "The database is opened WITHOUT running migrations, on purpose: a database written by a " +
      "newer myc refuses to open on the normal path with `precond.schema`, and that failure is " +
      "exactly what sends people here.\n\n" +
      "--recount only compares. `parent_closure` is compared by running the real rebuild inside " +
      "a transaction that is always rolled back, so the file is left byte-for-byte unchanged " +
      "and the check cannot drift from the repair it mirrors.\n\n" +
      "--hooks answers two questions. Did it fire: the counter is written only by a caller that " +
      "declared itself through MYC_HOOK, so 'session-start fired N times' means sessions, not " +
      "hand-typed `myc prime` calls. Is it the current hook: every file myc generates in full is " +
      "hashed against what this build would generate, so a helper installed by an older version " +
      "is reported as stale by name instead of silently doing nothing. The user layer (`myc wire " +
      "--scope user`) is checked by ~/.myc/wire-user.json against ~/.claude: myc's hook entries and " +
      "rules still there, its helpers what this build writes, its status line not replaced by " +
      "another tool, its MCP server still registered (~/.claude.json is only read).",
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
        return failure("ws.not_initialized", `no database: ${dbPath}`, ExitCode.NOWS, "myc init");
      }
      // Каталог базы — сторона ВОРКСПЕЙСА: там счётчик хуков и всё прочее,
      // что базе принадлежит. Каталог cwd — сторона РАБОЧЕГО ДЕРЕВА: там
      // конфиги харнесса и журнал их установки. Из git worktree это разные
      // каталоги, и `--hooks` спрашивает у каждого своё (см. checkHooks).
      const mycDir = dirname(dbPath);
      const treeMycDir = join(resolve(ctx.globals.directory ?? process.cwd()), ".myc");

      let driver: CliDriver | undefined;
      const needsDb = sections.includes("schema") || sections.includes("recount");
      if (needsDb) {
        try {
          driver = openDriver(dbPath, undefined, { extensions: true });
        } catch (e) {
          return failure(
            "db.open",
            `cannot open the database: ${e instanceof Error ? e.message : String(e)}`,
            ExitCode.ERR,
          );
        }
      }

      try {
        const schema = sections.includes("schema") ? await checkSchema(driver!) : undefined;
        const recount = sections.includes("recount") ? checkRecount(driver!) : undefined;
        const hooks = sections.includes("hooks")
          ? checkHooks(mycDir, treeMycDir, registry, env)
          : undefined;

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
            [`drift: ${drift}`, ...renderReport(data, verbose)].join("\n"),
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
