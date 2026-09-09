/**
 * `myc link` — связь между узлами из терминала.
 *
 * ПОЧЕМУ КОМАНДА ПОЯВИЛАСЬ (memory-55ggwfrm68gp). Связывание умело делаться
 * только по MCP (`myc_link`). При этом SKILL.md, который `myc wire` кладёт
 * КАЖДОМУ агенту в каждом проекте, велел писать
 * `myc link A supersedes B --reason "..."` — то есть инструкция исполнителю
 * называла команду, которой не было ни дня. Агент по MCP связывал узлы, тот
 * же агент в терминале и любой человек — нет. Возможность была, входа с одной
 * стороны не было; выбран вход, а не вычёркивание инструкции: противоречия в
 * памяти обязаны разрешаться связью, а не затиранием, и делать это должно быть
 * можно оттуда, откуда человек и агент работают чаще всего.
 *
 * КОНТРАКТ ОДИН НА ДВЕ ПОВЕРХНОСТИ. Типы связей, обязательность `reason`,
 * коды отказов и список эффектов здесь те же, что у `myc_link`
 * (packages/mcp/src/dispatch.ts, toolLink). Совпадение не обещано
 * комментарием, а проверено: link.parity.test.ts гоняет ОДИН сценарий через
 * обе поверхности и сверяет и результат, и итоговый граф, а таблица типов
 * рёбер сверяется с LINK_EDGE_KINDS из @myc/mcp поэлементно.
 *
 * ЗАВИСИМОСТИ НЕ ДУБЛИРУЮТСЯ. `blocks`/`blocked-by` — частный случай ребра с
 * готовым движком (циклы, ready-очередь, `left_ready`), и он уже живёт в
 * `myc dep`. MCP на этих типах зовёт `dep add`/`dep rm` подпроцессом; здесь
 * вызывается тот же обработчик напрямую. Третьей реализации `blocks` не
 * заводится — их и так было бы уже три.
 */

import { ExitCode } from "../exit.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";
import { graphFailure, resolveId, type StoreDeps, realStoreDeps } from "./store.ts";
import { createDepCommand } from "./dep.ts";
import type { EdgeKind } from "@myc/core";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

/**
 * Тип связи на поверхности → EdgeKind ядра. Копия LINK_EDGE_KINDS из
 * packages/mcp/src/store.ts, и копия НАМЕРЕННАЯ: тянуть @myc/mcp в команду
 * значит грузить сервер, диспетчер и весь его граф ради одного ребра, а
 * реестр команд специально сделан ленивым (register.ts). Расхождение ловит
 * link.parity.test.ts — он сверяет обе таблицы целиком, а не «на глаз».
 */
export const LINK_EDGE_KINDS = {
  "relates-to": "relates",
  duplicates: "duplicates",
  supersedes: "supersedes",
  contradicts: "contradicts",
  "replies-to": "replies_to",
  "derived-from": "derived_from",
  "part-of": "parent",
} as const satisfies Record<string, EdgeKind>;

/** Порядок важен: он же печатается в отказе и сверяется с MCP. */
export const LINK_TYPES = ["blocks", "blocked-by", ...Object.keys(LINK_EDGE_KINDS)] as const;

/** Типы, у которых `reason` обязателен: история не переписывается молча. */
export const REASON_REQUIRED = new Set(["supersedes", "duplicates"]);

export interface LinkData {
  /** ID после разрешения префикса — тот же конец, что печатает MCP в edge.from. */
  from: string;
  type: string;
  to: string;
  removed?: boolean;
  /** Побочные следствия ребра: `superseded_by`, уход/возврат в ready, reason. */
  effects: string[];
  took_ms: number;
}

export function renderLinkHuman(raw: unknown): string {
  const d = raw as LinkData;
  const head =
    d.removed === true ? `${d.type} ${d.from} → ${d.to} removed` : `${d.from} ${d.type} ${d.to}`;
  const effects = d.effects.length > 0 ? `\neffects   ${d.effects.join(" · ")}` : "";
  return `${head}${effects}\n${d.took_ms} мс\n`;
}

/** Данные `myc dep add|rm` — ровно то, чем отвечает подкоманда dep. */
interface DepEdgeData {
  src: string;
  dst: string;
  left_ready?: boolean;
  left_ready_id?: string;
  back_ready?: boolean;
  back_ready_id?: string;
}

/**
 * `blocks`/`blocked-by` → тот же обработчик, что у `myc dep add|rm`.
 * Позиционная грамматика у них совпадает (`<from> <type> <to>`), поэтому
 * контекст уходит как есть; переводится только форма ответа.
 */
async function viaDep(
  deps: StoreDeps,
  ctx: CommandContext,
  type: string,
  remove: boolean,
  t0: number,
): Promise<CommandResult> {
  const dep = createDepCommand(deps);
  const sub = (dep.subcommands ?? []).find((s) => s.name === (remove ? "rm" : "add"));
  if (sub?.handler === undefined) {
    return failure("internal.unexpected", `у dep нет подкоманды ${remove ? "rm" : "add"}`, ExitCode.ERR);
  }
  const result = await sub.handler(ctx);
  if (!result.ok) return result;

  const d = result.data as DepEdgeData;
  // Эффекты слово в слово те же, что печатает MCP: два текста про одно
  // событие — это вопрос «а какой правильный?» вместо ответа.
  const effects =
    d.left_ready === true
      ? [`${d.left_ready_id} вышла из ready`]
      : d.back_ready === true
        ? [`${d.back_ready_id} снова ready`]
        : [];
  const data: LinkData = {
    from: d.src,
    type,
    to: d.dst,
    ...(remove ? { removed: true } : {}),
    effects,
    took_ms: Math.round(performance.now() - t0),
  };
  return { ok: true, data, meta: { took_ms: data.took_ms } };
}

export function createLinkCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "link",
    summary: "link two nodes: link <from> <type> <to> [--reason ...] [--remove]",
    flags: [
      {
        name: "reason",
        value: "string",
        description: "why (required for supersedes and duplicates)",
      },
      { name: "remove", description: "remove the link instead of creating it" },
    ],
    help:
      `Types: ${LINK_TYPES.join(", ")}. The same contract as the \`myc_link\` MCP tool: same ` +
      "types, same required reason, same exit codes — the terminal and the tool are two doors " +
      "to one edge. `blocks`/`blocked-by` go through the dependency engine, so cycles and the " +
      "ready queue behave exactly as with `myc dep add`. `supersedes` also marks the old node " +
      "`superseded_by` and keeps it: a contradiction is recorded, not overwritten.",
    handler: async (ctx) => {
      const t0 = performance.now();
      const [fromInput, type, toInput] = ctx.args;
      if (fromInput === undefined || type === undefined || toInput === undefined) {
        return failure(
          "usage.invalid",
          "нужно: myc link <from> <type> <to>",
          ExitCode.USAGE,
          `тип — один из: ${LINK_TYPES.join(", ")}`,
        );
      }
      if (!(LINK_TYPES as readonly string[]).includes(type)) {
        return failure(
          "usage.invalid",
          `неверный type '${type}'; допустимы ${LINK_TYPES.join(", ")}`,
          ExitCode.USAGE,
        );
      }
      const reasonRaw = ctx.flags["reason"];
      const reason = typeof reasonRaw === "string" ? reasonRaw : undefined;
      if (REASON_REQUIRED.has(type) && reason === undefined) {
        return failure(
          "usage.missing",
          `для ${type} обязателен reason — история не переписывается`,
          ExitCode.USAGE,
        );
      }
      const remove = ctx.flags["remove"] === true;

      if (type === "blocks" || type === "blocked-by") {
        return viaDep(deps, ctx, type, remove, t0);
      }

      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const fromNode = resolveId(h, fromInput);
        if (!fromNode.ok) return fromNode.failure;
        const toNode = resolveId(h, toInput);
        if (!toNode.ok) return toNode.failure;
        const kind = LINK_EDGE_KINDS[type as keyof typeof LINK_EDGE_KINDS];
        const src = fromNode.node.id;
        const dst = toNode.node.id;

        const effects: string[] = [];
        if (remove) {
          if (!h.store.removeEdge(src, kind, dst)) {
            return failure("notfound.edge", `ребра ${src} ${type} ${dst} нет`, ExitCode.NOTFOUND);
          }
        } else {
          const existing = h.store.getEdge(src, kind, dst);
          // Удалённое ребро остаётся надгробием OR-Set — это не «уже есть».
          if (existing !== undefined && existing.deleted_at === null) {
            return failure(
              "conflict.edge_exists",
              `ребро ${src} ${type} ${dst} уже есть`,
              ExitCode.CONFLICT,
            );
          }
          try {
            h.store.addEdge(src, kind, dst, {
              ...(reason !== undefined ? { attrs: { reason } } : {}),
            });
          } catch (e) {
            return graphFailure(e);
          }
          if (type === "supersedes") {
            h.store.updateNode(dst, { attrs: { superseded_by: src } });
            effects.push(`${dst} помечен superseded_by ${src}; старый узел сохранён`);
          }
          if (reason !== undefined) effects.push(`reason: ${reason}`);
        }

        const data: LinkData = {
          from: src,
          type,
          to: dst,
          ...(remove ? { removed: true } : {}),
          effects,
          took_ms: Math.round(performance.now() - t0),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms } };
      } finally {
        h.close();
      }
    },
    renderHuman: renderLinkHuman,
  };
}
