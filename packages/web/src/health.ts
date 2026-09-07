/**
 * Экран «здоровье»: единственное место интерфейса, где деградация видна
 * целиком (инвариант И2 — молчаливого фолбэка не бывает).
 *
 * Собирается из четырёх источников:
 *   myc_health   — что записал пишущий процесс;
 *   myc_meta     — модель эмбеддера, размерность, версия схемы;
 *   схема        — применён ли векторный набор (значит, vec0 был доступен);
 *   файлы        — размер базы и WAL.
 *
 * Просмотрщик НЕ грузит расширение vec0 в свой процесс: это стоило бы
 * загрузки кастомного SQLite ради одной цифры. Поэтому состояние вектора
 * читается по факту наката schema_migrations_vec, и в интерфейсе так и
 * написано — «схема применена», а не «расширение работает».
 */

import type { CountRow, Degradation, HealthComponent, HealthPayload } from "./types.ts";
import type { ReadOnlyDb } from "./db.ts";
import { fileBytes } from "./workspace.ts";

/** Мягкий потолок WAL из предохранителя store-sqlite (решение S35). */
export const WAL_SOFT_LIMIT_BYTES = 8 * 1024 * 1024;
export const WAL_HARD_LIMIT_BYTES = 32 * 1024 * 1024;

function counts(db: ReadOnlyDb, sql: string): CountRow[] {
  return db.all<{ key: string; n: number }>(sql).map((r) => ({
    key: r.key ?? "—",
    n: Number(r.n ?? 0),
  }));
}

function numMeta(db: ReadOnlyDb, key: string): number | null {
  const raw = db.meta(key);
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export interface HealthOptions {
  readonly slug: string;
  readonly dbPath: string;
}

export function buildHealth(db: ReadOnlyDb, opts: HealthOptions): HealthPayload {
  const t0 = performance.now();
  const degraded: Degradation[] = [];

  const hasNodes = db.has("nodes");
  const hasEdges = db.has("edges");
  const hasOplog = db.has("oplog");
  const hasJobs = db.has("jobs");
  const hasAnchors = db.has("anchors");
  const hasSchemaMigrations = db.has("schema_migrations");

  if (!hasNodes) {
    degraded.push({
      code: "schema.missing",
      msg: "в базе нет таблицы nodes — схема не накатана; `myc init` или `myc doctor --schema`",
    });
  }

  // --- версия схемы --------------------------------------------------------
  // Источник истины — schema_migrations (учёт наката миграций), а не
  // myc_meta: там номер версии никогда не писался.
  const schemaVersion = hasSchemaMigrations
    ? (db.one<{ v: number | null }>("SELECT max(version) AS v FROM schema_migrations")?.v ?? null)
    : null;
  if (schemaVersion === null) {
    degraded.push({
      code: "schema.version_unknown",
      msg: hasSchemaMigrations
        ? "таблица schema_migrations пуста — ни одной миграции не накатано"
        : "в базе нет таблицы schema_migrations — версию схемы прочитать нельзя",
    });
  }

  // --- воркспейс ---------------------------------------------------------
  const dbBytes = fileBytes(opts.dbPath);
  const walBytes = fileBytes(`${opts.dbPath}-wal`);
  const shmBytes = fileBytes(`${opts.dbPath}-shm`);
  if (walBytes >= WAL_HARD_LIMIT_BYTES) {
    degraded.push({
      code: "wal.hard_limit",
      msg: `WAL ${(walBytes / 1048576).toFixed(1)} МБ — выше жёсткого потолка 32 МБ; нужен checkpoint`,
    });
  } else if (walBytes >= WAL_SOFT_LIMIT_BYTES) {
    degraded.push({
      code: "wal.soft_limit",
      msg: `WAL ${(walBytes / 1048576).toFixed(1)} МБ — выше мягкого потолка 8 МБ`,
    });
  }

  // --- узлы и рёбра ------------------------------------------------------
  const nodesTotal = hasNodes
    ? (db.one<{ n: number }>("SELECT count(*) AS n FROM nodes WHERE deleted_at IS NULL")?.n ?? 0)
    : 0;
  const byKind = hasNodes
    ? counts(
        db,
        `SELECT kind AS key, count(*) AS n FROM nodes WHERE deleted_at IS NULL
          GROUP BY kind ORDER BY n DESC`,
      )
    : [];
  const edgesTotal = hasEdges
    ? (db.one<{ n: number }>("SELECT count(*) AS n FROM edges WHERE deleted_at IS NULL")?.n ?? 0)
    : 0;
  const byType = hasEdges
    ? counts(
        db,
        `SELECT type AS key, count(*) AS n FROM edges WHERE deleted_at IS NULL
          GROUP BY type ORDER BY n DESC`,
      )
    : [];

  // --- эмбеддер ----------------------------------------------------------
  const embedModel = db.meta("embed_model") ?? "";
  const embedDim = numMeta(db, "embed_dim");
  let vecRows: number | null = null;
  let vecLoadedHere = false;
  try {
    if (db.has("nodes_vec")) {
      vecRows = db.one<{ n: number }>("SELECT count(*) AS n FROM nodes_vec")?.n ?? 0;
      vecLoadedHere = true;
    }
  } catch {
    // 'no such module: vec0' — расширение не загружено в этот процесс, и это
    // ожидаемо: просмотрщик его не грузит. Схему всё равно видно ниже.
    vecRows = null;
    vecLoadedHere = false;
  }

  const embedPending = hasJobs
    ? (db.one<{ n: number }>(
        "SELECT count(*) AS n FROM jobs WHERE kind = 'embed' AND attempts < max_attempts",
      )?.n ?? 0)
    : 0;
  const embedFailed = hasJobs
    ? (db.one<{ n: number }>(
        "SELECT count(*) AS n FROM jobs WHERE kind = 'embed' AND attempts >= max_attempts",
      )?.n ?? 0)
    : 0;

  let embedState: HealthPayload["embed"]["state"] = "unknown";
  let embedDetail: string;
  if (embedModel.length === 0) {
    embedState = "off";
    embedDetail = "модель не записана в myc_meta.embed_model — эмбеддинги выключены, поиск идёт по FTS";
    degraded.push({
      code: "embeddings.off",
      msg: "эмбеддер не настроен: векторный поиск недоступен, семантика урезана до полнотекста",
    });
  } else if (embedFailed > 0) {
    embedState = "degraded";
    embedDetail = `${embedModel}${embedDim !== null ? ` dim=${embedDim}` : ""} · ${embedFailed} задач исчерпали попытки`;
    degraded.push({
      code: "embeddings.failed",
      msg: `${embedFailed} задач эмбеддинга исчерпали попытки — часть узлов останется без вектора`,
    });
  } else {
    embedState = "ok";
    embedDetail = `${embedModel}${embedDim !== null ? ` dim=${embedDim}` : ""} · очередь ${embedPending}`;
  }

  // --- векторное расширение ---------------------------------------------
  const vecSchema = db.has("schema_migrations_vec");
  const vecVersions = vecSchema
    ? db
        .all<{ version: number }>(
          "SELECT version FROM schema_migrations_vec ORDER BY version ASC",
        )
        .map((r) => Number(r.version))
    : [];
  const vecApplied = vecVersions.length > 0;
  if (!vecApplied) {
    degraded.push({
      code: "vector.unavailable",
      msg: "расширение sqlite-vec (vec0) не загружалось: векторный набор миграций не накатан — векторный поиск выключен, остальные поверхности работают",
    });
  }
  const vecDetail = vecApplied
    ? `набор миграций применён (v${vecVersions.join(", v")})` +
      (vecLoadedHere
        ? ` · vec0 загружен в процессе просмотрщика · ${vecRows ?? 0} векторов`
        : " · vec0 в процессе просмотрщика не загружен (он его не грузит)")
    : "векторный набор миграций не накатан";

  // --- FTS ---------------------------------------------------------------
  const ftsAvailable = db.has("nodes_fts");
  if (!ftsAvailable && hasNodes) {
    degraded.push({ code: "fts.missing", msg: "нет таблицы nodes_fts — полнотекстовый поиск выключен" });
  }

  // --- очередь фоновых работ --------------------------------------------
  const jobsPending = hasJobs
    ? (db.one<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE attempts < max_attempts")?.n ?? 0)
    : 0;
  const jobsFailed = hasJobs
    ? (db.one<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE attempts >= max_attempts")?.n ?? 0)
    : 0;
  const jobsByKind = hasJobs
    ? counts(db, "SELECT kind AS key, count(*) AS n FROM jobs GROUP BY kind ORDER BY n DESC")
    : [];
  if (jobsFailed > 0) {
    degraded.push({ code: "jobs.failed", msg: `${jobsFailed} фоновых задач исчерпали попытки` });
  }

  // --- якоря -------------------------------------------------------------
  const anchorsTotal = hasAnchors
    ? (db.one<{ n: number }>("SELECT count(*) AS n FROM anchors")?.n ?? 0)
    : 0;
  const anchorsByState = hasAnchors
    ? counts(db, "SELECT state AS key, count(*) AS n FROM anchors GROUP BY state ORDER BY n DESC")
    : [];
  const stale = anchorsByState
    .filter((r) => r.key === "stale" || r.key === "lost")
    .reduce((s, r) => s + r.n, 0);
  if (stale > 0) {
    degraded.push({
      code: "anchor.stale",
      msg: `${stale} якорей протухло — привязка к коду больше не указывает на живой участок; myc anchor repair`,
    });
  }

  // --- оплог -------------------------------------------------------------
  const oplogCount = hasOplog
    ? (db.one<{ n: number }>("SELECT count(*) AS n FROM oplog")?.n ?? 0)
    : 0;
  const lastOp = hasOplog
    ? db.one<{ seq: number; ts_ms: number }>("SELECT seq, ts_ms FROM oplog ORDER BY seq DESC LIMIT 1")
    : undefined;
  const actors = hasOplog
    ? counts(
        db,
        `SELECT CASE WHEN actor = '' THEN '—' ELSE actor END AS key, count(*) AS n
           FROM oplog GROUP BY key ORDER BY n DESC LIMIT 8`,
      )
    : [];

  // --- компоненты, записанные пишущим процессом --------------------------
  const components: HealthComponent[] = db.has("myc_health")
    ? db
        .all<{ component: string; state: string; reason: string; since: number }>(
          "SELECT component, state, reason, since FROM myc_health ORDER BY component",
        )
        .map((r) => ({
          component: String(r.component),
          state: String(r.state),
          reason: String(r.reason ?? ""),
          since: Number(r.since ?? 0),
        }))
    : [];
  for (const c of components) {
    if (c.state === "ok") continue;
    degraded.push({
      code: `health.${c.component}`,
      msg: `${c.component}: ${c.state}${c.reason.length > 0 ? ` — ${c.reason}` : ""}`,
    });
  }

  return {
    workspace: {
      slug: opts.slug,
      db_path: opts.dbPath,
      db_bytes: dbBytes,
      wal_bytes: walBytes,
      shm_bytes: shmBytes,
      journal_mode: db.journalMode(),
      schema_version: schemaVersion,
      site_id: db.meta("site_id") ?? "",
      myc_version: db.meta("myc_version") ?? "",
      read_only: true,
    },
    nodes: { total: nodesTotal, by_kind: byKind },
    edges: { total: edgesTotal, by_type: byType },
    embed: {
      model: embedModel,
      dim: embedDim,
      rows: vecRows,
      pending: embedPending,
      failed: embedFailed,
      state: embedState,
      detail: embedDetail,
    },
    vec: {
      schema_applied: vecApplied,
      versions: vecVersions,
      loaded_here: vecLoadedHere,
      detail: vecDetail,
    },
    fts: {
      available: ftsAvailable,
      detail: ftsAvailable ? "nodes_fts на месте" : "таблицы nodes_fts нет",
    },
    jobs: { pending: jobsPending, failed: jobsFailed, by_kind: jobsByKind },
    anchors: { total: anchorsTotal, by_state: anchorsByState },
    oplog: {
      count: oplogCount,
      last_seq: lastOp?.seq ?? 0,
      last_ts: lastOp?.ts_ms ?? null,
      actors,
    },
    components,
    degraded,
    took_ms: Math.round(performance.now() - t0),
  };
}
