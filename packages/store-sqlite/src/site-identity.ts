/**
 * Идентичность реплики привязана к ФИЗИЧЕСКОМУ экземпляру базы (решение S65).
 *
 * `site_id` — это «кто минтит операции»: `op_id = <site_id>:<seq>`, и весь
 * обмен через git держится на том, что под одним `site_id` пишет ровно одна
 * база. `cp -R` каталога воркспейса ломает это молча: копия уносит `site_id`
 * вместе с `myc.db`, продолжает нумерацию с того же `seq` — и два разных
 * набора операций приезжают под одинаковыми op_id. Драйвер слияния и экспорт
 * теперь такую пару НЕ глотают (./export.ts, ./merge-driver.ts), но это
 * сеть безопасности: операции к тому моменту уже выписаны. Корень лечится
 * здесь — тем, что копия получает СВОЙ `site_id` при первом же открытии.
 *
 * Экземпляр опознаётся тройкой (host, dev, ino) с путём как запасным ключом.
 * Почему именно так — замер на Darwin 25.6 / APFS (arm64), `stat -f %d:%i`:
 *
 *   cp -R / cp -a / rsync -a / cp -c (APFS clone) / tar x  → НОВЫЙ inode
 *   cp файл поверх СУЩЕСТВУЮЩЕГО                           → тот же inode
 *   rsync поверх существующего (без --inplace)             → НОВЫЙ inode
 *   rsync --inplace поверх существующего                   → тот же inode
 *   mv в пределах ФС                                       → тот же inode, ДРУГОЙ путь
 *   ln (жёсткая ссылка)                                    → тот же inode
 *   2000 вставок + VACUUM + wal_checkpoint(TRUNCATE)       → тот же inode
 *   stat по симлинку                                       → inode СИМЛИНКА
 *
 * Отсюда три следствия, каждое из которых видно в правилах ниже.
 *   1. Путь НЕ входит в равенство: `mv` каталога проекта — законная операция,
 *      а по пути она выглядела бы как новая база. Путь хранится и работает
 *      только запасным ключом, когда `dev` сменился (перемонтирование,
 *      перезагрузка: номер устройства не переживает их гарантированно).
 *   2. `statSync` (а не `lstatSync`) плюс `realpathSync`: по симлинку иначе
 *      получаешь идентичность самого симлинка.
 *   3. Жизненный цикл sqlite инод не меняет — ложного перевыпуска на VACUUM
 *      или чекпоинте нет.
 *
 * Linux НЕ замерян: в этом окружении нет ни docker, ни podman, ни lima.
 * Направление, на котором держится обнаружение (копия ⇒ новый inode), там
 * следует из конструкции: `cp` и `rsync` создают файл через `open(O_CREAT)`,
 * а инод сохраняют только `link(2)` и `rename(2)`. Не проверено на Linux
 * поведение overlayfs и сетевых ФС — там `ino` может быть нестабилен, и
 * ошибка будет в безопасную сторону (лишний перевыпуск, см. ниже).
 *
 * Цена ошибки несимметрична, и правила настроены на это:
 *   - ЛИШНИЙ перевыпуск (rsync-восстановление из бэкапа, переезд на другую
 *     ФС, переименование машины) стоит одного нового `site_id` и одного
 *     лишнего каталога в оплоге. Ни одна операция не теряется: старые op_id
 *     остаются валидными, новые просто минтятся под новым именем;
 *   - ПРОПУЩЕННАЯ копия стоит потерянных операций. Поэтому расхождение
 *     `host` решающее, хотя из-за него переименование машины и даёт лишний
 *     перевыпуск: у двух Mac с настройками по умолчанию `dev` тома совпадает,
 *     и без `host` копия на вторую машину могла бы пройти незамеченной.
 */

import { readFileSync, realpathSync, statSync } from "node:fs";
import { hostname } from "node:os";
import type { Database } from "bun:sqlite";
import type { DbDriver } from "@myc/core";
import { Q } from "./queries.ts";

/** myc_meta: JSON физического экземпляра, к которому привязан site_id. */
export const META_SITE_INSTANCE = "site_instance";
/** myc_meta: JSON-массив прежних site_id этой реплики, старейший первым. */
export const META_SITE_PREV = "site_id_prev";

export interface SiteInstance {
  /** машина: /etc/machine-id, иначе нормализованное имя хоста */
  readonly host: string;
  /** st_dev — не переживает перемонтирование гарантированно, потому и не один */
  readonly dev: number;
  /** st_ino — главный признак: копия всегда получает новый */
  readonly ino: number;
  /** realpath базы; только запасной ключ и диагностика */
  readonly path: string;
}

let hostCache: string | undefined;

/**
 * Стабильный идентификатор машины. `/etc/machine-id` (Linux) не меняется от
 * сети и переименования; имя хоста меняется, поэтому нормализуется — на
 * macOS оно скачет между `foo.local` и `foo` при смене сети, и без этого
 * каждая смена сети выглядела бы переездом на другую машину.
 */
export function machineId(): string {
  if (hostCache !== undefined) return hostCache;
  for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
    try {
      const v = readFileSync(p, "utf8").trim();
      if (v.length > 0) return (hostCache = v);
    } catch {
      // нет файла — не Linux или урезанный образ
    }
  }
  return (hostCache = hostname().trim().toLowerCase().replace(/\.(local|lan)$/, ""));
}

/** Наблюдаемый экземпляр файла базы. Бросает, если файла нет. */
export function observeInstance(dbPath: string): SiteInstance {
  const real = realpathSync(dbPath);
  const st = statSync(real); // не lstat: по симлинку нужен целевой инод
  return { host: machineId(), dev: Number(st.dev), ino: Number(st.ino), path: real };
}

export function parseInstance(json: string | undefined): SiteInstance | undefined {
  if (json === undefined || json.length === 0) return undefined;
  try {
    const v = JSON.parse(json) as Partial<SiteInstance>;
    if (
      typeof v.host !== "string" ||
      typeof v.dev !== "number" ||
      typeof v.ino !== "number" ||
      typeof v.path !== "string"
    ) {
      return undefined;
    }
    return { host: v.host, dev: v.dev, ino: v.ino, path: v.path };
  } catch {
    return undefined;
  }
}

export function renderInstance(i: SiteInstance): string {
  return JSON.stringify({ host: i.host, dev: i.dev, ino: i.ino, path: i.path });
}

/**
 * Тот же физический файл? `host` обязателен всегда. Дальше либо совпала пара
 * (dev, ino) — обычный случай, включая `mv` в пределах ФС, — либо совпали
 * (ino, path): это перемонтирование или перезагрузка, которые сменили номер
 * устройства, оставив файл на месте.
 */
export function sameInstance(a: SiteInstance, b: SiteInstance): boolean {
  if (a.host !== b.host) return false;
  if (a.ino !== b.ino) return false;
  return a.dev === b.dev || a.path === b.path;
}

export type SiteIdOrigin = "existing" | "minted" | "adopted" | "reissued";

export interface SiteIdDecision {
  readonly siteId: string;
  /** что записать в myc_meta.site_instance; undefined — запись не нужна */
  readonly instance?: string;
  /** что записать в myc_meta.site_id_prev; undefined — запись не нужна */
  readonly predecessors?: string;
  readonly origin: SiteIdOrigin;
  /** прежний site_id — только при origin === "reissued" */
  readonly reissuedFrom?: string;
}

export interface SiteIdInput {
  /** myc_meta.site_id */
  readonly stored?: string;
  /** myc_meta.site_instance */
  readonly storedInstance?: string;
  /** myc_meta.site_id_prev */
  readonly storedPredecessors?: string;
  readonly observed: SiteInstance;
  /** выпуск нового идентификатора — форма та же, что у `myc init` */
  readonly mint: () => string;
}

function parsePredecessors(json: string | undefined): string[] {
  if (json === undefined || json.length === 0) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Решение о `site_id` при открытии базы. Чистая функция: вызывающий читает
 * три ключа `myc_meta`, зовёт это и записывает то, что вернулось, — по одной
 * записи на открытие и только когда что-то изменилось. Стоимость проверки —
 * один `statSync`, замер 0.59 мкс на вызов (n=20000, Darwin 25.6/APFS).
 *
 * База без записанного экземпляра НЕ перевыпускается, а усыновляется: до
 * S65 такой записи не существовало, и перевыпуск наугад раздробил бы
 * `site_id` разом у всех существующих воркспейсов, включая те, что никто не
 * копировал. Копии, сделанные ДО перехода, ловит громкость на стороне
 * экспорта и драйвера слияния — там их видно по op_id.
 */
export function decideSiteId(input: SiteIdInput): SiteIdDecision {
  const observed = renderInstance(input.observed);
  if (input.stored === undefined || input.stored.length === 0) {
    return { siteId: input.mint(), instance: observed, origin: "minted" };
  }
  const known = parseInstance(input.storedInstance);
  if (known === undefined) {
    return { siteId: input.stored, instance: observed, origin: "adopted" };
  }
  if (sameInstance(known, input.observed)) {
    // Путь мог измениться (`mv` каталога) — обновляем запись, но это тот же
    // экземпляр, и `site_id` не трогаем.
    return known.path === input.observed.path && known.dev === input.observed.dev
      ? { siteId: input.stored, origin: "existing" }
      : { siteId: input.stored, instance: observed, origin: "existing" };
  }
  const prev = parsePredecessors(input.storedPredecessors);
  if (!prev.includes(input.stored)) prev.push(input.stored);
  return {
    siteId: input.mint(),
    instance: observed,
    predecessors: JSON.stringify(prev),
    origin: "reissued",
    reissuedFrom: input.stored,
  };
}

// ---------------------------------------------------------------------------
// Подключение к путям открытия базы (S65, вторая половина)
// ---------------------------------------------------------------------------
//
// `decideSiteId` — чистая функция, и это сознательно: решение проверяется без
// базы. Но между ней и пятью местами, где база открывается, лежала одна и та
// же последовательность из шести шагов (три чтения `myc_meta`, решение, до
// четырёх записей), и пять её копий разъехались бы ровно так, как разъезжается
// всё продублированное — молча и по одной. Поэтому последовательность живёт
// здесь одна, а места открытия зовут `ensureSiteId`.
//
// Полноту подключения стережёт site-identity.wiring.test.ts: он САМ находит
// места, где может родиться `site_id`, и требует, чтобы каждое прошло отсюда.

/** myc_meta: сам идентификатор сайта. Дублирует приватную константу queries.ts. */
export const META_SITE_ID = "site_id";
/**
 * myc_meta: локальный счётчик seq. Ключ продублирован из queries.ts (там он
 * приватный); от расхождения страхует поведенческий тест — после перевыпуска
 * первая же операция обязана получить seq 1, а это верно только если ключ тот.
 */
export const META_LAST_SEQ = "last_seq";

/** Чтение и запись `myc_meta` — ровно то, что нужно от базы для решения. */
export interface SiteMetaIo {
  readonly read: (key: string) => string | undefined;
  readonly write: (key: string, value: string) => void;
}

export interface EnsureSiteIdOptions {
  readonly meta: SiteMetaIo;
  /** Путь к файлу базы: по нему наблюдается физический экземпляр. */
  readonly dbPath: string;
  /** Выпуск нового идентификатора; обычно `() => mintSiteId(slug)`. */
  readonly mint: () => string;
  /**
   * Куда уходит WARN о перевыпуске. Умолчание — stderr, и это часть контракта:
   * перевыпуск обязан быть громким у ЛЮБОГО вызывающего, включая забывшего
   * про параметр. Тесты подставляют свой сборщик.
   */
  readonly warn?: (line: string) => void;
}

export interface EnsureSiteIdResult extends SiteIdDecision {
  /** Текст WARN, если он был. Уже отправлен в `warn` — здесь для тестов и UI. */
  readonly warning?: string;
}

/**
 * `myc_meta` через драйвер — форма трёх путей из четырёх (CLI, дренаж, MCP).
 * Адаптеры живут здесь, а не у вызывающих: иначе к пяти копиям
 * последовательности добавились бы пять копий доступа к таблице.
 */
export function driverMeta(driver: DbDriver): SiteMetaIo {
  return {
    read: (key) => driver.one<{ value: string }>(Q.meta_get, [key])?.value,
    write: (key, value) => {
      driver.run(Q.meta_set, [key, value]);
    },
  };
}

/** То же для голого соединения: так базу создают `myc init` и личный ярус. */
export function databaseMeta(db: Database): SiteMetaIo {
  return {
    read: (key) => (db.prepare(Q.meta_get.sql).get(key) as { value?: string } | null)?.value,
    write: (key, value) => {
      db.prepare(Q.meta_set.sql).run(key, value);
    },
  };
}

/** Форма нового `site_id`, общая у `myc init` и у всех путей открытия. */
export function mintSiteId(slug: string): string {
  return `local-${slug}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
}

function reissueWarning(from: string, to: string, dbPath: string): string {
  return (
    `myc: WARN: site_id reissued: ${from} -> ${to}\n` +
    `  ${dbPath} is a different physical database instance than the one ${from} was bound to\n` +
    `  (usually a copy of the workspace directory: cp -R, tar x, a restore from backup).\n` +
    `  New operations of this copy are minted under ${to}; the earlier history is not rewritten,\n` +
    `  the previous site_id is kept in myc_meta.site_id_prev.\n`
  );
}

/**
 * Прочитать, решить, записать — и сказать человеку, если личность сменилась.
 *
 * Записей ровно столько, сколько изменений: у базы, открытой на своём месте,
 * их ноль, и вся проверка стоит одного `statSync` (0.59 мкс).
 *
 * При перевыпуске `last_seq` сбрасывается в 0, и это обязательная часть, а не
 * уборка. Счётчик локальный: под новым `site_id` в оплоге ещё нет ни одной
 * операции, а `GraphStore` берёт `max(myc_meta.last_seq, seq последней СВОЕЙ
 * операции)`. Оставив унаследованный `last_seq`, копия начала бы нумерацию с
 * чужого места — дыра в op_id на ровном месте, а после `myc import` встречной
 * истории ещё и риск снова столкнуться с чужой нумерацией.
 */
export function ensureSiteId(options: EnsureSiteIdOptions): EnsureSiteIdResult {
  const { meta, dbPath, mint } = options;
  const decision = decideSiteId({
    stored: meta.read(META_SITE_ID),
    storedInstance: meta.read(META_SITE_INSTANCE),
    storedPredecessors: meta.read(META_SITE_PREV),
    observed: observeInstance(dbPath),
    mint,
  });

  if (decision.origin === "minted" || decision.origin === "reissued") {
    meta.write(META_SITE_ID, decision.siteId);
  }
  if (decision.instance !== undefined) meta.write(META_SITE_INSTANCE, decision.instance);
  if (decision.predecessors !== undefined) meta.write(META_SITE_PREV, decision.predecessors);
  if (decision.origin !== "reissued") return decision;

  meta.write(META_LAST_SEQ, "0");
  const warning = reissueWarning(decision.reissuedFrom ?? "", decision.siteId, dbPath);
  (options.warn ?? ((line: string) => process.stderr.write(line)))(warning);
  return { ...decision, warning };
}
