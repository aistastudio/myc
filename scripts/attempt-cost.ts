/**
 * Какая сессия работала над задачей и во что она обошлась.
 *
 * Связь «задача → сессия» даёт сам бриф: он начинается строкой
 * `Задача myc: <id>`, и она попадает в первое сообщение сессии. Сессия
 * координатора содержит ту же строку (он бриф писал), поэтому исключается
 * по своему uuid — его передают в --self.
 *
 * Разбор живёт не здесь, а в packages/swarm/src/transcript.ts (импорт по
 * пути: @myc/swarm в корневые node_modules не слинкован):
 * это тот же код, которым `myc attempt finish --from-transcript` заполняет
 * расход, вместе со всеми его отказами. Скрипт — только поиск сессии и
 * готовая строка команды.
 *
 * Использование:
 *   bun run scripts/attempt-cost.ts <task-id> [--self <uuid>] [-C <dir>]
 */

import { resolve } from "node:path";
import {
  findTaskTranscripts,
  readTranscriptUsage,
  transcriptDir,
  TranscriptError,
} from "../packages/swarm/src/transcript.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const taskId = process.argv[2];
  if (taskId === undefined || taskId.startsWith("-")) {
    process.stderr.write(
      "нужен id задачи: bun run scripts/attempt-cost.ts <task-id> [--self <uuid>] [-C <dir>]\n",
    );
    process.exit(2);
  }
  const dir = transcriptDir(resolve(flag("C") ?? process.cwd()));
  let files: string[];
  try {
    files = findTaskTranscripts(dir, taskId, { exclude: flag("self") });
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(3);
  }
  if (files.length === 0) {
    process.stderr.write(`сессий для ${taskId} не найдено в ${dir}\n`);
    process.exit(3);
  }
  let failed = false;
  for (const file of files) {
    let c;
    try {
      c = readTranscriptUsage(file);
    } catch (e) {
      // Отказ разбора печатается как отказ: ноль здесь неотличим от
      // «не смогли прочитать», и молча он бы обнулил ось цены.
      failed = true;
      const code = e instanceof TranscriptError ? e.code : "error";
      process.stdout.write(`${file.split("/").pop()}  ОТКАЗ ${code}: ${(e as Error).message}\n`);
      continue;
    }
    process.stdout.write(
      `${c.sessionId}  ${c.startedAt?.slice(11, 19)}–${c.endedAt?.slice(11, 19)}  ` +
        `ответов ${c.responses} (записей ${c.usageRecords})  ` +
        `in ${c.tokensIn}  out ${c.tokensOut}  кеш ${c.tokensCacheRead}/${c.tokensCacheWrite}\n` +
        `  myc attempt finish --task ${taskId} --verdict <accepted|rework|rejected>` +
        ` --from-session ${c.sessionId}\n`,
    );
  }
  process.exit(failed ? 1 : 0);
}
