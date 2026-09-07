/**
 * Бюджет описаний MCP-тулов (решение: docs/design/03 §4.1).
 * Профиль agent обязан укладываться в 1100 токенов суммарных описаний —
 * это налог, который агент платит в каждой сессии за tools/list.
 *
 * Токенизатора в зависимостях нет, поэтому оценка консервативная:
 * ceil(chars / 3). Для русского текста в o200k/cl100k реальная цена
 * ~2.5–4 символа на токен, для английских идентификаторов схем — дороже;
 * chars/3 завышает оценку в обе стороны не даёт — недосчитать нельзя,
 * лучше сломать сборку раньше, чем раздуть промпт агента.
 */

export const DESCRIPTION_TOKEN_BUDGET = 1100;

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
