/**
 * `myc absorb-session` — тело хука pre-compact (§6.2, решение D11).
 *
 * Сжатие контекста — единственный момент, когда контекст теряется
 * ГАРАНТИРОВАННО. Если myc туда не встаёт, он не память, а записная книжка.
 * Отсюда три свойства, которые в этом файле важнее любой красоты:
 *
 * 1. ПОРЯДОК. Сырой эпизод пишется первым и быстро (бюджет 6 мс), пакет
 *    вторым, дистилляция — в фон. Если процесс убьют посреди, потерять надо
 *    минимум: из сырого эпизода восстанавливается всё остальное.
 * 2. ТАЙМАУТ. 8000 мс на весь хук, и его превышение не имеет права сломать
 *    сессию агента. Лучше сохранить часть, чем не сохранить ничего: после
 *    дедлайна пропускаются шаги, а не отменяется запись.
 * 3. СЕКРЕТЫ. Транскрипт проходит через redactSecrets ДО записи, без флага
 *    отключения (D23). Хук пишет сырые транскрипты, а `.myc/` лежит рядом с
 *    git — без этого утечка по расписанию.
 *
 * ОХВАТ (S58). Всё, что рождается здесь, принадлежит СВОЕЙ сессии: эпизод и
 * кандидаты получают `reach='session'`. Ключ ищется по трём источникам в
 * порядке убывания надёжности, и выбранный источник печатается в выдаче:
 *
 *   host       — `--session` от хоста (payload.session_id). Лучшее, что есть.
 *   transcript — uuid из имени файла стенограммы. Хост ведёт ОДИН файл на всю
 *                сессию и при сжатии дописывает его, поэтому uuid переживает
 *                сжатие и совпадает с тем же payload.session_id, который
 *                `prime` получает от SessionStart.
 *   episode    — `episode:<id>`, последняя линия обороны. Эпизод по своей
 *                природе НОВЫЙ на каждом сжатии, значит и ключ новый: то, что
 *                записано до сжатия, после него уедет в чужой охват. Поэтому
 *                этот источник больше не молчаливая норма, а громкая
 *                деградация — WARN'ом и строкой в спасательном пакете.
 *
 * Ровно на этом ломалось обещание вехи M1 «после каждого сжатия prime
 * возвращает решения, принятые до него»: ключ выводился из эпизода ВСЕГДА,
 * когда хост не назвал --session, то есть менялся на каждом сжатии.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactSecrets, type JsonValue } from "@myc/core";
import { HARNESSES } from "@myc/swarm";
// Подпуть, а не корень @myc/retrieval: хуку нужны две константы, а не гибрид.
import { PENDING_REVIEW, REVIEW_STATE_KEY } from "@myc/retrieval/review";
import {
  defineQueries,
  episodeSessionKey,
  reachAttrs,
  resolveSession,
  sessionKeyFromTranscript,
} from "@myc/core";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import {
  flagNum,
  flagStr,
  realStoreDeps,
  type StoreDeps,
  type StoreHandle,
} from "../commands/store.ts";
import { reconcileEpisodes, sweepPartialEpisodes, writeEpisode } from "./episode.ts";
import { recordHook } from "./counters.ts";
import { hookJson, isHookJson } from "./hook-output.ts";
import { activeTasks, buildRescuePacket } from "./rescue.ts";
import { extractSignals, parseTranscript } from "./transcript.ts";

/** Весь хук целиком (§6.1). Helper-обёртка режет себя на 500 мс раньше. */
export const HOOK_TIMEOUT_MS = 8000;
/**
 * Бюджет шага «сырой эпизод» (§6.2, шаг 3) — проверяется, а не декларируется.
 *
 * ПОЧЕМУ ОН СТАЛ ФУНКЦИЕЙ РАЗМЕРА. Константа 6 мс была бы честной, если бы шаг
 * делал работу постоянного объёма. Он её не делает: шаг кодирует стенограмму в
 * utf8, жмёт zstd и кладёт на диск — все три линейны по её размеру. На
 * настоящей стенограмме этого проекта (37.3 МБ, `~/.claude/projects`) шаг
 * раскладывается так: Buffer.from 15.5 мс, zstd L1 22.6 мс, write+rename
 * 1.2 мс. Нижняя граница физическая: запись ТЕХ ЖЕ 37.3 МБ вообще без сжатия
 * стоит 11.1 мс. Реализации, кладущей 37 МБ на диск за 6 мс, не существует —
 * значит константа не «нарушается», она просто мерит не то.
 *
 * ЧИСЛА, ИЗ КОТОРЫХ СОБРАН БЮДЖЕТ. Замер через сам CLI (то, что порог и
 * сторожит), по десять прогонов на каждую настоящую стенограмму, машина без
 * нагрузки:
 *
 *   1.95 МБ  min 3.9  med 4.2  max 7.8
 *   2.81 МБ  min 5.1  med 6.4  max 11.1
 *   5.96 МБ  min 7.9  med 8.4  max 9.0
 *   37.28 МБ min 34.3 med 36.7 max 49.9
 *
 * Прямая по медианам — ≈2 мс + 0.87 мс/МБ; худшая наблюдённая скорость на
 * большом файле 1.34 мс/МБ. Отсюда {@link EPISODE_BUDGET_MS} = 12 мс на
 * постоянную часть (строка узла плюс системные вызовы; её разброс на малых
 * файлах и есть 7.8 мс при 1.95 МБ) и {@link EPISODE_BUDGET_MS_PER_MB} = 2 мс/МБ
 * на переменную. Запас над худшим замером — от 1.5× до 2.3× на всех размерах;
 * на 37.3 МБ бюджет 86.6 мс против наблюдённых 49.9 мс.
 *
 * ЧЕГО БЮДЖЕТ НЕ СТОРОЖИТ, И ЭТО НАРОЧНО. Под конкуренцией (четыре хука разом,
 * 12 замеров) тот же шаг даёт min 40.7 / med 49.1 / max 123.8 мс, то есть до
 * 3.3 мс/МБ. Бюджет, переживающий и это, был бы 4 мс/МБ — вчетверо больше
 * измеренной цены, и перестал бы ловить что-либо вообще. Порог сторожит ПУТЬ
 * КОДА, а не занятость машины: хук, занявший втрое больше обычного, и есть
 * деградация, о которой агенту положено сказать вслух (И2), а не порог,
 * который надо было заранее ослабить.
 */
export const EPISODE_BUDGET_MS = 12;
/** Переменная часть бюджета эпизода: замер, а не догадка (см. выше). */
export const EPISODE_BUDGET_MS_PER_MB = 2;

export function episodeBudgetMs(bytes: number): number {
  return EPISODE_BUDGET_MS + (EPISODE_BUDGET_MS_PER_MB * bytes) / 1_000_000;
}
const BUDGET_AUTO = 1200;
const BUDGET_MANUAL = 2000;
/** Потолок кандидатов: они пишутся отдельными узлами, и их цена линейна. */
const MAX_CANDIDATES = 20;

/**
 * Откуда взялся ключ сессии. Порядок — убывание надёжности, и только
 * `episode` меняется от сжатия к сжатию (см. шапку файла).
 */
export type SessionSource = "host" | "transcript" | "episode";

const QJ = defineQueries({
  job_enqueue: {
    name: "job_enqueue",
    sql: `INSERT INTO jobs (kind, entity_id, scope, priority, run_after, payload, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)
          ON CONFLICT DO NOTHING`,
    params: ["kind", "entity_id", "scope", "priority", "now", "payload"],
  },
});

const ABSORB_FLAGS: readonly FlagSpec[] = [
  { name: "transcript", value: "string", description: "transcript path, or - for stdin" },
  { name: "stdin-transcript", description: "read the transcript from stdin (same as --transcript -)" },
  { name: "reason", value: "string", description: "compact|auto|manual|stop (default auto)" },
  { name: "budget", value: "number", description: "rescue packet size in characters" },
  { name: "hook-output", value: "string", description: "json|text (default text)" },
  { name: "timeout", value: "number", description: `whole-hook budget in ms (default ${HOOK_TIMEOUT_MS})` },
  // Список харнессов один на весь myc (@myc/swarm): вписанный сюда руками
  // он уже отставал — kimi звал этот хук, а в подсказке его не было.
  { name: "agent", value: "string", description: `host that fired the hook: ${HARNESSES.join("|")}` },
  { name: "no-candidates", description: "do not write pending_review candidates" },
  {
    name: "session",
    value: "string",
    description: "host session id (payload.session_id): owns the memory written here, S58",
  },
];

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

interface TranscriptSource {
  readonly text: string;
  readonly origin: string;
}

async function readTranscript(
  ctx: CommandContext,
  deps: AbsorbDeps,
): Promise<TranscriptSource | CommandFailure> {
  const wantsStdin = ctx.flags["stdin-transcript"] === true;
  const path = flagStr(ctx, "transcript");
  if (wantsStdin || path === "-" || (path === undefined && !process.stdin.isTTY)) {
    return { text: await deps.readStdin(), origin: "stdin" };
  }
  if (path === undefined) return { text: "", origin: "none" };
  const abs = resolve(path);
  if (!existsSync(abs)) {
    // Хост назвал файл, которого нет: это не повод терять эпизод целиком, но
    // и молчать нельзя — вызывающая сторона превратит это в WARN.
    return { text: "", origin: `missing:${abs}` };
  }
  try {
    return { text: readFileSync(abs, "utf8"), origin: abs };
  } catch (e) {
    return failure(
      "io.read",
      `cannot read transcript ${abs}: ${e instanceof Error ? e.message : String(e)}`,
      ExitCode.ERR,
    );
  }
}

function enqueue(
  handle: StoreHandle,
  kind: string,
  entityId: string,
  payload: Record<string, JsonValue>,
  priority: number,
  now: number,
): void {
  handle.driver.run(QJ.job_enqueue, [
    kind,
    entityId,
    handle.scope,
    priority,
    now,
    JSON.stringify(payload),
  ]);
}

/**
 * Кандидаты L2 со `state=pending_review` (§6.2, шаг 4). Это НЕ факты: их
 * подтверждает дистилляция или человек, поэтому `salience: 0` и `acl: private`.
 * Пишутся после эпизода — их потеря при убийстве процесса восстановима из него.
 */
function writeCandidates(
  handle: StoreHandle,
  episodeId: string,
  lines: readonly string[],
  agent: string,
  session: string,
): { written: number; known: number; error?: string } {
  let written = 0;
  let known = 0;
  let error: string | undefined;
  // Каждый кандидат отдельно: одно столкновение по content_hash не имеет
  // права уронить остальные. Столкновение вообще не ошибка — это тот же
  // вывод, уже лежащий в графе с прошлого сжатия, и терять его не пришлось.
  for (const line of lines.slice(0, MAX_CANDIDATES)) {
    const title = line.length > 120 ? `${line.slice(0, 119)}…` : line;
    try {
      const node = handle.store.createNode({
        kind: "note",
        layer: 2,
        acl: "private",
        salience: 0,
        scope: handle.scope,
        title,
        body: line.length > 120 ? line : null,
        actor: handle.actor,
        attrs: {
          // Ключ и значение — те же константы, которыми фильтр выдачи
          // (@myc/retrieval review.ts) узнаёт кандидата: переименуй одно без
          // другого, и кандидаты молча потекли бы агенту фактами.
          [REVIEW_STATE_KEY]: PENDING_REVIEW,
          extracted_by: "precompact",
          episode_id: episodeId,
          agent,
          // Охват сессионный (S58): кандидат родился в этой сессии и в
          // контекст чужой не пойдёт. episode_id остаётся и без флага —
          // по нему охват выводится структурно.
          ...reachAttrs("session", session.length > 0 ? session : episodeSessionKey(episodeId)),
        },
      });
      handle.store.addEdge(node.id, "derived_from", episodeId);
      written++;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/UNIQUE constraint failed: nodes\.scope, nodes\.kind, nodes\.content_hash/.test(msg)) known++;
      else error ??= msg;
    }
  }
  return { written, known, ...(error !== undefined ? { error } : {}) };
}

export interface AbsorbData {
  readonly episode: string | null;
  readonly reason: string;
  readonly agent: string;
  /** Ключ сессии, которой принадлежит записанное (S58). */
  readonly session: string;
  /** Откуда взят ключ: host → transcript → episode (см. шапку файла). */
  readonly session_source: SessionSource;
  /**
   * true — ключ не назван хостом. Устойчивости ключа это БОЛЬШЕ НЕ ОЗНАЧАЕТ:
   * `transcript` тоже выведен, но переживает сжатие. Смотреть надо на
   * {@link AbsorbData.session_source}.
   */
  readonly session_derived: boolean;
  readonly raw_bytes: number;
  readonly stored_bytes: number;
  readonly compression: string;
  readonly secrets_masked: number;
  readonly turns: number;
  readonly decisions: number;
  readonly candidates: number;
  /** Кандидаты, уже лежащие в графе с прошлого сжатия: не записаны и не потеряны. */
  readonly candidates_known: number;
  readonly files: number;
  readonly queue: readonly string[];
  /** Эпизоды, которым восстановили строку узла после обрыва прошлого хука. */
  readonly adopted: readonly string[];
  readonly packet: string;
  readonly packet_chars: number;
  readonly dropped: Readonly<Record<string, number>>;
  /** Фактическое время каждого шага, мс. Бюджет эпизода — 6 мс, всего — 8000. */
  readonly stages: Readonly<Record<string, number>>;
  readonly took_ms: number;
  readonly budget_exceeded: boolean;
}

export interface AbsorbDeps extends StoreDeps {
  readStdin(): Promise<string>;
}

export const realAbsorbDeps: AbsorbDeps = {
  openStore: realStoreDeps.openStore,
  readStdin: () => new Response(Bun.stdin.stream()).text(),
};

export function createAbsorbSessionCommand(deps: AbsorbDeps = realAbsorbDeps): Command {
  return {
    name: "absorb-session",
    summary: "save the session episode before context is compacted (pre-compact hook)",
    flags: ABSORB_FLAGS,
    help:
      "Writes the raw episode first (L0, private, secrets masked), then builds the rescue " +
      "packet, then queues distillation. The whole hook is bounded by --timeout; exceeding " +
      "it skips later steps but never cancels the episode that is already on disk.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const timeoutMs = flagNum(ctx, "timeout") ?? HOOK_TIMEOUT_MS;
      const reason = flagStr(ctx, "reason") ?? "auto";
      const agent = flagStr(ctx, "agent") ?? process.env["MYC_HOOK_AGENT"] ?? "unknown";
      const budget = flagNum(ctx, "budget") ?? (reason === "manual" ? BUDGET_MANUAL : BUDGET_AUTO);
      // S58: чьей сессии принадлежит всё, что тут родится. Ключ хоста
      // известен сразу, ключ из стенограммы — после шага 1.
      const hostSession = resolveSession(flagStr(ctx, "session"));
      const overBudget = (): boolean => performance.now() - t0 > timeoutMs;
      const stages: Record<string, number> = {};
      const mark = (name: string, from: number): void => {
        stages[name] = Math.round((performance.now() - from) * 100) / 100;
      };

      // Шаг 1: транскрипт.
      const tRead = performance.now();
      const source = await readTranscript(ctx, deps);
      if ("ok" in source && source.ok === false) return source;
      const raw = (source as TranscriptSource).text;
      const origin = (source as TranscriptSource).origin;
      mark("read", tRead);
      if (origin.startsWith("missing:")) {
        ctx.warn("degraded.transcript", `the host named a transcript that does not exist: ${origin.slice(8)}`);
      }

      // Ключ сессии: хост → uuid стенограммы → эпизод (см. шапку файла).
      // Второй источник и есть починка обещания вехи: имя файла стенограммы
      // не меняется при сжатии, номер эпизода меняется всегда.
      const transcriptSession = hostSession.length > 0 ? "" : sessionKeyFromTranscript(origin);
      const session = hostSession.length > 0 ? hostSession : transcriptSession;
      const sessionSource: SessionSource =
        hostSession.length > 0 ? "host" : session.length > 0 ? "transcript" : "episode";

      // Шаг 2: секреты. Всегда, без флага отключения (D23).
      const tRedact = performance.now();
      const redacted = raw.length > 0 ? redactSecrets(raw) : { text: "", findings: [] };
      mark("redact", tRedact);

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      // Каталог БАЗЫ, а не `<cwd>/.myc`. Эпизод и счётчик хука принадлежат
      // базе: из git worktree cwd — чужой каталог, он уходит вместе с веткой,
      // а база остаётся в основном дереве. Пока путь выводился из cwd, эпизод
      // сжатия умирал вместе с worktree, тогда как ЗАДАЧИ той же сессии
      // оставались в общей базе — половина работы сохранена, половина нет, и
      // никто об этом не говорил (memory-40dy12kkq6v2).
      const mycDir = h.mycDir;

      try {
        // Шаг 3: СЫРОЙ ЭПИЗОД. Первым и быстро — бюджет 6 мс.
        let episodeId: string | null = null;
        let storedBytes = 0;
        let compression = "none";
        if (raw.length > 0) {
          try {
            const written = writeEpisode({
              mycDir,
              handle: h,
              redacted: redacted.text,
              header: {
                reason,
                agent,
                created_at: Date.now(),
                raw_bytes: Buffer.byteLength(raw, "utf8"),
                secrets_masked: redacted.findings.length,
              },
              attrs: {
                reason,
                agent,
                origin,
                raw_bytes: Buffer.byteLength(raw, "utf8"),
                secrets_masked: redacted.findings.length,
                // Эпизод — запись САМОЙ сессии, охват у него сессионный
                // всегда. Без ключа хоста и без стенограммы им становится сам
                // эпизод — но тогда это уже названная деградация, не норма.
                ...(session.length > 0 ? reachAttrs("session", session) : {}),
              },
            });
            episodeId = written.id;
            storedBytes = written.storedBytes;
            compression = written.compression;
            stages["episode"] = Math.round(written.tookMs * 100) / 100;
            const budgetMs = episodeBudgetMs(Buffer.byteLength(raw, "utf8"));
            if (written.tookMs > budgetMs) {
              ctx.warn(
                "degraded.budget",
                `raw episode written in ${written.tookMs.toFixed(1)} ms against a budget of ` +
                  `${budgetMs.toFixed(1)} ms (${EPISODE_BUDGET_MS} ms + ${EPISODE_BUDGET_MS_PER_MB} ms/MB ` +
                  `for ${(Buffer.byteLength(raw, "utf8") / 1_000_000).toFixed(1)} MB)`,
              );
            }
          } catch (e) {
            // Эпизод не записался — это худший исход, но не повод не отдать
            // пакет: лучше сохранить часть, чем не сохранить ничего.
            ctx.warn(
              "degraded.episode",
              `raw episode NOT written: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        } else {
          ctx.warn("degraded.transcript", "empty transcript: no episode written, the packet was built from the graph");
        }

        // Шаг 4: дешёвая экстракция без LLM. После эпизода и под дедлайном.
        const tExtract = performance.now();
        let signals = { decisions: [] as string[], open: [] as string[], mycCalls: [] as string[], files: [] as { path: string; count: number }[] };
        let turns = 0;
        let candidates = 0;
        let candidatesKnown = 0;
        const queue: string[] = [];
        if (raw.length > 0 && !overBudget()) {
          const parsed = parseTranscript(redacted.text);
          turns = parsed.turns.length;
          const extracted = extractSignals(parsed);
          signals = {
            decisions: [...extracted.decisions],
            open: [...extracted.open],
            mycCalls: [...extracted.mycCalls],
            files: [...extracted.files],
          };
          if (episodeId !== null) {
            try {
              h.store.updateNode(episodeId, {
                attrs: {
                  turns,
                  transcript_format: parsed.format,
                  decisions: signals.decisions.length,
                  files: signals.files.length,
                  ...(parsed.truncated ? { parse_truncated: true } : {}),
                },
              });
            } catch {
              // атрибуты статистики не стоят падения хука: эпизод уже на диске
            }
            if (ctx.flags["no-candidates"] !== true && !overBudget()) {
              const written = writeCandidates(h, episodeId, signals.decisions, agent, session);
              candidates = written.written;
              candidatesKnown = written.known;
              if (written.error !== undefined) {
                ctx.warn("degraded.candidates", `candidates only partly written: ${written.error}`);
              }
            }
            // Шаг 5: дистилляция уходит в ФОН — здесь только строка в очереди.
            const now = Date.now();
            try {
              enqueue(h, "distill", episodeId, { reason, agent, candidates }, 4, now);
              queue.push("distill");
              if (signals.files.length > 0) {
                enqueue(h, "anchor_check", episodeId, { paths: signals.files.map((f) => f.path) }, 6, now);
                queue.push("anchor_check");
              }
            } catch (e) {
              ctx.warn(
                "degraded.queue",
                `background queue unavailable: ${e instanceof Error ? e.message : String(e)}`,
              );
            }
          }
        } else if (raw.length > 0) {
          ctx.warn("degraded.timeout", `budget of ${timeoutMs} ms spent before parsing: episode saved, atoms deferred`);
        }
        mark("extract", tExtract);

        // Шаг 6: СПАСАТЕЛЬНЫЙ ПАКЕТ.
        const tPacket = performance.now();
        const tasks = activeTasks(h);
        // И2: охват, выведенный из эпизода, — не то же самое, что охват,
        // названный хостом; второе сжатие той же сессии получит другой ключ.
        // Сказано это ПАКЕТОМ, а не ctx.warn, потому что читателю это нужно
        // ВНУТРИ контекста: пакет — единственное, что доезжает до агента, и
        // именно агенту решать, назвать ли ключ следующему `prime`. (Раньше
        // здесь стояла вторая причина — что WARN сломал бы разбор JSON. Она
        // больше не действует: блок WARN уходит в stderr, а деградация едет в
        // документе полем `warn`, см. hook-output.ts.)
        // Ключ из стенограммы деградацией НЕ является: он устойчив между
        // сжатиями и совпадает с тем, что хост даёт `prime`.
        const reachNote =
          sessionSource === "episode" && episodeId !== null
            ? `reach derived from the episode (${episodeSessionKey(episodeId)}): no --session and no uuid ` +
              "in the transcript name; the next compaction of the same session will get a different key"
            : undefined;
        const packet = buildRescuePacket(
          {
            episodeId: episodeId ?? "—",
            rawBytes: Buffer.byteLength(raw, "utf8"),
            secretsMasked: redacted.findings.length,
            decisions: signals.decisions,
            open: signals.open,
            files: signals.files,
            mycCalls: signals.mycCalls,
            tasks,
            budget,
            degraded: [
              ...ctx.diagnostics.items.map((w) => w.msg),
              ...(reachNote !== undefined ? [reachNote] : []),
            ],
          },
          performance.now() - t0,
        );
        mark("packet", tPacket);

        // Уборка последней: она чинит следы ПРОШЛОГО обрыва и не имеет права
        // конкурировать за бюджет с записью текущего эпизода.
        let adopted: readonly string[] = [];
        if (!overBudget()) {
          sweepPartialEpisodes(mycDir);
          adopted = reconcileEpisodes(mycDir, h).adopted;
          if (adopted.length > 0) {
            ctx.warn(
              "degraded.adopted",
              `recovered ${adopted.length} episode${adopted.length === 1 ? "" : "s"} after the previous hook was cut off: ${adopted.join(", ")}`,
            );
          }
        }

        const tookMs = Math.round((performance.now() - t0) * 10) / 10;
        recordHook(mycDir, `${agent}:pre-compact`, tookMs, episodeId === null ? "empty" : "ok");

        const sessionKey =
          session.length > 0
            ? session
            : episodeId !== null
              ? episodeSessionKey(episodeId)
              : "";
        const data: AbsorbData = {
          episode: episodeId,
          reason,
          agent,
          session: sessionKey,
          session_source: sessionSource,
          session_derived: hostSession.length === 0,
          raw_bytes: Buffer.byteLength(raw, "utf8"),
          stored_bytes: storedBytes,
          compression,
          secrets_masked: redacted.findings.length,
          turns,
          decisions: signals.decisions.length,
          candidates,
          candidates_known: candidatesKnown,
          files: signals.files.length,
          queue,
          adopted,
          packet: packet.text,
          packet_chars: packet.chars,
          dropped: packet.dropped,
          stages,
          took_ms: tookMs,
          budget_exceeded: tookMs > timeoutMs,
        };
        if (data.budget_exceeded) {
          ctx.warn("degraded.timeout", `hook took ${tookMs} ms against a budget of ${timeoutMs} ms`);
        }
        return { ok: true, data, meta: { took_ms: tookMs, episode: episodeId, stages } };
      } finally {
        h.close();
      }
    },
    // stdout под `--hook-output json` читает Claude Code, а не человек: каркас
    // не приклеивает к нему блок WARN, а уводит его в stderr (см. index.ts и
    // hooks/hook-output.ts). Деградация при этом не пропадает — она едет в том
    // же документе полем `warn`.
    machineStdout: (ctx) => isHookJson(ctx),
    renderHuman: (data, ctx) => {
      const d = data as AbsorbData;
      return isHookJson(ctx) ? hookJson("PreCompact", d.packet, ctx.diagnostics) : d.packet;
    },
  };
}
