/**
 * Компактирование закрытых задач и обратимый `myc uncompact`
 * (спека design01 §6.4(2), задача retention/2).
 *
 * Условие отбора (дословно по спеке): kind='task', статус закрыт или
 * отменён, закрыта больше 30 суток назад, ещё не компактирована, и ни одна
 * ОТКРЫТАЯ задача не держит на неё ребро blocks/parent/relates — «открытая»
 * здесь значит не закрытая, не отменённая, не superseded, не retracted:
 * ровно тот список, что используют триггеры счётчика блокеров.
 *
 * Действие: тело уезжает в bodies_cold (zstd, уровень 6), телом становится
 * шаблонное саммари ≤512 символов, body_cold := 1, compacted_at := now.
 * FTS перестраивается по саммари САМ триггером trg_fts_au (UPDATE OF body) —
 * отдельная пересборка не нужна и была бы второй правдой.
 *
 * ЛОКАЛЬНАЯ операция, оплог не пишется (§9.3: машинные мутации не порождают
 * op-записей с новым hlc — иначе свёртка перекатила бы LWW у живого тела).
 * Каждая машина свёртывает сама по одному и тому же детерминированному
 * правилу, поэтому расхождения по телу между пирами не возникает: у
 * некомпактированного пира тело просто полное до его собственного прохода.
 *
 * Обратимость: `myc uncompact <id>` восстанавливает тело байт-в-байт из
 * bodies_cold, снимает body_cold и compacted_at и удаляет холодную копию.
 * После uncompact узел снова попадает под условие компактирования — это
 * осознанно: uncompact нужен, чтобы ПРОЧИТАТЬ тело сейчас, а не отменить
 * жизненный цикл; следующий проход compact свернёт его снова.
 *
 * Саммари — шаблонное и детерминированное (первый шаг спеки; LLM-батч по 16
 * придёт вторым шагом той же задачи): заголовок, тип и приоритет, дата
 * закрытия, начало и конец тела, коммиты из attrs, если кто-то их писал.
 *
 * `--episodes` — ВТОРОЙ вид свёртки, §6.4(3) (retention/4): старые эпизоды
 * L0. Тело эпизода живёт НЕ в узле, а в файле `.myc/episodes/<id>.zst`
 * (D22: сырые транскрипты приватны и вне git), узел session несёт только
 * атрибуты. Свёртка: дайджест-note layer=1 с attrs.episode_of и ребром
 * derived_from, файл уезжает в bodies_cold (zstd, algo единый — uncompact
 * возвращает текст), атрибуты узла помечают архивацию. Свёртка — ЕДИНСТВЕННОЕ,
 * что уносит тело: с этого момента оно стареет вместе с bodies_cold и prune
 * добивает его через 180 суток — узлы остаются. Условие — наличие файла:
 * свёрнутый не сворачивается повторно, uncompact вернул тело в узел, а файла
 * уже нет.
 */

import { performance } from "node:perf_hooks";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { generateId } from "@myc/core";
import { ExitCode } from "../exit.ts";
import type { Command, CommandResult } from "../registry.ts";
import {
  flagBool,
  flagNum,
  parseWorkspaceToml,
  realStoreDeps,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

/** Срок из спеки §6.4(2): закрыта больше 30 суток. */
const CLOSED_TTL_MS = 30 * 86_400_000;
/** Потолок саммари из спеки §6.4(2). */
const SUMMARY_LIMIT = 512;
/** Куски тела в шаблоне: начало и конец (спека: первые200 + последние120). */
const HEAD_CHARS = 200;
const TAIL_CHARS = 120;

/** Статусы, которые триггеры DDL считают «закрытыми» — списком из 001-init. */
const CLOSED_STATUSES = "('closed','cancelled','superseded','retracted')";

/**
 * Шаблонное саммари: детерминированное, без LLM, укладывается в потолок.
 * Пустое тело — саммари деградирует до заголовочной строки, это тоже честно:
 * у задачи тела и не было.
 */
export function templateSummary(input: {
  readonly title: string;
  readonly kind: string;
  readonly priority: number;
  readonly closedAt: number;
  readonly body: string | null;
  readonly commits: readonly string[];
}): string {
  const date = new Date(input.closedAt).toISOString().slice(0, 10);
  const prefix = `${input.title} [${input.kind}/P${input.priority}] закрыта ${date}. `;
  const body = input.body ?? "";
  let middle: string;
  if (body.length === 0) {
    middle = "";
  } else if (body.length <= HEAD_CHARS + TAIL_CHARS) {
    middle = body;
  } else {
    middle = `${body.slice(0, HEAD_CHARS)} … ${body.slice(-TAIL_CHARS)}`;
  }
  const commits = input.commits.length > 0 ? ` коммиты: ${input.commits.join(", ")}.` : "";
  return `${prefix}${middle}${commits}`.slice(0, SUMMARY_LIMIT);
}

export interface CompactData {
  readonly candidates: number;
  readonly compacted: number;
  readonly skipped: number;
  readonly limit: number;
  readonly dry: boolean;
  readonly mode: "tasks" | "episodes";
  readonly took_ms: number;
}

export function renderCompactHuman(raw: unknown): string {
  const d = raw as CompactData;
  const verb =
    d.mode === "episodes"
      ? d.dry
        ? "would fold"
        : "folded"
      : d.dry
        ? "would compact"
        : "compacted";
  const lines = [
    `${verb} ${d.compacted} of ${d.candidates} closed tasks (>30d, no open relators; limit ${d.limit})`,
  ];
  if (d.skipped > 0) lines.push(`  · skipped by the open-relator guard: ${d.skipped}`);
  if (d.dry) lines.push("  · dry run: nothing was changed");
  lines.push(`${d.took_ms} ms`);
  return `${lines.join("\n")}\n`;
}

export interface UncompactData {
  readonly restored: number;
  readonly raw_len: number;
  readonly took_ms: number;
}

export function renderUncompactHuman(raw: unknown): string {
  const d = raw as UncompactData;
  return `${d.restored === 0 ? "nothing to restore" : `restored ${d.raw_len} bytes from the cold copy`}\n${d.took_ms} ms\n`;
}

interface CandidateRow {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly kind: string;
  readonly priority: number;
  readonly closed_at: number;
  readonly attrs: string;
}

/** Кандидаты прохода: спека §6.4(2) дословно, включая guard открытых реляторов. */
const CANDIDATES_SQL = `
  SELECT id, title, body, kind, priority, closed_at, attrs
    FROM nodes
   WHERE kind = 'task'
     AND status IN ${CLOSED_STATUSES}
     AND closed_at < ?
     AND compacted_at IS NULL
     AND deleted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM edges e JOIN nodes r ON r.id = e.src
        WHERE e.dst = nodes.id
          AND e.type IN ('blocks','parent','relates')
          AND e.deleted_at IS NULL
          AND r.status NOT IN ${CLOSED_STATUSES}
     )
   ORDER BY closed_at
   LIMIT ?`;

function parseCommits(attrs: string): string[] {
  try {
    const parsed = JSON.parse(attrs) as { commits?: unknown };
    if (!Array.isArray(parsed.commits)) return [];
    return parsed.commits.filter((c): c is string => typeof c === "string");
  } catch {
    return [];
  }
}

export function createCompactCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "compact",
    summary: "move bodies of closed tasks (>30d) to cold storage, keeping a template summary",
    help:
      "Two kinds of folding (design01 §6.4): closed tasks and old L0 episodes (--episodes). Tasks: " +
      "a task closed more than 30 days ago gets its body moved to bodies_cold (zstd level 6) " +
      "and replaced with a deterministic template summary capped at 512 chars; FTS is " +
      "rebuilt over the summary by the schema trigger. A task with an OPEN relator " +
      "(blocks/parent/relates) is never touched, and nothing enters the oplog — every peer " +
      "compacts itself by the same rule. `myc uncompact <id>` restores the body byte-for-byte. " +
      "Use --dry-run to see the count, --limit to bound one pass. --episodes folds sessions older " +
      "than retention.l0_days (14 by default): the raw transcript file moves from .myc/episodes to " +
      "bodies_cold, a layer-1 digest note with attrs.episode_of and a derived_from edge appears, and " +
      "from then on the transcript ages with bodies_cold until prune removes it. Folded episodes " +
      "never fold twice (the file is the eligibility), and `myc uncompact <id>` reads the transcript back.",
    flags: [
      { name: "dry-run", description: "count the candidates, change nothing" },
      { name: "limit", value: "number", description: "max tasks in one pass (default 64)" },
      { name: "episodes", description: "fold old L0 episodes (design01 §6.4(3)) instead of compacting tasks" },
    ],
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const dry = flagBool(ctx, "dry-run");
      const limit = Math.max(1, Math.floor(flagNum(ctx, "limit") ?? 64));
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      if (flagBool(ctx, "episodes")) {
        try {
          return foldEpisodes(h, { dry, limit }, t0);
        } finally {
          h.close();
        }
      }
      try {
        const now = Date.now();
        const db = h.driver.database;
        const rows = db
          .query<CandidateRow, [number, number]>(CANDIDATES_SQL)
          .all(now - CLOSED_TTL_MS, limit) as CandidateRow[];
        let compacted = 0;
        let skipped = 0;
        for (const row of rows) {
          if (!dry) {
            const summary = templateSummary({
              title: row.title,
              kind: row.kind,
              priority: row.priority,
              closedAt: row.closed_at,
              body: row.body,
              commits: parseCommits(row.attrs),
            });
            db.transaction(() => {
              db.prepare(
                `INSERT INTO bodies_cold (node_id, algo, level, raw_len, blob, archived_at)
                 VALUES (?1, 'zstd', 6, ?2, ?3, ?4)`,
              ).run(row.id, (row.body ?? "").length, Bun.zstdCompressSync(row.body ?? ""), now);
              db.prepare(
                `UPDATE nodes
                    SET body = ?1, body_cold = 1, compacted_at = ?2
                  WHERE id = ?3`,
              ).run(summary, now, row.id);
            })();
          }
          compacted++;
        }
        // Guard-счётчик для честного вывода: кандидаты, отсечённые guard'ом
        // открытых реляторов, не попадают в основной запрос вовсе — считаем
        // отдельно, чтобы сухой прогон называл причину, а не молчал.
        const guarded =
          db.query<{ n: number }, [number]>(
            `SELECT count(*) AS n
               FROM nodes n2
              WHERE n2.kind = 'task'
                AND n2.status IN ${CLOSED_STATUSES}
                AND n2.closed_at < ?
                AND n2.compacted_at IS NULL
                AND n2.deleted_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM edges e JOIN nodes r ON r.id = e.src
                   WHERE e.dst = n2.id
                     AND e.type IN ('blocks','parent','relates')
                     AND e.deleted_at IS NULL
                     AND r.status NOT IN ${CLOSED_STATUSES}
                )`,
          )
          .get(now - CLOSED_TTL_MS)?.n ?? 0;
        skipped = guarded;
        const data: CompactData = {
          candidates: rows.length,
          compacted,
          skipped,
          limit,
          dry,
          mode: "tasks",
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderCompactHuman,
  };
}

export function createUncompactCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "uncompact",
    summary: "restore a compacted body from bodies_cold, byte-for-byte",
    help:
      "Reverse of `myc compact`: the body comes back byte-for-byte from bodies_cold, " +
      "body_cold and compacted_at are cleared, the cold copy is consumed, and FTS is " +
      "rebuilt over the restored body by the schema trigger. The node becomes eligible " +
      "for compaction again — that is by design: uncompact is for reading now, not for " +
      "opting out of the lifecycle.",
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const id = ctx.args[0] ?? "";
      if (id === "") {
        return {
          ok: false,
          code: "args.missing_id",
          msg: "uncompact: node id required",
          exit: ExitCode.USAGE,
        };
      }
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const db = h.driver.database;
        const cold = db
          .query<{ blob: Uint8Array; algo: string }, [string]>(
            "SELECT blob, algo FROM bodies_cold WHERE node_id = ?",
          )
          .get(id);
        if (cold == null) {
          return {
            ok: false,
            code: "compact.no_cold_copy",
            msg: `uncompact: no cold copy for ${id} (not compacted, or unknown id)`,
            exit: ExitCode.NOTFOUND,
          };
        }
        if (cold.algo !== "zstd") {
          return {
            ok: false,
            code: "compact.unknown_algo",
            msg: `uncompact: cold copy of ${id} uses unknown algo ${cold.algo}`,
            exit: ExitCode.ERR,
          };
        }
        const body = Bun.zstdDecompressSync(cold.blob).toString("utf-8");
        db.transaction(() => {
          db.prepare(
            "UPDATE nodes SET body = ?1, body_cold = 0, compacted_at = NULL WHERE id = ?2",
          ).run(body, id);
          db.prepare("DELETE FROM bodies_cold WHERE node_id = ?").run(id);
        })();
        const data: UncompactData = {
          restored: 1,
          raw_len: body.length,
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderUncompactHuman,
  };
}

// ---------------------------------------------------------------------------
// Свёртка эпизодов L0 (§6.4(3), retention/4)
// ---------------------------------------------------------------------------

/** Срок из спеки §6.4(3):14 суток; параметр retention.l0_days в конфиге. */
const DEFAULT_L0_DAYS = 14;

/**
 * Срок жизни эпизода — из конфига воркспейса, единый источник (retention/5).
 * Плохой или отсутствующий конфиг не повод падать: умолчание спеки.
 */
function l0DaysOf(mycDir: string): number {
  try {
    const cfg = parseWorkspaceToml(readFileSync(join(mycDir, "workspace.toml"), "utf8"));
    return cfg.retention?.l0_days ?? DEFAULT_L0_DAYS;
  } catch {
    return DEFAULT_L0_DAYS;
  }
}

/**
 * Шаблонный дайджест (первый шаг спеки; LLM-батч — вторым). Факты эпизода
 * читаются из атрибутов узла — они были записаны бесплатно при свершившемся
 * событии, и разбирать ради шаблона транскрипт не нужно.
 */
export function episodeDigest(
  id: string,
  createdAt: number,
  attrs: Readonly<Record<string, unknown>>,
): string {
  const date = new Date(createdAt).toISOString().slice(0, 10);
  const parts = [
    `Эпизод ${id} от ${date}: ${String(attrs.reason ?? "?")}, агент ${String(attrs.agent ?? "?")}.`,
    `Сырой транскрипт ${String(attrs.raw_bytes ?? "?")} байт, масок секретов: ${String(attrs.secrets_masked ?? 0)}.`,
  ];
  const cwd = attrs.cwd;
  if (typeof cwd === "string" && cwd !== "") parts.push(`Рабочий каталог: ${cwd}.`);
  const reason = attrs.reason;
  if (reason === "compact") {
    parts.push("Причина записи — компактирование контекста: это и был момент потери, ради которого эпизод существует.");
  }
  return parts.join(" ");
}

/**
 * Одна партия свёртки. Локальная операция: оплог не пишется (машинная
 * мутация, §9.3) — каждая машина сворачивает свои эпизоды сама, и файл у
 * каждой свой.
 *
 * Порядок одного узла: дайджест-узел и ребро → холодная копия (ON CONFLICT
 * DO NOTHING: повтор после сбоя не падает) → только ПОСЛЕ фиксации файла →
 * удаление. Если бы удалить раньше, сбой между шагами оставил бы эпизод
 * без тела навсегда: в оплоге ничего, в файле ничего, в холодном — пусто.
 */
function foldEpisodes(
  h: StoreHandle,
  opts: { readonly dry: boolean; readonly limit: number },
  t0: number,
): CommandResult {
  const db = h.driver.database;
  const cutoff = Date.now() - l0DaysOf(h.mycDir) * 86_400_000;
  const rows = db
    .query<{ id: string; created_at: number; attrs: string }, [number, number]>(
      `SELECT id, created_at, attrs FROM nodes
        WHERE kind = 'session' AND created_at < ? AND deleted_at IS NULL
        ORDER BY created_at
        LIMIT ?`,
    )
    .all(cutoff, opts.limit) as { id: string; created_at: number; attrs: string }[];

  let folded = 0;
  let skipped = 0;
  for (const row of rows) {
    let attrs: Record<string, unknown>;
    try {
      attrs = JSON.parse(row.attrs) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    const rel = typeof attrs.episode_path === "string" ? attrs.episode_path : "";
    const abs = rel === "" ? "" : join(h.mycDir, rel);
    // Нет файла — сворачивать нечего: либо уже свёрнут, либо эпизод
    // писался другой машиной (файлы не реплицируются, D22).
    if (abs === "" || !existsSync(abs)) {
      skipped++;
      continue;
    }
    if (opts.dry) {
      folded++;
      continue;
    }

    const fileBytes = readFileSync(abs);
    const wasZstd = attrs.compression === "zstd";
    // Нормализация к zstd: bodies_cold несёт algo='zstd', и uncompact обязан
    // вернуть текст — распакованный файл перепаковываем, сжатый берём как есть.
    const blob = wasZstd ? new Uint8Array(fileBytes) : Bun.zstdCompressSync(fileBytes);
    const rawLen = wasZstd ? Bun.zstdDecompressSync(fileBytes).byteLength : fileBytes.byteLength;

    const noteId = generateId(h.slug);
    h.store.createNode({
      id: noteId,
      kind: "note",
      layer: 1,
      scope: h.scope,
      title: `эпизод ${row.id}: свёртка`,
      body: episodeDigest(row.id, row.created_at, attrs),
      actor: h.actor,
      attrs: { episode_of: row.id, summary_kind: "template" },
    });
    h.store.addEdge(noteId, "derived_from", row.id, {});

    db.transaction(() => {
      db.prepare(
        `INSERT INTO bodies_cold (node_id, algo, level, raw_len, blob, archived_at)
         VALUES (?1, 'zstd', 6, ?2, ?3, ?4)
         ON CONFLICT(node_id) DO NOTHING`,
      ).run(row.id, rawLen, blob, Date.now());
      db.prepare(
        `UPDATE nodes SET attrs = json_patch(coalesce(attrs, '{}'), ?2) WHERE id = ?1`,
      ).run(row.id, JSON.stringify({ episode_archived: true, episode_path: "" }));
    })();
    // Файл уходит ПОСЛЕ фиксации: холодная копия уже в базе, сбой на этом
    // шаге оставляет файл, который следующий проход просто дочистит.
    unlinkSync(abs);
    folded++;
  }

  const data: CompactData = {
    candidates: rows.length,
    compacted: folded,
    skipped,
    limit: opts.limit,
    dry: opts.dry,
    mode: "episodes",
    took_ms: Math.round(performance.now() - t0),
  };
  return { ok: true, data, meta: { took_ms: data.took_ms } };
}
