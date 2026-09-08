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
import type { HookEvent } from "./templates.ts";

export const COUNTERS_FILE = "hooks.json";

/**
 * События, которые СЕБЯ ОТМЕЧАЮТ, то есть про которые счётчик вообще может
 * что-то сказать. Сегодня это ровно одно — pre-compact (`absorb-session`).
 *
 * Список существует затем, чтобы `myc doctor --hooks` не врал. Для события
 * из этого списка «счётчика нет» значит «не срабатывал». Для события ВНЕ
 * списка то же самое значит «не знаю»: `myc prime` вызывают и хуком на старте
 * сессии, и руками, и отличить одно от другого нечем (memory-q9k2zxfx2mcm),
 * а `anchor touch` в горячем пути правки намеренно не открывает ничего лишнего.
 * Разница принципиальна (И2): «не срабатывал» — утверждение, «не знаю» — нет.
 *
 * Стережётся тестом: событие попадает сюда только вместе с вызовом
 * {@link recordHook} в его обработчике, и наоборот.
 */
export const SELF_REPORTING_HOOKS: readonly HookEvent[] = ["pre-compact"];

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
    const tmp = join(mycDir, `.${COUNTERS_FILE}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // счётчик — диагностика, а не данные: его потеря не должна ничего ломать
  }
}
