/**
 * Контракт `--hook-output json`: stdout принадлежит ХОСТУ ЦЕЛИКОМ.
 *
 * Claude Code разбирает stdout хука как один JSON-документ. Всё, что мы
 * допишем следующей строкой, ломает разбор — и пакет не доходит вовсе. То
 * есть громкая деградация превращается в ПОЛНУЮ потерю, а это ровно тот
 * исход, ради предотвращения которого И2 и написана (memory-mgkkdrbt27fb:
 * сообщено с живого проекта — `absorb-session --hook-output json` печатал
 * JSON, а за ним две строки `WARN`).
 *
 * Столкнулись два наших же правила, и разводятся они не выбором «кто важнее»,
 * а разделением каналов:
 *
 *   stdout — только документ для хоста;
 *   stderr — та же диагностика словами, для человека, который позвал хук
 *            руками (helper агента stderr не читает и не показывает);
 *   поле `warn` ВНУТРИ документа — деградация для машины.
 *
 * Поле называется `warn` и имеет форму `{code, msg}[]` не случайно: это ТО ЖЕ
 * поле, что у конверта `--json` (envelope.ts). Второго словаря деградации у
 * myc нет и заводить его здесь не за чем.
 *
 * Правило шире одной команды: любая команда с машинным stdout объявляет
 * `machineStdout` (registry.ts), и каркас уводит блок WARN в stderr сам —
 * см. index.ts. Забыть это в НОВОМ хуке нельзя незаметно: ошибка выглядит как
 * молчащий агент, а не как красная строка.
 */

import type { Diagnostics } from "../diagnostics.ts";
import type { CommandContext } from "../registry.ts";
import { flagStr } from "../commands/store.ts";

/** Один разбор `--hook-output` на всех: `machineStdout` и `renderHuman` обязаны
 *  отвечать одинаково, иначе stdout снова разъедется с тем, что его читает. */
export function isHookJson(ctx: CommandContext): boolean {
  return flagStr(ctx, "hook-output") === "json";
}

/** Событие хоста, в контекст которого просится пакет. */
export type HookEventName = "PreCompact" | "SessionStart";

/**
 * Документ для Claude Code: `hookSpecificOutput` — его контракт, `warn` — наш.
 * Незнакомые ключи верхнего уровня хост игнорирует, поэтому деградация едет
 * рядом с пакетом, а не вместо него.
 */
export function hookJson(
  event: HookEventName,
  packet: string,
  diags: Diagnostics,
): string {
  return `${JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: packet },
    warn: diags.items.map((d) => ({ code: d.code, msg: d.msg })),
  })}\n`;
}
