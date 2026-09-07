import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  ensureSwarmSchema,
  HARNESSES,
  isPriceStale,
  PRICE_STALE_MS,
  Roster,
  RosterError,
  SwarmSchemaError,
  swarmMigrations,
  type AddModelInput,
} from "./index.ts";

/**
 * Тесты ростера. Часы подменяются (now) — устаревание цены и даты
 * проверяются детерминированно, без ожиданий.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-09-01T00:00:00Z");

let dir: string;
let db: Database;
let roster: Roster;
let now: number;

function input(overrides: Partial<AddModelInput> = {}): AddModelInput {
  return {
    modelId: "anthropic/claude-sonnet-5",
    family: "claude-sonnet",
    harness: "claude",
    effort: "high",
    price: { usdPerMIn: 3, usdPerMOut: 15, validFrom: now },
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-swarm-"));
  db = new Database(join(dir, "myc.db"), { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  ensureSwarmSchema(db);
  now = T0;
  roster = new Roster(db, () => now);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    // уже закрыта тестом
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("add/get", () => {
  test("модель заводится и читается обратно со всеми полями", () => {
    roster.addModel(
      input({ strengths: ["fix:module"], version: "5", tokensPerSec: 80 }),
    );
    const entry = roster.getModel("anthropic/claude-sonnet-5");
    expect(entry).toBeDefined();
    expect(entry!.model).toMatchObject({
      modelId: "anthropic/claude-sonnet-5",
      family: "claude-sonnet",
      version: "5",
      harness: "claude",
      effort: "high",
      tokensPerSec: 80,
      strengths: ["fix:module"],
      active: true,
    });
    expect(entry!.price).toMatchObject({ usdPerMIn: 3, usdPerMOut: 15 });
    expect(entry!.priceStale).toBe(false);
    expect(entry!.priceAgeDays).toBe(0);
  });

  test("strengths по умолчанию пустой список — место под атрибуцию W11", () => {
    const model = roster.addModel(input());
    expect(model.strengths).toEqual([]);
  });

  test("повторное заведение той же модели — conflict.model, а не перезапись", () => {
    roster.addModel(input());
    expect(() => roster.addModel(input())).toThrow(RosterError);
    try {
      roster.addModel(input());
    } catch (e) {
      expect((e as RosterError).code).toBe("conflict.model");
    }
  });

  test("неизвестная модель — undefined из get, notfound.model из update", () => {
    expect(roster.getModel("nobody")).toBeUndefined();
    try {
      roster.updateModel("nobody", { effort: "low" });
      expect.unreachable();
    } catch (e) {
      expect((e as RosterError).code).toBe("notfound.model");
    }
  });
});

describe("харнесс — закрытый список (мутация 1: произвольный харнесс)", () => {
  test("add с неизвестным харнессом отвергается и записи-призрака не остаётся", () => {
    try {
      roster.addModel(input({ harness: "vim" as never }));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RosterError);
      expect((e as RosterError).code).toBe("usage.harness");
    }
    // Призрак — это строка в таблице после отвергнутой записи.
    expect(roster.getModel("anthropic/claude-sonnet-5")).toBeUndefined();
    expect(
      db.query("SELECT count(*) AS n FROM swarm_model").get(),
    ).toEqual({ n: 0 });
  });

  test("update на неизвестный харнесс отвергается, старое значение не тронуто", () => {
    roster.addModel(input());
    try {
      roster.updateModel("anthropic/claude-sonnet-5", { harness: "ed" as never });
      expect.unreachable();
    } catch (e) {
      expect((e as RosterError).code).toBe("usage.harness");
    }
    expect(roster.getModel("anthropic/claude-sonnet-5")!.model.harness).toBe("claude");
  });

  test("CHECK схемы отвергает неизвестный харнесс даже мимо домена", () => {
    expect(() =>
      db
        .query(
          `INSERT INTO swarm_model (model_id, family, harness, created_at, updated_at)
           VALUES ('x', 'f', 'vim', 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    expect(db.query("SELECT count(*) AS n FROM swarm_model").get()).toEqual({ n: 0 });
  });

  test("все заявленные харнессы проходят", () => {
    for (const harness of HARNESSES) {
      roster.addModel(input({ modelId: `p/m-${harness}`, harness }));
    }
    expect(roster.listModels().length).toBe(HARNESSES.length);
  });
});

describe("цена — факт с датой (мутация 2: цена без даты)", () => {
  test("цена без validFrom отвергается на add и на update", () => {
    const noDate = { usdPerMIn: 1, usdPerMOut: 2, validFrom: 0 };
    try {
      roster.addModel(input({ price: noDate }));
      expect.unreachable();
    } catch (e) {
      expect((e as RosterError).code).toBe("usage.price");
    }
    roster.addModel(input());
    try {
      roster.updateModel("anthropic/claude-sonnet-5", { price: noDate });
      expect.unreachable();
    } catch (e) {
      expect((e as RosterError).code).toBe("usage.price");
    }
  });

  test("каждая записанная цена хранит дату, и это та дата, которую передали", () => {
    const date = Date.parse("2026-06-15T00:00:00Z");
    roster.addModel(input({ price: { usdPerMIn: 3, usdPerMOut: 15, validFrom: date } }));
    const rows = db
      .query("SELECT valid_from FROM swarm_model_price")
      .all() as Array<{ valid_from: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.valid_from).toBe(date);
    expect(rows[0]!.valid_from).toBeGreaterThan(0);
  });

  test("протухшая цена помечается, свежая — нет", () => {
    roster.addModel(
      input({ price: { usdPerMIn: 3, usdPerMOut: 15, validFrom: now - 200 * DAY_MS } }),
    );
    const stale = roster.getModel("anthropic/claude-sonnet-5")!;
    expect(stale.priceStale).toBe(true);
    expect(stale.priceAgeDays).toBe(200);

    roster.addModel(
      input({
        modelId: "zai/glm-5.3",
        family: "glm",
        harness: "opencode",
        price: { usdPerMIn: 1, usdPerMOut: 2, validFrom: now - 10 * DAY_MS },
      }),
    );
    const fresh = roster.getModel("zai/glm-5.3")!;
    expect(fresh.priceStale).toBe(false);
    expect(fresh.priceAgeDays).toBe(10);

    // Граница порога честная: PRICE_STALE_MS ровно — ещё не протухло.
    expect(isPriceStale(now - PRICE_STALE_MS, now)).toBe(false);
    expect(isPriceStale(now - PRICE_STALE_MS - 1, now)).toBe(true);
  });

  test("смена цены — новый факт со своей датой, история не затирается", () => {
    const d1 = Date.parse("2026-01-01T00:00:00Z");
    roster.addModel(input({ price: { usdPerMIn: 5, usdPerMOut: 25, validFrom: d1 } }));
    roster.updateModel("anthropic/claude-sonnet-5", {
      price: { usdPerMIn: 3, usdPerMOut: 15, validFrom: now },
    });

    const history = roster.priceHistory("anthropic/claude-sonnet-5");
    expect(history.map((p) => p.validFrom)).toEqual([now, d1]);
    expect(history.map((p) => p.usdPerMIn)).toEqual([3, 5]);

    // Действующая цена — по дате спроса, как у attempt.started_at в §2.2.
    const mid = Date.parse("2026-06-01T00:00:00Z");
    expect(roster.getModel("anthropic/claude-sonnet-5", mid)!.price!.usdPerMIn).toBe(5);
    expect(roster.getModel("anthropic/claude-sonnet-5")!.price!.usdPerMIn).toBe(3);
  });
});

describe("мягкое удаление (мутация 3: физическое стирание)", () => {
  test("disable прячет из list, но запись и история цен остаются", () => {
    roster.addModel(input());
    roster.disableModel("anthropic/claude-sonnet-5");

    expect(roster.listModels()).toEqual([]);
    const all = roster.listModels({ includeInactive: true });
    expect(all.length).toBe(1);
    expect(all[0]!.model.active).toBe(false);

    // Атрибуция на закрытых задачах ссылается на model_id: чтение обязано
    // пережить удаление, вместе с историей цен.
    const entry = roster.getModel("anthropic/claude-sonnet-5");
    expect(entry).toBeDefined();
    expect(entry!.model.active).toBe(false);
    expect(entry!.price).not.toBeNull();
    expect(roster.priceHistory("anthropic/claude-sonnet-5").length).toBe(1);

    // И на уровне таблицы строка тоже обязана быть — физический DELETE краснит тест.
    const row = db
      .query("SELECT active FROM swarm_model WHERE model_id = ?1")
      .get("anthropic/claude-sonnet-5") as { active: number } | null;
    expect(row).not.toBeNull();
    expect(row!.active).toBe(0);
  });

  test("enable возвращает модель в ростер", () => {
    roster.addModel(input());
    roster.disableModel("anthropic/claude-sonnet-5");
    roster.enableModel("anthropic/claude-sonnet-5");
    expect(roster.listModels().length).toBe(1);
  });

  test("disable неизвестной модели — notfound.model", () => {
    try {
      roster.disableModel("nobody");
      expect.unreachable();
    } catch (e) {
      expect((e as RosterError).code).toBe("notfound.model");
    }
  });
});

describe("update", () => {
  test("меняет поля выборочно, updated_at двигается", () => {
    roster.addModel(input());
    now += 1000;
    const updated = roster.updateModel("anthropic/claude-sonnet-5", {
      effort: "low",
      strengths: ["docs:local", "fix:module"],
    });
    expect(updated.effort).toBe("low");
    expect(updated.strengths).toEqual(["docs:local", "fix:module"]);
    expect(updated.harness).toBe("claude");
    expect(updated.updatedAt).toBe(T0 + 1000);
    expect(updated.createdAt).toBe(T0);
  });
});

describe("схема", () => {
  test("накат идемпотентен: второй ensureSwarmSchema — холостой", () => {
    ensureSwarmSchema(db);
    const rows = db
      .query("SELECT version, name FROM swarm_schema_migrations ORDER BY version")
      .all() as Array<{ version: number; name: string }>;
    expect(rows).toEqual([
      { version: 1, name: "swarm_model" },
      { version: 2, name: "swarm_model_price" },
      { version: 3, name: "swarm_attempt" },
      { version: 4, name: "swarm_attempt_task" },
      { version: 5, name: "swarm_attempt_arm" },
      { version: 6, name: "swarm_attempt_run" },
      { version: 7, name: "swarm_attempt_run_session" },
    ]);
  });

  test("правка DDL задним числом — schema.checksum, а не молчаливое расхождение", () => {
    const tampered = swarmMigrations.map((m, i) =>
      i === 0 ? { ...m, sql: `${m.sql} -- правка после наката` } : m,
    );
    expect(() => ensureSwarmSchema(db, tampered)).toThrow(SwarmSchemaError);
    try {
      ensureSwarmSchema(db, tampered);
    } catch (e) {
      expect((e as SwarmSchemaError).code).toBe("schema.checksum");
    }
  });

  test("объект, не появившийся в sqlite_master, роняет накат", () => {
    const ghost = swarmMigrations.map((m, i) =>
      i === 0 ? { ...m, version: 5, objects: [...m.objects, "ghost_table"] } : m,
    );
    const fresh = new Database(join(dir, "ghost.db"), { create: true });
    try {
      ensureSwarmSchema(fresh, ghost.filter((m) => m.version === 5));
      expect.unreachable();
    } catch (e) {
      expect((e as SwarmSchemaError).code).toBe("schema.objects");
      expect((e as Error).message).toContain("ghost_table");
    }
    fresh.close();
  });

  test("база новее бинаря — schema.newer", () => {
    db.query(
      "INSERT INTO swarm_schema_migrations (version, name, checksum, applied_at) VALUES (99, 'future', 'x', 1)",
    ).run();
    try {
      ensureSwarmSchema(db);
      expect.unreachable();
    } catch (e) {
      expect((e as SwarmSchemaError).code).toBe("schema.newer");
    }
  });

  test("каждая миграция — ровно один оператор", () => {
    for (const migration of swarmMigrations) {
      const body = migration.sql
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n");
      expect(body).not.toContain(";");
    }
  });
});
