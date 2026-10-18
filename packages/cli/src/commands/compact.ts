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
 */

import { performance } from "node:perf_hooks";
import { ExitCode } from "../exit.ts";
import type { Command, CommandResult } from "../registry.ts";
import { flagBool, flagNum, realStoreDeps, type StoreDeps } from "./store.ts";

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
  readonly took_ms: number;
}

export function renderCompactHuman(raw: unknown): string {
  const d = raw as CompactData;
  const verb = d.dry ? "would compact" : "compacted";
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
      "Reversible, local-only compaction of closed and cancelled tasks per design01 §6.4(2): " +
      "a task closed more than 30 days ago gets its body moved to bodies_cold (zstd level 6) " +
      "and replaced with a deterministic template summary capped at 512 chars; FTS is " +
      "rebuilt over the summary by the schema trigger. A task with an OPEN relator " +
      "(blocks/parent/relates) is never touched, and nothing enters the oplog — every peer " +
      "compacts itself by the same rule. `myc uncompact <id>` restores the body byte-for-byte. " +
      "Use --dry-run to see the count, --limit to bound one pass.",
    flags: [
      { name: "dry-run", description: "count the candidates, change nothing" },
      { name: "limit", value: "number", description: "max tasks in one pass (default 64)" },
    ],
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const dry = flagBool(ctx, "dry-run");
      const limit = Math.max(1, Math.floor(flagNum(ctx, "limit") ?? 64));
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
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
