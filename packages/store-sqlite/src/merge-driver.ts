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
 * Эта предпосылка держится на уникальности op_id, а уникальность op_id —
 * на том, что под одним `site_id` пишет одна база. Копия каталога
 * воркспейса (`cp -R`) ломает ровно это: обе копии продолжают нумеровать с
 * того же `seq`, и два РАЗНЫХ набора строк приезжают под одними op_id.
 * Раньше драйвер такую пару молча дедуплицировал и рапортовал «+0 строк» —
 * операции исчезали внутри успешного `git merge`. Теперь предпосылка
 * ПРОВЕРЯЕТСЯ: совпадение op_id при разном содержимом — конфликт (S65).
 *
 * Код выхода 0 — «конфликтов нет». Ненулевой в двух случаях, и оба про
 * одно: молча выбросить строку значило бы потерять операцию (И2).
 *   - файл не разбирается как оплог (`reason: "parse"`). Это же покрывает
 *     случай, когда драйвер по ошибке навесили на другой файл: он не
 *     притворится, что слил его;
 *   - один op_id с разным содержимым (`reason: "collision"`).
 * В обоих случаях `%A` НЕ переписывается: git оставляет конфликт человеку,
 * а обе версии файла остаются целы в индексе (`:2:` и `:3:`).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { OplogCollisionError, splitLines, unionOplogText } from "./export.ts";

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
    return "three paths required: %O %A %B (then optional %L %P)";
  }
  let path: string | undefined;
  for (const arg of rest) {
    if (/^\d+$/.test(arg)) continue; // %L
    path = arg;
  }
  return path === undefined ? { base, ours, theirs } : { base, ours, theirs, path };
}

/** Почему драйвер вернул ненулевой код: строка не разобралась или op_id столкнулись. */
export type MergeRefusal = "parse" | "collision";

export interface MergeDriverRun {
  readonly code: number;
  readonly outcome?: MergeOutcome;
  readonly message: string;
  /** только при `code !== 0` */
  readonly reason?: MergeRefusal;
  /** только при `reason === "collision"` */
  readonly opId?: string;
}

/**
 * Выполнить слияние на файлах: результат пишется в `ours` (%A), как того
 * требует git. Возвращает код выхода и строку для stdout.
 */
export function runMergeDriver(args: MergeDriverArgs): MergeDriverRun {
  const ours = readFileSync(args.ours, "utf8");
  const theirs = readFileSync(args.theirs, "utf8");
  const label = args.path ?? args.ours;
  let outcome: MergeOutcome;
  try {
    outcome = mergeOplogText(ours, theirs);
  } catch (error) {
    if (error instanceof OplogCollisionError) {
      return {
        code: 1,
        reason: "collision",
        opId: error.opId,
        message:
          `myc merge-driver: ${label} — op_id COLLISION ${error.opId}: ` +
          "the same operation arrived from both sides with different content. " +
          "A union by op_id would silently drop one of them, so the file " +
          "is not merged and the conflict is left to a human.\n" +
          `  ours:   ${error.kept}\n` +
          `  theirs: ${error.dropped}\n` +
          "  The cause is almost always the same: a copy of the workspace directory (cp -R, rsync, " +
          "an unpacked backup) carried off the live database's site_id, and both databases number " +
          "operations from the same seq (S65). An honest `git clone` does not break this way. " +
          "Resolve it by hand: both versions of the file are intact in the index — " +
          `\`git show :2:${label}\` (ours) and \`git show :3:${label}\` (theirs).`,
      };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      reason: "parse",
      message: `myc merge-driver: oplog file ${label} does not parse, conflict left in place: ${msg}`,
    };
  }
  if (outcome.text !== ours) writeFileSync(args.ours, outcome.text);
  const message =
    `myc merge-driver: ${label} — union by op_id, ` +
    `+${outcome.added} ${outcome.added === 1 ? "line" : "lines"}, ${outcome.lines} total`;
  return { code: 0, outcome, message };
}
