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
    return "нужны три пути: %O %A %B (затем необязательные %L %P)";
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
          `myc merge-driver: ${label} — КОЛЛИЗИЯ op_id ${error.opId}: ` +
          "с двух сторон пришла одна и та же операция с разным содержимым. " +
          "Объединение по op_id выбросило бы одну из них молча, поэтому файл " +
          "не слит и конфликт оставлен человеку.\n" +
          `  наша:  ${error.kept}\n` +
          `  их:    ${error.dropped}\n` +
          "  Причина почти всегда одна: копия каталога воркспейса (cp -R, rsync, " +
          "распакованный бэкап) унесла site_id живой базы, и обе базы нумеруют " +
          "операции с одного seq (S65). Честный `git clone` так не ломается. " +
          "Разберите вручную: обе версии файла целы в индексе — " +
          `\`git show :2:${label}\` (наша) и \`git show :3:${label}\` (их).`,
      };
    }
    const msg = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      reason: "parse",
      message: `myc merge-driver: файл оплога ${label} не разбирается, конфликт оставлен: ${msg}`,
    };
  }
  if (outcome.text !== ours) writeFileSync(args.ours, outcome.text);
  const message = `myc merge-driver: ${label} — объединение по op_id, +${outcome.added} строк, всего ${outcome.lines}`;
  return { code: 0, outcome, message };
}
