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
import { jobs, Q } from "@myc/store-sqlite";
import { localWorkspaceConfig, remoteRun, remoteTarget, syncModeFrom, type RemoteEnv } from "../remote.ts";
import { SYNC_BG_LAST_AT_KEY, SYNC_BG_PERIOD_MS, syncPreconditionReason } from "../sync-bg.ts";
import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import { flagNum, realStoreDeps, type CliDriver, type StoreDeps } from "./store.ts";

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
  /** Режим обмена: manual — только эта команда, auto — работает и фон (§9.5). */
  readonly mode: "manual" | "auto";
  /** Откуда режим: .myc/workspace.toml, MYC_SYNC или умолчание. */
  readonly mode_source: "env" | "config" | "default";
  /** Откуда адрес сервера: --server, конфиг репозитория или профиль. */
  readonly server_source?: "flag" | "config" | "env";
  /** Откуда токен: .myc/token репозитория или профильный MYC_TOKEN. */
  readonly token_source?: "file" | "env";
  /** Когда был последний обмен (sync_state/маркер планирования); null — ещё не было. */
  readonly bg_last_at: number | null;
  /** Через сколько мс фон имеет право планировать следующий обмен; null — не auto. */
  readonly bg_due_in_ms: number | null;
  /** Почему фон включён, но не поднимется (пусто — поднимется). */
  readonly bg_blocked: string | null;
  /** Неразобранная строка sync в конфиге — её называют, а не проглатывают. */
  readonly bg_invalid?: string;
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
  // Строка режима (§9.5): откуда сервер/токен и что делает фон. Человек,
  // впервые включивший auto, обязан видеть, когда обмен случится сам.
  lines.push(`  ${backgroundLine(d)}`);
  return `${lines.join("\n")}\n`;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/** Строка режима: источники цели и состояния фонового обмена (§9.5). */
export function backgroundLine(d: SyncData): string {
  const parts = [`mode ${d.mode}`];
  if (d.server_source !== undefined) {
    parts.push(
      `server ${d.server_source === "config" ? "config" : d.server_source === "flag" ? "--server" : "MYC_SERVER"}`,
    );
  }
  if (d.token_source !== undefined) {
    parts.push(`token ${d.token_source === "file" ? ".myc/token" : "MYC_TOKEN"}`);
  }
  if (d.bg_invalid !== undefined) {
    parts.push(`sync = "${d.bg_invalid}" is not a known mode — treated as manual`);
  }
  if (d.mode === "auto") {
    if (d.bg_blocked !== null) {
      parts.push(`background idle: ${d.bg_blocked}`);
    } else {
      parts.push(
        d.bg_last_at === null ? "never synced" : `last sync ${ago(Date.now() - d.bg_last_at)} ago`,
      );
      if (d.bg_due_in_ms !== null) {
        parts.push(d.bg_due_in_ms <= 0 ? "background due now" : `background in ${ago(d.bg_due_in_ms)}`);
      }
    }
  } else {
    parts.push(`background off — set sync = "auto" in .myc/workspace.toml (or MYC_SYNC=auto)`);
  }
  return parts.join(" · ");
}

type BackgroundView = Pick<
  SyncData,
  | "mode"
  | "mode_source"
  | "server_source"
  | "token_source"
  | "bg_last_at"
  | "bg_due_in_ms"
  | "bg_blocked"
  | "bg_invalid"
>;

/** Состояние фонового обмена для вывода: режим, источники цели, когда пора. */
function backgroundView(ctx: CommandContext, driver: CliDriver): BackgroundView {
  const dir = ctx.globals.directory ?? process.cwd();
  const { mode, source, invalid } = syncModeFrom(process.env, localWorkspaceConfig(dir));
  const t = remoteTarget(ctx, process.env as RemoteEnv, { configSuffices: true });
  const target = t.kind === "remote" ? t.target : undefined;
  const blocked = mode === "auto" ? syncPreconditionReason(dir, process.env) : null;
  const scheduledAt = Number(
    driver.one<{ value: string }>(Q.meta_get, [SYNC_BG_LAST_AT_KEY])?.value ?? 0,
  );
  const syncedAt = Number(
    driver.database
      .query<{ t: number | null }, []>("SELECT max(last_sync_at) AS t FROM sync_state")
      .get()?.t ?? 0,
  );
  const last = Math.max(
    Number.isFinite(scheduledAt) ? scheduledAt : 0,
    Number.isFinite(syncedAt) ? syncedAt : 0,
  );
  const dueIn =
    mode === "auto" && blocked === null ? Math.max(0, last + SYNC_BG_PERIOD_MS - Date.now()) : null;
  return {
    mode,
    mode_source: source,
    ...(target !== undefined
      ? {
          server_source: target.source,
          ...(target.tokenSource !== null ? { token_source: target.tokenSource } : {}),
        }
      : {}),
    bg_last_at: last > 0 ? last : null,
    bg_due_in_ms: dueIn,
    bg_blocked: blocked,
    ...(invalid !== undefined ? { bg_invalid: invalid } : {}),
  };
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
      {
        name: "job",
        value: "number",
        description:
          "background exchange: the jobs row (kind='sync') the drain claimed for this process — the row " +
          "is completed at exit, or failed with the error; a row no longer under --holder's lease is left alone",
      },
      { name: "holder", value: "string", description: "with --job: the lease holder the drain claimed the row under" },
    ],
    help:
      "The client always initiates: the server is another site, not the source of truth, and the " +
      "network is never in the hot path — prime, ready and show read the local database. The " +
      "target resolves in order: --server, then `server` in .myc/workspace.toml, then MYC_SERVER; " +
      "the token — .myc/token of this repository (gitignored), then MYC_TOKEN — so repositories of " +
      "different companies keep different servers without a per-shell setup. The workspace itself " +
      "is the local slug by default, so the usual call is just myc sync. With sync = \"auto\" in " +
      ".myc/workspace.toml (or MYC_SYNC=auto) the drain raises this same exchange in the " +
      "background: every 60s once due, and 2s after a local close/claim. A replica is complete " +
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
      // КОНТРАКТ ВОРКЕРА (§9.5): строку очереди снимает или проваливает сам
      // этот процесс — тот же контракт, что --job у `myc code index`. Направление
      // или примерка воркером не бывают: строка означает «полный обмен».
      const jobId = flagNum(ctx, "job");
      const holderFlag =
        typeof ctx.flags["holder"] === "string" ? String(ctx.flags["holder"]) : undefined;
      if ((jobId === undefined) !== (holderFlag === undefined || holderFlag === "")) {
        return failure(
          "usage.worker",
          "--job and --holder go together: this is the background worker contract",
          ExitCode.USAGE,
        );
      }
      if (jobId !== undefined && (dry || pushOnly || pullOnly)) {
        return failure(
          "usage.worker",
          "--job is the background worker contract: it does a full exchange, not a direction or a dry run",
          ExitCode.USAGE,
        );
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      // Снимает/проваливает только под СВОИМ холдером: чужая аренда — чужая.
      const jobFail = (msg: string): void => {
        if (jobId === undefined || holderFlag === undefined) return;
        try {
          jobs.fail(h.driver.database, jobId, msg, { holder: holderFlag });
        } catch {
          // фон не шумит: строка уйдёт в backoff сама
        }
      };
      const jobDone = (): void => {
        if (jobId === undefined || holderFlag === undefined) return;
        try {
          jobs.complete(h.driver.database, jobId, holderFlag);
        } catch {
          // как выше
        }
      };
      try {
        // `sync` сам просит сервер: конфиг репозитория — законная цель, даже
        // когда профиль молчит (мультисерверный режим).
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
            ...backgroundView(ctx, h.driver),
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
        }, { configSuffices: true });
        if (result !== undefined) {
          if (result.ok) jobDone();
          else jobFail(result.msg);
          return result;
        }
        jobFail("sync needs a server: there is nothing to exchange with");
        return failure(
          "precond.no_remote",
          "sync needs a server: there is nothing to exchange with",
          ExitCode.PRECOND,
          "set `server` in .myc/workspace.toml, or MYC_SERVER and MYC_TOKEN (see .myc/token)",
        );
      } finally {
        h.close();
      }
    },
    renderHuman: renderSyncHuman,
  };
}
