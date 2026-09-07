import type { Diagnostics } from "./diagnostics.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";

export function isIterable(value: unknown): value is Iterable<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === "function"
  );
}

function isPrimitive(value: unknown): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/** Ячейка таблицы / скаляр: компактно, без украшений. */
export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value) ?? "null";
}

/**
 * Плотная колоночная таблица: одна сущность — одна строка, ширина колонок
 * по факту содержимого, разделитель — два пробела, без рамок. Последняя
 * колонка не паддингуется — хвостовые пробелы суть потерянные токены.
 */
export function renderTable(
  header: readonly string[] | null,
  rows: readonly (readonly string[])[],
  color: boolean,
): string {
  const nCols = header?.length ?? rows[0]?.length ?? 0;
  if (nCols === 0) return "";
  const widths: number[] = [];
  for (let c = 0; c < nCols; c++) {
    widths[c] = Math.max(
      header?.[c]?.length ?? 0,
      ...rows.map((r) => r[c]?.length ?? 0),
    );
  }
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, c) => (c === nCols - 1 ? cell : cell.padEnd(widths[c]!)))
      .join("  ")
      .trimEnd();
  const out: string[] = [];
  if (header) {
    const text = line(header.map((h) => h.toUpperCase()));
    out.push(color ? `${BOLD}${text}${RESET}` : text);
  }
  for (const row of rows) out.push(line(row));
  return `${out.join("\n")}\n`;
}

function columnKeys(rows: readonly Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  return keys;
}

/**
 * Дефолтная отрисовка данных команды: скаляр — как есть; список примитивов —
 * по строке; список объектов — таблица; один объект — ключ/значение; Iterable
 * материализуется (таблице нужны ширины всех строк; стриминг — это --ndjson).
 */
export function renderDataHuman(data: unknown, color: boolean): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") {
    return data.endsWith("\n") ? data : `${data}\n`;
  }
  if (typeof data === "number" || typeof data === "boolean") {
    return `${String(data)}\n`;
  }
  const array = Array.isArray(data) ? data : isIterable(data) ? [...data] : null;
  if (array) {
    if (array.length === 0) return "";
    if (array.every(isPrimitive)) {
      return `${array.map((v) => renderValue(v)).join("\n")}\n`;
    }
    const objects = array as unknown[];
    const keys = columnKeys(objects as Record<string, unknown>[]);
    const rows = objects.map((row) =>
      keys.map((k) =>
        renderValue((row as Record<string, unknown>)[k] ?? ""),
      ),
    );
    return renderTable(keys, rows, color);
  }
  if (typeof data === "object") {
    const entries = Object.entries(data as Record<string, unknown>);
    const rows = entries.map(([k, v]) => [k, renderValue(v)]);
    return renderTable(null, rows, false);
  }
  return `${String(data)}\n`;
}

/** Деградация в человеческом выводе: одна строка WARN на источник. */
export function renderWarnLines(diags: Diagnostics, color: boolean): string {
  if (diags.size === 0) return "";
  const lines = diags.items.map((d) => {
    const text = `WARN ${d.code}: ${d.msg}`;
    return color ? `${YELLOW}${text}${RESET}` : text;
  });
  return `${lines.join("\n")}\n`;
}

/** Ошибка в человеческом выводе: плотно, на stderr. */
export function renderErrorHuman(
  error: { code: string; msg: string; hint?: string },
  diags: Diagnostics,
  color: boolean,
): string {
  const head = `myc: ${error.code}: ${error.msg}`;
  const lines = [color ? `${RED}${head}${RESET}` : head];
  if (error.hint) lines.push(`  hint: ${error.hint}`);
  return `${lines.join("\n")}\n${renderWarnLines(diags, color)}`;
}

/**
 * Русское склонение при числе: «1 узел», «2 узла», «10 узлов». Нужно там,
 * где строку читает человек в неудачный момент, — «1 узлов» в сообщении об
 * отказе стереть память выглядит как машинный сбой, а не как ответ.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
