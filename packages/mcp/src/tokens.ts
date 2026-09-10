/**
 * Бюджет описаний MCP-тулов (решение: docs/design/03 §4.1).
 * Инструменты работы профиля agent обязаны укладываться в 1100 токенов
 * суммарных описаний, инструменты кода — в свой потолок ниже; это налог,
 * который агент платит в каждой сессии за tools/list.
 *
 * Токенизатора в зависимостях нет, поэтому оценка консервативная:
 * ceil(chars / 3). Для русского текста в o200k/cl100k реальная цена
 * ~2.5–4 символа на токен, для английских идентификаторов схем — дороже;
 * chars/3 завышает оценку в обе стороны не даёт — недосчитать нельзя,
 * лучше сломать сборку раньше, чем раздуть промпт агента.
 */

/** Инструменты работы с памятью и задачами (WORK_TOOLS) — прежние 1100. */
export const DESCRIPTION_TOKEN_BUDGET = 1100;

/**
 * Инструменты кода (CODE_TOOLS) — отдельной строкой, а не прибавкой к 1100.
 *
 * D7 пускает новый тул в профиль «вместе с удалением другого или письменным
 * обоснованием». Обоснование — число, а не довод. Инструменты кода входят в
 * профиль ВМЕСТО graft: пока он стоит в .mcp.json, агент платит за его шесть
 * тулов в каждой сессии. Замер 2026-09-10, graft 0.16.0, `tools/list` тем же
 * оценщиком, что ниже: 2180 символов описаний = 727 токенов. Потолок наших —
 * ровно столько: снятие graft не имеет права сделать сессию дороже, чем она
 * была с ним.
 *
 * Отдельная строка, а не общий потолок профиля, чтобы ни одна половина не
 * разрасталась за счёт другой: запас, оставленный кодом, не становится
 * разрешением раздуть myc_update.
 */
export const GRAFT_TOOLS_TOKENS = 727;
export const CODE_DESCRIPTION_TOKEN_BUDGET = GRAFT_TOOLS_TOKENS;

/** Весь профиль agent: сумма двух потолков выше. */
export const AGENT_PROFILE_TOKEN_BUDGET = DESCRIPTION_TOKEN_BUDGET + CODE_DESCRIPTION_TOKEN_BUDGET;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

/** Все строки description в схеме (рекурсивно), плюс имя и описание тула. */
export function toolDescriptionChars(tool: {
  name: string;
  description: string;
  inputSchema: unknown;
}): number {
  let chars = tool.name.length + tool.description.length;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node === "object" && node !== null) {
      for (const [key, value] of Object.entries(node)) {
        if (key === "description" && typeof value === "string") chars += value.length;
        else walk(value);
      }
    }
  };
  walk(tool.inputSchema);
  return chars;
}

export function profileDescriptionTokens(
  tools: readonly { name: string; description: string; inputSchema: unknown }[],
): number {
  const chars = tools.reduce((sum, tool) => sum + toolDescriptionChars(tool), 0);
  return estimateTokens(" ".repeat(chars));
}
