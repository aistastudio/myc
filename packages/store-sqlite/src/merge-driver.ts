/**
 * Драйвер слияния git для `.myc/graph/` (решение S42). Он ОДИН и знает
 * только оплог: в git ничего другого из графа не идёт.
 *
 * Оплог: объединение «наших» и «их» строк по op_id, сортировка по seq.
 * Текстового мержа нет — строки неизменяемы, а порядок внутри файла
 * задан seq, поэтому у двух версий файла нет ни одной причины разойтись,
 * кроме разного набора строк. Базовая версия (%O) не нужна: лог только
 * растёт, и всё, что было в базе, есть в обеих сторонах.
 *
 * Код выхода 0 — «конфликтов нет». Ненулевой только когда файл не
 * разбирается как оплог: молча выбросить строку значило бы потерять
 * операцию (И2), поэтому такой мерж остаётся конфликтом и требует человека.
 * Это же покрывает случай, когда драйвер по ошибке навесили на другой
 * файл: он не притворится, что слил его.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { splitLines, unionOplogText } from "./export.ts";

export interface MergeOutcome {
  /** строк в результате */
  readonly lines: number;
  /** строк, пришедших со стороны `theirs` */
  readonly added: number;
  readonly text: string;
}

/**
 * Слить содержимое файла оплога. `base` принимается для симметрии с
 * протоколом git и намеренно не используется — см. шапку.
 */
export function mergeOplogText(ours: string, theirs: string, _base?: string): MergeOutcome {
  const { text, added } = unionOplogText(ours, theirs);
  return { lines: splitLines(text).length, added, text };
}

export interface MergeDriverArgs {
  readonly base: string;
  readonly ours: string;
  readonly theirs: string;
  /** %P — путь файла в дереве; только для сообщений */
  readonly path?: string;
}

/**
 * Разбор argv в форме `%O %A %B [%L] [%P]`: %L (размер маркера) — число,
 * которое git подставляет по конвенции; нам он не нужен, но позицию занимает.
 */
export function parseMergeDriverArgs(argv: readonly string[]): MergeDriverArgs | string {
  const [base, ours, theirs, ...rest] = argv;
  if (base === undefined || ours === undefined || theirs === undefined) {
    return "нужны три пути: %O %A %B (затем необязательные %L %P)";
  }
  let path: string | undefined;
  for (const arg of rest) {
    if (/^\d+$/.test(arg)) continue; // %L
    path = arg;
  }
  return path === undefined ? { base, ours, theirs } : { base, ours, theirs, path };
}

export interface MergeDriverRun {
  readonly code: number;
  readonly outcome?: MergeOutcome;
  readonly message: string;
}

/**
 * Выполнить слияние на файлах: результат пишется в `ours` (%A), как того
 * требует git. Возвращает код выхода и строку для stdout.
 */
export function runMergeDriver(args: MergeDriverArgs): MergeDriverRun {
  const ours = readFileSync(args.ours, "utf8");
  const theirs = readFileSync(args.theirs, "utf8");
  let outcome: MergeOutcome;
  try {
    outcome = mergeOplogText(ours, theirs);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      message: `myc merge-driver: файл оплога ${args.path ?? args.ours} не разбирается, конфликт оставлен: ${msg}`,
    };
  }
  if (outcome.text !== ours) writeFileSync(args.ours, outcome.text);
  const label = args.path ?? args.ours;
  const message = `myc merge-driver: ${label} — объединение по op_id, +${outcome.added} строк, всего ${outcome.lines}`;
  return { code: 0, outcome, message };
}
