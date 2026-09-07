import { Database } from "bun:sqlite";
import { statSync } from "node:fs";

// Checkpoint WAL вне потока писателя (решение S35, docs/design/ARCHITECTURE.md §10).
//
// Штатный `PRAGMA wal_autocheckpoint = 2000` из §8.1.0 кладёт синхронный
// checkpoint на поток писателя: при `synchronous = NORMAL` fsync основного
// файла делает именно checkpoint, он приходит раз в ~70 записей и стоит
// 12-17 мс — это и есть весь хвост p99 (11.78 мс против 0.46 при выключенном
// авточекпойнте). Поэтому авточекпойнт выключен, а работа переехала в класс
// `compact` очереди `jobs`.
//
// Демона у нас нет (решение S8: хвост очереди подхватывает следующий вызов
// CLI), поэтому полагаться на то, что фоновый обработчик когда-нибудь
// запустится, нельзя. Предохранитель обязателен: по достижении жёсткого
// потолка следующая запись делает `wal_checkpoint(PASSIVE)` синхронно.
// Так рост ограничен, даже если фон не запускался ни разу.

/**
 * Жёсткий потолок размера WAL: 32 МиБ (8192 страницы по 4 КиБ — вчетверо
 * больше выключенного `wal_autocheckpoint = 2000`).
 *
 * Число выбрано замером на прогретой базе в 100k узлов (296 МБ), macOS arm64,
 * Bun 1.3.14, SQLite 3.51.0 — тремя ограничениями сразу:
 *
 *  1. **Частота срабатывания.** Одна запись узла добавляет в WAL ~115 КБ
 *     (26 страниц: строка, оплог, часы полей, счётчики, FTS, производные).
 *     32 МиБ — это ~280 записей между срабатываниями, 0.36 % записей. Хвост
 *     p99 отсекает 1 %, поэтому предохранитель в него не попадает даже когда
 *     фон не запускался ни разу: замер 6000 записей подряд без единого запуска
 *     фона дал 0.35 % срабатываний и p99 2.56 мс при пике WAL ровно 32.0 МБ.
 *     Потолок 8 МиБ (как у старого авточекпойнта) дал бы ~1.4 % — ровно
 *     сегодняшний сломанный p99 (11.3 мс на том же прогоне).
 *  2. **Холодный старт.** Невосстановленный WAL читается целиком при первом
 *     открытии базы: замер 4→128 МиБ монотонен и даёт 0.19 мс на МиБ
 *     (5.1 / 6.3 / 8.0 / 11.2 / 17.4 / 29.0 мс на 4/8/16/32/64/128 МиБ).
 *     32 МиБ — это ~6 мс, десятая часть бюджета холодного старта в 60 мс.
 *     При 128 МиБ было бы 24 мс, то есть 40 % бюджета — недопустимо.
 *  3. **Цена самого срабатывания.** `wal_checkpoint(PASSIVE)` на той же базе
 *     стоит 12.1 / 20.5 / 34.2 / 62.9 мс при WAL 8 / 16 / 32 / 64 МиБ; в живом
 *     прогоне сработавшие записи заняли 30.3-39.3 мс (медиана 32.4). Это
 *     худший случай одной записи из ~280 и только при мёртвом фоне; при 64 МиБ
 *     цена удваивается, а выигрыш по частоте уже не окупает.
 *
 * Диск: потолок фиксированный, ~10 % от базы в 296 МБ на 100k узлов.
 */
export const WAL_HARD_LIMIT_BYTES = 32 * 1024 * 1024;

/**
 * Мягкий порог: с него ставится фоновое задание класса `compact`.
 * 8 МиБ — ровно та точка, в которой старый `wal_autocheckpoint = 2000` делал
 * checkpoint синхронно; теперь в ней всего лишь появляется задание в очереди.
 */
export const WAL_SOFT_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Насколько должен вырасти WAL, чтобы повторить неудавшийся checkpoint.
 * PASSIVE не может перенести кадры, которые ещё читает чужой снимок; без
 * этого зазора каждая следующая запись платила бы за заведомо пустую попытку.
 */
export const WAL_REARM_BYTES = 4 * 1024 * 1024;

/** Класс задания в очереди `jobs` (§8.1.7) и его ключ дедупликации. */
export const COMPACT_JOB_KIND = "compact";
export const WAL_JOB_ENTITY = "wal";

/** Приоритет задания: как у таймерных прогонов дистиллятора (§5.3). */
export const WAL_JOB_PRIORITY = 7;

export type CheckpointMode = "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE";

export interface CheckpointResult {
  /** Checkpoint не смог получить нужные блокировки (чужой писатель/читатель). */
  readonly busy: boolean;
  /** Кадров в WAL на момент вызова. */
  readonly log: number;
  /** Из них перенесено в основной файл. */
  readonly checkpointed: number;
  /** log === checkpointed и не busy — WAL перенесён целиком. */
  readonly complete: boolean;
}

interface CheckpointRow {
  readonly busy: number;
  readonly log: number;
  readonly checkpointed: number;
}

/** `PRAGMA wal_checkpoint(<mode>)` с разобранным результатом. */
export function walCheckpoint(
  db: Database,
  mode: CheckpointMode = "PASSIVE",
): CheckpointResult {
  const row = db.query(`PRAGMA wal_checkpoint(${mode})`).get() as CheckpointRow | null;
  // Строки нет только у баз без WAL (:memory:) — считаем это пустым WAL.
  const busy = row === null ? false : row.busy !== 0;
  const log = row === null ? 0 : row.log;
  const checkpointed = row === null ? 0 : row.checkpointed;
  return { busy, log, checkpointed, complete: !busy && log === checkpointed };
}

/** Путь к файлу WAL или null, если у базы его быть не может (`:memory:`). */
export function walPath(db: Database): string | null {
  const name = db.filename;
  if (name === "" || name === ":memory:") return null;
  return `${name}-wal`;
}

/**
 * Размер WAL в байтах.
 *
 * Мера честная только при `PRAGMA journal_size_limit = 0`: после checkpoint
 * SQLite не укорачивает файл сам, а переиспользует его с начала, и без
 * усечения размер навсегда залипает на достигнутом максимуме. Ровно поэтому
 * дефект и не был виден по размеру файла (см. myc-443).
 */
export function walSizeBytes(db: Database): number {
  const path = walPath(db);
  if (path === null) return 0;
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

export interface WalGuardOptions {
  /** Потолок, выше которого запись платит за checkpoint сама. */
  readonly hardLimitBytes?: number;
  /** Порог, с которого ставится фоновое задание. */
  readonly softLimitBytes?: number;
  /** Зазор перед повтором неудавшегося checkpoint. */
  readonly rearmBytes?: number;
  /** Ставить ли задание класса `compact`; выключается, если таблицы `jobs` нет. */
  readonly enqueueJob?: boolean;
  readonly now?: () => number;
}

export interface WalGuardStats {
  /** Сколько раз предохранитель делал checkpoint синхронно. */
  readonly checkpoints: number;
  /** Сколько из них не смогли перенести WAL целиком. */
  readonly incomplete: number;
  /** Сколько раз ставилось фоновое задание. */
  readonly enqueued: number;
  /** Длительность последнего синхронного checkpoint, мс. */
  readonly lastMs: number;
  /** Суммарно потрачено на синхронные checkpoint, мс. */
  readonly totalMs: number;
  /** Текущий размер WAL, байт. */
  readonly walBytes: number;
  /**
   * WAL выше потолка, а checkpoint его не разгребает. Громкая деградация (И2):
   * рост в этом состоянии не ограничен, и это должно быть видно в `myc doctor`.
   */
  readonly degraded: boolean;
  /** Последняя ошибка предохранителя; он никогда не роняет успевшую запись. */
  readonly lastError: string | null;
}

export interface WalGuard {
  /** Вызывается после каждого удачного коммита писателя. Не бросает. */
  afterCommit(): void;
  /** Принудительный checkpoint (фоновый обработчик, закрытие, тесты). */
  checkpointNow(mode?: CheckpointMode): CheckpointResult;
  stats(): WalGuardStats;
}

const INSERT_JOB = `
INSERT OR IGNORE INTO jobs (kind, entity_id, scope, priority, run_after, payload, created_at)
VALUES (?, ?, '', ?, ?, '{"op":"wal_checkpoint"}', ?)`;

const DELETE_JOB = `DELETE FROM jobs WHERE kind = ? AND entity_id = ?`;

/**
 * Ставит задание класса `compact` на checkpoint. Идемпотентно: уникальный
 * индекс `ux_jobs_dedup(kind, entity_id)` держит в очереди ровно одну строку.
 * Возвращает true, если строка появилась именно сейчас.
 */
export function enqueueWalCheckpointJob(db: Database, nowMs: number = Date.now()): boolean {
  const res = db
    .query(INSERT_JOB)
    .run(COMPACT_JOB_KIND, WAL_JOB_ENTITY, WAL_JOB_PRIORITY, nowMs, nowMs);
  return Number(res.changes) > 0;
}

/** Снимает задание с очереди (checkpoint сделан). */
export function dropWalCheckpointJob(db: Database): void {
  db.query(DELETE_JOB).run(COMPACT_JOB_KIND, WAL_JOB_ENTITY);
}

/** Ждёт ли очередь checkpoint. Для `myc doctor` и тестов. */
export function walCheckpointJobPending(db: Database): boolean {
  const row = db
    .query(`SELECT 1 AS x FROM jobs WHERE kind = ? AND entity_id = ? LIMIT 1`)
    .get(COMPACT_JOB_KIND, WAL_JOB_ENTITY) as { x: number } | null;
  return row !== null;
}

/**
 * Фоновая сторона: то, что должен вызвать обработчик класса `compact`.
 * Задание снимается только после полного переноса WAL — недоделанный
 * checkpoint обязан остаться в очереди.
 */
export function runWalCheckpointJob(
  db: Database,
  mode: CheckpointMode = "PASSIVE",
): CheckpointResult {
  const result = walCheckpoint(db, mode);
  if (result.complete) dropWalCheckpointJob(db);
  return result;
}

class SqliteWalGuard implements WalGuard {
  private readonly hard: number;
  private readonly soft: number;
  private readonly rearm: number;
  private readonly now: () => number;
  private readonly file: string | null;

  private enqueueEnabled: boolean;
  /** Размер, при котором повторять checkpoint бессмысленно (файл ещё не усечён). */
  private settled = 0;
  /** Задание в этом цикле роста ещё не ставилось. */
  private softArmed = true;

  private checkpoints = 0;
  private incomplete = 0;
  private enqueued = 0;
  private lastMs = 0;
  private totalMs = 0;
  private degraded = false;
  private lastError: string | null = null;

  constructor(
    private readonly db: Database,
    options: WalGuardOptions = {},
  ) {
    this.hard = options.hardLimitBytes ?? WAL_HARD_LIMIT_BYTES;
    this.soft = Math.min(options.softLimitBytes ?? WAL_SOFT_LIMIT_BYTES, this.hard);
    this.rearm = options.rearmBytes ?? WAL_REARM_BYTES;
    this.now = options.now ?? Date.now;
    this.enqueueEnabled = options.enqueueJob ?? true;
    this.file = walPath(db);
  }

  afterCommit(): void {
    if (this.file === null) return;
    try {
      // stat стоит ~0.7 мкс против ~200 мкс записи, поэтому меру берём точную,
      // а не «раз в N коммитов»: иначе одна большая транзакция проскочит порог.
      const size = statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;

      if (size < this.soft) {
        this.settled = 0;
        this.softArmed = true;
        this.degraded = false;
        return;
      }

      if (size >= this.hard) {
        if (size <= this.settled) return;
        this.fire(size);
        return;
      }

      if (this.enqueueEnabled && this.softArmed) {
        this.softArmed = false;
        if (enqueueWalCheckpointJob(this.db, this.now())) this.enqueued++;
      }
    } catch (error) {
      // Запись уже закоммичена — уронить её из-за обслуживания WAL нельзя.
      this.lastError = error instanceof Error ? error.message : String(error);
      this.enqueueEnabled = false;
    }
  }

  checkpointNow(mode: CheckpointMode = "PASSIVE"): CheckpointResult {
    const t = performance.now();
    const result = walCheckpoint(this.db, mode);
    this.lastMs = performance.now() - t;
    this.totalMs += this.lastMs;
    this.checkpoints++;
    if (!result.complete) this.incomplete++;
    return result;
  }

  private fire(size: number): void {
    const result = this.checkpointNow("PASSIVE");
    if (result.complete) {
      // WAL перенесён целиком, но файл ещё той же длины: `journal_size_limit`
      // укоротит его на ближайшем сбросе, то есть на следующей записи. До
      // тех пор повторять нечего.
      this.settled = size;
      this.degraded = false;
      if (this.enqueueEnabled) {
        try {
          dropWalCheckpointJob(this.db);
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.enqueueEnabled = false;
        }
      }
    } else {
      // Чужой снимок держит кадры: ждём ещё rearm байт роста, иначе каждая
      // следующая запись платила бы за заведомо пустую попытку.
      this.settled = size + this.rearm;
      this.degraded = true;
    }
  }

  stats(): WalGuardStats {
    return {
      checkpoints: this.checkpoints,
      incomplete: this.incomplete,
      enqueued: this.enqueued,
      lastMs: this.lastMs,
      totalMs: this.totalMs,
      walBytes: walSizeBytes(this.db),
      degraded: this.degraded,
      lastError: this.lastError,
    };
  }
}

export function createWalGuard(db: Database, options: WalGuardOptions = {}): WalGuard {
  return new SqliteWalGuard(db, options);
}
