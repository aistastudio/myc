import { describe, expect, test } from "bun:test";
import { defineQueries } from "@myc/core";
import { openPostgres, type PostgresStore } from "./index.ts";

describe("store-postgres (skeleton)", () => {
  test("PostgresStore type is assignable with dialect postgres", () => {
    const store: PostgresStore = { dialect: "postgres", schemaVersion: 1 };
    expect(store.dialect).toBe("postgres");
  });
});

describe("openPostgres (stub until M4)", () => {
  const driver = openPostgres({ url: "postgres://localhost/myc" });

  test("declares the pg dialect and the shared DbDriver contract", () => {
    expect(driver.dialect).toBe("pg");
  });

  test("one/all/run/tx throw the M4-availability error", () => {
    const def = { name: "node_get", sql: "SELECT ?1", params: ["id"] };
    expect(() => driver.one(def, ["x"])).toThrow(/M4/);
    expect(() => driver.all(def, ["x"])).toThrow(/M4/);
    expect(() => driver.run(def, ["x"])).toThrow(/M4/);
    expect(() => driver.tx("immediate", (tx) => tx.run(def, ["x"]))).toThrow(/M4/);
  });

  test("close is a safe no-op before M4", () => {
    expect(() => driver.close()).not.toThrow();
  });

  test("accepts a pg-flavoured query with an explicit override", () => {
    const Q = defineQueries({
      probe: {
        name: "probe",
        sql: "SELECT ?1",
        params: ["v"],
        pg: "SELECT $1::text",
      },
    });
    expect(Q.probe!.pg).toBe("SELECT $1::text");
    expect(() => driver.one(Q.probe!, ["x"])).toThrow(/M4/);
  });
});
