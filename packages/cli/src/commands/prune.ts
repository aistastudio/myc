/**
 * `myc prune` — локальная чистка холодного хвоста (спека design01 §6.5).
 *
 * ДВА УДАЛЕНИЯ, оба по возрасту, ни одно не трогает граф:
 *   - `bodies_cold` старше 180 суток — тела, уже утёкшие в холод компактированием
 *     или свёрткой эпизодов; узлы, рёбра и саммари остаются;
 *   - `oplog` старше 30 суток, подтверждённый ВСЕМИ известными пирами
 *     (`sync_state.last_seq_sent` каждого пира ≥ seq записи). Неподтверждённый
 *     оплог не удаляется НИКОГДА: он — единственный источник для пира, который
 *     ещё не синхронизировался. Пиров нет — оплог не трогается, и причина
 *     называется в выводе.
 *
 * Тумбстоун `purge` (§6.5) — исключение из будущего пруна, как `edge_add`
 * тегов: он лежит в оплоге и обязан пережить чистку, иначе пиры не узнают о
 * стирании. Оплог, подтверждённый всеми, тумбстоунов уже не содержит —
 * каждый пир, принявший его, сам стёр у себя (retention/3).
 *
 * VACUUM — при фрагментации > 25 % (freelist/page_count): чистка строк без
 * возврата страниц превращала бы базу в разреженный файл навсегда.
 *
 * Ограничение «недистиллированное не трогать» соблюдается ПОСТРОЕНИЕМ:
 * тело эпизода попадает в bodies_cold только свёрткой (§6.4(3), retention/4),
 * а prune смотрит только на возраст уже утёкших тел (тест: эпизод без свёртки
 * переживает prune).
 */

import { ExitCode } from "../exit.ts";
import type { Command, CommandResult } from "../registry.ts";
import { flagBool, realStoreDeps, type StoreDeps } from "./store.ts";

/** Сроки из спеки §6.5. */
const BODY_TTL_MS = 180 * 86_400_000;
const OPLOG_TTL_MS = 30 * 86_400_000;
const VACUUM_FRAG = 0.25;

export interface PruneData {
  readonly bodies_removed: number;
  readonly ops_removed: number;
  readonly peers: number;
  readonly vacuum_frag_pct: number;
  readonly vacuumed: boolean;
  readonly dry: boolean;
  readonly took_ms: number;
}

export function renderPruneHuman(raw: unknown): string {
  const d = raw as PruneData;
  const verb = d.dry ? "would remove" : "removed";
  const lines = [
    `${verb} ${d.bodies_removed} cold bodies (>180d), ${d.ops_removed} oplog rows (>30d, confirmed by ${d.peers} peer${d.peers === 1 ? "" : "s"})`,
  ];
  if (d.peers === 0) {
    lines.push("  · no peers in sync_state — the oplog is untouched: nothing has confirmed it");
  }
  const kept = (d as PruneData & { tombstones_kept?: number }).tombstones_kept ?? 0;
  if (kept > 0) {
    lines.push(`  · ${kept} purge tombstone(s) kept: exempt from pruning (design01 §6.5)`);
  }
  lines.push(
    d.vacuumed || d.dry
      ? `  · fragmentation ${d.vacuum_frag_pct}% ${d.vacuumed ? "→ VACUUM done" : "(dry-run: no VACUUM)"}`
      : `  · fragmentation ${d.vacuum_frag_pct}% — below the25% threshold, no VACUUM`,
  );
  if (d.dry) lines.push("  · dry run: nothing was changed");
  lines.push(`${d.took_ms} ms`);
  return `${lines.join("\n")}\n`;
}

export function createPruneCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "prune",
    summary: "delete cold bodies older than 180 days and peer-confirmed oplog older than 30 days",
    help:
      "Local cleanup, no network: bodies_cold older than 180 days go; oplog rows older " +
      "than 30 days go only if EVERY known peer has confirmed past them (sync_state) — with " +
      "no peers the oplog is untouched, and the reason is printed. Nodes, edges and summaries " +
      "are never touched, and nothing is written to the oplog: this is a machine-local " +
      "operation — hard deletion with a replicating tombstone is a separate, explicit act. VACUUM runs when fragmentation " +
      "exceeds 25%. `--dry-run` counts without changing anything.",
    flags: [{ name: "dry-run", description: "count what would be removed, change nothing" }],
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const dry = flagBool(ctx, "dry-run");
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const now = Date.now();
        const db = h.driver.database;
        const peers = db.query<{ n: number }, []>("SELECT count(*) AS n FROM sync_state").get()?.n ?? 0;
        const bodyCutoff = now - BODY_TTL_MS;
        const oplogCutoff = now - OPLOG_TTL_MS;
        const bodies = dry
          ? (db
              .query<{ n: number }, [number]>(
                "SELECT count(*) AS n FROM bodies_cold WHERE archived_at < ?",
              )
              .get(bodyCutoff)?.n ?? 0)
          : db.prepare("DELETE FROM bodies_cold WHERE archived_at < ?").run(bodyCutoff).changes;
        // Подтверждение пирами — subquery: при пустом sync_state min() даёт NULL,
        // сравнение с NULL истинно не бывает, и оплог остаётся нетронутым сам собой.
        // Тумбстоуны purge из пруна ИСКЛЮЧЕНЫ (§6.5, retention/3): новый пир
        // обязан узнать о стирании, иначе вернул бы узел первым же обменом.
        // Подтверждённый всеми пир означает «применено всеми, кто был», а не
        // «применено всеми, кто будет».
        const ops = dry
          ? (db
              .query<{ n: number }, [number]>(
                `SELECT count(*) AS n FROM oplog
                  WHERE ts_ms < ? AND op != 'purge'
                    AND seq <= (SELECT min(last_seq_sent) FROM sync_state)`,
              )
              .get(oplogCutoff)?.n ?? 0)
          : db
              .prepare(
                `DELETE FROM oplog
                  WHERE ts_ms < ? AND op != 'purge'
                    AND seq <= (SELECT min(last_seq_sent) FROM sync_state)`,
              )
              .run(oplogCutoff).changes;
        const tombstones =
          db.query<{ n: number }, []>("SELECT count(*) AS n FROM oplog WHERE op = 'purge'").get()?.n ?? 0;
        const pages = Number(
          db.query<{ c: number }, []>("PRAGMA page_count").get()?.c ?? 0,
        );
        const free = Number(
          db.query<{ c: number }, []>("PRAGMA freelist_count").get()?.c ?? 0,
        );
        const frag = pages > 0 ? free / pages : 0;
        const vacuumed = !dry && frag > VACUUM_FRAG;
        if (vacuumed) db.exec("VACUUM");
        const data: PruneData & { readonly tombstones_kept: number } = {
          bodies_removed: bodies,
          ops_removed: ops,
          peers,
          vacuum_frag_pct: Math.round(frag * 1000) / 10,
          vacuumed,
          dry,
          tombstones_kept: tombstones,
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderPruneHuman,
  };
}
