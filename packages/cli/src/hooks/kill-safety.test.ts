/**
 * Убийство процесса посреди хука (§6.2, приёмка myc-rjm).
 *
 * Компакт — момент, когда контекст теряется гарантированно, и хук обязан
 * пережить SIGKILL в любой точке. Проверяем два инварианта:
 *
 *   1. СТРОКА УЗЛА НИКОГДА НЕ ВРЁТ: если эпизод есть в графе, файл к нему
 *      лежит на диске. Обратное окно (файл уже переехал, строку вставить не
 *      успели) SIGKILL достижимо — и оно самозалечивается: следующий запуск
 *      читает шапку осиротевшего файла и восстанавливает строку. Данные не
 *      теряются ни в одном кадре.
 *   2. УЖЕ ЗАПИСАННОЕ НЕ ПРОПАДАЕТ: эпизоды прошлых прогонов на месте.
 *
 * Тест запускает НАСТОЯЩИЙ процесс CLI и убивает его SIGKILL'ом (не SIGTERM:
 * SIGKILL не даёт отработать ни одному обработчику, ровно как OOM-killer).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { EPISODES_DIR } from "./episode.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
let dir: string;
let transcript: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-kill-"));
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  transcript = join(dir, "t.jsonl");
  const rows: string[] = [];
  for (let i = 0; i < 600; i++) {
    rows.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `Решили: вариант ${i} оставляем как есть.` }],
        },
      }),
    );
  }
  writeFileSync(transcript, `${rows.join("\n")}\n`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function episodeFiles(): string[] {
  const path = join(dir, ".myc", EPISODES_DIR);
  if (!existsSync(path)) return [];
  // Скрытые `.tmp` — это незавершённая запись, а не эпизод; наружу она не видна.
  return readdirSync(path).filter((f) => !f.startsWith("."));
}

function episodeRows(): string[] {
  const conn = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  const rows = conn.query<{ id: string }, []>("SELECT id FROM nodes WHERE kind='session'").all();
  conn.close();
  return rows.map((r) => r.id);
}

function runHook(extra: string[] = []): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["bun", "run", MAIN, "-C", dir, "absorb-session", "--transcript", transcript, ...extra], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MYC_ACTOR: "tester" },
  });
}

test("SIGKILL посреди хука не оставляет полусостояния и не теряет прошлые эпизоды", async () => {
  // Базовый эпизод: он обязан пережить все последующие убийства. Заодно
  // меряем, сколько живёт полный прогон, — задержки убийства считаем от него,
  // иначе на медленной машине все выстрелы придутся в старт процесса и тест
  // не проверит ничего.
  const t0 = performance.now();
  await runHook(["--reason", "manual"]).exited;
  const fullRunMs = performance.now() - t0;
  const baseline = episodeFiles();
  expect(baseline.length).toBe(1);

  let killedAlive = 0;
  let crossedWrite = 0;
  for (let step = 1; step <= 20; step++) {
    const before = episodeFiles().length;
    const proc = runHook();
    await Bun.sleep(Math.round((fullRunMs * step * 1.2) / 20));
    const alive = proc.exitCode === null && proc.signalCode === null;
    proc.kill("SIGKILL");
    await proc.exited;

    const files = episodeFiles();
    if (alive) {
      killedAlive++;
      if (files.length > before) crossedWrite++; // убили уже ПОСЛЕ записи эпизода
    }

    // Инвариант 1: ни одной строки узла без файла. Узел, обещающий эпизод,
    // которого нет на диске, — единственное по-настоящему испорченное
    // состояние, и его быть не должно ни в одном кадре.
    const rows = new Set(episodeRows());
    const ids = new Set(files.map((f) => f.split(".")[0]!));
    expect([...rows].every((id) => ids.has(id))).toBe(true);
    // Инвариант 2: базовый эпизод на месте после каждого убийства.
    for (const f of baseline) expect(files.includes(f)).toBe(true);
  }

  // Без этих двух проверок тест мог бы «пройти», ни разу не выстрелив в живой
  // процесс и ни разу не задев окно записи.
  expect(killedAlive).toBeGreaterThan(0);
  expect(crossedWrite).toBeGreaterThan(0);

  // Спокойный прогон после серии убийств возвращает каталог в согласованное
  // состояние: осиротевшие файлы получают свои строки обратно.
  await runHook().exited;
  const rows = new Set(episodeRows());
  for (const f of episodeFiles()) expect(rows.has(f.split(".")[0]!)).toBe(true);
}, 120_000);

test("осиротевший файл эпизода усыновляется: строка восстанавливается из шапки", async () => {
  await runHook().exited;
  const dirPath = join(dir, ".myc", EPISODES_DIR);
  const real = episodeFiles()[0]!;
  const id = "orph1234567890ab";

  // Ровно то состояние, которое оставляет SIGKILL между rename и вставкой
  // строки узла: валидный файл эпизода на месте, строки в графе нет.
  const header = JSON.stringify({
    v: 1,
    id,
    reason: "compact",
    agent: "claude",
    created_at: Date.now(),
    raw_bytes: 4096,
    secrets_masked: 2,
  });
  writeFileSync(
    join(dirPath, `${id}.jsonl.zst`),
    Bun.zstdCompressSync(Buffer.from(`${header}\nсодержимое эпизода\n`, "utf8")),
  );
  expect(episodeRows()).not.toContain(id);

  expect(await runHook().exited).toBe(0);
  expect(episodeRows()).toContain(id);
  expect(episodeFiles()).toContain(real); // настоящий эпизод не пострадал

  const conn = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  const row = conn
    .query<{ adopted: number; secrets: number; acl: string }, [string]>(
      "SELECT json_extract(attrs,\'$.adopted\') AS adopted, json_extract(attrs,\'$.secrets_masked\') AS secrets, acl FROM nodes WHERE id = ?1",
    )
    .get(id);
  conn.close();
  // Восстановление видно запросом, а не прячется под «как будто так и было».
  expect(row?.adopted).toBeTruthy();
  expect(row?.secrets).toBe(2);
  expect(row?.acl).toBe("private");
}, 30_000);

test("нечитаемый файл в каталоге эпизодов не удаляется и не роняет хук", async () => {
  await runHook().exited;
  const junk = join(dir, ".myc", EPISODES_DIR, "notanepisode.jsonl.zst");
  writeFileSync(junk, "это не эпизод");

  expect(await runHook().exited).toBe(0);
  expect(existsSync(junk)).toBe(true); // непонятный файл — повод посмотреть, а не стереть
}, 30_000);

test("незавершённая запись (.tmp) наружу не видна и подметается по возрасту", async () => {
  await runHook().exited;
  const dirPath = join(dir, ".myc", EPISODES_DIR);
  const stale = join(dirPath, ".killed-mid-write.jsonl.zst.tmp");
  writeFileSync(stale, "полузапись");
  utimesSync(stale, new Date(Date.now() - 7_200_000), new Date(Date.now() - 7_200_000));

  expect(episodeFiles()).not.toContain(".killed-mid-write.jsonl.zst.tmp");
  await runHook().exited;
  expect(existsSync(stale)).toBe(false);
}, 30_000);
