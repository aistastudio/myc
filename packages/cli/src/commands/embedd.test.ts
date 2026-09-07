/**
 * Приёмка второй половины S44: фоновый прогрев эмбеддера как работа очереди.
 *
 * Настоящий ONNX здесь не грузится — прогрев подменяется. Проверяется не
 * качество векторов (это @myc/embed), а ровно то, что ломалось живым прогоном:
 * единственность демона во время прогрева, честный ответ «греюсь» вместо
 * молчания, учёт работы в `jobs` и то, что клиент никогда никого не ждёт.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import {
  DEFAULT_DAEMON_TTL_MS,
  WARM_JOB_ENTITY,
  WARM_JOB_KIND,
  embedSocketPath,
  enqueueWarmJob,
  pingEmbedDaemon,
  requestVector,
  runEmbedDaemon,
  stopEmbedDaemon,
} from "./embedd.ts";

const CLI_ENTRY = join(import.meta.dir, "..", "main.ts");

const dirs: string[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "myc-embedd-"));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function db(path: string): SqliteDriver {
  const driver = openSqlite(path);
  driver.database.exec(migration001Init.sql);
  return driver;
}

/** Эмбеддер-заглушка: прогрев занимает столько, сколько скажут. */
function fakeEmbedder(warmMs: number, state = "ok") {
  return async () => ({
    warmup: async () => {
      await new Promise((r) => setTimeout(r, warmMs));
      return state;
    },
    embed: async (text: string) => {
      const vec = new Float32Array(384);
      for (let i = 0; i < 384; i++) vec[i] = ((text.charCodeAt(i % text.length) + i) % 100) / 100;
      return { state: "ok", vec };
    },
    destroy: async () => {},
  });
}

describe("myc embedd — демон прогрева", () => {
  test("база исчезла — демон уходит, а не досиживает TTL", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    db(dbPath).close();

    // TTL заведомо больше времени теста: если демон дождётся выхода, то
    // ТОЛЬКО по сторожу за базой, а не по простою.
    const run = runEmbedDaemon({
      dbPath,
      ttlMs: 600_000,
      dbWatchMs: 25,
      createEmbedder: fakeEmbedder(0),
    });

    await new Promise((r) => setTimeout(r, 120));
    expect(await pingEmbedDaemon(embedSocketPath(dbPath), 500)).not.toBeNull();

    // Ровно то, что делает прогон тестов: каталог с базой удаляют под демоном.
    rmSync(dir, { recursive: true, force: true });

    const done = await run;
    expect(done.stopped).toBe("db_gone");
    // Сокет за собой убран — следующий демон не примет его за живого.
    expect(existsSync(embedSocketPath(dbPath))).toBe(false);
  }, 10_000);

  test("настоящий процесс демона ВЫХОДИТ, когда базы не стало", async () => {
    // Проверка выше показывает лишь, что промис разрешился; здесь — что
    // НАСТОЯЩИЙ процесс, поднятый через тот же main.ts, что и в бою, действительно
    // завершается. Ровно этот сценарий и был багом: демон переживал свой
    // воркспейс и досиживал TTL в 10 минут с базой в удалённом каталоге.
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    db(dbPath).close();

    const proc = Bun.spawn([process.execPath, CLI_ENTRY, "embedd", "--db", dbPath, "--ttl", "600000"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, MYC_EMBED_DB_WATCH_MS: "50" },
    });

    // Дать демону подняться, затем убрать базу у него из-под ног.
    await new Promise((r) => setTimeout(r, 1500));
    rmSync(dir, { recursive: true, force: true });

    const exited = await Promise.race([
      proc.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 8000)),
    ]);
    if (exited === "timeout") proc.kill("SIGKILL");
    expect(exited).not.toBe("timeout");
  }, 20_000);

  test("сокет занимается ДО прогрева: ping отвечает 'warming', второй демон не поднимается", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    db(dbPath).close();
    const socketPath = embedSocketPath(dbPath);

    // Демон греется 400 мс. За это время ping обязан ОТВЕЧАТЬ.
    const first = runEmbedDaemon({
      dbPath,
      ttlMs: 3000,
      createEmbedder: fakeEmbedder(400),
    });

    await new Promise((r) => setTimeout(r, 120));
    const early = await pingEmbedDaemon(socketPath, 500);
    expect(early).not.toBeNull();
    expect(early!.state).toBe("warming");

    // Запрос вектора во время прогрева — отказ С ПРИЧИНОЙ, а не ожидание.
    const during = await requestVector(socketPath, "вопрос", 200);
    expect(during.ok).toBe(false);
    if (!during.ok) expect(during.daemon).toBe("warming");

    // Второй экземпляр видит ответ и уходит, а не удаляет чужой сокет.
    const second = await runEmbedDaemon({ dbPath, ttlMs: 1000, createEmbedder: fakeEmbedder(0) });
    expect(second.state).toBe("already-running");

    // После прогрева — вектор.
    await new Promise((r) => setTimeout(r, 400));
    const after = await requestVector(socketPath, "вопрос", 1000);
    expect(after.ok).toBe(true);
    if (after.ok) expect(after.vec.length).toBe(384);

    await stopEmbedDaemon(socketPath);
    const run = await first;
    expect(run.stopped).toBe("signal");
    expect(run.served).toBe(1);
  }, 20_000);

  test("работа embed_warm берётся в аренду и снимается по факту прогрева", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    const driver = db(dbPath);
    const socketPath = embedSocketPath(dbPath);

    const run = runEmbedDaemon({
      dbPath,
      ttlMs: 2000,
      createEmbedder: fakeEmbedder(50),
      openQueue: () => ({ db: driver, scope: "", close: () => {} }),
    });
    await new Promise((r) => setTimeout(r, 400));

    // Прогрев состоялся — строка снята сразу, а не при выходе: убитый демон
    // не должен оставлять «вечно арендованную» работу.
    const left = driver.database
      .query("SELECT count(*) AS n FROM jobs WHERE kind = ?1")
      .get(WARM_JOB_KIND) as { n: number };
    expect(left.n).toBe(0);

    await stopEmbedDaemon(socketPath);
    const r = await run;
    expect(r.leased).toBe(true);
    expect(r.state).toBe("ok");
    driver.close();
  }, 20_000);

  test("неудачный прогрев записывает причину в jobs и не притворяется живым", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    const driver = db(dbPath);

    const r = await runEmbedDaemon({
      dbPath,
      ttlMs: 500,
      createEmbedder: fakeEmbedder(10, "degraded"),
      openQueue: () => ({ db: driver, scope: "", close: () => {} }),
    });
    expect(r.stopped).toBe("failed");
    expect(r.reason).toContain("degraded");

    const row = driver.database
      .query("SELECT last_error, lease_holder FROM jobs WHERE kind = ?1")
      .get(WARM_JOB_KIND) as { last_error: string | null; lease_holder: string } | null;
    expect(row?.last_error).toContain("degraded");
    // Аренда отпущена: следующий демон имеет право попробовать снова.
    expect(row?.lease_holder).toBe("");

    // Сокет убран за собой — иначе следующий клиент ждал бы дедлайн впустую.
    expect(await pingEmbedDaemon(embedSocketPath(dbPath), 200)).toBeNull();
    driver.close();
  }, 20_000);

  test("нет демона — запрос вектора возвращается мгновенно и говорит 'absent'", async () => {
    const dir = scratch();
    const dbPath = join(dir, "myc.db");
    db(dbPath).close();
    const t0 = performance.now();
    const r = await requestVector(embedSocketPath(dbPath), "вопрос", 5000);
    const ms = performance.now() - t0;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.daemon).toBe("absent");
    // Дедлайн был 5 секунд, но ждать нечего: горячий путь не платит за
    // отсутствие демона ничего.
    expect(ms).toBeLessThan(50);
  });

  test("постановка работы дедуплицируется и уважает исчерпанные попытки", () => {
    const dir = scratch();
    const driver = db(join(dir, "myc.db"));
    expect(enqueueWarmJob(driver, "", 1000)).toBe(true);
    expect(enqueueWarmJob(driver, "", 2000)).toBe(true);
    const n = driver.database
      .query("SELECT count(*) AS n FROM jobs WHERE kind = ?1 AND entity_id = ?2")
      .get(WARM_JOB_KIND, WARM_JOB_ENTITY) as { n: number };
    expect(n.n).toBe(1);

    driver.database.query("UPDATE jobs SET attempts = max_attempts WHERE kind = ?1").run(WARM_JOB_KIND);
    // Демон, который не поднимается, не должен переподниматься бесконечно.
    expect(enqueueWarmJob(driver, "", 3000)).toBe(false);
    driver.close();
  });

  test("путь сокета короткий и стабильный даже из глубокого каталога", () => {
    const deep = join("/tmp", "a".repeat(60), "b".repeat(60), ".myc", "myc.db");
    const p = embedSocketPath(deep);
    // Предел sun_path на macOS — 104 байта; путь обязан быть заведомо короче.
    expect(p.length).toBeLessThan(100);
    expect(embedSocketPath(deep)).toBe(p);
    expect(embedSocketPath(join("/tmp", "other", "myc.db"))).not.toBe(p);
  });

  test("TTL по умолчанию — длина рабочей сессии, а не вечность", () => {
    expect(DEFAULT_DAEMON_TTL_MS).toBe(600_000);
  });
});
