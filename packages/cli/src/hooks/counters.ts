/**
 * Счётчики срабатываний хуков (§6.7, вывод `myc doctor --hooks`).
 *
 * Хук, который «стоит», и хук, который «работает», — разные вещи, и отличить
 * их можно только по факту вызова. Поэтому каждый вызов оставляет след здесь.
 *
 * Файл пишется ПОСЛЕ эпизода и пакета: это диагностика, и она не имеет права
 * стоять между потерей контекста и его спасением. Любая ошибка проглатывается —
 * не сохранившийся счётчик не повод ронять хук.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOOK_EVENTS, type HookEvent } from "./templates.ts";

export const COUNTERS_FILE = "hooks.json";

/**
 * События, которые СЕБЯ ОТМЕЧАЮТ, то есть про которые счётчик вообще может
 * что-то сказать.
 *
 * Список существует затем, чтобы `myc doctor --hooks` не врал. Для события
 * из этого списка «счётчика нет» значит «не срабатывал». Для события ВНЕ
 * списка то же самое значит «не знаю». Разница принципиальна (И2):
 * «не срабатывал» — утверждение, «не знаю» — нет.
 *
 * `stop` остаётся вне списка, потому что команды `myc close-session` в сборке
 * нет и хук не ставится вовсе.
 *
 * Стережётся тестом: событие попадает сюда только вместе с вызовом
 * {@link recordHook} или {@link markHookCall} в его обработчике, и наоборот.
 */
export const SELF_REPORTING_HOOKS: readonly HookEvent[] = [
  "session-start",
  "pre-compact",
  "post-edit",
];

/**
 * Имя переменной, которой ВЫЗЫВАЮЩИЙ объявляет себя, и имя харнесса рядом.
 *
 * Без объявления отметка невозможна, и это не мелочь реализации, а суть
 * задачи. `myc prime` хук старта сессии зовёт ровно теми же аргументами, что
 * человек в терминале (`--format agent` — умолчание, `--session` берётся из
 * окружения): у вызова из хука нет ни одного собственного признака. Счётчик
 * `session-start`, который тикал бы и от ручного `prime`, означал бы
 * «кто-нибудь запускал prime» — метку, означающую не то, что на ней написано,
 * и это ХУЖЕ отсутствия метки (memory-q9k2zxfx2mcm). Поэтому объявляет себя
 * helper, а не угадывает myc.
 */
export const HOOK_ENV = "MYC_HOOK";
export const HOOK_AGENT_ENV = "MYC_HOOK_AGENT";

/** Харнесс, который не назвал себя: ключ счётчика всё равно должен быть. */
export const UNKNOWN_AGENT = "unknown";

export interface HookCaller {
  readonly event: HookEvent;
  readonly agent: string;
}

/**
 * Кто нас позвал, по объявлению вызывающего. `null` — не хук: ни ручной
 * вызов, ни чужой скрипт с чужим значением в {@link HOOK_ENV} отметки не
 * получат.
 */
export function hookCaller(
  env: Record<string, string | undefined> = process.env,
  events: readonly HookEvent[] = HOOK_EVENTS,
): HookCaller | null {
  const raw = env[HOOK_ENV];
  if (raw === undefined) return null;
  const event = events.find((e) => e === raw);
  if (event === undefined) return null;
  const agent = env[HOOK_AGENT_ENV];
  return { event, agent: agent !== undefined && agent.length > 0 ? agent : UNKNOWN_AGENT };
}

/**
 * Отметка вызова, которую ставит хук и НЕ ставит человек.
 *
 * Возвращает `true`, только если отметка записана: вызывающий объявил себя
 * именно этим событием. Ключ — `<агент>:<событие>`, тот же, что у
 * `absorb-session`, иначе `doctor --hooks` не сложит одно событие по агентам.
 */
export function markHookCall(
  mycDir: string,
  event: HookEvent,
  tookMs: number,
  status: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const caller = hookCaller(env);
  if (caller === null || caller.event !== event) return false;
  recordHook(mycDir, `${caller.agent}:${event}`, tookMs, status);
  return true;
}

/**
 * Статусы, означающие «хук сработал, но работы не сделал». Пустой эпизод и
 * старт сессии без её личности — разные болезни с одним исходом: обещанного
 * в базе нет. `doctor --hooks` печатает их как расхождение, а не как здоровье
 * (поймано на живом проекте: 11 срабатываний подряд со статусом `empty` и ни
 * одного узла session в базе).
 */
export const HOLLOW_STATUS: Readonly<Record<string, string>> = {
  empty: "сохранять было нечего — эпизод не создан, проверьте, что хук передаёт транскрипт",
  "no-session": "хост не назвал сессию — сессионная память в контекст не попала; перезапустите `myc wire`, старый helper не передаёт --session",
  "log-unwritable": "журнал грязных пометок недоступен для записи — правки не попадут в очередь `myc anchor check`",
};

export interface HookCounter {
  readonly count: number;
  readonly last_at: number;
  readonly last_ms: number;
  readonly last_status: string;
}

export interface HookCounters {
  readonly v: 1;
  readonly hooks: Readonly<Record<string, HookCounter>>;
}

export function readCounters(mycDir: string): HookCounters {
  try {
    const raw = readFileSync(join(mycDir, COUNTERS_FILE), "utf8");
    const parsed = JSON.parse(raw) as Partial<HookCounters>;
    if (parsed !== null && typeof parsed === "object" && typeof parsed.hooks === "object") {
      return { v: 1, hooks: parsed.hooks as Record<string, HookCounter> };
    }
  } catch {
    // нет файла или он битый — начинаем с нуля, это не ошибка
  }
  return { v: 1, hooks: {} };
}

export function recordHook(
  mycDir: string,
  key: string,
  tookMs: number,
  status: string,
  now = Date.now(),
): void {
  try {
    if (!existsSync(mycDir)) mkdirSync(mycDir, { recursive: true });
    const current = readCounters(mycDir);
    const prev = current.hooks[key];
    const next: HookCounters = {
      v: 1,
      hooks: {
        ...current.hooks,
        [key]: {
          count: (prev?.count ?? 0) + 1,
          last_at: now,
          last_ms: Math.round(tookMs),
          last_status: status,
        },
      },
    };
    const path = join(mycDir, COUNTERS_FILE);
    // Имя временного файла — СВОЁ у каждого процесса. Общее `.hooks.json.tmp`
    // означало, что два хука, сработавших одновременно, пишут в один файл: один
    // обрезает его, пока другой ещё пишет, и переименован может оказаться
    // обрывок. Пока себя отмечал только pre-compact, случай был редким; хук на
    // правку файла срабатывает пачками и параллельно, и делает его обычным.
    const tmp = join(mycDir, `.${COUNTERS_FILE}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // счётчик — диагностика, а не данные: его потеря не должна ничего ломать
  }
}
