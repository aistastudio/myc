/**
 * `myc embedd` — фоновый прогрев эмбеддера, вторая половина решения S44
 * (ARCHITECTURE.md §10).
 *
 * ЗАЧЕМ. Векторная ветка нужна ровно там, где лексика бессильна: на
 * перефразировке, где ни одно слово вопроса не встречается в тексте дословно
 * (S32: без вектора recall@10 на таких запросах равен нулю). Но в одноразовом
 * процессе CLI она недоступна по стоимости: замер на этой машине —
 * `import @myc/embed` 9 мс, `warmup()` до state=ok **223 мс**, и только после
 * этого `embed()` 28 мс. Бюджет `recall` — 25 мс на 100k (И1). Прогрев в
 * горячем пути не помещается в него на порядок, поэтому по умолчанию его и
 * выключили — а вместе с ним выключилась вся векторная ветка.
 *
 * РЕШЕНИЕ. Прогрев переносится туда, где ему и место: в фоновую работу из
 * очереди `jobs` (класс `embed_warm`, S7/myc-ewq — «очередь эмбеддингов это
 * класс задач, а не отдельный механизм»). Демон один раз платит 223 мс, живёт
 * дальше с готовой сессией ONNX и отдаёт вектор запроса по unix-сокету. CLI в
 * горячем пути делает connect+write+read вместо загрузки рантайма.
 *
 * ПРОГРЕВ НЕ ЗАДЕРЖИВАЕТ НИ ОДНУ КОМАНДУ. Клиент (retrieve.ts) никогда не ждёт
 * демона: он либо получает вектор за отведённый дедлайн, либо работает без
 * вектора и говорит об этом (И2). Запуск демона — `spawn` без `await`, а сама
 * работа в очереди — один INSERT ... ON CONFLICT DO NOTHING.
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Демон НЕ индексирует корпус: заполнение `nodes_vec` — это
 * `myc-o6z` (индексация: батчи, чекпойнты, пропуски по content-hash) поверх
 * `myc-ewq` (общий воркер очереди), обе открыты. Здесь только вектор ЗАПРОСА:
 * ровно то, что стоит 223 мс в горячем пути и ровно то, чего не хватало
 * условной векторной ветке, чтобы вообще включиться.
 *
 * ЖИВУЧЕСТЬ. Убитый демон не теряет и не дублирует работу: строка в `jobs`
 * держится арендой (`lease_holder`/`lease_expires`), протухшую аренду
 * подбирает следующий демон, а второй экземпляр на том же сокете просто
 * выходит — единственность обеспечивает сам сокет, а не файл-лок.
 */

import { createHash } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineQueries, type DbDriver } from "@myc/core";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext } from "../registry.ts";
import { flagNum, openDriver } from "./store.ts";

// ---------------------------------------------------------------------------
// Очередь: класс работ embed_warm
// ---------------------------------------------------------------------------

/** Класс работы в jobs. Приоритет 2 — выше embed(3): без прогрева embed не поедет. */
export const WARM_JOB_KIND = "embed_warm";
export const WARM_JOB_ENTITY = "query-embedder";
export const WARM_JOB_PRIORITY = 2;

/** Сколько демон держит аренду работы; продлевать её незачем — он либо жив, либо нет. */
const WARM_LEASE_MS = 900_000;

export const embedJobQueries = defineQueries({
  // ON CONFLICT DO NOTHING без цели: дедуп стоит на частичном уникальном
  // индексе ux_jobs_dedup(kind, entity_id), а на частичный индекс нельзя
  // сослаться конфликт-таргетом (тот же приём, что в remember.ts).
  warm_enqueue: {
    name: "warm_enqueue",
    sql: `INSERT INTO jobs (kind, entity_id, scope, priority, run_after, payload, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, '{}', ?5)
          ON CONFLICT DO NOTHING`,
    params: ["kind", "entity_id", "scope", "priority", "now"],
  },
  // Аренда: забрать может только тот, у кого прежняя истекла. Один UPDATE —
  // значит гонка двух демонов решается самой БД, а не порядком вызовов.
  warm_lease: {
    name: "warm_lease",
    sql: `UPDATE jobs
             SET lease_holder = ?1, lease_expires = ?2, attempts = attempts + 1
           WHERE kind = ?3
             AND entity_id = ?4
             AND lease_expires < ?5`,
    params: ["holder", "expires", "kind", "entity_id", "now"],
  },
  warm_done: {
    name: "warm_done",
    sql: `DELETE FROM jobs WHERE kind = ?1 AND entity_id = ?2 AND lease_holder = ?3`,
    params: ["kind", "entity_id", "holder"],
  },
  warm_fail: {
    name: "warm_fail",
    sql: `UPDATE jobs SET last_error = ?1, lease_holder = '', lease_expires = 0
           WHERE kind = ?2 AND entity_id = ?3`,
    params: ["error", "kind", "entity_id"],
  },
  warm_pending: {
    name: "warm_pending",
    sql: `SELECT attempts, max_attempts, last_error FROM jobs WHERE kind = ?1 AND entity_id = ?2`,
    params: ["kind", "entity_id"],
  },
});

interface WarmJobRow {
  readonly attempts: number;
  readonly max_attempts: number;
  readonly last_error: string | null;
}

/**
 * Поставить прогрев в очередь. Один INSERT, безопасен к повтору. Возвращает
 * false, если работа уже исчерпала попытки: бесконечно перезапускать демона,
 * который не поднимается, — это тот же тихий фолбэк, только дорогой.
 */
export function enqueueWarmJob(db: DbDriver, scope: string, now: number = Date.now()): boolean {
  const existing = db.all<WarmJobRow>(embedJobQueries.warm_pending, [
    WARM_JOB_KIND,
    WARM_JOB_ENTITY,
  ])[0];
  if (existing !== undefined && existing.attempts >= existing.max_attempts) return false;
  db.run(embedJobQueries.warm_enqueue, [
    WARM_JOB_KIND,
    WARM_JOB_ENTITY,
    scope,
    WARM_JOB_PRIORITY,
    now,
  ]);
  return true;
}

// ---------------------------------------------------------------------------
// Сокет
// ---------------------------------------------------------------------------

/**
 * Путь сокета выводится из пути базы, а не лежит рядом с ней: у unix-сокета на
 * macOS предел пути 104 байта (sun_path), и рабочая копия в глубоком каталоге
 * его пробивает. Хеш пути базы даёт короткое и стабильное имя, одинаковое у
 * клиента и демона, — это и есть их единственная договорённость.
 */
export function embedSocketPath(dbPath: string): string {
  const h = createHash("sha1").update(resolve(dbPath)).digest("hex").slice(0, 16);
  return join(tmpdir(), `myc-embed-${h}.sock`);
}

/** Ответ демона на ping — состояние прогрева, а не просто «жив». */
export interface DaemonPing {
  readonly state: string;
  readonly dim: number;
  readonly warmMs: number;
  readonly served: number;
}

type Reply = Record<string, unknown>;

/**
 * Один запрос-ответ по сокету с жёстким дедлайном. Дедлайн обязателен: демон
 * может застрять в прогреве, а горячий путь не имеет права ждать никого.
 */
type AskFailure = "no_socket" | "refused" | "timeout" | "bad_reply";

/**
 * Отказ РАЗМЕЧЕН по причине. Файл сокета, оставшийся от убитого демона, — это
 * не «демон занят», а «демона нет»: без этого различия одна протухшая ссылка в
 * /tmp навсегда лишала бы воркспейс прогрева, потому что новый демон никто бы
 * не поднял, а каждый запрос платил бы дедлайн впустую. Найдено живым
 * прогоном.
 */
async function ask(
  socketPath: string,
  payload: Reply,
  timeoutMs: number,
): Promise<{ ok: true; reply: Reply } | { ok: false; why: AskFailure }> {
  if (!existsSync(socketPath)) return { ok: false, why: "no_socket" };
  return await askOpen(socketPath, payload, timeoutMs);
}

async function askOpen(
  socketPath: string,
  payload: Reply,
  timeoutMs: number,
): Promise<{ ok: true; reply: Reply } | { ok: false; why: AskFailure }> {
  type Out = { ok: true; reply: Reply } | { ok: false; why: AskFailure };
  return await new Promise<Out>((done) => {
    let settled = false;
    let opened = false;
    let buf = "";
    const finish = (v: Out): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(v);
    };
    const timer = setTimeout(() => finish({ ok: false, why: "timeout" }), timeoutMs);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(sock) {
          opened = true;
          sock.write(`${JSON.stringify(payload)}\n`);
        },
        data(sock, chunk) {
          buf += chunk.toString("utf8");
          const nl = buf.indexOf("\n");
          if (nl < 0) return;
          const line = buf.slice(0, nl);
          // Ответ разбирается ДО end(): end() синхронно зовёт close(), а тот —
          // finish(null), и результат, который уже пришёл, терялся бы гонкой с
          // собственным закрытием сокета. Найдено живым прогоном: демон
          // отвечал, а клиент видел «нет ответа».
          try {
            finish({ ok: true, reply: JSON.parse(line) as Reply });
          } catch {
            finish({ ok: false, why: "bad_reply" });
          }
          sock.end();
        },
        error() {
          finish({ ok: false, why: opened ? "bad_reply" : "refused" });
        },
        close() {
          finish({ ok: false, why: opened ? "bad_reply" : "refused" });
        },
      },
    }).catch(() => finish({ ok: false, why: "refused" }));
  });
}

export async function pingEmbedDaemon(
  socketPath: string,
  timeoutMs = 200,
): Promise<DaemonPing | null> {
  const out = await ask(socketPath, { op: "ping" }, timeoutMs);
  if (!out.ok || out.reply["ok"] !== true) return null;
  const r = out.reply;
  return {
    state: String(r["state"] ?? "unknown"),
    dim: Number(r["dim"] ?? 0),
    warmMs: Number(r["warm_ms"] ?? 0),
    served: Number(r["served"] ?? 0),
  };
}

/**
 * Ответ демона на запрос вектора. РАЗЛИЧАТЬ «нет демона» и «демон греется»
 * обязательно: в первом случае его надо поднять, во втором — ни в коем случае,
 * иначе каждый запрос в течение прогрева плодит ещё одного демона (эта ошибка
 * была найдена живым прогоном: живых процессов несколько, отвечающих ноль).
 */
export type DaemonVector =
  | { readonly ok: true; readonly vec: Float32Array }
  | { readonly ok: false; readonly daemon: "absent" | "warming" | "error"; readonly reason: string };

export async function requestVector(
  socketPath: string,
  text: string,
  timeoutMs: number,
): Promise<DaemonVector> {
  if (!existsSync(socketPath)) {
    return { ok: false, daemon: "absent", reason: "прогретого эмбеддера нет" };
  }
  const out = await ask(socketPath, { op: "embed", text }, timeoutMs);
  if (!out.ok) {
    // Сокет есть, но соединение отвергнуто — файл остался от убитого демона.
    // Это ровно «демона нет»: нового поднять можно и нужно, он сам уберёт
    // мусор. Дедлайн же означает «демон жив, но занят»: второго не плодим.
    if (out.why === "refused") {
      return { ok: false, daemon: "absent", reason: "сокет от умершего демона" };
    }
    return { ok: false, daemon: "error", reason: `нет ответа за ${timeoutMs} мс` };
  }
  const r = out.reply;
  if (r["ok"] !== true) {
    const reason = String(r["reason"] ?? "без причины");
    return {
      ok: false,
      daemon: reason.includes("warming") ? "warming" : "error",
      reason,
    };
  }
  const vec = r["vec"];
  if (!Array.isArray(vec) || vec.length === 0) {
    return { ok: false, daemon: "error", reason: "демон вернул пустой вектор" };
  }
  const parsed = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const v = Number(vec[i]);
    if (!Number.isFinite(v)) {
      return { ok: false, daemon: "error", reason: `компонент ${i} не конечен` };
    }
    parsed[i] = v;
  }
  return { ok: true, vec: parsed };
}

/** Короткая форма для вызывающих, которым нужен только вектор. */
export async function embedViaDaemon(
  socketPath: string,
  text: string,
  timeoutMs: number,
): Promise<Float32Array | null> {
  const r = await requestVector(socketPath, text, timeoutMs);
  return r.ok ? r.vec : null;
}

export async function stopEmbedDaemon(socketPath: string, timeoutMs = 500): Promise<boolean> {
  const out = await ask(socketPath, { op: "stop" }, timeoutMs);
  return out.ok && out.reply["ok"] === true;
}

/**
 * Запуск демона В ФОНЕ. Не ждёт ничего и никогда не бросает: прогрев не имеет
 * права задержать или уронить команду, ради которой он затеян.
 *
 * argv собирается от `process.execPath`, потому что путь запуска у собранного
 * бинаря и у исходников разный: в бинаре execPath — сам `myc`, из исходников —
 * `bun`, и тогда нужен ещё путь входного файла.
 */
export function spawnEmbedDaemon(dbPath: string, ttlMs?: number): void {
  try {
    const entry = process.argv[1];
    const fromSource = typeof entry === "string" && /\.(ts|js|mjs)$/.test(entry);
    const argv = [
      process.execPath,
      ...(fromSource ? [entry] : []),
      "embedd",
      "--db",
      dbPath,
      ...(ttlMs !== undefined ? ["--ttl", String(ttlMs)] : []),
    ];
    const child = Bun.spawn(argv, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      // Демон обязан пережить процесс, который его позвал: иначе прогрев
      // умирал бы вместе с той самой командой, которой он не помог.
      detached: true,
    });
    child.unref();
  } catch {
    // Не поднялся — значит следующий запрос снова пойдёт без вектора и снова
    // честно об этом скажет. Падать здесь нечему.
  }
}

// ---------------------------------------------------------------------------
// Сам демон
// ---------------------------------------------------------------------------

/** Сколько демон живёт без единого запроса. 10 минут — длина рабочей сессии агента. */
export const DEFAULT_DAEMON_TTL_MS = 600_000;

/** Как часто демон проверяет, на месте ли его база. Дёшево: один existsSync. */
export const DB_WATCH_INTERVAL_MS = 30_000;

/**
 * Период сторожа из окружения. Нужен тесту, который поднимает НАСТОЯЩИЙ
 * процесс демона: только так видно, что процесс действительно вышел, а не
 * повис на незагашенном таймере — внутрипроцессная проверка этого не различает.
 */
export function dbWatchIntervalFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MYC_EMBED_DB_WATCH_MS;
  if (raw === undefined || raw.trim().length === 0) return DB_WATCH_INTERVAL_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : DB_WATCH_INTERVAL_MS;
}

export interface DaemonOptions {
  readonly dbPath: string;
  readonly ttlMs?: number;
  /** Подмена эмбеддера (тесты): вернуть готовый объект вместо загрузки ONNX. */
  readonly createEmbedder?: () => Promise<{
    warmup(): Promise<string>;
    embed(text: string): Promise<{ state: string; vec?: Float32Array }>;
    destroy(): Promise<void>;
  }>;
  /** Подмена драйвера очереди (тесты); undefined — открыть базу самому. */
  readonly openQueue?: () => { db: DbDriver; scope: string; close(): void } | null;
  /** Период проверки, на месте ли база (тесты); по умолчанию DB_WATCH_INTERVAL_MS. */
  readonly dbWatchMs?: number;
}

export interface DaemonRun {
  readonly socketPath: string;
  readonly warmMs: number;
  readonly state: string;
  readonly served: number;
  readonly leased: boolean;
  readonly stopped: "idle" | "signal" | "failed" | "db_gone";
  readonly reason?: string;
}

/**
 * Тело демона. Возвращает управление, только когда сокет закрыт: прогрев,
 * обслуживание и уборка — один линейный путь, потому что «частично поднятый
 * демон» — это состояние, о котором клиент не может узнать.
 */
export async function runEmbedDaemon(opts: DaemonOptions): Promise<DaemonRun> {
  const socketPath = embedSocketPath(opts.dbPath);
  const ttlMs = opts.ttlMs ?? DEFAULT_DAEMON_TTL_MS;

  // Единственность — через сам сокет: если по нему кто-то отвечает, второй
  // экземпляр не нужен. Файл-лок здесь был бы лишней сущностью с собственным
  // протуханием.
  if (await pingEmbedDaemon(socketPath, 300)) {
    return {
      socketPath,
      warmMs: 0,
      state: "already-running",
      served: 0,
      leased: false,
      stopped: "signal",
    };
  }
  if (existsSync(socketPath)) {
    // Сокет от убитого демона: connect по нему уже не отвечает (проверено
    // выше), значит файл — мусор, и unlink безопасен.
    try {
      unlinkSync(socketPath);
    } catch {
      /* гонка с другим стартующим демоном — он и займёт сокет */
    }
  }

  // СОКЕТ ЗАНИМАЕТСЯ ДО ПРОГРЕВА, а не после.
  //
  // Это не мелочь порядка, а исправление гонки, найденной живым прогоном:
  // прогрев длится 200+ мс, и пока сокета нет, КАЖДЫЙ следующий `recall`
  // считал, что демона нет, поднимал ещё одного, тот удалял сокет предыдущего
  // как «мусор от убитого» — и в итоге живых демонов было несколько, а
  // отвечающих ноль. Заняв сокет первым, демон отвечает на ping сразу и
  // честно: state="warming". Второй экземпляр видит ответ и уходит, а клиент
  // видит разницу между «греется» и «нет вовсе».
  let state = "warming";
  let warmMs = 0;
  let served = 0;
  let stopped: DaemonRun['stopped'] = "idle";
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveDone: (() => void) | undefined;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      stopped = "idle";
      resolveDone?.();
    }, ttlMs);
  };

  // Вторая линия обороны: демон обязан уйти, когда его базы больше нет.
  //
  // Первая линия — embedDaemonEnabled, но она читает NODE_ENV дочернего
  // процесса, а тест, собирающий окружение белым списком, эту переменную не
  // передаёт. Так и получилось: прогон оставлял демона с базой во временном
  // каталоге, каталог удалялся, а демон досиживал свои 10 минут TTL, держа
  // ONNX в памяти. Ждать TTL здесь не за чем — работать уже не над чем.
  let dbWatch: ReturnType<typeof setInterval> | undefined;
  const armDbWatch = (): void => {
    dbWatch = setInterval(() => {
      if (existsSync(opts.dbPath)) return;
      stopped = "db_gone";
      resolveDone?.();
    }, opts.dbWatchMs ?? dbWatchIntervalFromEnv());
  };

  let embedder:
    | Awaited<ReturnType<NonNullable<DaemonOptions['createEmbedder']>>>
    | undefined;

  let server: ReturnType<typeof Bun.listen>;
  try {
    server = Bun.listen({
      unix: socketPath,
      socket: {
        data(sock, chunk) {
          armIdle();
          for (const line of chunk.toString("utf8").split("\n")) {
            if (line.trim().length === 0) continue;
            let req: Record<string, unknown>;
            try {
              req = JSON.parse(line) as Record<string, unknown>;
            } catch {
              sock.write(`${JSON.stringify({ ok: false, reason: "плохой JSON" })}\n`);
              continue;
            }
            const op = String(req["op"] ?? "");
            if (op === "ping") {
              sock.write(
                `${JSON.stringify({ ok: true, state, dim: 384, warm_ms: warmMs, served })}\n`,
              );
            } else if (op === "stop") {
              sock.write(`${JSON.stringify({ ok: true })}\n`);
              stopped = "signal";
              resolveDone?.();
            } else if (op === "embed") {
              // Пока греемся — отказ с ПРИЧИНОЙ, а не молчание и не ожидание:
              // клиент обязан уметь уйти без вектора, и он это умеет.
              if (embedder === undefined || state !== "ok") {
                sock.write(`${JSON.stringify({ ok: false, reason: `state=${state}` })}\n`);
                continue;
              }
              const text = String(req["text"] ?? "");
              void embedder
                .embed(text)
                .then((r) => {
                  served++;
                  if (r.state === "ok" && r.vec !== undefined) {
                    sock.write(`${JSON.stringify({ ok: true, vec: [...r.vec] })}\n`);
                  } else {
                    sock.write(`${JSON.stringify({ ok: false, reason: `state=${r.state}` })}\n`);
                  }
                })
                .catch((e: unknown) => {
                  sock.write(
                    `${JSON.stringify({ ok: false, reason: e instanceof Error ? e.message : String(e) })}\n`,
                  );
                });
            } else {
              sock.write(
                `${JSON.stringify({ ok: false, reason: `неизвестная операция '${op}'` })}\n`,
              );
            }
          }
        },
        open() {
          armIdle();
        },
        close() {},
        error() {},
      },
    });
  } catch (e) {
    // Сокет занял кто-то другой в те же миллисекунды — это успех, а не сбой:
    // прогретый демон в системе будет, просто не этот.
    return {
      socketPath,
      warmMs: 0,
      state: "already-running",
      served: 0,
      leased: false,
      stopped: "signal",
      reason: e instanceof Error ? e.message : String(e),
    };
  }
  armIdle();
  armDbWatch();

  // Учёт в очереди — после того, как сокет занят: работа берётся тем, кто её
  // реально делает.
  const holder = `embedd-${process.pid}`;
  const queue = opts.openQueue?.() ?? null;
  let leased = false;
  if (queue !== null) {
    try {
      const now = Date.now();
      enqueueWarmJob(queue.db, queue.scope, now);
      queue.db.run(embedJobQueries.warm_lease, [
        holder,
        now + WARM_LEASE_MS,
        WARM_JOB_KIND,
        WARM_JOB_ENTITY,
        now,
      ]);
      leased = true;
    } catch {
      // Очередь недоступна (база занята, схема старая) — прогрев от неё не
      // зависит: она учёт, а не механизм (S7).
    }
  }

  const finish = async (run: Omit<DaemonRun, "socketPath">): Promise<DaemonRun> => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (dbWatch !== undefined) clearInterval(dbWatch);
    server.stop(true);
    try {
      unlinkSync(socketPath);
    } catch {
      /* уже убран */
    }
    await embedder?.destroy();
    return { socketPath, ...run };
  };

  const t0 = performance.now();
  try {
    embedder =
      opts.createEmbedder !== undefined
        ? await opts.createEmbedder()
        : await (async () => {
            const embed = await import("@myc/embed");
            const e = embed.createEmbedder({ backend: "local" });
            return {
              warmup: async () => String(await e.warmup()),
              embed: async (text: string) => {
                const r = await e.embed(text);
                return r.state === "ok" && r.vec !== null
                  ? { state: "ok", vec: r.vec }
                  : { state: String(r.state) };
              },
              destroy: () => e.destroy(),
            };
          })();
  } catch (e) {
    const reason = `эмбеддер не загрузился: ${e instanceof Error ? e.message : String(e)}`;
    state = "failed";
    if (queue !== null && leased) {
      try {
        queue.db.run(embedJobQueries.warm_fail, [reason, WARM_JOB_KIND, WARM_JOB_ENTITY]);
      } catch {
        /* учёт не критичен */
      }
    }
    queue?.close();
    return await finish({ warmMs: 0, state, served: 0, leased, stopped: "failed", reason });
  }

  state = await embedder.warmup();
  warmMs = Math.round((performance.now() - t0) * 10) / 10;

  if (state !== "ok") {
    const reason = `прогрев не завершился: state=${state}`;
    if (queue !== null && leased) {
      try {
        queue.db.run(embedJobQueries.warm_fail, [reason, WARM_JOB_KIND, WARM_JOB_ENTITY]);
      } catch {
        /* учёт не критичен */
      }
    }
    queue?.close();
    return await finish({ warmMs, state, served: 0, leased, stopped: "failed", reason });
  }

  // Прогрев состоялся — работа выполнена. Строка удаляется СЕЙЧАС, а не при
  // выходе: демон может быть убит, и тогда «работа висит в аренде навсегда»
  // было бы враньём о состоянии очереди.
  if (queue !== null && leased) {
    try {
      queue.db.run(embedJobQueries.warm_done, [WARM_JOB_KIND, WARM_JOB_ENTITY, holder]);
    } catch {
      /* учёт не критичен */
    }
  }
  queue?.close();

  await done;
  return await finish({ warmMs, state, served, leased, stopped });
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

const EMBEDD_FLAGS: readonly FlagSpec[] = [
  { name: "ttl", value: "number", description: `ms to stay alive while idle (default ${DEFAULT_DAEMON_TTL_MS})` },
  { name: "status", description: "report whether a warm embedder is serving this workspace" },
  { name: "stop", description: "ask the running daemon to exit" },
];

function dbPathOf(ctx: CommandContext): string {
  const dir = resolve(ctx.globals.directory ?? process.cwd());
  return ctx.globals.db ?? join(dir, ".myc", "myc.db");
}

/**
 * Очередь для демона: своё короткоживущее соединение с той же базой.
 * Отдельное от соединения команды намеренно — демон живёт минутами, а держать
 * ради учёта открытый дескриптор всё это время незачем: он закрывает базу
 * сразу после того, как отметил работу выполненной.
 */
export function openWarmQueue(
  dbPath: string,
): { db: DbDriver; scope: string; close(): void } | null {
  if (!existsSync(dbPath)) return null;
  try {
    const d = openDriver(dbPath);
    return { db: d, scope: "", close: () => d.close() };
  } catch {
    return null;
  }
}

export function createEmbeddCommand(
  openQueue: (dbPath: string) => { db: DbDriver; scope: string; close(): void } | null = openWarmQueue,
): Command {
  return {
    name: "embedd",
    summary: "warm query embedder: background job from the jobs queue, serves vectors over a socket",
    flags: EMBEDD_FLAGS,
    help:
      "Second half of decision S44. A cold ONNX warmup costs ~223 ms against a 25 ms recall " +
      "budget, so the vector branch was off by default and paraphrased questions found nothing. " +
      "This daemon pays the warmup once as an `embed_warm` job from the jobs queue and then " +
      "answers query-vector requests over a unix socket. Started automatically in the " +
      "background by `myc recall`/`myc search`; it never delays them. Set MYC_EMBED_DAEMON=0 " +
      "to disable that. Indexing the corpus is NOT done here — that is myc-o6z on top of myc-ewq.",
    handler: async (ctx) => {
      const dbPath = dbPathOf(ctx);
      const socketPath = embedSocketPath(dbPath);

      if (ctx.flags["status"] === true) {
        const ping = await pingEmbedDaemon(socketPath, 300);
        return {
          ok: true,
          data: {
            socket: socketPath,
            running: ping !== null,
            ...(ping !== null
              ? { state: ping.state, dim: ping.dim, warm_ms: ping.warmMs, served: ping.served }
              : {}),
          },
        };
      }

      if (ctx.flags["stop"] === true) {
        const okStop = await stopEmbedDaemon(socketPath);
        return { ok: true, data: { socket: socketPath, stopped: okStop } };
      }

      const ttlRaw = flagNum(ctx, "ttl");
      const ttlMs =
        ttlRaw !== undefined && Number.isFinite(ttlRaw) && ttlRaw > 0
          ? Math.floor(ttlRaw)
          : DEFAULT_DAEMON_TTL_MS;

      const run = await runEmbedDaemon({ dbPath, ttlMs, openQueue: () => openQueue(dbPath) });
      if (run.stopped === "failed") {
        return {
          ok: false,
          code: "embed.warmup_failed",
          msg: run.reason ?? "прогрев эмбеддера не удался",
          exit: ExitCode.DEGRADED,
          hint: "myc models fetch",
        };
      }
      return {
        ok: true,
        data: {
          socket: run.socketPath,
          warm_ms: run.warmMs,
          state: run.state,
          served: run.served,
          leased: run.leased,
          stopped: run.stopped,
        },
      };
    },
  };
}
