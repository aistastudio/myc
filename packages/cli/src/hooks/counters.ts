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

export const COUNTERS_FILE = "hooks.json";

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
