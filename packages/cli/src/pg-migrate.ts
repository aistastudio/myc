/**
 * ДОГОНЯЮЩИЕ МИГРАЦИИ POSTGRES (memory-rjb0vk556j8e).
 *
 * `db/schema.postgres.sql` — СЛЕПОК: он создаёт всю схему разом и пишет в
 * учёт одну строку `(N, 'postgres-baseline')`. Для пустой базы это и дешевле
 * цепочки, и надёжнее. Но дороги с номера N на N+1 у слепка нет по
 * построению, и сервер, поднятый прошлым релизом, не мог дойти до нынешней
 * схемы никак: `--apply-schema` населённую базу отвергает намеренно.
 *
 * СПИСОК МИГРАЦИЙ ОДИН НА ОБА ДИАЛЕКТА. У записи есть текст SQLite и, только
 * при настоящем расхождении, `pg` — тем же правилом, что у реестра запросов.
 * Второй список разъехался бы с первым, и две базы под одним номером схемы
 * имели бы разную схему; номер же — единственное, по чему их сравнивают.
 *
 * ОТСТАВШИЕ СЧИТАЮТСЯ ПО МАКСИМУМУ, А НЕ РАЗНОСТЬЮ МНОЖЕСТВ. В учёте
 * Postgres лежит одна строка слепка, и разность множеств объявила бы
 * отставшими все миграции до неё — то есть накатила бы на готовую схему
 * первую попавшуюся. Строка слепка означает «всё по этот номер включительно
 * уже есть», поэтому отставшие — это строго те, чей номер больше
 * максимального в учёте.
 *
 * ПОЧЕМУ ЭТО НЕ ПРИ СТАРТЕ. По той же причине, по которой `--apply-schema`
 * отказывает населённой базе: накат DDL поверх живых данных — операция с
 * порядком, проверками и откатом, и делать её молча при каждом подъёме
 * контейнера значит однажды потерять базу. Здесь только механика; зовёт её
 * явная команда `myc serve --migrate`, а старт сервера умеет лишь ЗАМЕТИТЬ
 * отставание и отказаться работать.
 */

import { toPgDialect } from "@myc/core";
import type { PostgresDriver } from "@myc/store-postgres";
import { COMPAT_MIGRATIONS_TABLE, migrations as allMigrations, type Migration } from "@myc/store-sqlite";

export interface PgMigrateResult {
  /** Версии, накатанные ЭТИМ вызовом, по возрастанию. */
  readonly appliedVersions: readonly number[];
  /** Версия учёта до вызова и после. */
  readonly from: number;
  readonly to: number;
}

/**
 * Видит ли роль ВСЕ строки, а не только своего арендатора.
 *
 * ЭТО НЕ ПРИДИРКА К ПРАВАМ, А УСЛОВИЕ ПРАВИЛЬНОСТИ. Миграция данных идёт по
 * всем арендаторам сразу, а `nodes` закрыта политикой RLS: под прикладной
 * ролью `UPDATE ... WHERE ...` видит ноль строк, МОЛЧА меняет ноль и всё
 * равно записывает строку учёта. Замерено ровно это: база после «наката»
 * стояла на новом номере со старыми данными, то есть учёт врал. Поэтому
 * накат — операция суперпользователя, как и `--apply-schema` рядом.
 */
export async function canBypassRls(pg: PostgresDriver): Promise<boolean> {
  const [row] = await pg.raw<{ ok: boolean | string }>(
    "SELECT (rolsuper OR rolbypassrls) AS ok FROM pg_roles WHERE rolname = current_user",
  );
  return row?.ok === true || row?.ok === "t" || row?.ok === "true";
}

/** Максимум по обеим таблицам учёта; 0 — схемы нет вовсе. */
export async function pgSchemaVersion(pg: PostgresDriver): Promise<number> {
  const [row] = await pg.raw<{ v: string | null }>(
    `SELECT max(v) AS v FROM (
       SELECT max(version) AS v FROM schema_migrations
       UNION ALL
       SELECT max(version) AS v FROM ${COMPAT_MIGRATIONS_TABLE}
     ) t`,
  );
  return row?.v == null ? 0 : Number(row.v);
}

/** Что этот бинарь знает: номер последней миграции в списке. */
export function knownSchemaVersion(migrations: readonly Migration[] = allMigrations): number {
  return migrations.reduce((m, mig) => Math.max(m, mig.version), 0);
}

/** Текст миграции для Postgres: явный `pg` или механический перевод. */
export function pgTextOf(migration: Migration): string {
  return migration.pg ?? toPgDialect(migration.sql);
}

/**
 * Накатить отставшие. Каждая — СВОЕЙ транзакцией: половина миграции хуже,
 * чем ненакатанная, а половина набора — это просто более ранний номер, с
 * которого повтор продолжит.
 *
 * Пустой текст (`pg: ""`) означает «на Postgres делать нечего»: строка учёта
 * всё равно пишется, иначе номер не сдвинется и следующая попытка начнёт с
 * той же миграции.
 */
export async function migratePostgres(
  pg: PostgresDriver,
  migrations: readonly Migration[] = allMigrations,
): Promise<PgMigrateResult> {
  const known = [...migrations].sort((a, b) => a.version - b.version);
  if (!(await canBypassRls(pg))) {
    throw new Error(
      "migrations must run as a role that sees every tenant's rows (superuser or BYPASSRLS): " +
        "under the application role a data migration silently changes nothing and still records the version",
    );
  }
  const from = await pgSchemaVersion(pg);
  const pending = known.filter((m) => m.version > from);
  const appliedVersions: number[] = [];

  for (const migration of pending) {
    const text = pgTextOf(migration).trim();
    const checksum = await sha256Hex(migration.sql);
    const compat = migration.readableFrom !== undefined;
    // Транзакция вокруг ВСЕГО: и объектов, и строки учёта. Иначе упавшая на
    // полпути миграция оставила бы схему изменённой, а учёт — прежним.
    const record = compat
      ? `INSERT INTO ${COMPAT_MIGRATIONS_TABLE} (version, name, checksum, applied_at, readable_from)
         VALUES (${migration.version}, ${quote(migration.name)}, ${quote(checksum)}, ${Date.now()}, ${migration.readableFrom!})`
      : `INSERT INTO schema_migrations (version, name, checksum, applied_at, by_version)
         VALUES (${migration.version}, ${quote(migration.name)}, ${quote(checksum)}, ${Date.now()}, ${quote("myc")})`;
    // `SET LOCAL row_security = off` здесь НЕ НУЖЕН, и это проверено
    // мутацией: снять его — ни один тест не краснеет. Предусловие уже
    // пускает сюда только суперпользователя или роль с BYPASSRLS, а обе
    // видят все строки независимо от этой настройки. Строка, которую нечем
    // доказать, — украшение; правило живёт в предусловии выше.
    await pg.withTransaction(async (tx) => {
      if (text.length > 0) await tx.raw(text);
      await tx.raw(record);
    });
    appliedVersions.push(migration.version);
  }

  return { appliedVersions, from, to: await pgSchemaVersion(pg) };
}

/** Строковый литерал SQL: миграции свои, но имя и контрольная сумма — данные. */
function quote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
