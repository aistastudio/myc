/**
 * `myc purge` — жёсткое стирание (спека design01 §6.5, задача retention/3).
 *
 * Две формы:
 *   `purge --id X [--cascade]` — один узел; живые рёбра требуют --cascade:
 *     их убирает каскад вместе с узлом, и флаг называет это вслух;
 *   `purge --scope X --before T [--yes]` — массово, требует --yes; T —
 *     дата ISO или возраст вроде `90d` (та же грамматика, что у --since/--until).
 *
 * В отличие от мягкого удаления (deleted_at, обратимо через восстановление
 * поля) purge физически удаляет узел, его рёбра (каскад), вектор, FTS-строку,
 * bodies_cold, замыкание и CRDT-таблицы — и кладёт op='purge' в оплог: пиры
 * стёрт у себя. Тумбстоун переживает prune — отбор к пиру его пропускает, а
 * прун оплога строки purge не трогает: новый пир обязан узнать о стирании,
 * иначе вернул бы узел обратно первым же обменом.
 *
 * Повтор идемпотентен: узла уже нет — purgeNode возвращает false, команда
 * отвечает ok с purged=0. `--dry-run` показывает, что ушло бы, и не меняет
 * ничего.
 */

import { performance } from "node:perf_hooks";
import { ExitCode } from "../exit.ts";
import type { Command, CommandResult } from "../registry.ts";
import { flagBool, flagStr, parseDuration, realStoreDeps, type StoreDeps } from "./store.ts";

export interface PurgeData {
  readonly purged: number;
  readonly ids: readonly string[];
  readonly dry: boolean;
  /** Для массовой формы: сколько узлов подходило под --scope/--before. */
  readonly matched: number;
  readonly live_edges?: number;
  readonly took_ms: number;
}

export function renderPurgeHuman(raw: unknown): string {
  const d = raw as PurgeData;
  const verb = d.dry ? "would purge" : "purged";
  const lines = [`${verb} ${d.purged} node${d.purged === 1 ? "" : "s"}${d.matched > 0 ? ` of ${d.matched} matched` : ""}`];
  if (d.ids.length > 0 && d.ids.length <= 20) lines.push(`  · ${d.ids.join(", ")}`);
  if (d.live_edges !== undefined && d.live_edges > 0) {
    lines.push(`  · ${d.live_edges} live edge(s) erased with the node (cascade)`);
  }
  if (d.dry) lines.push("  · dry run: nothing was changed");
  lines.push(`${d.took_ms} ms`);
  return `${lines.join("\n")}\n`;
}

export function createPurgeCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "purge",
    summary: "physically erase nodes (and their edges, vector, FTS and cold bodies) with a replicating tombstone",
    help:
      "Irreversible, unlike the soft delete which only sets deleted_at and can be " +
      "undone. One form per run: `--id X [--cascade]` erases one node (live edges " +
      "require --cascade: they die with the node), `--scope X --before T --yes` erases " +
      "every node in a scope created before T (ISO date or age like 90d) and demands " +
      "--yes. The oplog gets op='purge' so every peer erases the node too, and the " +
      "tombstone is exempt from prune: a new peer must learn about the erase, or it " +
      "would return the node on the first exchange. Repeating a purge is a no-op. " +
      "--dry-run lists what would go and changes nothing.",
    flags: [
      { name: "id", value: "string", description: "node id to erase" },
      { name: "cascade", description: "erase live edges along with the node" },
      { name: "scope", value: "string", description: "mass form: workspace slug" },
      { name: "before", value: "string", description: "mass form: created before this moment (ISO date or age)" },
      { name: "yes", description: "mass form: confirm irreversible erasure" },
      { name: "dry-run", description: "list what would be erased, change nothing" },
    ],
    handler: async (ctx): Promise<CommandResult> => {
      const t0 = performance.now();
      const id = flagStr(ctx, "id");
      const scope = flagStr(ctx, "scope");
      const beforeRaw = flagStr(ctx, "before");
      const cascade = flagBool(ctx, "cascade");
      const yes = flagBool(ctx, "yes");
      const dry = flagBool(ctx, "dry-run");
      const usage = (msg: string, hint?: string): CommandResult => ({
        ok: false,
        code: "usage.purge",
        msg,
        exit: ExitCode.USAGE,
        hint,
      });

      const forms = (id !== undefined ? 1 : 0) + (scope !== undefined ? 1 : 0);
      if (forms !== 1) {
        return usage("purge: exactly one form per run — --id <node> or --scope <slug> --before <time>");
      }
      if (scope !== undefined && beforeRaw === undefined) {
        return usage("purge: --scope requires --before (ISO date or age like 90d)");
      }
      if (id !== undefined && beforeRaw !== undefined) {
        return usage("purge: --before belongs to the --scope form");
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const db = h.driver.database;
        if (id !== undefined) {
          const node = h.store.getNode(id, true);
          if (node === undefined) {
            // Уже стёрт — идемпотентный повтор? Наш собственный тумбстоун в
            // оплоге — единственное честное различие: «был и стёрт» против
            // «никогда не существовал».
            const tomb =
              db
                .query<{ n: number }, [string]>(
                  "SELECT count(*) AS n FROM oplog WHERE op = 'purge' AND entity = 'node' AND entity_id = ?",
                )
                .get(id)?.n ?? 0;
            if (tomb === 0) {
              return {
                ok: false,
                code: "notfound.node",
                msg: `purge: node ${id} not found`,
                exit: ExitCode.NOTFOUND,
              };
            }
            const data: PurgeData = {
              purged: 0,
              ids: [id],
              matched: 1,
              dry,
              took_ms: Math.round(performance.now() - t0),
            };
            return { ok: true, data, meta: { took_ms: data.took_ms } };
          }
          const live =
            db
              .query<{ n: number }, [string, string]>(
                "SELECT count(*) AS n FROM edges WHERE (src = ? OR dst = ?) AND deleted_at IS NULL",
              )
              .get(id, id)?.n ?? 0;
          if (live > 0 && !cascade && !dry) {
            return {
              ok: false,
              code: "precond.live_edges",
              msg: `purge: ${id} has ${live} live edge(s): pass --cascade to erase them with the node, or delete softly instead`,
              exit: ExitCode.PRECOND,
              hint: "soft deletion sets deleted_at and is reversible",
            };
          }
          if (!dry) h.store.purgeNode(id);
          const data: PurgeData = {
            purged: dry ? 0 : 1,
            ids: [id],
            matched: 1,
            dry,
            live_edges: live,
            took_ms: Math.round(performance.now() - t0),
          };
          return { ok: true, data, meta: { took_ms: data.took_ms } };
        }

        // Массовая форма: --scope/--before [--yes].
        const dur = parseDuration(beforeRaw!);
        const before = dur !== undefined ? Date.now() - dur : Date.parse(beforeRaw!);
        if (Number.isNaN(before)) {
          return usage(`purge: invalid --before '${beforeRaw}' (ISO date or age like 90d)`);
        }
        if (!yes && !dry) {
          return usage("purge: the scope form is irreversible — confirm with --yes", "or run --dry-run first");
        }
        const ids = db
          .query<{ id: string }, [string, number]>(
            "SELECT id FROM nodes WHERE scope = ? AND created_at < ? ORDER BY id",
          )
          .all(scope!, before)
          .map((r) => r.id);
        let purged = 0;
        if (!dry) {
          for (const nodeId of ids) {
            if (h.store.purgeNode(nodeId)) purged++;
          }
        }
        const data: PurgeData = {
          purged,
          ids,
          matched: ids.length,
          dry,
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderPurgeHuman,
  };
}
