/**
 * Идентификатор модели по умолчанию и путь к её каталогу — ОДИН источник
 * на весь репозиторий.
 *
 * Зачем отдельный модуль. Дешёвому привратнику «модель вообще скачана?»
 * нужен этот идентификатор, но не нужен эмбеддер: динамический
 * `import("@myc/embed")` на холодном процессе стоил 190 мс при бюджете
 * поиска 25 мс. Раньше выход был в копии литерала на стороне CLI — и это
 * третий случай одной болезни подряд (S43: скопированный список PRAGMA
 * разошёлся; S45: два верных решения дали неверное целое). Копия литерала
 * ломается ТИХО: привратник смотрит на каталог старой модели, не находит
 * его и молча не зовёт вектор — симптомом будет не ошибка, а «семантика
 * почему-то не работает».
 *
 * Поэтому модуль намеренно нищий: `node:os` + `node:path`, ни одной
 * зависимости на ONNX, токенизаторы и реестр. Импортировать его дёшево из
 * любого места, включая горячий путь.
 *
 * Публикуется как подпуть пакета: `@myc/embed/model-id`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Модель по умолчанию — МНОГОЯЗЫЧНАЯ (решение S46). Содержимое myc пишет
 * пользователь, а не тот, кому удобно мерить: английская модель на русском
 * корпусе давала отрицательное разделение близких и далёких пар.
 */
export const DEFAULT_MODEL_ID = "multilingual-e5-small-q8";

/** Английская модель: осознанный выбор для англоязычных корпусов, не дефолт. */
export const ENGLISH_MODEL_ID = "bge-small-en-v1.5-q8";

/** Базовый каталог моделей: MYC_MODELS_DIR или ~/.cache/myc/models. */
export function defaultModelsDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MYC_MODELS_DIR;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(homedir(), ".cache", "myc", "models");
}

/** Каталог конкретной модели: один базовый может держать несколько. */
export function modelDir(modelId: string, dir?: string): string {
  return join(dir ?? defaultModelsDir(), modelId);
}

/**
 * Путь манифеста модели. По контракту fetch.ts manifest.json пишется
 * ПОСЛЕДНИМ, поэтому его наличие — необходимое условие целостности и
 * достаточное для дешёвой проверки одним stat.
 */
export function modelManifestPath(
  modelId: string = DEFAULT_MODEL_ID,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(modelDir(modelId, defaultModelsDir(env)), "manifest.json");
}
