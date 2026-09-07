/**
 * `myc remember` — записать факт (§3.8).
 *
 *   myc remember <текст>|- [--tag t1,t2] [--anchor <file>[:<a>-<b>]]
 *                [--layer L1|L2|L3] [--acl private|team|restricted|agent]
 *                [--source <url|file>] [--no-absorb] [--global]
 *
 * И1 — БЮДЖЕТ ЗАПИСИ 5 мс. В горячем пути ровно две вещи: одна транзакция
 * createNode (оплог + строка узла + часы полей) и один INSERT в jobs. Всё
 * дорогое — эмбеддинг (p50 23 мс) и классификация absorb (сеть/LLM) — не
 * делается здесь вовсе, а СТАВИТСЯ В ОЧЕРЕДЬ jobs и печатается строкой
 * `queue`: пользователь видит, что работа не потеряна, а отложена. Ни одного
 * импорта @myc/embed в этом модуле нет намеренно — он тянет ONNX-рантайм,
 * то есть десятки миллисекунд на запуск процесса ради записи в 2 мс.
 *
 * И2 — ГРОМКОСТЬ. Отсутствие chat-LLM не прячется: строка очереди пишется
 * как `absorb(эвристика — chat-LLM выключен)`, ровно как в §3.8. Это не
 * WARN (запись прошла полностью и качество записи не пострадало), а честная
 * пометка о том, чем будет разбирать факт фоновый дистиллятор.
 *
 * --global (S41) пишет в личный ярус ~/.myc. Ярус не создаётся молча: если
 * его нет, команда падает с подсказкой `myc init --global` — запись в личный
 * ярус обязана быть явным действием.
 *
 * ОХВАТ СЕССИОННЫЙ ПО УМОЛЧАНИЮ (S58). Записанное здесь принадлежит ТЕКУЩЕЙ
 * сессии и в `prime` чужой сессии не попадает — но и не испаряется: `myc
 * recall` его находит, оплог его хранит. Проектным факт становится ЯВНЫМ
 * решением `--reach project`, а не догадкой по содержанию: заказчик отдельно
 * отверг «пусть absorb решит сам», потому что ошибка догадки молча уводит
 * знание из контекста. Если личность сессии определить неоткуда (нет
 * `--session`, нет MYC_SESSION_ID/CLAUDE_SESSION_ID), охват НЕ записывается
 * вовсе и команда говорит об этом WARN'ом — «неизвестно» честнее, чем
 * «сессия по имени пустая строка» (И2). Ярус (S41, --global) и охват — две
 * разные оси: личное бывает и проектным, и сессионным.
 */

import type { JsonValue, Layer, NodeInput, NodeRecord, Reach, ReachInfo } from "@myc/core";
import {
  REACH_VALUES,
  contentHash,
  defineQueries,
  reachAttrs,
  readReach,
  resolveSession,
} from "@myc/core";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandContext, CommandFailure } from "../registry.ts";
import {
  flagStr,
  graphFailure,
  openPersonalStore,
  personalWorkspaceStatus,
  realStoreDeps,
  type OpenPersonalResult,
  type StoreDeps,
  type StoreHandle,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Очередь фоновых работ
// ---------------------------------------------------------------------------

/**
 * jobs (§8.1.7 схемы). `ON CONFLICT DO NOTHING` без указания цели: дедуп
 * стоит на ЧАСТИЧНОМ уникальном индексе ux_jobs_dedup(kind, entity_id)
 * WHERE entity_id IS NOT NULL, а на частичный индекс нельзя сослаться
 * конфликт-таргетом. Повторный `remember` того же узла не плодит вторую
 * работу того же вида — это и есть требуемое поведение.
 */
const QJ = defineQueries({
  // ФАЗА 0 absorb (§6.1): точный дубликат по ux_nodes_content(scope, kind,
  // content_hash) — один спуск по уникальному индексу, микросекунды.
  exact_dup: {
    name: "exact_dup",
    sql: `SELECT id, attrs FROM nodes
           WHERE scope = ?1 AND kind = ?2 AND content_hash = ?3 AND deleted_at IS NULL`,
    params: ["scope", "kind", "content_hash"],
  },
  job_enqueue: {
    name: "job_enqueue",
    sql: `INSERT INTO jobs (kind, entity_id, scope, priority, run_after, payload, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?5)
          ON CONFLICT DO NOTHING`,
    params: ["kind", "entity_id", "scope", "priority", "now", "payload"],
  },
});

/** Приоритеты очереди: эмбеддинг раньше классификации — от него зависит поиск. */
const JOB_PRIORITY: Readonly<Record<string, number>> = { embed: 3, absorb: 5, anchor_check: 6 };

interface JobRequest {
  readonly kind: string;
  readonly payload: Record<string, JsonValue>;
}

/**
 * Постановка всех работ ОДНОЙ транзакцией. Раздельные INSERT'ы дали бы по
 * коммиту на работу, то есть по записи в WAL на каждую, — и это ровно тот
 * хвост, из которого складывается p99 записи при бюджете 5 мс.
 */
function enqueueAll(
  h: StoreHandle,
  entityId: string,
  scope: string,
  jobs: readonly JobRequest[],
  now: number,
): void {
  if (jobs.length === 0) return;
  h.driver.tx("immediate", (tx) => {
    for (const job of jobs) {
      tx.run(QJ.job_enqueue, [
        job.kind,
        entityId,
        scope,
        JOB_PRIORITY[job.kind] ?? 5,
        now,
        JSON.stringify(job.payload),
      ]);
    }
  });
}

// ---------------------------------------------------------------------------
// Флаги и разбор
// ---------------------------------------------------------------------------

const REMEMBER_FLAGS: readonly FlagSpec[] = [
  { name: "tag", value: "string", description: "comma-separated tags" },
  { name: "anchor", value: "string", description: "file[:<a>-<b>] anchor request" },
  { name: "layer", value: "string", description: "L0|L1|L2|L3 (default L1)" },
  { name: "acl", value: "string", description: "private|team|restricted|agent" },
  { name: "source", value: "string", description: "provenance: url or file" },
  { name: "no-absorb", description: "do not queue absorb classification" },
  { name: "global", description: "write to the personal tier ~/.myc instead of the project" },
  { name: "as", value: "string", description: "actor for the record (default $MYC_ACTOR/$USER)" },
  { name: "reach", value: "string", description: "session (default) | project — memory reach, S58" },
  {
    name: "session",
    value: "string",
    description: "session identity (default $MYC_SESSION_ID/$CLAUDE_SESSION_ID)",
  },
];

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

function splitList(text: string | undefined): string[] {
  if (text === undefined) return [];
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface AnchorRequest {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

function parseAnchor(text: string): AnchorRequest | undefined {
  const m = /^(.+?)(?::(\d+)(?:-(\d+))?)?$/.exec(text.trim());
  if (!m) return undefined;
  const start = m[2] !== undefined ? Number(m[2]) : 1;
  const end = m[3] !== undefined ? Number(m[3]) : start;
  return { path: m[1]!, start, end };
}

function parseLayer(raw: string): Layer | undefined {
  const m = /^L?([0-3])$/i.exec(raw.trim());
  return m ? (Number(m[1]) as Layer) : undefined;
}

/**
 * Заголовок — первая строка факта, тело — весь факт, если он длиннее.
 * Так узел одинаково хорошо читается и в плотной выдаче recall (заголовок),
 * и целиком в `myc show` (тело), а excerpt считает сам движок из body (S5).
 */
const TITLE_MAX = 120;

function splitFact(text: string): { title: string; body: string | null } {
  const trimmed = text.trim();
  const firstLine = (trimmed.split("\n", 1)[0] ?? "").trim();
  if (firstLine.length <= TITLE_MAX && firstLine.length === trimmed.length) {
    return { title: firstLine, body: null };
  }
  const title =
    firstLine.length <= TITLE_MAX ? firstLine : `${firstLine.slice(0, TITLE_MAX - 1).trimEnd()}…`;
  return { title, body: trimmed };
}

/**
 * Форма note-узла (§2.3): kind='note', теги и происхождение — в attrs.
 *
 * Это повтор `noteInput` из packages/core/src/memory.ts, а не вызов: core
 * пока не реэкспортирует memory.ts из своего index (единственная точка
 * входа пакета — exports["."]), а править core в этой задаче нельзя — там
 * работает другой агент. Когда реэкспорт появится, эта функция уходит,
 * а вызов заменяется на импорт; расхождение полей ловит тест
 * remember.test.ts («форма узла совпадает с noteInput из core»).
 */
function memoryNodeInput(args: {
  scope: string;
  title: string;
  body: string | null;
  tags: readonly string[];
  layer?: Layer;
}): NodeInput {
  const attrs: Record<string, JsonValue> = { source: "agent" };
  if (args.tags.length > 0) attrs["tags"] = [...args.tags];
  return {
    kind: "note",
    scope: args.scope,
    title: args.title,
    body: args.body,
    ...(args.layer !== undefined ? { layer: args.layer } : {}),
    attrs,
  };
}

/**
 * Есть ли chat-LLM для absorb. Ключ читается только как ПРИЗНАК: ни его
 * значение, ни сам вызов модели здесь не используются — absorb работает в
 * фоне. Пустая строка считается отсутствием ключа.
 */
function chatLlmAvailable(env: Record<string, string | undefined> = process.env): boolean {
  for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "MYC_CHAT_API_KEY"]) {
    const v = env[key];
    if (typeof v === "string" && v.trim().length > 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Данные и отрисовка
// ---------------------------------------------------------------------------

export interface RememberData {
  id: string;
  kind: string;
  tier: "project" | "personal";
  /** Охват S58: session | project | unknown (сессию определить не удалось). */
  reach: ReachInfo["reach"];
  /** Ключ сессии-владельца; пусто у project и unknown. */
  session: string;
  /**
   * Точный повтор факта, уже лежащего в ЧУЖОЙ сессии: узел остаётся там,
   * где родился. Явное `--reach project` поднимает его — это и есть тот
   * «подъём по решению», о котором говорит S58.
   */
  reach_promoted?: boolean;
  layer: number;
  acl: string;
  tags: string[];
  source?: string;
  anchors: AnchorRequest[];
  queue: string[];
  /** absorb поставлен на эвристике: chat-LLM выключен (И2). */
  absorb_heuristic: boolean;
  /**
   * ФАЗА 0 absorb: факт уже есть слово в слово — узел не создан, `id` — это
   * id существующего, у которого вырос seen_count. Очередь пуста.
   */
  duplicate_of?: string;
  seen_count?: number;
  body_chars: number;
  took_ms: number;
}

/** Охват одной строкой: он обязан быть виден в каждой записи (И2). */
function reachBit(d: RememberData): string {
  if (d.reach === "project") return "охват project";
  if (d.reach === "session") return `охват session ${d.session}`;
  return "охват НЕИЗВЕСТЕН (сессия не определена)";
}

function renderRememberHuman(raw: unknown): string {
  const d = raw as RememberData;
  if (d.duplicate_of !== undefined) {
    const promoted = d.reach_promoted === true ? ", поднят до project" : "";
    return (
      `${d.id} duplicate · точный повтор, seen_count ${d.seen_count ?? "?"}${promoted} · ` +
      `${reachBit(d)} · ${d.took_ms} мс\n`
    );
  }
  const head = [d.id, d.kind === "note" ? "memory" : d.kind, `L${d.layer}`];
  const bits: string[] = [reachBit(d)];
  if (d.tier === "personal") bits.push("tier personal (~/.myc)");
  if (d.tags.length > 0) bits.push(`tags ${d.tags.join(",")}`);
  bits.push(`acl ${d.acl}`);
  if (d.source !== undefined) bits.push(`source ${d.source}`);
  const lines = [`${head.join(" ")} · ${bits.join(" · ")}`];
  for (const a of d.anchors) {
    const span = a.start === a.end ? `${a.start}` : `${a.start}-${a.end}`;
    lines.push(`anchor    ${a.path}:${span} @— (якорь отложен до myc anchor bind)`);
  }
  const queue = d.queue.map((k) =>
    k === "absorb" && d.absorb_heuristic ? "absorb(эвристика — chat-LLM выключен)" : k,
  );
  lines.push(`queue     ${queue.length > 0 ? queue.join(", ") : "—"}`);
  lines.push(`${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Команда
// ---------------------------------------------------------------------------

export interface RememberDeps extends StoreDeps {
  openPersonal(ctx: CommandContext): Promise<OpenPersonalResult>;
  /** Признак наличия chat-LLM; подменяется в тестах. */
  chatLlm(): boolean;
}

export const realRememberDeps: RememberDeps = {
  openStore: realStoreDeps.openStore,
  openPersonal: (ctx) => openPersonalStore(ctx),
  chatLlm: () => chatLlmAvailable(),
};

export function createRememberCommand(deps: RememberDeps = realRememberDeps): Command {
  return {
    name: "remember",
    summary: "record a fact into memory (project tier, or --global for ~/.myc)",
    flags: REMEMBER_FLAGS,
    help:
      "Writes one memory node. The fact is the positional argument; '-' reads stdin. " +
      "Everything expensive (embedding, absorb classification) is queued in jobs, never " +
      "done on the write path: the write itself is a single transaction under 5 ms.",
    handler: async (ctx) => {
      const t0 = performance.now();

      const positional = ctx.args.join(" ").trim();
      let text: string;
      if (positional === "-") {
        text = (await new Response(Bun.stdin.stream()).text()).trim();
      } else {
        text = positional;
      }
      if (text.length === 0) {
        return failure(
          "usage.invalid",
          "нужен текст факта: myc remember <текст> (или - для stdin)",
          ExitCode.USAGE,
        );
      }

      let layer: Layer | undefined;
      const layerRaw = flagStr(ctx, "layer");
      if (layerRaw !== undefined) {
        layer = parseLayer(layerRaw);
        if (layer === undefined) {
          return failure(
            "usage.invalid",
            `неверный слой '${layerRaw}'; допустимы L0..L3`,
            ExitCode.USAGE,
          );
        }
      }

      // ОХВАТ (S58). Умолчание — session, и оно не перевёрнуто ничем, кроме
      // явного `--reach project`. Личность сессии берётся из флага или
      // окружения; её отсутствие — не ошибка, а «охват неизвестен», и об
      // этом говорит WARN, а не тишина.
      const reachRaw = flagStr(ctx, "reach");
      if (reachRaw !== undefined && !(REACH_VALUES as readonly string[]).includes(reachRaw)) {
        return failure(
          "usage.invalid",
          `неверный --reach '${reachRaw}'; допустимы ${REACH_VALUES.join("|")}`,
          ExitCode.USAGE,
        );
      }
      const wantedReach: Reach = (reachRaw as Reach | undefined) ?? "session";
      const session = resolveSession(flagStr(ctx, "session"));
      const reachKnown = wantedReach === "project" || session.length > 0;

      let anchor: AnchorRequest | undefined;
      const anchorRaw = flagStr(ctx, "anchor");
      if (anchorRaw !== undefined) {
        anchor = parseAnchor(anchorRaw);
        if (anchor === undefined || anchor.path.length === 0) {
          return failure(
            "usage.invalid",
            `неверный якорь '${anchorRaw}'; формат file[:a-b]`,
            ExitCode.USAGE,
          );
        }
      }

      const global = ctx.flags["global"] === true;

      let h: StoreHandle;
      if (global) {
        const status = personalWorkspaceStatus();
        const openedPersonal = await deps.openPersonal(ctx);
        if (!openedPersonal.ok) return openedPersonal.failure;
        if (openedPersonal.handle === undefined) {
          return failure(
            "ws.not_initialized",
            `личный ярус не инициализирован: нет ${status.dbPath}`,
            ExitCode.NOWS,
            "myc init --global",
          );
        }
        h = openedPersonal.handle;
      } else {
        const opened = await deps.openStore(ctx);
        if (!opened.ok) return opened.failure;
        h = opened.handle;
      }

      try {
        const { title, body } = splitFact(text);
        const tags = splitList(flagStr(ctx, "tag"));
        const source = flagStr(ctx, "source");
        const acl = flagStr(ctx, "acl");

        const input = memoryNodeInput({
          scope: h.scope,
          title,
          body,
          tags,
          ...(layer !== undefined ? { layer } : {}),
        });
        const attrs: Record<string, JsonValue> = { ...input.attrs };
        if (reachKnown) Object.assign(attrs, reachAttrs(wantedReach, session));
        else {
          // И2: не выдумываем ни сессию, ни проектность. Узел записывается
          // без охвата, «неизвестно» видно в выдаче и считается в prime.
          ctx.warn(
            "degraded.reach",
            "охват не записан: личность сессии неизвестна — задайте --session, " +
              "MYC_SESSION_ID или пишите с --reach project",
          );
        }
        if (source !== undefined) attrs["provenance"] = source;
        if (anchor !== undefined) {
          attrs["anchors"] = [
            { path: anchor.path, start: anchor.start, end: anchor.end, state: "pending" },
          ];
        }

        // ФАЗА 0 absorb (§6.1): точный дубликат не плодит узел — растёт
        // seen_count у существующего, и работа в очередь не ставится. Без
        // этой проверки createNode падал бы на ux_nodes_content с ошибкой
        // «UNIQUE constraint failed», то есть повтор факта был отказом записи.
        const existing = h.driver.one<{ id: string; attrs: string }>(QJ.exact_dup, [
          h.scope,
          input.kind,
          contentHash(input.kind, title, body),
        ]);
        if (existing !== undefined) {
          let seen: number;
          try {
            seen = h.store.bumpCounter(existing.id, "seen_count");
          } catch (e) {
            return graphFailure(e);
          }
          // content_hash считается от (kind, title, body) и охвата не знает,
          // поэтому тот же факт из другой сессии попадает в УЖЕ СУЩЕСТВУЮЩИЙ
          // узел. Молча переносить его в новую сессию нельзя — он там не
          // рождался; молча оставлять чужим тоже нельзя — пользователь решил,
          // что факт ему нужен. Поэтому: явное `--reach project` поднимает
          // узел (решение принято человеком), всё остальное печатает
          // фактический охват и предупреждает, если он чужой.
          let before: ReachInfo;
          try {
            before = readReach(JSON.parse(existing.attrs) as Record<string, JsonValue>);
          } catch {
            before = readReach(undefined);
          }
          let after = before;
          let promoted = false;
          if (reachRaw === "project" && before.reach !== "project") {
            try {
              h.store.updateNode(existing.id, { attrs: reachAttrs("project", "") });
              after = { reach: "project", session: "", by: "recorded" };
              promoted = true;
            } catch (e) {
              return graphFailure(e);
            }
          } else if (
            before.reach === "session" &&
            (session.length === 0 || before.session !== session)
          ) {
            ctx.warn(
              "degraded.reach",
              `факт уже записан в другой сессии (${before.session}) и остаётся там; ` +
                "поднять до проектного — myc remember … --reach project",
            );
          }
          const dup: RememberData = {
            id: existing.id,
            kind: input.kind,
            tier: global ? "personal" : "project",
            reach: after.reach,
            session: after.session,
            ...(promoted ? { reach_promoted: true } : {}),
            layer: layer ?? 1,
            acl: acl ?? "team",
            tags,
            anchors: [],
            queue: [],
            absorb_heuristic: false,
            duplicate_of: existing.id,
            seen_count: seen,
            body_chars: text.length,
            took_ms: Math.round((performance.now() - t0) * 10) / 10,
          };
          return {
            ok: true,
            data: dup,
            meta: {
              took_ms: dup.took_ms,
              tier: dup.tier,
              queue: [],
              duplicate_of: existing.id,
              reach: after.reach,
              session: after.session.length > 0 ? after.session : null,
            },
          };
        }

        let node: NodeRecord;
        try {
          node = h.store.createNode({
            ...input,
            attrs,
            actor: flagStr(ctx, "as") ?? h.actor,
            ...(acl !== undefined ? { acl } : {}),
          });
        } catch (e) {
          return graphFailure(e);
        }

        // Всё тяжёлое — в очередь, а не в горячий путь (И1).
        const now = Date.now();
        const jobs: JobRequest[] = [{ kind: "embed", payload: { reason: "remember" } }];
        if (ctx.flags["no-absorb"] !== true) {
          jobs.push({ kind: "absorb", payload: { reason: "remember" } });
        }
        if (anchor !== undefined) {
          jobs.push({
            kind: "anchor_check",
            payload: { path: anchor.path, start: anchor.start, end: anchor.end },
          });
        }
        let queue: string[] = jobs.map((j) => j.kind);
        try {
          enqueueAll(h, node.id, h.scope, jobs, now);
        } catch (e) {
          queue = [];
          // Узел уже записан: потеря очереди — деградация, а не отказ записи.
          ctx.warn(
            "degraded.queue",
            `фоновая очередь недоступна: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        const absorbHeuristic = queue.includes("absorb") && !deps.chatLlm();
        const data: RememberData = {
          id: node.id,
          kind: node.kind,
          tier: global ? "personal" : "project",
          reach: reachKnown ? wantedReach : "unknown",
          session: reachKnown && wantedReach === "session" ? session : "",
          layer: node.layer,
          acl: node.acl,
          tags,
          ...(source !== undefined ? { source } : {}),
          anchors: anchor !== undefined ? [anchor] : [],
          queue,
          absorb_heuristic: absorbHeuristic,
          body_chars: text.length,
          took_ms: Math.round((performance.now() - t0) * 10) / 10,
        };
        return {
          ok: true,
          data,
          meta: {
            took_ms: data.took_ms,
            tier: data.tier,
            queue,
            reach: data.reach,
            session: data.session.length > 0 ? data.session : null,
          },
        };
      } finally {
        h.close();
      }
    },
    renderHuman: renderRememberHuman,
  };
}
