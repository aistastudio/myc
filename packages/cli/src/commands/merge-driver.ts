/**
 * `myc merge-driver %O %A %B %L %P` — единственный драйвер слияния git для
 * `.myc/graph/` (решение S42). Файлы оплога объединяются по op_id; ничего
 * другого из графа в git не идёт. Базы данных не открывает: работа чисто
 * над тремя файлами, код выхода 0 — «конфликтов нет».
 *
 * Регистрация (один раз на клон):
 *   git config merge.myc-oplog.driver "myc merge-driver %O %A %B %L %P"
 * Атрибуты в .myc/graph/.gitattributes пишет `myc export`.
 *
 * Ненулевой код — всегда «слить нельзя, разбирайтесь руками»: либо строка не
 * разбирается как оплог, либо один op_id пришёл с двух сторон с разным
 * содержимым (S65). Второе значит, что под одним site_id пишут две живые
 * базы; тихая дедупликация тут стоила бы операции.
 */

import { existsSync } from "node:fs";
import { parseMergeDriverArgs, runMergeDriver, type MergeDriverRun } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import type { Command, CommandFailure } from "../registry.ts";
import { GIT_SETUP_HINT } from "./export.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

interface MergeDriverData {
  path: string;
  lines: number;
  added: number;
  message: string;
}

const COLLISION_HINT =
  "две живые базы под одним site_id — обычно копия каталога воркспейса (cp -R/rsync), " +
  "а не клон; см. S65 в docs/design/ARCHITECTURE.md";

export function createMergeDriverCommand(): Command {
  return {
    name: "merge-driver",
    summary: "git merge driver for .myc/graph oplog files: union by op_id",
    help:
      "Arguments as git passes them: %O (base) %A (ours, rewritten in place) %B (theirs) " +
      "[%L marker size] [%P path]. Exit 4 (conflict) when a line does not parse or when one " +
      "op_id arrives from both sides with different content — the latter means two live " +
      "databases share a site_id (S65). Register once per clone:\n  " +
      GIT_SETUP_HINT,
    handler: (ctx) => {
      const parsed = parseMergeDriverArgs(ctx.args);
      if (typeof parsed === "string") {
        return failure("usage.args", parsed, ExitCode.USAGE, "myc merge-driver %O %A %B %L %P");
      }
      for (const p of [parsed.ours, parsed.theirs]) {
        if (!existsSync(p)) {
          return failure("notfound.file", `файл не найден: ${p}`, ExitCode.NOTFOUND);
        }
      }
      let run: MergeDriverRun;
      try {
        run = runMergeDriver(parsed);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return failure("precond.merge_io", msg, ExitCode.PRECOND);
      }
      if (run.code !== 0 || run.outcome === undefined) {
        // Конфликт остаётся человеку (И2) — по одной из двух причин, и они
        // разные для того, кто читает вывод: нечитаемая строка означает
        // испорченный (или чужой) файл, коллизия op_id — что где-то есть
        // вторая живая база с тем же site_id, и чинить надо её.
        if (run.reason === "collision") {
          return failure("conflict.op_id", run.message, ExitCode.CONFLICT, COLLISION_HINT);
        }
        return failure("conflict.oplog_line", run.message, ExitCode.CONFLICT);
      }
      const data: MergeDriverData = {
        path: parsed.path ?? parsed.ours,
        lines: run.outcome.lines,
        added: run.outcome.added,
        message: run.message,
      };
      return { ok: true, data };
    },
    renderHuman: (raw) => `${(raw as MergeDriverData).message}\n`,
  };
}
