/**
 * S65: `site_id` привязан к физическому экземпляру базы.
 *
 * Правила проверяются не на выдуманных числах, а на НАСТОЯЩИХ файлах: копия
 * делается `cp -R`, переезд — `mv`, восстановление — `rsync`. Смысл теста в
 * том, что решение опирается на поведение файловой системы, а его надо
 * измерять, а не предполагать; если на какой-то платформе `cp` начнёт
 * сохранять инод, тест это покажет, а не архитектура окажется неверной молча.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  decideSiteId,
  machineId,
  observeInstance,
  parseInstance,
  renderInstance,
  sameInstance,
  type SiteInstance,
} from "./site-identity.ts";

let root: string;
let counter = 0;
const mint = (): string => `local-slug-mint${++counter}`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "myc-site-id-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Каталог воркспейса с настоящим файлом базы внутри. */
function workspace(name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, ".myc"), { recursive: true });
  writeFileSync(join(dir, ".myc", "myc.db"), "not-really-sqlite");
  return dir;
}

function dbOf(dir: string): string {
  return join(dir, ".myc", "myc.db");
}

describe("наблюдение экземпляра на настоящей ФС", () => {
  test("cp -R даёт ДРУГОЙ инод: копия каталога опознаётся как новый экземпляр", () => {
    const src = workspace("cp-src");
    const dst = join(root, "cp-dst");
    cpSync(src, dst, { recursive: true });
    const a = observeInstance(dbOf(src));
    const b = observeInstance(dbOf(dst));
    expect(b.ino).not.toBe(a.ino);
    expect(sameInstance(a, b)).toBe(false);
  });

  test("mv каталога сохраняет инод и меняет путь: тот же экземпляр", () => {
    const src = workspace("mv-src");
    const before = observeInstance(dbOf(src));
    const dst = join(root, "mv-dst");
    renameSync(src, dst);
    const after = observeInstance(dbOf(dst));
    expect(after.ino).toBe(before.ino);
    expect(after.path).not.toBe(before.path);
    expect(sameInstance(before, after)).toBe(true);
  });

  test("жизненный цикл sqlite инод не меняет: вставки, VACUUM, чекпоинт, закрытие", () => {
    const dir = workspace("sqlite");
    const path = dbOf(dir);
    rmSync(path);
    const db = new Database(path, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("CREATE TABLE t(a)");
    const before = observeInstance(path);
    for (let i = 0; i < 2000; i++) db.run("INSERT INTO t VALUES (?)", [i]);
    db.run("DELETE FROM t");
    db.run("VACUUM");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    const mid = observeInstance(path);
    db.close();
    const after = observeInstance(path);
    expect(mid.ino).toBe(before.ino);
    expect(after.ino).toBe(before.ino);
    expect(sameInstance(before, after)).toBe(true);
  });

  test("симлинк на базу — тот же экземпляр: identity берётся с цели, не с ссылки", () => {
    const dir = workspace("symlink");
    const direct = observeInstance(dbOf(dir));
    const link = join(root, "link-to-db");
    symlinkSync(dbOf(dir), link);
    expect(observeInstance(link).ino).toBe(direct.ino);
    expect(sameInstance(direct, observeInstance(link))).toBe(true);
  });

  test("rsync без --inplace поверх существующей базы меняет инод — известный лишний перевыпуск", () => {
    const rsync = spawnSync("rsync", ["--version"], { encoding: "utf8" });
    if (rsync.status !== 0) return; // rsync есть не везде; правило от него не зависит
    const dir = workspace("rsync");
    const backup = join(root, "backup.db");
    writeFileSync(backup, "backup-content");
    const before = observeInstance(dbOf(dir));
    expect(spawnSync("rsync", ["-a", backup, dbOf(dir)]).status).toBe(0);
    const after = observeInstance(dbOf(dir));
    // Замер, а не желаемое: rsync пишет во временный файл и переименовывает.
    expect(after.ino).not.toBe(before.ino);
    expect(sameInstance(before, after)).toBe(false);
  });
});

describe("sameInstance: что считается тем же файлом", () => {
  const base: SiteInstance = { host: "h1", dev: 10, ino: 777, path: "/w/.myc/myc.db" };

  test("совпали (dev, ino) — тот же, даже если путь другой (mv)", () => {
    expect(sameInstance(base, { ...base, path: "/other/.myc/myc.db" })).toBe(true);
  });

  test("сменился только dev, путь тот же — перемонтирование, а не копия", () => {
    expect(sameInstance(base, { ...base, dev: 11 })).toBe(true);
  });

  test("другой ino — всегда другой экземпляр", () => {
    expect(sameInstance(base, { ...base, ino: 778 })).toBe(false);
  });

  test("другая машина — другой экземпляр, даже при совпадении dev и ino", () => {
    // Два Mac с настройками по умолчанию делят номер загрузочного тома;
    // без host копия на вторую машину прошла бы незамеченной.
    expect(sameInstance(base, { ...base, host: "h2" })).toBe(false);
  });

  test("сменился dev И путь — считаем копией: ошибка в безопасную сторону", () => {
    expect(sameInstance(base, { ...base, dev: 11, path: "/elsewhere/myc.db" })).toBe(false);
  });

  test("machineId стабилен в пределах процесса и не пуст", () => {
    expect(machineId().length).toBeGreaterThan(0);
    expect(machineId()).toBe(machineId());
  });
});

describe("decideSiteId", () => {
  const inst: SiteInstance = { host: "h1", dev: 10, ino: 777, path: "/w/.myc/myc.db" };

  test("пустая база — выпуск нового site_id и запись экземпляра", () => {
    const d = decideSiteId({ observed: inst, mint });
    expect(d.origin).toBe("minted");
    expect(d.siteId).toMatch(/^local-slug-mint\d+$/);
    expect(parseInstance(d.instance)).toEqual(inst);
  });

  test("site_id есть, экземпляра нет — усыновление, а НЕ перевыпуск", () => {
    // База из до-S65 времён: перевыпуск наугад раздробил бы site_id разом у
    // всех существующих воркспейсов, включая нескопированные.
    const d = decideSiteId({ stored: "local-old-1", observed: inst, mint });
    expect(d.origin).toBe("adopted");
    expect(d.siteId).toBe("local-old-1");
    expect(parseInstance(d.instance)).toEqual(inst);
    expect(d.reissuedFrom).toBeUndefined();
  });

  test("экземпляр совпал — ничего не меняется и ничего не пишется", () => {
    const d = decideSiteId({
      stored: "local-old-1",
      storedInstance: renderInstance(inst),
      observed: inst,
      mint,
    });
    expect(d.origin).toBe("existing");
    expect(d.siteId).toBe("local-old-1");
    expect(d.instance).toBeUndefined();
    expect(d.predecessors).toBeUndefined();
  });

  test("тот же файл по другому пути (mv) — site_id прежний, запись обновлена", () => {
    const moved = { ...inst, path: "/moved/.myc/myc.db" };
    const d = decideSiteId({
      stored: "local-old-1",
      storedInstance: renderInstance(inst),
      observed: moved,
      mint,
    });
    expect(d.origin).toBe("existing");
    expect(d.siteId).toBe("local-old-1");
    expect(parseInstance(d.instance)).toEqual(moved);
  });

  test("другой экземпляр — перевыпуск, прежний site_id уходит в предшественники", () => {
    const copy = { ...inst, ino: 999, path: "/copyA/.myc/myc.db" };
    const d = decideSiteId({
      stored: "local-old-1",
      storedInstance: renderInstance(inst),
      observed: copy,
      mint,
    });
    expect(d.origin).toBe("reissued");
    expect(d.reissuedFrom).toBe("local-old-1");
    expect(d.siteId).not.toBe("local-old-1");
    expect(JSON.parse(d.predecessors!)).toEqual(["local-old-1"]);
    expect(parseInstance(d.instance)).toEqual(copy);
  });

  test("повторное открытие копии второй раз НЕ перевыпускает", () => {
    const copy = { ...inst, ino: 999, path: "/copyA/.myc/myc.db" };
    const first = decideSiteId({
      stored: "local-old-1",
      storedInstance: renderInstance(inst),
      observed: copy,
      mint,
    });
    const second = decideSiteId({
      stored: first.siteId,
      storedInstance: first.instance!,
      storedPredecessors: first.predecessors!,
      observed: copy,
      mint,
    });
    expect(second.origin).toBe("existing");
    expect(second.siteId).toBe(first.siteId);
  });

  test("цепочка предшественников копится, а не затирается", () => {
    const one = { ...inst, ino: 999 };
    const two = { ...inst, ino: 1000 };
    const a = decideSiteId({
      stored: "s0",
      storedInstance: renderInstance(inst),
      observed: one,
      mint,
    });
    const b = decideSiteId({
      stored: a.siteId,
      storedInstance: a.instance!,
      storedPredecessors: a.predecessors!,
      observed: two,
      mint,
    });
    expect(JSON.parse(b.predecessors!)).toEqual(["s0", a.siteId]);
  });

  test("испорченный JSON экземпляра — усыновление, а не перевыпуск и не падение", () => {
    const d = decideSiteId({
      stored: "local-old-1",
      storedInstance: "{это не json",
      observed: inst,
      mint,
    });
    expect(d.origin).toBe("adopted");
    expect(d.siteId).toBe("local-old-1");
  });

  test("настоящая копия каталога проходит весь путь: cp -R → перевыпуск", () => {
    const src = workspace("decide-src");
    const dst = join(root, "decide-dst");
    const original = observeInstance(dbOf(src));
    const stored = { siteId: "local-origin-ncross", instance: renderInstance(original) };
    cpSync(src, dst, { recursive: true });

    // Оригинал открывается снова — ничего не меняется.
    const same = decideSiteId({
      stored: stored.siteId,
      storedInstance: stored.instance,
      observed: observeInstance(dbOf(src)),
      mint,
    });
    expect(same.origin).toBe("existing");
    expect(same.siteId).toBe("local-origin-ncross");

    // Копия открывается впервые — свой site_id, старый в предшественниках.
    const copy = decideSiteId({
      stored: stored.siteId,
      storedInstance: stored.instance,
      observed: observeInstance(dbOf(dst)),
      mint,
    });
    expect(copy.origin).toBe("reissued");
    expect(copy.siteId).not.toBe(same.siteId);
    expect(JSON.parse(copy.predecessors!)).toEqual(["local-origin-ncross"]);
  });
});
