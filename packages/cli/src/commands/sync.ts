/**
 * `myc sync` — обмен операциями с командным сервером (§3.17, §9.5).
 *
 * ИНИЦИАТОР ВСЕГДА КЛИЕНТ, и это свойство, а не ограничение: сервер — такой
 * же сайт, локальная база остаётся источником истины для того, кто за ней
 * сидит, и сеть НИКОГДА не стоит в горячем пути. `prime`, `ready`, `show`
 * читают свою базу и не ждут обмена; обмен — отдельный шаг, который можно не
 * делать вовсе.
 *
 * ПОРЯДОК КРУГОВ. Первый вызов НИЧЕГО НЕ ШЛЁТ: у клиента ещё нет вод сервера,
 * и отправка «на всякий случай» вылилась бы в тысячу операций, которые сервер
 * и так знает, при каждом запуске. Ответ приносит воды сервера — дальше
 * отправляется ровно недостающее. Круги повторяются, пока есть что слать и
 * пока сервер говорит `more`.
 *
 * SCOPE ОБЯЗАН СОВПАДАТЬ С ВОРКСПЕЙСОМ СЕРВЕРА. На сервере воркспейс — это и
 * есть `scope` узла (`/v1/ws/:ws/…` выбирает по нему), поэтому обмен между
 * локальным scope `a` и удалённым `b` означал бы, что узлы приедут в чужой
 * воркспейс и пропадут из обоих списков. Расхождение — отказ, а не догадка.
 */

import {
  SYNC_MAX_OPS,
  sortOps,
  watermarksOf,
  type Op,
  type Watermarks,
} from "@myc/core";
import { remoteRun } from "../remote.ts";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import { flagNum, realStoreDeps, type StoreDeps } from "./store.ts";

/** Потолок кругов: защита от пира, который отвечает `more` бесконечно. */
export const SYNC_MAX_ROUNDS = 100;

export interface SyncData {
  readonly ws: string;
  readonly peer_site: string;
  readonly pushed: number;
  readonly pulled: number;
  readonly applied: number;
  readonly duplicate: number;
  readonly stale: number;
  readonly deferred: number;
  readonly rounds: number;
  readonly dry: boolean;
  readonly incomplete: boolean;
  readonly took_ms: number;
}

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, ...(hint === undefined ? {} : { hint }) };
}

export function renderSyncHuman(raw: unknown): string {
  const d = raw as SyncData;
  const head = d.dry
    ? `would push ${d.pushed}, would pull ${d.pulled}`
    : `push ${d.pushed} op · pull ${d.pulled} op`;
  const lines = [`${head} · ${d.rounds} round${d.rounds === 1 ? "" : "s"} · ${d.took_ms} ms`];
  if (!d.dry && d.pulled > 0) {
    const parts = [`applied ${d.applied}`, `duplicate ${d.duplicate}`, `stale ${d.stale}`];
    // Отложенное — не ошибка: операция приехала раньше своего узла и ждёт его
    // в oplog_pending. Молчать о нём нельзя, иначе «приняли 9, видно 7».
    if (d.deferred > 0) parts.push(`deferred ${d.deferred}`);
    lines.push(`  ${parts.join(", ")}`);
  }
  if (d.incomplete) {
    lines.push(`  ! stopped at ${SYNC_MAX_ROUNDS} rounds — more is left, run sync again`);
  }
  return `${lines.join("\n")}\n`;
}

export function createSyncCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "sync",
    remote: true,
    summary: "exchange operations with a team server (push what it lacks, pull what you lack)",
    flags: [
      { name: "push-only", description: "send ours, ask for nothing back" },
      { name: "pull-only", description: "ask for theirs, send nothing" },
      { name: "dry-run", description: "count both directions, change nothing" },
      { name: "max-ops", value: "number", description: `operations per round (default ${SYNC_MAX_OPS})` },
    ],
    help:
      "The client always initiates: the server is another site, not the source of truth, and the " +
      "network is never in the hot path — prime, ready and show read the local database. " +
      "Needs --server (or MYC_SERVER) and MYC_TOKEN with the 'sync' scope: a replica is complete " +
      "by construction, so taking one means seeing everything in the workspace. Merging is CRDT " +
      "(per-field LWW, add-wins edges, G-counters) and idempotent by op_id, so an interrupted " +
      "exchange is resumed by running it again.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const pushOnly = ctx.flags["push-only"] === true;
      const pullOnly = ctx.flags["pull-only"] === true;
      if (pushOnly && pullOnly) {
        return failure(
          "usage.direction",
          "--push-only and --pull-only exclude each other",
          ExitCode.USAGE,
        );
      }
      const dry = ctx.flags["dry-run"] === true;
      const maxOps = flagNum(ctx, "max-ops") ?? SYNC_MAX_OPS;
      if (maxOps < 1 || maxOps > SYNC_MAX_OPS) {
        return failure(
          "usage.max_ops",
          `--max-ops is between 1 and ${SYNC_MAX_OPS}, got ${maxOps}`,
          ExitCode.USAGE,
        );
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const result = await remoteRun(ctx, async (client) => {
          if (h.scope !== client.ws) {
            return failure(
              "usage.ws_mismatch",
              `this workspace writes scope '${h.scope}', the server workspace is '${client.ws}' — ` +
                "syncing them would move nodes into a workspace neither side lists",
              ExitCode.USAGE,
              h.scope === ""
                ? "this workspace has no scope at all, so it has no server counterpart yet"
                : `point --server at /ws/${h.scope} instead`,
            );
          }

          let ours: Watermarks = h.store.syncWatermarks(h.scope);
          let theirs: Watermarks = {};
          let pushed = 0;
          let pulled = 0;
          let applied = 0;
          let duplicate = 0;
          let stale = 0;
          let deferred = 0;
          let rounds = 0;
          let more = true;
          let peerSite = "";
          // Первый круг — без отправки: воды сервера ещё неизвестны, и слать
          // вслепую значило бы гнать по сети то, что у него уже есть.
          let toSend: readonly Op[] = [];

          while (rounds < SYNC_MAX_ROUNDS) {
            rounds++;
            const answer = await client.sync({
              site_id: h.store.siteId,
              have: ours,
              ops: toSend as readonly unknown[],
              ...(pushOnly ? { want: false } : {}),
              ...(dry ? { dry: true } : {}),
            });
            const data = answer.data as {
              site_id?: string;
              ops?: readonly unknown[];
              watermarks?: Watermarks;
              more?: boolean;
            };
            pushed += toSend.length;
            peerSite = data.site_id ?? peerSite;
            theirs = data.watermarks ?? {};
            const incoming = (data.ops ?? []) as Op[];
            pulled += incoming.length;
            more = data.more === true;

            if (incoming.length > 0 && !dry) {
              const r = h.store.applyOps(sortOps(incoming), 0);
              applied += r.applied;
              duplicate += r.duplicate;
              stale += r.stale;
              deferred += r.deferred.length;
              ours = watermarksOf(incoming, h.store.syncWatermarks(h.scope));
            } else if (incoming.length > 0) {
              // Примерка: считаем, но воды не поднимаем — иначе второй круг
              // «не увидел бы» то, что на самом деле не применяли.
              ours = watermarksOf(incoming, ours);
            }

            const next = pullOnly
              ? { ops: [] as readonly Op[], more: false }
              : h.store.syncCollect(h.scope, theirs, maxOps);
            toSend = next.ops;
            if (toSend.length === 0 && !more) break;
            if (dry) {
              // В примерке сервер ничего не принял, поэтому его воды не
              // сдвинутся, и следующий круг прислал бы тот же пакет.
              pushed += toSend.length;
              break;
            }
          }

          // Состояние обмена пишется под САЙТОМ пира, который он назвал сам:
          // выводить его из вод нельзя — там сайты всех, кого он видел.
          if (!dry && peerSite !== "") {
            h.store.syncRecordPeer(peerSite, theirs, Date.now());
          }

          const data: SyncData = {
            ws: client.ws,
            peer_site: peerSite,
            pushed,
            pulled,
            applied,
            duplicate,
            stale,
            deferred,
            rounds,
            dry,
            incomplete: rounds >= SYNC_MAX_ROUNDS && (more || toSend.length > 0),
            took_ms: Math.round(performance.now() - t0),
          };
          return { ok: true, data, meta: { remote: client.ws } };
        });
        if (result !== undefined) return result;
        return failure(
          "precond.no_remote",
          "sync needs a server: there is nothing to exchange with",
          ExitCode.PRECOND,
          "myc --server <url> sync, or set MYC_SERVER and MYC_TOKEN",
        );
      } finally {
        h.close();
      }
    },
    renderHuman: renderSyncHuman,
  };
}
