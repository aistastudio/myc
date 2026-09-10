/**
 * Передача ввода строки статуса ЧУЖОЙ команде — той, что стояла до нас.
 *
 * ЗАЧЕМ. Проектная `statusLine` перекрывает пользовательскую. У заказчика
 * пользовательская строка — orca: она ничего не печатает, а шлёт ввод строки
 * POST'ом в orca (контекст, стоимость, длительность для её интерфейса).
 * Поставленная без передачи, наша строка молча отрезала бы orca от данных
 * сессии. Поэтому каждый вызов `myc statusline` отдаёт чужой команде ТЕ ЖЕ
 * байты stdin.
 *
 * НЕ ЖДЁМ ВОВСЕ — ПОКАЗЫВАЕМ ПРОШЛЫЙ ЗАВЕРШЁННЫЙ ЗАПУСК. Первая версия ждала
 * чужую до 100 мс, и у orca это было худшим случаем, а не редким: раз в ~15 с
 * она шлёт POST (curl до 1,5 с), ничего при этом не печатая, и отрисовка
 * стоила 125–135 мс ради пустоты. Теперь итог каждого запуска чужой команды —
 * код и вывод — фоновая обёртка кладёт в файл результата, а отрисовка берёт
 * последний ЗАВЕРШЁННЫЙ: успела текущая за время нашей работы — её, нет —
 * предыдущую. Вывод чужой отстаёт не больше чем на одну отрисовку, наша строка
 * от времени чужой не зависит вовсе, а молчащей чужой это не стоит ничего.
 * «Ждать по опыту только печатающую» отвергнуто: печатающая медленная снова
 * вывела бы отрисовку из бюджета, а медленная-иногда (как orca) обучала бы
 * ожидание на удачных запусках. Ожидание осталось флагом `--wait-ms` — тем,
 * кому свежесть важнее бюджета, и тестам.
 *
 * ПОЧЕМУ ДВОЙНОЙ FORK, А НЕ ПРОСТО `detached`. Claude Code (2.1.267, `AS`)
 * отменяет строку не сигналом группе, а обходом ВСЕГО дерева потомков по
 * `ps -A -o pid=,ppid=` — SIGTERM каждому найденному. Отсоединённый ребёнок
 * (setsid) из группы уходит, но потомком по ppid остаётся, пока жив наш
 * процесс, и отмена отрисовки убила бы POST orca на полпути. Поэтому:
 *
 *   myc ─spawn(detached)→ dash -c '( … ) &'   ← выходит сразу
 *                             └─ ( … )          ← сирота: ppid 1, своя сессия
 *                                  └─ /bin/sh -c "<чужая команда>"
 *
 * Внешняя оболочка запускает асинхронный список и завершается за миллисекунду;
 * список остаётся без родителя (его подбирает launchd/init) и в своей сессии —
 * ни обход дерева, ни `kill(-pid)` нашей группы его не находят. Чужой процесс
 * пишет не в наш пайп, а в подстановку `$(…)`, которую список читает до
 * конца, — SIGPIPE ему не грозит, даже если мы давно вышли.
 *
 * STDIN — ФАЙЛОМ, А НЕ ПАЙПОМ. Пайп живёт, пока мы пишем; уйди мы раньше, чем
 * чужая прочитала всё, — она получила бы обрезок. Файл открывает внешняя
 * оболочка до fork'а (`exec 3<`), список удаляет его, когда чужая отработала:
 * байты те же при любом размере и при любом порядке выхода, без предположений
 * о кодировке.
 *
 * Только POSIX. На Windows строку статуса Claude Code гонит через Git Bash, и
 * этот путь не проверен — `wire` там строку поверх чужой не ставит вовсе.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { NESTED_ENV } from "./statusline-config.ts";

/**
 * Сколько ждать чужую по умолчанию: НОЛЬ (см. шапку). `--wait-ms N` ждёт
 * текущий запуск до N мс и, не дождавшись, всё равно берёт прошлый.
 */
export const PASS_WINDOW_MS = 0;

/**
 * Скрипт внешней оболочки. `$1` — чужая команда (как её дал бы `sh -c` сам
 * Claude Code), `$2` — файл с байтами stdin, `$3` — файл результата. Файл
 * stdin открывается ДО fork'а (`exec 3<`), асинхронный список берёт его как
 * stdin явно (`0<&3` — у списка stdin из /dev/null по POSIX). Итог пишется в
 * «линию жизни» (наш пайп, если мы слушаем, иначе /dev/null), линия
 * закрывается — и только потом файл результата: tmp + mv, чтобы отрисовка не
 * прочитала половину.
 */
const WRAPPER =
  'exec 3<"$2" || exit 1; ( exec 0<&3 3<&-; out=$(/bin/sh -c "$1" 2>/dev/null); rc=$?; ' +
  "printf '%s\\n%s' \"$rc\" \"$out\"; exec 1>&-; rm -f \"$2\"; " +
  "printf '%s\\n%s' \"$rc\" \"$out\" > \"$3.$$\" && mv -f \"$3.$$\" \"$3\" ) &";

/**
 * Оболочка для самой ОБЁРТКИ (не для чужой команды — та всегда идёт через
 * `/bin/sh -c`, как у хоста). Скрипт обёртки — чистый POSIX, и dash поднимается
 * вдвое быстрее bash, которым на macOS является /bin/sh: замер на этой машине —
 * обёртка вокруг `sh -c cat` 4,99 мс против 6,93 мс p50. Нет dash — /bin/sh.
 */
const WRAPPER_SHELL = existsSync("/bin/dash") ? "/bin/dash" : "/bin/sh";

/** Итог одного завершённого запуска чужой команды. */
export interface ForeignResult {
  readonly rc: number | null;
  readonly output: string;
  /** Когда он записан (mtime файла результата), мс эпохи; 0 — из линии. */
  readonly at: number;
}

export interface PassOutcome {
  /** Обёртку удалось запустить. */
  readonly started: boolean;
  /** Текущий запуск завершился, пока мы его ждали (только при `--wait-ms`). */
  readonly finished: boolean;
  /** Итог текущего запуска, если дождались. */
  readonly current: ForeignResult | null;
  /** Сколько ждали, мс. Без `--wait-ms` — только время запуска обёртки. */
  readonly waitedMs: number;
  /** Когда запустили, мс эпохи: результат новее — он от ЭТОЙ отрисовки. */
  readonly startedAt: number;
  readonly error?: string;
}

export interface PassOptions {
  readonly command: string;
  readonly payload: Uint8Array;
  readonly windowMs: number;
  readonly env: NodeJS.ProcessEnv;
  /** Каталог для файла stdin (его удаляет обёртка, когда чужая отработала). */
  readonly tmpDir: string;
  /** Куда обёртка положит итог запуска — его прочитает следующая отрисовка. */
  readonly resultFile: string;
  readonly platform?: NodeJS.Platform;
}

let seq = 0;

function parseResult(text: string, at: number): ForeignResult {
  const nl = text.indexOf("\n");
  const rcRaw = nl === -1 ? text : text.slice(0, nl);
  return { rc: /^\d+$/.test(rcRaw) ? Number(rcRaw) : null, output: nl === -1 ? "" : text.slice(nl + 1), at };
}

/** Последний завершённый запуск чужой команды или null, если его ещё не было. */
export function readForeignResult(resultFile: string): ForeignResult | null {
  try {
    const at = statSync(resultFile).mtimeMs;
    return parseResult(readFileSync(resultFile, "utf8"), at);
  } catch {
    return null;
  }
}

/**
 * Запустить чужую команду, отсоединив её от себя. Без окна — вернуться сразу
 * после запуска обёртки; с окном — ждать итог текущего запуска не дольше
 * него. Никогда не бросает и никогда не убивает чужую: падение чужой — не
 * падение нашей строки, POST orca обязан дойти.
 */
export async function runPassthrough(opts: PassOptions): Promise<PassOutcome> {
  const t0 = performance.now();
  const startedAt = Date.now();
  const waited = (): number => Math.round((performance.now() - t0) * 10) / 10;
  const fail = (error: string): PassOutcome => ({
    started: false,
    finished: false,
    current: null,
    waitedMs: waited(),
    startedAt,
    error,
  });
  if ((opts.platform ?? process.platform) === "win32") return fail("win32");

  let inFile: string;
  try {
    mkdirSync(opts.tmpDir, { recursive: true });
    inFile = join(opts.tmpDir, `pass-${process.pid}-${Date.now()}-${seq++}.in`);
    const fd = openSync(inFile, "w", 0o600);
    try {
      let off = 0;
      while (off < opts.payload.length) off += writeSync(fd, opts.payload, off);
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return fail(errText(e));
  }

  const listen = opts.windowMs > 0;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [WRAPPER_SHELL, "-c", WRAPPER, "myc-statusline-pass", opts.command, inFile, opts.resultFile],
      {
        stdin: "ignore",
        stdout: listen ? "pipe" : "ignore",
        stderr: "ignore",
        detached: true,
        env: { ...opts.env, [NESTED_ENV]: "1" },
      },
    );
  } catch (e) {
    rmSync(inFile, { force: true });
    return fail(errText(e));
  }

  if (!listen) {
    proc.unref();
    return { started: true, finished: false, current: null, waitedMs: waited(), startedAt };
  }

  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), opts.windowMs);
  });
  try {
    for (;;) {
      const r = await Promise.race([reader.read(), timeout]);
      if (r === "timeout") break;
      if (r.done) {
        finished = true;
        break;
      }
      chunks.push(r.value);
    }
  } catch {
    // Линия оборвалась — чужая умерла вместе с обёрткой; ждать нечего.
    finished = true;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Не дождались — перестаём слушать и отпускаем. Не kill.
    if (!finished) reader.cancel().catch(() => {});
    proc.unref();
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return {
    started: true,
    finished,
    current: finished && text.length > 0 ? parseResult(text, 0) : null,
    waitedMs: waited(),
    startedAt,
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
