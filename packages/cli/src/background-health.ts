/**
 * `myc doctor`, раздел background: ЖИВ ЛИ ФОН ПОСЛЕ КОМАНД (memory-h5zp5mqcdbay).
 *
 * Фон — прогон якорей и обновление код-индекса после каждой успешной команды
 * (drain.ts) — ставит две отметки в `myc_meta`: `anchor_swept_at` (не реже
 * раза в 300 с) и `code_indexed_at` (не реже раза в 15 минут). 2026-09-14
 * бинарь, собранный под `bun test`, получил сторож тестового режима
 * свёрнутым в безусловный return, и обе отметки стояли ~21 ч при сотнях
 * команд. Этого не видел никто: команды отвечали как обычно, и единственным
 * следом был возраст отметки.
 *
 * ВОЗРАСТ САМ ПО СЕБЕ — НЕ УЛИКА. Отметку двигает только команда: у
 * воркспейса, где никто ничего не делал с пятницы, отметке законно три дня, и
 * тревога на этом — ложь, которую человек научится пропускать. Улика — то,
 * что КОМАНДЫ ШЛИ, А ОТМЕТКА СТОЯЛА. Команды видны по локальным записям
 * оплога (`origin = 1`: claim, inc счётчика показов у recall, всякая правка),
 * а у здорового фона каждая команда, пришедшая после истечения периода,
 * двигает отметку сама.
 *
 * ПРАВИЛО (judgeMark). Отметка просрочена на OVERDUE_PERIODS периодов, и
 * ПОСЛЕ этого локальные записи шли не меньше одного периода (от первой такой
 * записи до последней). Запас в два периода отсекает законное отставание
 * (прогон по батчу, аренда воркера кода); требование «записи шли период»
 * отсекает одиночный дренаж, уступивший чужому write-lock после простоя, —
 * неудачей одного дренажа замёрзший фон не отличить от невезения, серией
 * длиной в период — можно.
 *
 * Периоды — из drain.ts и @myc/code-intel/refresh, с теми же
 * переопределениями окружения: сверка мерит отметку тем же аршином, которым
 * её ставят.
 *
 * Фон выключен в этом процессе (тест-раннер, MYC_DRAIN=0 и выключатели
 * механизмов) — «n/a»: сверять нечего. Тест-раннер узнаётся параметром
 * `processEnv`, а не литералом `process.env.NODE_ENV` — литерал бандлер
 * сворачивает в константу из окружения сборки (node-env-fold.test.ts).
 */

import type { Database } from "bun:sqlite";
import { CODE_INDEXED_AT_KEY, refreshAfterMs, refreshJob } from "@myc/code-intel/refresh";
import type { Check } from "./commands/doctor.ts";
import {
  ANCHOR_SWEPT_AT_KEY,
  anchorSweepEnabled,
  anchorSweepPeriodMs,
  codeIndexEnabled,
  queueDrainEnabled,
} from "./drain.ts";

/** Во сколько периодов просрочки записи после отметки начинают считаться уликой. */
export const OVERDUE_PERIODS = 2;

/** Локальные записи оплога позже порога просрочки. */
export interface OverdueWrites {
  readonly first: number;
  readonly last: number;
  readonly count: number;
}

/**
 * ok — отметка поспевает за записями; frozen — записи шли, отметка стояла;
 * never — отметки нет, а записи были; idle — ни отметки, ни записей.
 */
export type MarkVerdict = "ok" | "frozen" | "never" | "idle";

/**
 * Вердикт по числам — чистая функция, её и сторожит тест порога.
 * `overdue` — локальные записи позже `stamp + OVERDUE_PERIODS·period`, а у
 * отметки, которой нет, — все локальные записи.
 *
 * Отметки нет, а записи есть — «never» без требования к длине серии: первый
 * же дренаж здоровой сборки ставит её сразу (её отсутствие — «пора»), и
 * `myc init` уже выходит с отметкой. Такой вердикт — «не знаю» с тревогой, а
 * не расхождение: отличить сломанный фон от только что обновлённого myc,
 * ещё не сделавшего ни одной команды, здесь нечем.
 */
export function judgeMark(stamp: number | null, periodMs: number, overdue: OverdueWrites | null): MarkVerdict {
  const writes = overdue !== null && overdue.count > 0;
  if (stamp === null) return writes ? "never" : "idle";
  if (!writes || overdue.last - overdue.first < periodMs) return "ok";
  return "frozen";
}

/** Порог, после которого записи считаются уликой; у отметки, которой нет, — любая запись. */
export function overdueFrom(stamp: number | null, periodMs: number): number {
  return stamp === null ? Number.NEGATIVE_INFINITY : stamp + OVERDUE_PERIODS * periodMs;
}

export interface MarkReport {
  readonly name: string;
  readonly key: string;
  readonly stampMs: number | null;
  readonly periodMs: number;
  readonly lastLocalWriteMs: number | null;
  readonly overdue: OverdueWrites | null;
  readonly verdict: MarkVerdict;
}

export interface BackgroundSection {
  readonly checks: readonly Check[];
  /** Числа, из которых выведен вердикт; пусто, когда сверять было нечего. */
  readonly marks: readonly MarkReport[];
}

export interface BackgroundOptions {
  /** Окружение вызова: выключатели и переопределения периодов. */
  readonly env: NodeJS.ProcessEnv;
  /** Окружение процесса — по нему узнаётся тест-раннер. Параметр, не литерал. */
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly now: number;
}

function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

function metaNumber(db: Database, key: string): number | null {
  const row = db.query("SELECT value FROM myc_meta WHERE key = ?1").get(key) as { value: string } | null;
  const n = Number(row?.value);
  return row === null || !Number.isFinite(n) || n <= 0 ? null : n;
}

function lastLocalWrite(db: Database): number | null {
  const row = db.query("SELECT ts_ms FROM oplog WHERE origin = 1 ORDER BY seq DESC LIMIT 1").get() as
    | { ts_ms: number }
    | null;
  return row?.ts_ms ?? null;
}

function overdueWrites(db: Database, from: number): OverdueWrites | null {
  // Полный проход по оплогу: индекса по времени нет, а doctor не горячий путь
  // (здесь 10k строк — единицы миллисекунд). Фильтр по origin: реплицированная
  // запись — след чужой машины, а не команды здесь.
  const row = db
    .query("SELECT min(ts_ms) AS first, max(ts_ms) AS last, count(*) AS n FROM oplog WHERE origin = 1 AND ts_ms > ?1")
    .get(Number.isFinite(from) ? from : -1) as { first: number | null; last: number | null; n: number };
  return row.n === 0 || row.first === null || row.last === null ? null : { first: row.first, last: row.last, count: row.n };
}

interface MarkSpec {
  readonly name: string;
  readonly key: string;
  readonly periodMs: number;
  /** Что ещё сказать о лечении этой отметки, кроме пересборки. */
  readonly cure: string;
  /** Подробность о состоянии исполнителя — только к тревоге. */
  readonly extra?: () => string | null;
}

const FOLDED_CURE =
  "the binary may carry its test-mode guard folded in by the bundler (memory-h5zp5mqcdbay): rebuild it with " +
  "`bun run build` (the build now refuses such an artifact) and restart what runs it (the MCP server, hooks)";

function evaluate(db: Database, spec: MarkSpec, now: number): { check: Check; mark: MarkReport } {
  const stamp = metaNumber(db, spec.key);
  const last = lastLocalWrite(db);
  const overdue = overdueWrites(db, overdueFrom(stamp, spec.periodMs));
  const verdict = judgeMark(stamp, spec.periodMs, overdue);
  const mark: MarkReport = {
    name: spec.name,
    key: spec.key,
    stampMs: stamp,
    periodMs: spec.periodMs,
    lastLocalWriteMs: last,
    overdue,
    verdict,
  };
  const items = [
    `${spec.key} ${stamp === null ? "none" : new Date(stamp).toISOString()}`,
    `period ${dur(spec.periodMs)}, overdue after ${OVERDUE_PERIODS} periods`,
    `last local write ${last === null ? "none" : new Date(last).toISOString()}`,
    ...(overdue !== null
      ? [`${overdue.count} local writes after it was overdue, ${new Date(overdue.first).toISOString()} … ${new Date(overdue.last).toISOString()}`]
      : []),
  ];
  const lastAgo = last === null ? "" : `, last local write ${dur(now - last)} ago`;
  const extra = verdict === "frozen" || verdict === "never" ? spec.extra?.() ?? null : null;
  const cure = `${FOLDED_CURE}; ${spec.cure}${extra !== null ? `; ${extra}` : ""}`;
  let check: Check;
  if (verdict === "frozen") {
    check = {
      name: spec.name,
      verdict: "drift",
      detail:
        `${spec.key} is ${dur(now - stamp!)} old, yet local writes kept coming for ${dur(overdue!.last - overdue!.first)} ` +
        `after it was ${OVERDUE_PERIODS} periods (${dur(OVERDUE_PERIODS * spec.periodMs)}) overdue${lastAgo}: ` +
        `commands run, the background after them does not — ${cure}`,
      items,
    };
  } else if (verdict === "never") {
    check = {
      name: spec.name,
      verdict: "unknown",
      detail:
        `no ${spec.key}: the background has never done this here, yet there are ${overdue!.count} local writes ` +
        `over ${dur(overdue!.last - overdue!.first)}${lastAgo} (just upgraded myc? any command sets it) — ${cure}`,
      items,
    };
  } else if (verdict === "idle") {
    check = { name: spec.name, verdict: "n/a", detail: `no ${spec.key} and no local writes yet: nothing has asked for it`, items };
  } else {
    const pending =
      overdue !== null
        ? `; ${overdue.count} local writes since it went overdue span ${dur(overdue.last - overdue.first)}, under one period — not yet a frozen background`
        : "";
    check = {
      name: spec.name,
      verdict: "ok",
      detail: `${spec.key} ${dur(now - stamp!)} ago (period ${dur(spec.periodMs)})${lastAgo}${pending}`,
      items,
    };
  }
  return { check, mark };
}

/**
 * Сверка отметок фона с локальными записями. НИКОГДА не бросает: база, где
 * нет оплога или отметок, — «unknown» с причиной, а не отказ doctor.
 */
export function checkBackground(db: Database, opts: BackgroundOptions): BackgroundSection {
  const processEnv = opts.processEnv ?? process.env;
  const env = opts.env;
  const off = (why: string): BackgroundSection => ({
    checks: [
      { name: "anchor_sweep", verdict: "n/a", detail: why },
      { name: "code_index", verdict: "n/a", detail: why },
    ],
    marks: [],
  });
  if (processEnv.NODE_ENV === "test") return off("the background is off in this process: test runner (NODE_ENV=test)");
  if (!queueDrainEnabled(env)) return off(`the background is off in this environment: MYC_DRAIN=${env.MYC_DRAIN ?? ""}`);

  const checks: Check[] = [];
  const marks: MarkReport[] = [];
  const safely = (name: string, run: () => { check: Check; mark: MarkReport } | Check): void => {
    try {
      const r = run();
      if ("check" in r) {
        checks.push(r.check);
        marks.push(r.mark);
      } else {
        checks.push(r);
      }
    } catch (e) {
      checks.push({ name, verdict: "unknown", detail: `not checked: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  safely("anchor_sweep", () =>
    anchorSweepEnabled(env)
      ? evaluate(
          db,
          {
            name: "anchor_sweep",
            key: ANCHOR_SWEPT_AT_KEY,
            periodMs: anchorSweepPeriodMs(env),
            cure: "check MYC_DRAIN and MYC_ANCHOR_CHECK in their environment; `myc anchor check` sweeps by hand",
          },
          opts.now,
        )
      : { name: "anchor_sweep", verdict: "n/a", detail: `the anchor sweep is off in this environment: MYC_ANCHOR_CHECK=${env.MYC_ANCHOR_CHECK ?? ""}` },
  );

  safely("code_index", () => {
    if (!codeIndexEnabled(env)) {
      return { name: "code_index", verdict: "n/a", detail: `the code-index refresh is off in this environment: MYC_CODE_INDEX=${env.MYC_CODE_INDEX ?? ""}` };
    }
    // Условие §4.3 — то же, что у шага дренажа: без якорей и без индекса
    // фон чужое дерево не обходит, и возраст отметки ничего не значит.
    const anchors = db.query("SELECT 1 AS x FROM anchors LIMIT 1").get() !== null;
    const indexed = db.query("SELECT 1 AS x FROM code_files LIMIT 1").get() !== null;
    if (!anchors && !indexed) {
      return { name: "code_index", verdict: "n/a", detail: "no code index and no anchors: the background does not index this workspace (§4.3)" };
    }
    return evaluate(
      db,
      {
        name: "code_index",
        key: CODE_INDEXED_AT_KEY,
        periodMs: refreshAfterMs(env),
        cure: "check MYC_DRAIN and MYC_CODE_INDEX in their environment; `myc code index` refreshes by hand",
        extra: () => {
          const job = refreshJob(db, opts.now);
          if (job === null) return null;
          if (job.state === "failed") {
            return `the refresh job gave up after ${job.attempts} attempts (${job.lastError ?? "the worker died without a word"}) — \`myc code index\` shows why and clears it`;
          }
          return `a refresh job is ${job.state}`;
        },
      },
      opts.now,
    );
  });

  return { checks, marks };
}
