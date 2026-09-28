/**
 * ЧАСЫ СВЕЖЕСТИ — ОДНО ОПРЕДЕЛЕНИЕ НА ВСЕ ПОВЕРХНОСТИ (memory-khny4xb612m6).
 *
 * Жили в `@myc/retrieval`, переехали в ядро: свежесть считает не только
 * выдача, но и очередь `ready`, а её реестр теперь исполняет ещё и сервер
 * (`GET /v1/ws/:ws/ready`). Пакет `store-*` и сервер видят только ядро, и
 * второго определения свежести быть не должно — разъехавшись, две копии
 * по-разному ответят на вопрос «насколько эта задача свежая», и очередь на
 * сервере разойдётся с очередью в CLI.
 *
 * `@myc/retrieval` реэкспортирует их, чтобы вызывающие не переучивались.
 */

import type { Dialect } from "./sql.ts";
import type { JsonValue } from "./oplog.ts";

/**
 * Ключи attrs, из которых складываются часы свежести. Пишет их
 * `myc import-beads`: время события в источнике (у задачи — «обновлена», у
 * комментария — только «создан») и метку собственной записи импорта.
 */
export const FRESHNESS_ATTRS = {
  sourceUpdated: "external_updated_at",
  sourceCreated: "external_created_at",
  synced: "external_synced_at",
} as const;

/**
 * Допуск, в пределах которого `updated_at` после метки импорта — всё ещё
 * запись САМОГО импорта, а не правка в myc. Импорт берёт метку по тем же
 * часам, что уйдут в HLC операции (max(Date.now(), clock.state.ts)), прямо
 * перед записью; зазор до выпуска операции — микросекунды, при ожидании
 * чужой блокировки записи — секунды (busy_timeout ~5 с). Минута — запас в
 * 12 раз. Цена: правка в первую минуту после ввоза не освежает — на кванте
 * свежести в сутки (FRESHNESS_QUANTUM_MS) это не видно.
 */
export const IMPORT_WRITE_SLACK_MS = 60_000;

const isClockValue = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * ЧАСЫ СВЕЖЕСТИ УЗЛА — одно определение на все поверхности
 * (memory-khny4xb612m6): буст выдачи (boostOf), дата хита в search/recall (и
 * их --since/--until, --sort updated), слагаемое свежести очереди ready (S21,
 * в SQL — freshnessClockSql), шапка и поле updated у `myc show`.
 *
 *  - Свой узел: `updated_at`.
 *  - Ввезённый, и после записи импорта его НЕ правили: время события в
 *    источнике (`external_updated_at`, иначе `external_created_at`), но не
 *    позже `updated_at` — часы источника, убежавшие вперёд, не делают запись
 *    свежее момента, когда её записали сюда (min).
 *  - Ввезённый, и `updated_at` позже метки импорта больше чем на допуск —
 *    узел правили в myc (update, claim, close): часы — `updated_at`. Работа
 *    здесь обязана освежать: после переезда она идёт именно здесь.
 *
 * Метки импорта нет (ввезено до неё) — различить запись импорта и правку
 * нечем, и часы — время источника. Родную колонку не подменяем: это время
 * операции и её HLC, оплог не должен врать о записи.
 */
export function freshnessClock(node: {
  readonly updated_at: number;
  readonly attrs: Readonly<Record<string, unknown>>;
}): number {
  // Порядок проверок — ровно тот же, что в freshnessClockSql: сначала «правили
  // в myc» (тогда источник не нужен вовсе), потом время источника.
  const w = node.updated_at;
  const synced = node.attrs[FRESHNESS_ATTRS.synced];
  if (isClockValue(synced) && w > synced + IMPORT_WRITE_SLACK_MS) return w;
  const u = node.attrs[FRESHNESS_ATTRS.sourceUpdated];
  if (isClockValue(u)) return Math.min(u, w);
  const c = node.attrs[FRESHNESS_ATTRS.sourceCreated];
  if (isClockValue(c)) return Math.min(c, w);
  return w;
}

/**
 * Дата создания для показа — пара к часам свежести и из того же места: у
 * ввезённого — момент создания в источнике (`external_created_at`), не
 * позже записи сюда, у своего — `created_at`. Её печатают show и строки
 * search/recall, иначе карточка и выдача называли бы разный «created».
 */
export function sourceCreatedAt(node: {
  readonly created_at: number;
  readonly attrs: Readonly<Record<string, unknown>>;
}): number {
  const src = node.attrs[FRESHNESS_ATTRS.sourceCreated];
  return isClockValue(src) ? Math.min(src, node.created_at) : node.created_at;
}

/**
 * freshnessClock в SQL — для тех, кто считает свежесть в самом запросе
 * (скоринг очереди ready идёт одним сканом индекса и режется LIMIT'ом, там
 * TS не успевает). Равенство с TS-версией на каждом случае держит
 * freshness-source-time.test.ts. `json_type`, а не `typeof(json_extract)`:
 * JSON-true у SQLite извлекается как целое 1, а в TS это не число.
 *
 * Цена — на КАЖДОГО кандидата очереди, поэтому выражение собрано под неё:
 *  - свой узел (в тексте attrs нет ни одного `"external_`) отсекается
 *    `instr`, без разбора JSON;
 *  - «правили в myc» проверяется первым — тогда время источника не читается;
 *  - у ввезённого и не тронутого — четыре обращения к JSON (тип и значение
 *    метки, тип и значение времени источника); разбор attrs SQLite кеширует
 *    в пределах строки.
 * Вызывающий обязан вычислять выражение ОДИН раз на строку (у ready — через
 * `CASE <возраст в сутках> WHEN …`, где база CASE считается однажды).
 */
export function freshnessClockSql(alias: string, dialect: Dialect = "sqlite"): string {
  const a = `${alias}.attrs`;
  const w = `${alias}.updated_at`;
  const pg = dialect === "pg";
  // Диалект знает САМ генератор, а не копия рядом: выражение уходит и в
  // скоринг очереди, и в гибридный поиск, и второй текст, живущий отдельно,
  // разошёлся бы с первым при первой же правке формулы.
  //
  // Чем отличается Postgres. `json_type` там нет — есть `jsonb_typeof`, и он
  // не различает целое и вещественное: оба 'number', что здесь и требуется.
  // `->>` отдаёт ТЕКСТ, поэтому время приводится к bigint явно — иначе
  // сравнение с `updated_at` было бы сравнением строк. `instr` заменяет
  // `position`, а двухаргументный `min` — `least` (в Postgres `min` только
  // агрегат).
  const isNum = (key: string): string =>
    pg ? `jsonb_typeof(${a}->'${key}') = 'number'` : `json_type(${a},'$.${key}') IN ('integer','real')`;
  const val = (key: string): string => (pg ? `(${a}->>'${key}')::bigint` : `json_extract(${a},'$.${key}')`);
  const noExternal = pg ? `position('"external_' in ${a}::text) = 0` : `instr(${a}, '"external_') = 0`;
  const least = (x: string, y: string): string => (pg ? `least(${x}, ${y})` : `min(${x}, ${y})`);
  const U = FRESHNESS_ATTRS.sourceUpdated;
  const C = FRESHNESS_ATTRS.sourceCreated;
  const S = FRESHNESS_ATTRS.synced;
  return `(CASE
      WHEN ${noExternal} THEN ${w}
      WHEN ${isNum(S)} AND ${w} > ${val(S)} + ${IMPORT_WRITE_SLACK_MS} THEN ${w}
      WHEN ${isNum(U)} THEN ${least(val(U), w)}
      WHEN ${isNum(C)} THEN ${least(val(C), w)}
      ELSE ${w}
    END)`;
}
