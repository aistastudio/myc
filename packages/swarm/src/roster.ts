import type { Database } from "bun:sqlite";
import { HARNESSES, type Harness } from "./harness.ts";

/**
 * Ростер моделей роя — домен поверх таблиц swarm_model / swarm_model_price
 * (миграции ./migrations/). Здесь вся валидация, которую нельзя выразить
 * в схеме, и форма данных, которую читает раздающий задачи.
 *
 * Инварианты, которые держит этот модуль (на них стоят тесты и мутации):
 *
 * 1. Харнесс — закрытый список HARNESSES. Неизвестный харнесс отвергается
 *    RosterError(usage.harness) ДО записи; записи-призрака не появляется
 *    (дублирует CHECK схемы — барьер и на прямой INSERT).
 * 2. Цена — факт с датой: valid_from обязателен всегда. Без даты цена не
 *    записывается (usage.price), а читатель помечает протухшую
 *    (priceStale, порог PRICE_STALE_MS) — роутинг по устаревшим числам
 *    виден, а не тих.
 * 3. Удаление только мягкое (active=0). Запись никогда не стирается:
 *    на model_id ссылаются попытки и атрибуция закрытых задач.
 * 4. Цена кеша — часть цены, а не поправка к ней. У агентского запуска
 *    чтений кеша миллионы против десятков тысяч выходных токенов, поэтому
 *    нулевая ставка кеша занижает стоимость в разы, и занижает НЕРАВНОМЕРНО:
 *    сильнее у той модели, которая больше читала и меньше писала. Ноль
 *    поэтому не молчит — читатель видит cacheUnpriced и обязан его показать.
 */

// Список харнессов — общий на весь myc и живёт в ./harness.ts: ростеру он
// нужен для атрибуции, `myc wire` — для установки, и разъехаться они не
// имеют права. Реэкспорт здесь оставлен, чтобы @myc/swarm по-прежнему
// отдавал HARNESSES одним импортом.
export { HARNESSES, type Harness } from "./harness.ts";

export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Цена старше 90 дней считается протухшей: читатель обязан это видеть. */
export const PRICE_STALE_MS = 90 * 24 * 60 * 60 * 1000;

export type RosterErrorCode =
  | "usage.input"
  | "usage.harness"
  | "usage.effort"
  | "usage.price"
  | "usage.date"
  | "notfound.model"
  | "conflict.model";

export class RosterError extends Error {
  readonly code: RosterErrorCode;

  constructor(code: RosterErrorCode, message: string) {
    super(message);
    this.name = "RosterError";
    this.code = code;
  }
}

export interface RosterModel {
  readonly modelId: string;
  readonly family: string;
  readonly version: string;
  readonly parentModelId: string | null;
  readonly harness: Harness;
  readonly effort: Effort;
  readonly tokensPerSec: number;
  /** Классы задач, на которых модель хороша; наполняет атрибуция (W11). */
  readonly strengths: readonly string[];
  readonly active: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ModelPrice {
  readonly modelId: string;
  readonly validFrom: number;
  readonly usdPerMIn: number;
  readonly usdPerMOut: number;
  readonly usdPerMCacheRead: number;
  readonly usdPerMCacheWrite: number;
}

export interface PriceInput {
  readonly usdPerMIn: number;
  readonly usdPerMOut: number;
  /** unix ms; обязателен — цена без даты не хранится. */
  readonly validFrom: number;
  readonly usdPerMCacheRead?: number;
  readonly usdPerMCacheWrite?: number;
}

export interface AddModelInput {
  readonly modelId: string;
  readonly family: string;
  readonly harness: Harness;
  readonly effort?: Effort;
  readonly price: PriceInput;
  readonly version?: string;
  readonly parentModelId?: string;
  readonly tokensPerSec?: number;
  readonly strengths?: readonly string[];
}

export interface UpdateModelInput {
  readonly family?: string;
  readonly harness?: Harness;
  readonly effort?: Effort;
  readonly version?: string;
  readonly parentModelId?: string | null;
  readonly tokensPerSec?: number;
  readonly strengths?: readonly string[];
  /** Новая цена — отдельным фактом со своей датой; история сохраняется. */
  readonly price?: PriceInput;
}

export interface RosterEntry {
  readonly model: RosterModel;
  /** Действующая на `now` цена (max valid_from ≤ now; иначе самая ранняя). */
  readonly price: ModelPrice | null;
  /** Возраст действующей цены в полных днях; null — цены нет вовсе. */
  readonly priceAgeDays: number | null;
  /** true, когда действующей цене больше PRICE_STALE_MS. */
  readonly priceStale: boolean;
  /**
   * Цена есть, но обе ставки кеша нулевые. Для харнесса, который читает
   * кеш миллионами токенов, это не «кеш бесплатен», а «цену кеша не
   * завели»: счёт по такой строке занижен и переставляет модели местами.
   * Отличить одно от другого мы не можем, поэтому говорим вслух.
   */
  readonly cacheUnpriced: boolean;
}

/** Цена кеша не заведена: обе ставки нулевые. */
export function isCacheUnpriced(price: ModelPrice): boolean {
  return price.usdPerMCacheRead === 0 && price.usdPerMCacheWrite === 0;
}

export function isPriceStale(validFrom: number, now: number): boolean {
  return now - validFrom > PRICE_STALE_MS;
}

function requireHarness(value: string): Harness {
  if ((HARNESSES as readonly string[]).includes(value)) return value as Harness;
  throw new RosterError(
    "usage.harness",
    `неизвестный харнесс "${value}"; известно: ${HARNESSES.join(", ")}`,
  );
}

function requireEffort(value: string): Effort {
  if ((EFFORTS as readonly string[]).includes(value)) return value as Effort;
  throw new RosterError(
    "usage.effort",
    `неизвестный уровень рассуждений "${value}"; известно: ${EFFORTS.join(", ")}`,
  );
}

function requirePrice(price: PriceInput): void {
  if (!Number.isFinite(price.usdPerMIn) || price.usdPerMIn < 0) {
    throw new RosterError("usage.price", `usdPerMIn обязан быть числом ≥ 0`);
  }
  if (!Number.isFinite(price.usdPerMOut) || price.usdPerMOut < 0) {
    throw new RosterError("usage.price", `usdPerMOut обязан быть числом ≥ 0`);
  }
  for (const [name, value] of [
    ["usdPerMCacheRead", price.usdPerMCacheRead],
    ["usdPerMCacheWrite", price.usdPerMCacheWrite],
  ] as const) {
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new RosterError("usage.price", `${name} обязан быть числом ≥ 0`);
    }
  }
  if (!Number.isInteger(price.validFrom) || price.validFrom <= 0) {
    throw new RosterError(
      "usage.price",
      "цена обязана храниться с датой: validFrom (unix ms) отсутствует",
    );
  }
}

interface ModelRow {
  model_id: string;
  family: string;
  version: string;
  parent_model_id: string | null;
  harness: string;
  effort: string;
  tokens_per_sec: number;
  strengths: string;
  active: number;
  created_at: number;
  updated_at: number;
}

interface PriceRow {
  model_id: string;
  valid_from: number;
  usd_per_m_in: number;
  usd_per_m_out: number;
  usd_per_m_cache_read: number;
  usd_per_m_cache_write: number;
}

function toModel(row: ModelRow): RosterModel {
  return {
    modelId: row.model_id,
    family: row.family,
    version: row.version,
    parentModelId: row.parent_model_id,
    harness: row.harness as Harness,
    effort: row.effort as Effort,
    tokensPerSec: row.tokens_per_sec,
    strengths: JSON.parse(row.strengths) as string[],
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPrice(row: PriceRow): ModelPrice {
  return {
    modelId: row.model_id,
    validFrom: row.valid_from,
    usdPerMIn: row.usd_per_m_in,
    usdPerMOut: row.usd_per_m_out,
    usdPerMCacheRead: row.usd_per_m_cache_read,
    usdPerMCacheWrite: row.usd_per_m_cache_write,
  };
}

export class Roster {
  readonly #db: Database;
  readonly #now: () => number;

  constructor(db: Database, now: () => number = Date.now) {
    this.#db = db;
    this.#now = now;
  }

  /**
   * Запись всегда в BEGIN IMMEDIATE, а не в deferred-транзакции bun:sqlite:
   * два процесса с deferred-чтением, повышающимся до записи, получают
   * SQLITE_BUSY_SNAPSHOT мгновенно, в обход busy_timeout — а конкурентные
   * `myc model add` из параллельных терминалов это штатная ситуация.
   * Вызывающий обязан выставить PRAGMA busy_timeout на соединении.
   */
  #writeTx(fn: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  addModel(input: AddModelInput): RosterModel {
    if (input.modelId.trim() === "") {
      throw new RosterError("usage.input", "modelId обязан быть непустым");
    }
    if (input.family.trim() === "") {
      throw new RosterError("usage.input", "family обязан быть непустым");
    }
    requireHarness(input.harness);
    const effort = input.effort ?? "medium";
    requireEffort(effort);
    requirePrice(input.price);

    const now = this.#now();
    try {
      this.#writeTx(() => {
        this.#db
          .query(
            `INSERT INTO swarm_model (model_id, family, version, parent_model_id, harness,
                                      effort, tokens_per_sec, strengths, active,
                                      created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)`,
          )
          .run(
            input.modelId,
            input.family,
            input.version ?? "",
            input.parentModelId ?? null,
            input.harness,
            effort,
            input.tokensPerSec ?? 60,
            JSON.stringify(input.strengths ?? []),
            now,
          );
        this.#insertPrice(input.modelId, input.price);
      });
    } catch (e) {
      if (e instanceof Error && /UNIQUE constraint failed: swarm_model/.test(e.message)) {
        throw new RosterError(
          "conflict.model",
          `модель "${input.modelId}" уже в ростере; изменяйте через update`,
        );
      }
      throw e;
    }
    return this.#requireModel(input.modelId);
  }

  updateModel(modelId: string, patch: UpdateModelInput): RosterModel {
    this.#requireModel(modelId);
    if (patch.harness !== undefined) requireHarness(patch.harness);
    if (patch.effort !== undefined) requireEffort(patch.effort);
    if (patch.price !== undefined) requirePrice(patch.price);

    const now = this.#now();
    this.#writeTx(() => {
      const sets: string[] = [];
      const params: Array<string | number | null> = [];
      const field = (column: string, value: string | number | null): void => {
        sets.push(`${column} = ?${params.length + 1}`);
        params.push(value);
      };
      if (patch.family !== undefined) field("family", patch.family);
      if (patch.harness !== undefined) field("harness", patch.harness);
      if (patch.effort !== undefined) field("effort", patch.effort);
      if (patch.version !== undefined) field("version", patch.version);
      if (patch.parentModelId !== undefined) field("parent_model_id", patch.parentModelId);
      if (patch.tokensPerSec !== undefined) field("tokens_per_sec", patch.tokensPerSec);
      if (patch.strengths !== undefined) field("strengths", JSON.stringify(patch.strengths));
      if (sets.length > 0) {
        field("updated_at", now);
        this.#db
          .query(
            `UPDATE swarm_model SET ${sets.join(", ")} WHERE model_id = ?${params.length + 1}`,
          )
          .run(...params, modelId);
      }
      if (patch.price !== undefined) this.#insertPrice(modelId, patch.price);
    });
    return this.#requireModel(modelId);
  }

  /** Мягкое удаление: запись и история цен остаются для атрибуции. */
  disableModel(modelId: string): RosterModel {
    this.#setActive(modelId, false);
    return this.#requireModel(modelId);
  }

  enableModel(modelId: string): RosterModel {
    this.#setActive(modelId, true);
    return this.#requireModel(modelId);
  }

  /** Читает модель независимо от active — история обязана переживать disable. */
  getModel(modelId: string, now: number = this.#now()): RosterEntry | undefined {
    const row = this.#db
      .query("SELECT * FROM swarm_model WHERE model_id = ?1")
      .get(modelId) as ModelRow | null;
    if (row === null) return undefined;
    return this.#entry(toModel(row), now);
  }

  listModels(options: { includeInactive?: boolean; now?: number } = {}): RosterEntry[] {
    const now = options.now ?? this.#now();
    const rows = (
      options.includeInactive === true
        ? this.#db.query("SELECT * FROM swarm_model ORDER BY model_id").all()
        : this.#db
            .query("SELECT * FROM swarm_model WHERE active = 1 ORDER BY model_id")
            .all()
    ) as ModelRow[];
    return rows.map((row) => this.#entry(toModel(row), now));
  }

  /** Вся история цен модели, от новых к старым — цена это факты с датами. */
  priceHistory(modelId: string): ModelPrice[] {
    this.#requireModel(modelId);
    const rows = this.#db
      .query(
        `SELECT * FROM swarm_model_price WHERE model_id = ?1 ORDER BY valid_from DESC`,
      )
      .all(modelId) as PriceRow[];
    return rows.map(toPrice);
  }

  #insertPrice(modelId: string, price: PriceInput): void {
    this.#db
      .query(
        `INSERT INTO swarm_model_price
           (model_id, valid_from, usd_per_m_in, usd_per_m_out,
            usd_per_m_cache_read, usd_per_m_cache_write)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (model_id, valid_from) DO UPDATE SET
           usd_per_m_in = excluded.usd_per_m_in,
           usd_per_m_out = excluded.usd_per_m_out,
           usd_per_m_cache_read = excluded.usd_per_m_cache_read,
           usd_per_m_cache_write = excluded.usd_per_m_cache_write`,
      )
      .run(
        modelId,
        price.validFrom,
        price.usdPerMIn,
        price.usdPerMOut,
        price.usdPerMCacheRead ?? 0,
        price.usdPerMCacheWrite ?? 0,
      );
  }

  #setActive(modelId: string, active: boolean): void {
    this.#requireModel(modelId);
    this.#db
      .query("UPDATE swarm_model SET active = ?1, updated_at = ?2 WHERE model_id = ?3")
      .run(active ? 1 : 0, this.#now(), modelId);
  }

  #requireModel(modelId: string): RosterModel {
    const row = this.#db
      .query("SELECT * FROM swarm_model WHERE model_id = ?1")
      .get(modelId) as ModelRow | null;
    if (row === null) {
      throw new RosterError("notfound.model", `модель "${modelId}" не найдена в ростере`);
    }
    return toModel(row);
  }

  #entry(model: RosterModel, now: number): RosterEntry {
    const price = this.#currentPrice(model.modelId, now);
    return {
      model,
      price,
      priceAgeDays:
        price === null ? null : Math.floor((now - price.validFrom) / (24 * 60 * 60 * 1000)),
      priceStale: price !== null && isPriceStale(price.validFrom, now),
      cacheUnpriced: price !== null && isCacheUnpriced(price),
    };
  }

  #currentPrice(modelId: string, now: number): ModelPrice | null {
    const current = this.#db
      .query(
        `SELECT * FROM swarm_model_price
          WHERE model_id = ?1 AND valid_from <= ?2
          ORDER BY valid_from DESC LIMIT 1`,
      )
      .get(modelId, now) as PriceRow | null;
    if (current !== null) return toPrice(current);
    // Все цены в будущем — берём самую раннюю известную.
    const earliest = this.#db
      .query(
        `SELECT * FROM swarm_model_price
          WHERE model_id = ?1 ORDER BY valid_from ASC LIMIT 1`,
      )
      .get(modelId) as PriceRow | null;
    return earliest === null ? null : toPrice(earliest);
  }
}
