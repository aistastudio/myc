/**
 * ВКЛЮЧАЕМЫЙ ОБМЕН: переключатель режима и событийный триггер (§9.5).
 *
 * Режим обмена живёт в `.myc/workspace.toml` (`sync = "manual" | "auto"`) —
 * коммитится вместе с личностью воркспейса, потому что это свойство
 * воркспейса, а не отдельной машины. `manual` — как и раньше: обмен только
 * явной командой `myc sync`. `auto` — фон поднимает обмен сам: период §9.5
 * (60 с) ведёт дренаж, а ВАЖНОЕ СОБЫТИЕ — close/claim задачи — ставит
 * строку очереди `jobs(kind='sync')` с задержкой 2 с (константы §12).
 *
 * Ни в одном режиме сеть не входит в горячем пути: событие — это строка в
 * очереди, а не обмен внутри команды. Ставит строку ТОЛЬКО локальная ветка
 * close/claim: при удалённом режиме операция уже легла на сервер, и ставить
 * нечего.
 *
 * Поверх конфига читается `MYC_SYNC` — личный override: включить обмен на
 * своей машине, не меняя общий файл.
 */

import { jobs } from "@myc/store-sqlite";
import { ambientServer, localTokenFile, localWorkspaceConfig, syncModeFrom } from "./remote.ts";
import type { StoreHandle } from "./commands/store.ts";

/** Класс очереди. Приоритет 8 — из JOB_PRIORITY (embed 3 … rescore 9). */
export const SYNC_JOB_KIND = "sync";

/** Сущность строки: одна строка обмена на воркспейс — дедупликация enqueue. */
export const SYNC_JOB_ENTITY = "background";

/** Период фонового обмена §9.5/§12: 60 000 мс от последнего обмена. */
export const SYNC_BG_PERIOD_MS = 60_000;

/** Задержка после важного события §9.5/§12: 2 000 мс. */
export const SYNC_EVENT_DELAY_MS = 2_000;

/** Ключ myc_meta: отметка последнего ПЛАНИРОВАНИЯ обмена (антишторм спавна). */
export const SYNC_BG_LAST_AT_KEY = "sync_bg_last_at";

/** Аренда строки: полный обмен с сетью живёт дольше аренды по умолчанию (60 с). */
export const SYNC_JOB_LEASE_MS = 120_000;

/**
 * Постановка строки после важного события. true — строка поставлена
 * (наблюдаемо: ровно одна строка на воркспейс, дедупликация по
 * (kind, entity_id)). НИКОГДА не бросает и не шумит: фон внутри команды, чей
 * отказ не имеет права стать отказом команды.
 */
export function scheduleBackgroundSync(
  h: Pick<StoreHandle, "driver" | "scope" | "wsDir">,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): boolean {
  try {
    const { mode } = syncModeFrom(env, localWorkspaceConfig(h.wsDir));
    if (mode !== "auto") return false;
    // Без цели событию некуда: обмен инициирует клиент, а цель у него одна —
    // конфиг репозитория или профильный MYC_SERVER (флаг --server одного
    // вызова фон не видит).
    if (ambientServer(env, h.wsDir) === undefined) return false;
    jobs.enqueue(h.driver.database, SYNC_JOB_KIND, {
      entityId: SYNC_JOB_ENTITY,
      runAfter: now + SYNC_EVENT_DELAY_MS,
      scope: h.scope,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * ПОЧЕМУ ФОН НЕ ПОДНИМЕТСЯ (пусто — все предусловия сошлись). Цель и токен
 * берутся как в remoteTarget: конфиг репозитория обгоняет профильное
 * окружение, токен — `.myc/token` репозитория обгоняет MYC_TOKEN. Причина
 * называется, а не проглатывается: включённый `sync = "auto"` без сервера —
 * это состояние, а не тишина.
 */
export function syncPreconditionReason(ws: string, env: NodeJS.ProcessEnv): string | null {
  if (ambientServer(env, ws) === undefined) {
    return (
      "no server to exchange with: set `server` in .myc/workspace.toml or MYC_SERVER " +
      "(or turn sync back to manual)"
    );
  }
  if ((env.MYC_TOKEN ?? "").trim() === "" && localTokenFile(ws) === undefined) {
    return "no token: put one in MYC_TOKEN or in .myc/token of this repository";
  }
  return null;
}
