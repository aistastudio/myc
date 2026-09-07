// TODO(coordinator): switch to "@myc/core" once sql.ts is re-exported from the package root.
import type { DbDriver, QueryDef, TxMode } from "@myc/core";
import type { SCHEMA_VERSION } from "@myc/core";

export type PostgresStore = {
  readonly dialect: "postgres";
  readonly schemaVersion: typeof SCHEMA_VERSION;
};

export interface PostgresOpenOptions {
  readonly url: string;
}

export interface PostgresDriver extends DbDriver {
  readonly dialect: "pg";
  close(): void;
}

function unavailable(op: string): never {
  throw new Error(
    `Postgres driver: операция '${op}' доступна с вехи M4 (myc-123: Postgres DDL и pgvector)`,
  );
}

export function openPostgres(options: PostgresOpenOptions | string): PostgresDriver {
  void (typeof options === "string" ? options : options.url);
  const driver: PostgresDriver = {
    dialect: "pg",

    one<T>(_query: QueryDef, _params: readonly unknown[]): T | undefined {
      return unavailable("one");
    },

    all<T>(_query: QueryDef, _params: readonly unknown[]): T[] {
      return unavailable("all");
    },

    run(_query: QueryDef, _params: readonly unknown[]): { changes: number } {
      return unavailable("run");
    },

    tx<T>(_mode: TxMode, _fn: (tx: DbDriver) => T): T {
      return unavailable("tx");
    },

    close(): void {
      // соединение появится вместе с реализацией M4
    },
  };
  return driver;
}
