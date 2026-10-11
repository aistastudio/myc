/**
 * ПРОТОКОЛ ОБМЕНА — ТО, ЧТО ПРОВЕРЯЕТСЯ БЕЗ БАЗЫ.
 *
 * Здесь две темы, и обе про доверие. Первая: всё, что приезжает по сети, —
 * ЧУЖИЕ ДАННЫЕ, и `parseOp`/`parseWatermarks` обязаны отказывать, а не
 * пропускать «почти правильное». Вторая: выборка для пира обязана слушаться
 * потолков и правильно понимать разреженный вектор вод — сайт, которого в
 * нём нет, пир не видел вовсе.
 *
 * Сквозная сходимость двух настоящих баз проверяется отдельно и на живом
 * сервере: packages/cli/src/sync.pg.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runSync } from "./effect.ts";
import { resolveQueryText, type DbDriver, type QueryDef, type TxMode } from "./sql.ts";
import {
  collectForPeer,
  localWatermarks,
  opsForPeerQuery,
  parseOp,
  parseWatermarks,
  rowToOp,
  SYNC_MAX_OPS,
  watermarksOf,
  type OplogRow,
} from "./sync.ts";
import { packHlc, type Op } from "./oplog.ts";

const set = (site: string, seq: number, ts: number, ctr: number, entity: string): Op => ({
  op_id: `${site}:${seq}`,
  seq,
  hlc: { ts, ctr },
  site_id: site,
  entity_id: entity,
  field: "title",
  op: "set",
  value: `заголовок ${seq}`,
});

describe("разбор чужой операции", () => {
  test("целая операция проходит, и проходит ровно той же", () => {
    const op = set("siteA", 7, 1000, 1, "n-1");
    expect(parseOp(JSON.parse(JSON.stringify(op)))).toEqual(op);
  });

  test("op_id обязан совпадать с парой (site_id, seq)", () => {
    // Ключ идемпотентности — единственное, чем дедупликация отличает
    // операции. Подделанная пара означала бы, что повтор не узнают.
    const op = { ...set("siteA", 7, 1000, 1, "n-1"), op_id: "siteA:9" };
    expect(parseOp(op)).toBeUndefined();
  });

  test("отказ вместо догадки на каждом негодном поле", () => {
    const good = set("siteA", 7, 1000, 1, "n-1");
    expect(parseOp({ ...good, op: "purge" })).toBeUndefined();
    expect(parseOp({ ...good, site_id: "" })).toBeUndefined();
    expect(parseOp({ ...good, entity_id: "" })).toBeUndefined();
    expect(parseOp({ ...good, hlc: { ts: -1, ctr: 0 }, op_id: "siteA:7" })).toBeUndefined();
    expect(parseOp({ ...good, hlc: 12345 })).toBeUndefined();
    expect(parseOp({ ...good, field: 7 })).toBeUndefined();
    expect(parseOp(null)).toBeUndefined();
    expect(parseOp("не объект")).toBeUndefined();
  });

  test("значение проверяется по виду операции, а не «как-нибудь»", () => {
    const base = set("siteA", 7, 1000, 1, "n-1");
    expect(parseOp({ ...base, op: "inc", value: "два" })).toBeUndefined();
    expect(parseOp({ ...base, op: "inc", value: 2 })).toBeDefined();
    expect(parseOp({ ...base, op: "edge_add", value: {} })).toBeUndefined();
    expect(parseOp({ ...base, op: "edge_add", value: { tag: "t" } })).toBeDefined();
    expect(parseOp({ ...base, op: "edge_del", value: { tags: [1] } })).toBeUndefined();
    expect(parseOp({ ...base, op: "edge_del", value: { tags: ["t"] } })).toBeDefined();
  });

  test("воды: отрицательных и нечисловых не бывает", () => {
    expect(parseWatermarks({ siteA: "123" })).toEqual({ siteA: "123" });
    expect(parseWatermarks({ siteA: 123 })).toEqual({ siteA: "123" });
    expect(parseWatermarks(undefined)).toEqual({});
    expect(parseWatermarks({ siteA: "-1" })).toBeUndefined();
    expect(parseWatermarks({ siteA: "дом" })).toBeUndefined();
    expect(parseWatermarks({ "": "1" })).toBeUndefined();
    expect(parseWatermarks([1, 2])).toBeUndefined();
  });

  test("воды пакета — максимум по каждому сайту, и они не опускаются", () => {
    const ops = [set("a", 1, 10, 0, "n"), set("a", 2, 30, 0, "n"), set("b", 1, 20, 0, "n")];
    const w = watermarksOf(ops);
    expect(w["a"]).toBe(packHlc({ ts: 30, ctr: 0 }).toString());
    expect(w["b"]).toBe(packHlc({ ts: 20, ctr: 0 }).toString());
    // Уже известная вода выше — она и остаётся: «забыть» принятое значит
    // попросить его ещё раз.
    const higher = packHlc({ ts: 99, ctr: 0 }).toString();
    expect(watermarksOf(ops, { a: higher })["a"]).toBe(higher);
  });
});

describe("запрос под размер вектора вод", () => {
  test("число плейсхолдеров сходится со списком параметров при любой арности", () => {
    // Несоответствие ловит сам defineQueries — проверяем, что оно и не
    // возникает: запрос строится, а не пишется руками.
    for (const n of [0, 1, 2, 5]) {
      const q = opsForPeerQuery(n);
      expect(q.params.length).toBe(1 + n * 2 + 1);
      expect(q.sql).toContain(`LIMIT ?${2 + n * 2}`);
    }
  });

  test("неизвестный пиру сайт не исключается: NOT IN перечисляет только известные", () => {
    const q = opsForPeerQuery(2);
    expect(q.sql).toContain("site_id NOT IN (?2, ?4)");
    expect(opsForPeerQuery(0).sql).not.toContain("NOT IN");
  });

  test("отбор пропускает только реплицируемые виды: журнал пиру не едет", () => {
    // Журнальные строки (claim аренды, purge) не проецируются в Op — rowToOp
    // падает на них намеренно (§9.4: аренда локальна). Белый список в отборе
    // — то, что не даёт обмену упасть на первом же claim (memory-6js4sp142hvt).
    // Список обязан совпадать с parseOp: parseOp принимает ровно эти четыре.
    for (const n of [0, 1, 3]) {
      const q = opsForPeerQuery(n);
      expect(q.sql).toContain("op IN ('set','inc','edge_add','edge_del')");
    }
  });
});

describe("выборка для пира на живой базе", () => {
  const DDL = readFileSync(
    join(import.meta.dir, "..", "..", "..", "db", "schema.sqlite.sql"),
    "utf8",
  );

  /**
   * Драйвер прямо здесь: ядро не зависит от движка, и тест ядра тоже не
   * должен — иначе проверялась бы связка, а не правило.
   */
  function driverOf(db: Database): DbDriver {
    const d: DbDriver = {
      dialect: "sqlite",
      one: <T,>(q: QueryDef, p: readonly unknown[]): T | undefined =>
        (db.query(resolveQueryText(q, "sqlite")).get(...(p as never[])) ?? undefined) as T | undefined,
      all: <T,>(q: QueryDef, p: readonly unknown[]): T[] =>
        db.query(resolveQueryText(q, "sqlite")).all(...(p as never[])) as T[],
      run: (q: QueryDef, p: readonly unknown[]): { changes: number } => {
        const r = db.query(resolveQueryText(q, "sqlite")).run(...(p as never[]));
        return { changes: Number(r.changes) };
      },
      tx: <T,>(_mode: TxMode, fn: (tx: DbDriver) => T): T => fn(d),
    };
    return d;
  }

  function seeded(): DbDriver {
    const db = new Database(":memory:");
    db.exec(DDL);
    const add = (site: string, seq: number, ts: number, scope: string, value: string): void => {
      db.query(
        `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id, field, value, scope, origin)
         VALUES (?, ?, ?, ?, '', 'set', 'node', 'n-1', 'title', ?, ?, 0)`,
      ).run(`${site}:${seq}`, site, Number(packHlc({ ts, ctr: 0 })), ts, JSON.stringify(value), scope);
    };
    add("a", 1, 100, "ws", "первая");
    add("a", 2, 200, "ws", "вторая");
    add("b", 1, 150, "ws", "чужая");
    // Операция ДРУГОГО воркспейса: в пакет попадать не должна.
    add("c", 1, 120, "other", "не отсюда");
    // Журнальная строка аренды (journalClaim, §9.4): в воркспейсе она есть,
    // пиру не едет — rowToOp на ней падает намеренно. Часы ВЫШЕ всех
    // реплицируемых, чтобы вода сайта её перекрывала: так проверяется, что
    // отбор пропускает её и при пустых водах, и под водой сайта.
    db.query(
      `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id, field, value, scope, origin)
       VALUES ('a:3', 'a', ?, 300, '', 'claim', 'node', 'n-1', 'lease', ?, 'ws', 1)`,
    ).run(Number(packHlc({ ts: 300, ctr: 0 })), JSON.stringify({ action: "claim", holder: "anna", epoch: 1, expires: 900 }));
    return driverOf(db);
  }

  test("без вод едет весь воркспейс и ничего чужого", () => {
    const d = seeded();
    const batch = runSync(collectForPeer("ws", {}), d);
    expect(batch.ops.map((o) => o.op_id)).toEqual(["a:1", "b:1", "a:2"]);
    expect(batch.more).toBe(false);
  });

  test("вода сайта отсекает его старое и не трогает остальных", () => {
    const d = seeded();
    const batch = runSync(collectForPeer("ws", { a: packHlc({ ts: 100, ctr: 0 }).toString() }), d);
    // У 'a' осталась только вторая; 'b' пир не видел вовсе — едет целиком.
    expect(batch.ops.map((o) => o.op_id)).toEqual(["b:1", "a:2"]);
  });

  test("порядок — (hlc, site_id), а не порядок записи", () => {
    const d = seeded();
    const ops = runSync(collectForPeer("ws", {}), d).ops;
    expect(ops.map((o) => o.hlc.ts)).toEqual([100, 150, 200]);
  });

  test("потолок пакета: лишняя строка становится ответом «есть ещё»", () => {
    const d = seeded();
    const batch = runSync(collectForPeer("ws", {}, 2), d);
    expect(batch.ops.length).toBe(2);
    expect(batch.more).toBe(true);
  });

  test("потолок по байтам: первая операция едет всегда, даже если одна больше", () => {
    const d = seeded();
    const batch = runSync(collectForPeer("ws", {}, SYNC_MAX_OPS, 1), d);
    // Иначе обмен встал бы навсегда на одной большой записи.
    expect(batch.ops.length).toBe(1);
    expect(batch.more).toBe(true);
  });

  test("наши воды — по одной на сайт, и это максимум сайта", () => {
    const d = seeded();
    const w = runSync(localWatermarks("ws"), d);
    expect(Object.keys(w).sort()).toEqual(["a", "b"]);
    // Воду сайта a держит журнальная claim-строка (hlc 300). Это безвредно:
    // вода отражает «что сайт видел», а пропуск реплицируемых строк ниже
    // не бывает — заявленная вода всегда покрывает и реплицируемый максимум.
    expect(w["a"]).toBe(packHlc({ ts: 300, ctr: 0 }).toString());
  });

  test("строка оплога в операцию: seq берётся из op_id, а не из колонки", () => {
    const row: OplogRow = {
      seq: 999,
      op_id: "siteA:42",
      site_id: "siteA",
      hlc: packHlc({ ts: 5, ctr: 1 }).toString(),
      ts_ms: 5,
      actor: "",
      op: "set",
      entity: "node",
      entity_id: "n-1",
      field: "title",
      value: JSON.stringify("т"),
      scope: "ws",
      origin: 0,
    };
    // 999 — номер строки ЭТОГО хранилища; операции нужен её номер на
    // сайте-источнике, иначе у реплики она перестанет быть той же самой.
    expect(rowToOp(row).seq).toBe(42);
  });
});
