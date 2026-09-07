/**
 * `myc model …` — ростер моделей роя как данные (задача W10,
 * docs/design/04-swarm-learning-and-routing.md §2.2, §2.10.1).
 *
 *   myc model add <id> --family F --harness claude|opencode|kimi
 *        [--effort low|medium|high] --price-in X --price-out Y
 *        [--price-cache-read X] [--price-cache-write Y]
 *        [--price-date YYYY-MM-DD] [--version V] [--parent <id>]
 *        [--tps N] [--strengths fix:module,docs:local]
 *   myc model update <id> [те же флаги, всё опционально]
 *   myc model list [--all]        myc model show <id>
 *   myc model disable <id>        myc model enable <id>
 *
 * Ростер читает тот, кто раздаёт задачи: --json даёт машинный вид.
 * Цена — факт с датой (история в swarm_model_price), протухшая (> 90 дней)
 * помечается priceStale. Удаление только мягкое (disable): на model_id
 * ссылаются закрытые попытки и атрибуция.
 *
 * ЦЕНА КЕША — ЧЕТЫРЁХ СТАВОК, А НЕ ДВУХ. У агентского запуска чтений кеша
 * миллионы против десятков тысяч выходных токенов, поэтому нулевая ставка
 * кеша занижает стоимость в разы и НЕРАВНОМЕРНО: сильнее у той модели,
 * которая больше читала и меньше писала. Отсюда два правила этой команды:
 * ставки кеша вводятся теми же флагами и в ту же строку цены, что и
 * остальные (второго пути нет), а если их не задали — применяется
 * НАЗВАННОЕ В ВЫВОДЕ умолчание (CACHE_PRICE_SHARES), и в базу ложатся уже
 * вычисленные ставки: цена остаётся данными, доли — только формой ввода.
 *
 * Таблицы swarm_* живут в той же .myc/myc.db, но версионируются своим
 * набором миграций (@myc/swarm, учёт в swarm_schema_migrations) — базовая
 * схема о них не знает. Открытие базы повторяет дисциплину store.ts:
 * STORE_PRAGMAS на соединении (S43), без векторного рантайма — ростеру
 * vec0 не нужен.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { STORE_PRAGMAS } from "@myc/store-sqlite";
import {
  ensureSwarmSchema,
  EFFORTS,
  HARNESSES,
  Roster,
  RosterError,
  type AddModelInput,
  type RosterEntry,
  type UpdateModelInput,
} from "@myc/swarm";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";
import { flagBool, flagNum, flagStr } from "./store.ts";

export interface RosterHandle {
  readonly roster: Roster;
  close(): void;
}

/** Открытие базы через deps (как models.ts): тесты подменяют своей базой. */
export interface RosterDeps {
  openRoster(ctx: CommandContext): RosterHandle | CommandFailure;
}

function realOpenRoster(ctx: CommandContext): RosterHandle | CommandFailure {
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  const dbPath = ctx.globals.db ?? join(dir, ".myc", "myc.db");
  if (!existsSync(dbPath)) {
    return {
      ok: false,
      code: "ws.not_initialized",
      msg: `воркспейс не инициализирован: нет ${dbPath}`,
      exit: ExitCode.NOWS,
      hint: "myc init",
    };
  }
  const db = new Database(dbPath);
  for (const pragma of STORE_PRAGMAS) db.exec(pragma);
  ensureSwarmSchema(db);
  return { roster: new Roster(db), close: () => db.close() };
}

const realDeps: RosterDeps = { openRoster: realOpenRoster };

function rosterFailure(e: unknown): CommandFailure {
  if (e instanceof RosterError) {
    const exit =
      e.code === "notfound.model"
        ? ExitCode.NOTFOUND
        : e.code === "conflict.model"
          ? ExitCode.CONFLICT
          : ExitCode.USAGE;
    return { ok: false, code: e.code, msg: e.message, exit };
  }
  throw e;
}

function usage(code: string, msg: string): CommandFailure {
  return { ok: false, code, msg, exit: ExitCode.USAGE };
}

/** Машинный вид записи ростера — его читает раздающий задачи. */
function entryView(entry: RosterEntry): Record<string, unknown> {
  return {
    modelId: entry.model.modelId,
    family: entry.model.family,
    version: entry.model.version,
    parentModelId: entry.model.parentModelId,
    harness: entry.model.harness,
    effort: entry.model.effort,
    tokensPerSec: entry.model.tokensPerSec,
    strengths: entry.model.strengths,
    active: entry.model.active,
    price:
      entry.price === null
        ? null
        : {
            usdPerMIn: entry.price.usdPerMIn,
            usdPerMOut: entry.price.usdPerMOut,
            usdPerMCacheRead: entry.price.usdPerMCacheRead,
            usdPerMCacheWrite: entry.price.usdPerMCacheWrite,
            validFrom: new Date(entry.price.validFrom).toISOString(),
          },
    priceAgeDays: entry.priceAgeDays,
    priceStale: entry.priceStale,
    cacheUnpriced: entry.cacheUnpriced,
    createdAt: new Date(entry.model.createdAt).toISOString(),
    updatedAt: new Date(entry.model.updatedAt).toISOString(),
  };
}

/**
 * Умолчание для ставок кеша, когда флагами их не задали: доли от цены
 * входного токена. Числа отраслевые (чтение кеша дешевле входа примерно
 * на порядок, запись — дороже на четверть), но это ДОПУЩЕНИЕ, а не прайс
 * провайдера. Поэтому применённое умолчание называется в выводе (warn
 * price.cache_defaulted), а в swarm_model_price ложатся уже вычисленные
 * ставки: доли не участвуют в счёте стоимости и не переживают ввод.
 */
export const CACHE_PRICE_SHARES = { read: 0.1, write: 1.25 } as const;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/**
 * --price-date: YYYY-MM-DD или полный YYYY-MM-DDTHH:MM:SS[.mmm]Z → unix ms;
 * без флага — сейчас (факт с датой записи). Точный момент нужен, чтобы
 * ИСПРАВИТЬ уже записанный факт цены (ключ таблицы — model_id+valid_from),
 * а не завести рядом второй: неполно введённая цена — ошибка ввода, а не
 * новая цена с новой даты.
 */
function priceDate(ctx: CommandContext): number | CommandFailure {
  const raw = flagStr(ctx, "price-date");
  if (raw === undefined) return Date.now();
  const bad = usage(
    "usage.date",
    `--price-date обязан быть YYYY-MM-DD или YYYY-MM-DDTHH:MM:SS[.mmm]Z, получено "${raw}"`,
  );
  if (!DATE_RE.test(raw) && !TIMESTAMP_RE.test(raw)) return bad;
  const ms = Date.parse(DATE_RE.test(raw) ? `${raw}T00:00:00Z` : raw);
  if (!Number.isFinite(ms)) return bad;
  return ms;
}

interface CachePrice {
  readonly usdPerMCacheRead: number;
  readonly usdPerMCacheWrite: number;
  /** Какие ставки пришли из умолчания, а не из флагов. */
  readonly defaulted: readonly string[];
}

/**
 * Ставки кеша из флагов; недостающие — по долям от цены входа. Возвращает
 * и то, что вывели, чтобы вызывающий назвал умолчание вслух.
 */
function cachePrice(ctx: CommandContext, usdPerMIn: number): CachePrice | CommandFailure {
  const read = flagNum(ctx, "price-cache-read");
  const write = flagNum(ctx, "price-cache-write");
  for (const [flag, value] of [
    ["--price-cache-read", read],
    ["--price-cache-write", write],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      return usage("usage.price", `${flag} обязан быть числом ≥ 0, получено "${value}"`);
    }
  }
  const defaulted: string[] = [];
  if (read === undefined) defaulted.push(`read=${CACHE_PRICE_SHARES.read * 100}%`);
  if (write === undefined) defaulted.push(`write=${CACHE_PRICE_SHARES.write * 100}%`);
  // Округление до цента за 1M: доля от цены даёт 0.30000000000000004,
  // и такой хвост в прайсе — мусор, а не точность.
  const share = (value: number): number => Math.round(usdPerMIn * value * 1e6) / 1e6;
  return {
    usdPerMCacheRead: read ?? share(CACHE_PRICE_SHARES.read),
    usdPerMCacheWrite: write ?? share(CACHE_PRICE_SHARES.write),
    defaulted,
  };
}

/** Умолчание обязано быть слышно: что применили, к чему и что задать взамен. */
function warnDefaulted(ctx: CommandContext, cache: CachePrice, usdPerMIn: number): void {
  if (cache.defaulted.length === 0) return;
  ctx.warn(
    "price.cache_defaulted",
    `ставки кеша не заданы: применено умолчание ${cache.defaulted.join(", ")} от --price-in ` +
      `${usdPerMIn} → read ${cache.usdPerMCacheRead}, write ${cache.usdPerMCacheWrite} $/1M. ` +
      "Это допущение, а не прайс провайдера: задайте --price-cache-read/--price-cache-write",
  );
}

function strengthsArg(ctx: CommandContext): string[] | undefined {
  const raw = flagStr(ctx, "strengths");
  if (raw === undefined) return undefined;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

const PRICE_FLAGS: readonly FlagSpec[] = [
  { name: "price-in", value: "number", description: "USD per 1M input tokens" },
  { name: "price-out", value: "number", description: "USD per 1M output tokens" },
  {
    name: "price-cache-read",
    value: "number",
    description: `USD per 1M cache-read tokens (default: ${CACHE_PRICE_SHARES.read * 100}% of --price-in)`,
  },
  {
    name: "price-cache-write",
    value: "number",
    description: `USD per 1M cache-write tokens (default: ${CACHE_PRICE_SHARES.write * 100}% of --price-in)`,
  },
  {
    name: "price-date",
    value: "string",
    description: "price valid from YYYY-MM-DD or full ISO timestamp (default: now)",
  },
];

const MODEL_FLAGS: readonly FlagSpec[] = [
  { name: "family", value: "string", description: "model family for prior inheritance, e.g. claude-sonnet" },
  { name: "harness", value: "string", description: `launch harness: ${HARNESSES.join("|")}` },
  { name: "effort", value: "string", description: `reasoning effort: ${EFFORTS.join("|")} (default medium)` },
  { name: "version", value: "string", description: "model version, e.g. 5.4" },
  { name: "parent", value: "string", description: "previous version's model id" },
  { name: "tps", value: "number", description: "tokens per second (cold-start latency estimate)" },
  { name: "strengths", value: "string", description: "comma-separated task classes the model is good at" },
  ...PRICE_FLAGS,
];

function buildAddCommand(deps: RosterDeps): Command {
  return {
    name: "add",
    summary: "add a model to the roster",
    help: "Цена обязательна и хранится с датой (--price-date, по умолчанию сегодня): факт, а не константа.",
    flags: MODEL_FLAGS,
    handler: (ctx): CommandResult => {
      const modelId = ctx.args[0];
      if (modelId === undefined) return usage("usage.input", "нужен id модели: myc model add <id> …");
      const family = flagStr(ctx, "family");
      if (family === undefined) return usage("usage.input", "нужен --family");
      const harness = flagStr(ctx, "harness");
      if (harness === undefined) return usage("usage.input", "нужен --harness");
      const priceIn = flagNum(ctx, "price-in");
      const priceOut = flagNum(ctx, "price-out");
      if (priceIn === undefined || priceOut === undefined) {
        return usage("usage.price", "нужны --price-in и --price-out (USD за 1M токенов)");
      }
      const validFrom = priceDate(ctx);
      if (typeof validFrom !== "number") return validFrom;
      const cache = cachePrice(ctx, priceIn);
      if (!("usdPerMCacheRead" in cache)) return cache;

      const opened = deps.openRoster(ctx);
      if (!("roster" in opened)) return opened;
      try {
        const input: AddModelInput = {
          modelId,
          family,
          harness: harness as AddModelInput["harness"],
          effort: flagStr(ctx, "effort") as AddModelInput["effort"],
          version: flagStr(ctx, "version"),
          parentModelId: flagStr(ctx, "parent"),
          tokensPerSec: flagNum(ctx, "tps"),
          strengths: strengthsArg(ctx),
          price: {
            usdPerMIn: priceIn,
            usdPerMOut: priceOut,
            usdPerMCacheRead: cache.usdPerMCacheRead,
            usdPerMCacheWrite: cache.usdPerMCacheWrite,
            validFrom,
          },
        };
        warnDefaulted(ctx, cache, priceIn);
        const model = opened.roster.addModel(input);
        const entry = opened.roster.getModel(model.modelId);
        return { ok: true, data: entryView(entry!) };
      } catch (e) {
        return rosterFailure(e);
      } finally {
        opened.close();
      }
    },
  };
}

function buildUpdateCommand(deps: RosterDeps): Command {
  return {
    name: "update",
    summary: "change roster fields; a new price is a new dated fact",
    flags: MODEL_FLAGS,
    handler: (ctx): CommandResult => {
      const modelId = ctx.args[0];
      if (modelId === undefined) return usage("usage.input", "нужен id модели: myc model update <id> …");

      const patch: {
        -readonly [K in keyof UpdateModelInput]?: UpdateModelInput[K];
      } = {};
      const family = flagStr(ctx, "family");
      if (family !== undefined) patch.family = family;
      const harness = flagStr(ctx, "harness");
      if (harness !== undefined) patch.harness = harness as UpdateModelInput["harness"];
      const effort = flagStr(ctx, "effort");
      if (effort !== undefined) patch.effort = effort as UpdateModelInput["effort"];
      const version = flagStr(ctx, "version");
      if (version !== undefined) patch.version = version;
      const parent = flagStr(ctx, "parent");
      if (parent !== undefined) patch.parentModelId = parent;
      const tps = flagNum(ctx, "tps");
      if (tps !== undefined) patch.tokensPerSec = tps;
      const strengths = strengthsArg(ctx);
      if (strengths !== undefined) patch.strengths = strengths;

      const priceIn = flagNum(ctx, "price-in");
      const priceOut = flagNum(ctx, "price-out");
      const cacheGiven =
        flagNum(ctx, "price-cache-read") !== undefined ||
        flagNum(ctx, "price-cache-write") !== undefined;
      const priceTouched = priceIn !== undefined || priceOut !== undefined || cacheGiven;
      let validFrom = 0;
      if (priceTouched) {
        if ((priceIn === undefined) !== (priceOut === undefined)) {
          return usage("usage.price", "цену меняем парой: --price-in и --price-out вместе");
        }
        const parsed = priceDate(ctx);
        if (typeof parsed !== "number") return parsed;
        validFrom = parsed;
      }

      if (Object.keys(patch).length === 0 && !priceTouched) {
        return usage("usage.input", "нечего менять: передайте хотя бы один флаг");
      }

      const opened = deps.openRoster(ctx);
      if (!("roster" in opened)) return opened;
      try {
        if (priceTouched) {
          // Правка одних лишь ставок кеша — это по-прежнему полный факт
          // цены: недостающие in/out берём из действующей на ту же дату
          // строки, а не пишем строку с дырами.
          let base: { in: number; out: number } | undefined;
          if (priceIn === undefined) {
            const current = opened.roster.getModel(modelId, validFrom);
            if (current === undefined) {
              return {
                ok: false,
                code: "notfound.model",
                msg: `модель "${modelId}" не найдена в ростере`,
                exit: ExitCode.NOTFOUND,
              };
            }
            if (current.price === null) {
              return usage(
                "usage.price",
                "у модели нет цены, на которую опереться: задайте --price-in и --price-out",
              );
            }
            base = { in: current.price.usdPerMIn, out: current.price.usdPerMOut };
          } else {
            base = { in: priceIn, out: priceOut! };
          }
          const cache = cachePrice(ctx, base.in);
          if (!("usdPerMCacheRead" in cache)) return cache;
          warnDefaulted(ctx, cache, base.in);
          patch.price = {
            usdPerMIn: base.in,
            usdPerMOut: base.out,
            usdPerMCacheRead: cache.usdPerMCacheRead,
            usdPerMCacheWrite: cache.usdPerMCacheWrite,
            validFrom,
          };
        }
        opened.roster.updateModel(modelId, patch);
        const entry = opened.roster.getModel(modelId);
        return { ok: true, data: entryView(entry!) };
      } catch (e) {
        return rosterFailure(e);
      } finally {
        opened.close();
      }
    },
  };
}

function buildListCommand(deps: RosterDeps): Command {
  return {
    name: "list",
    summary: "roster entries with current prices; stale prices are flagged",
    flags: [{ name: "all", description: "include disabled models" }],
    handler: (ctx): CommandResult => {
      const opened = deps.openRoster(ctx);
      if (!("roster" in opened)) return opened;
      try {
        const entries = opened.roster.listModels({ includeInactive: flagBool(ctx, "all") });
        return { ok: true, data: entries.map(entryView), meta: { count: entries.length } };
      } catch (e) {
        return rosterFailure(e);
      } finally {
        opened.close();
      }
    },
  };
}

function buildShowCommand(deps: RosterDeps): Command {
  return {
    name: "show",
    summary: "one roster entry with full price history",
    handler: (ctx): CommandResult => {
      const modelId = ctx.args[0];
      if (modelId === undefined) return usage("usage.input", "нужен id модели: myc model show <id>");
      const opened = deps.openRoster(ctx);
      if (!("roster" in opened)) return opened;
      try {
        const entry = opened.roster.getModel(modelId);
        if (entry === undefined) {
          return {
            ok: false,
            code: "notfound.model",
            msg: `модель "${modelId}" не найдена в ростере`,
            exit: ExitCode.NOTFOUND,
          };
        }
        // История печатает все четыре ставки: нулевая цена кеша в старой
        // строке — то, что читатель обязан увидеть, а не то, что мы прячем.
        const history = opened.roster.priceHistory(modelId).map((p) => ({
          validFrom: new Date(p.validFrom).toISOString(),
          usdPerMIn: p.usdPerMIn,
          usdPerMOut: p.usdPerMOut,
          usdPerMCacheRead: p.usdPerMCacheRead,
          usdPerMCacheWrite: p.usdPerMCacheWrite,
        }));
        return { ok: true, data: { ...entryView(entry), priceHistory: history } };
      } catch (e) {
        return rosterFailure(e);
      } finally {
        opened.close();
      }
    },
  };
}

function buildSetActiveCommand(deps: RosterDeps, active: boolean): Command {
  const name = active ? "enable" : "disable";
  return {
    name,
    summary: active
      ? "return a model to the roster"
      : "soft-delete: hide from list, keep record and price history",
    handler: (ctx): CommandResult => {
      const modelId = ctx.args[0];
      if (modelId === undefined) return usage("usage.input", `нужен id модели: myc model ${name} <id>`);
      const opened = deps.openRoster(ctx);
      if (!("roster" in opened)) return opened;
      try {
        if (active) opened.roster.enableModel(modelId);
        else opened.roster.disableModel(modelId);
        const entry = opened.roster.getModel(modelId);
        return { ok: true, data: entryView(entry!) };
      } catch (e) {
        return rosterFailure(e);
      } finally {
        opened.close();
      }
    },
  };
}

export function createModelCommand(deps: RosterDeps = realDeps): Command {
  return {
    name: "model",
    summary: "model roster: harness, effort, dated prices (swarm routing data)",
    subcommands: [
      buildAddCommand(deps),
      buildUpdateCommand(deps),
      buildListCommand(deps),
      buildShowCommand(deps),
      buildSetActiveCommand(deps, false),
      buildSetActiveCommand(deps, true),
    ],
  };
}

export const modelCommand: Command = createModelCommand();
