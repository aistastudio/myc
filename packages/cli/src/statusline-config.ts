/**
 * Строка статуса Claude Code: общее для `myc wire --status-line` (ставит) и
 * `myc statusline` (исполняет). Одно место на три вещи, которые обязаны
 * совпадать у обеих сторон: как узнать СВОЮ строку, как собрать её команду и
 * где лежит пользовательская строка, которой мы передаём ввод.
 *
 * ЧТО ВЫЯСНЕНО ЧТЕНИЕМ БИНАРЯ Claude Code 2.1.267, а не документации:
 *
 *   - Строку исполняет `i9t` → `xbe`: `sh -c <command>`, `detached: true`
 *     (своя группа процессов), stdin — `JSON.stringify(ввод) + "\n"`, в env —
 *     `CLAUDE_PROJECT_DIR`. Таймаут 600 000 мс, если у statusLine нет своего.
 *   - Вывод показывается ТОЛЬКО при коде 0: `stdout.trim()`, строки по `\n`,
 *     пустые выброшены. Ненулевой код — пустая строка статуса.
 *   - Новая отрисовка ОТМЕНЯЕТ незавершённую прежнюю (дебаунс 300 мс), и
 *     отмена убивает не группу, а ВСЁ ДЕРЕВО: `ps -A -o pid=,ppid=`, обход
 *     потомков, SIGTERM каждому (`AS` → `g`). Отсюда устройство передачи
 *     чужой строке в statusline-passthrough.ts.
 *   - Слои настроек в порядке старшинства: user < project < local < flag <
 *     policy. Проектная statusLine перекрывает пользовательскую, а
 *     `.claude/settings.local.json` перекрывает проектную.
 *   - Пользовательский слой — `${CLAUDE_CONFIG_DIR ?? ~/.claude}/settings.json`.
 *
 * ЧТО ВЫЯСНЕНО ЧТЕНИЕМ КОДА orca (Orca.app, 2026-09-09,
 * `out/main/chunks/managed-agent-hook-controls-*.js` и
 * `managed-home-shell-preflight-*.js`) — для строки пользовательского слоя
 * (`myc wire --scope user --status-line`, memory-6x0ag4p493pc):
 *
 *   - Своей orca считает строку по матчеру `C("claude-statusline.sh")` (экспорт
 *     `dt`): команда (плюс раскодированный `-EncodedCommand`, `\` → `/`)
 *     СОДЕРЖИТ `agent-hooks/claude-statusline.{sh,cmd,ps1}`.
 *   - `$t(config)` классифицирует: `managed` (матчер сработал), `user` (чужая
 *     команда), `empty` (команды нет).
 *   - Установка `installManagedStatusLine` → `tn`: при `user` конфиг НЕ меняет;
 *     при `empty` с меткой `~/.orca/agent-hooks/claude-statusline.installed`
 *     тоже не меняет (однажды поставленную и снятую не возвращает).
 *   - Снятие `remove` → `nn`: удаляет statusLine ТОЛЬКО если она `managed`.
 * Отсюда правило: команда нашей строки НЕ содержит `claude-statusline` — иначе
 * orca сочтёт её своей и при снятии удалит. Прежнюю строку orca мы не вшиваем
 * в нашу команду (`--then`), а берём из журнала пользовательского слоя.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Подкоманда, которую ставит wire и по которой строку узнают как свою. */
export const STATUSLINE_COMMAND = "statusline";

/** Флаг, через который строке передаётся ПРОЕКТНАЯ чужая команда. */
export const THEN_FLAG = "--then";

/**
 * Предохранитель от рекурсии, живущий в процессах, а не в конфиге: чужая
 * команда запускается с этой переменной, и `myc statusline`, увидев её,
 * никому ничего не передаёт. Нужен сверх распознавания по тексту команды:
 * пользовательская строка может звать `myc statusline` через свой скрипт, и
 * тогда текст её команды ничего о myc не говорит.
 */
export const NESTED_ENV = "MYC_STATUSLINE_NESTED";

/**
 * Своя ли это команда строки. Узнаём по вызову `myc statusline` в командной
 * позиции: имя бинаря `myc` (с путём, в кавычках, с .exe) и сразу за ним
 * подкоманда. `claude-statusline.sh` orca сюда не попадает: там нет `myc`
 * перед словом, а `mycroft statusline` отсекает граница имени.
 */
const OUR_COMMAND_RE = /(?:^|[\s/"'])myc(?:\.exe|\.cmd|\.bat)?["']?\s+statusline(?:\s|$)/;

export function isOurStatusLineCommand(command: string): boolean {
  return OUR_COMMAND_RE.test(command);
}

/** Своя ли это запись `statusLine` (объект из settings.json). */
export function isOurStatusLine(value: unknown): boolean {
  const cmd = statusLineCommand(value);
  return cmd !== null && isOurStatusLineCommand(cmd);
}

/**
 * Команда записи `statusLine`, если это запись с командой. Claude Code
 * исполняет только `type: "command"` — остальное ему (и нам) нечем запускать.
 */
export function statusLineCommand(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rec = value as Record<string, unknown>;
  if (rec["type"] !== "command") return null;
  const cmd = rec["command"];
  return typeof cmd === "string" && cmd.trim().length > 0 ? cmd : null;
}

/** POSIX-кавычки: строка целиком в одинарных, одинарная — как '\''. */
export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Команда нашей строки. Бинарь из репозитория пишется от
 * `${CLAUDE_PROJECT_DIR:-.}` — тем же приёмом, что и хуки: строку Claude Code
 * запускает с этой переменной, и относительный `./dist/myc` не зависит от
 * каталога, в котором её позвали. Проектная чужая команда (если была)
 * приезжает аргументом `--then` — дословно, в кавычках.
 */
export function ourStatusLineCommand(
  bin: { readonly command: string; readonly source: string },
  thenCommand?: string,
): string {
  let head: string;
  if (bin.source === "repo") {
    const rel = bin.command.replace(/^\.\//, "");
    head = `"\${CLAUDE_PROJECT_DIR:-.}/${rel}"`;
  } else {
    head = shellQuote(bin.command);
  }
  const tail = thenCommand !== undefined ? ` ${THEN_FLAG} ${shellQuote(thenCommand)}` : "";
  return `${head} ${STATUSLINE_COMMAND}${tail}`;
}

/** Флаг строки пользовательского слоя: `myc statusline --scope user`. */
export const USER_SCOPE_FLAG = "--scope";

/**
 * Команда строки пользовательского слоя. Вне воркспейса myc она не печатает
 * ничего своего (см. statusline.ts), чужой строке ввод отдаёт всегда. Бинарь —
 * абсолютный путь (слой личный, а сессии, запущенные не из терминала, видят
 * другой PATH), `--then` нет никогда: прежняя строка живёт в журнале, а не в
 * нашей команде (правило orca в шапке).
 */
export function ourUserStatusLineCommand(bin: { readonly command: string }): string {
  return `${shellQuote(bin.command)} ${STATUSLINE_COMMAND} ${USER_SCOPE_FLAG} user`;
}

/** Слово, по которому orca узнаёт свою строку. В нашей команде его быть не должно. */
export const ORCA_STATUSLINE_MARK = "claude-statusline";

/**
 * Сочтёт ли orca эту команду СВОЕЙ строкой — перенос её матчера `C()` (шапка):
 * `agent-hooks/claude-statusline.{sh,cmd,ps1}` в тексте команды или в
 * раскодированном `-EncodedCommand`, обратные косые — как прямые. Для отчётов
 * (doctor: «строку заменила orca»), а не для записи: wire держит правило строже
 * — в нашей команде нет `claude-statusline` вовсе.
 */
export function orcaClaimsStatusLine(command: string): boolean {
  const m = /\s-EncodedCommand\s+(\S+)/i.exec(command);
  let decoded = "";
  if (m !== null) {
    try {
      decoded = Buffer.from(m[1]!, "base64").toString("utf16le");
    } catch {
      decoded = "";
    }
  }
  const text = (decoded.length > 0 ? `${command}\n${decoded}` : command).replaceAll("\\", "/");
  return ["sh", "cmd", "ps1"].some((ext) => text.includes(`agent-hooks/${ORCA_STATUSLINE_MARK}.${ext}`));
}

/** Каталог пользовательских настроек Claude Code — как его считает сам хост. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR;
  if (dir !== undefined && dir.length > 0) return dir;
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, ".claude");
}

export function userSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(claudeConfigDir(env), "settings.json");
}

/**
 * `statusLine` из файла настроек. `undefined` — ключа нет или файла нет;
 * битый файл тоже `undefined`, но с флагом: писать рядом с тем, чего не
 * прочитали, нельзя, а исполнять — нечего.
 */
export function readStatusLine(path: string): { readonly value: unknown; readonly broken: boolean } {
  if (!existsSync(path)) return { value: undefined, broken: false };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { value: undefined, broken: true };
    }
    return { value: (parsed as Record<string, unknown>)["statusLine"], broken: false };
  } catch {
    return { value: undefined, broken: true };
  }
}

/** Журнал `myc wire --scope user`. */
export const USER_JOURNAL = "wire-user.json";

/**
 * Где журнал пользовательского слоя: `${MYC_HOME ?? HOME}/.myc/wire-user.json`.
 * ТОЛЬКО из переданного окружения, без os.homedir(): тест с подменённым HOME не
 * должен дотянуться до настоящего журнала ни одной веткой. null — нет HOME.
 */
export function userJournalPath(env: NodeJS.ProcessEnv): string | null {
  const pick = (v: string | undefined): string | undefined => (v !== undefined && v.length > 0 ? v : undefined);
  const base = pick(env.MYC_HOME) ?? pick(env.HOME) ?? pick(env.USERPROFILE);
  return base === undefined ? null : join(base, ".myc", USER_JOURNAL);
}

/**
 * Прежняя пользовательская строка, которую заменила наша, — как её записал
 * `myc wire --scope user --status-line`. `undefined` — записи нет (журнала нет,
 * он битый или строку не ставили); `previous: null` — до нас строки не было.
 *
 * Читается на КАЖДОЙ отрисовке, где пользовательская строка — наша: и самой
 * этой строкой, и проектной строкой myc, которая отдаёт ввод пользовательской.
 * Поэтому здесь только node:fs — один read и JSON.parse журнала в пару КБ.
 */
export function recordedUserStatusLine(env: NodeJS.ProcessEnv): { readonly previous: unknown } | undefined {
  const path = userJournalPath(env);
  if (path === null) return undefined;
  try {
    const j = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
    if (j === null || typeof j !== "object" || j["scope"] !== "user") return undefined;
    const sl = j["status_line"];
    if (sl === null || typeof sl !== "object" || Array.isArray(sl)) return undefined;
    return { previous: (sl as Record<string, unknown>)["previous"] ?? null };
  } catch {
    return undefined;
  }
}
