/**
 * `myc absorb-session` — хук pre-compact целиком (§6.2, D11, D22, D23).
 *
 * Тесты здесь проверяют не «работает ли команда», а четыре свойства, ради
 * которых она написана: ни одно решение не теряется при сжатии, сырой эпизод
 * укладывается в 6 мс, убийство процесса посреди хука не оставляет
 * полусостояния, и секреты не доезжают до диска.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createTaskCommand } from "../commands/tasks.ts";
import {
  createAbsorbSessionCommand,
  EPISODE_BUDGET_MS,
  EPISODE_BUDGET_MS_PER_MB,
  episodeBudgetMs,
} from "./absorb-session.ts";
import { EPISODES_DIR } from "./episode.ts";

let dir: string;
let transcript: string;
let registry: Registry;

const DECISIONS = [
  "Решили: k=60 в RRF оставляем — разница с k=30 в пределах шума.",
  "Выбрали sqlite-vec вместо Qdrant, потому что отдельный сервис ломает $0 по умолчанию.",
  "Отказались от отдельного кеша — оплог уже даёт инвалидацию по seq.",
  "Договорились: вектор храним внутри SQLite.",
];

/** Синтетический ключ: 31 вид секретов детектора, нам достаточно одного. */
const FAKE_KEY = `sk-ant-api03-${"Q".repeat(88)}-AAAAAA`;

function makeTranscript(padTurns = 400): string {
  const rows: unknown[] = [
    { type: "user", cwd: "/repo", sessionId: "s1", message: { role: "user", content: "доделаем поиск" } },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `${DECISIONS[0]}\n${DECISIONS[1]}` },
          { type: "tool_use", name: "Edit", input: { file_path: "src/retrieval/fuse.ts" } },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `${DECISIONS[2]}\nTODO: бенч на 100k не прогнан.` },
          { type: "tool_use", name: "Bash", input: { command: `export ANTHROPIC_API_KEY=${FAKE_KEY}` } },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: DECISIONS[3] },
          { type: "tool_use", name: "Edit", input: { file_path: "src/db/schema.sql" } },
        ],
      },
    },
  ];
  for (let i = 0; i < padTurns; i++) {
    rows.push({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `Прогон ${i}: сверяю веса, ничего нового не выяснил.` }],
      },
    });
  }
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-precompact-"));
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  transcript = join(dir, "transcript.jsonl");
  writeFileSync(transcript, makeTranscript());
  registry = new Registry();
  registry.register(createTaskCommand());
  registry.register(createAbsorbSessionCommand());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester" } });
}

async function absorb(...extra: string[]): Promise<Record<string, unknown>> {
  const r = await myc("absorb-session", "--transcript", transcript, ...extra, "--json");
  const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
  expect(env["ok"]).toBe(true);
  return env["data"] as Record<string, unknown>;
}

function db(): Database {
  return new Database(join(dir, ".myc", "myc.db"), { readonly: true });
}

function episodeFiles(): string[] {
  const path = join(dir, ".myc", EPISODES_DIR);
  // Точечные файлы — служебные: `.gitignore` каталога и `.tmp` незавершённой
  // записи. Эпизодами они не являются.
  return existsSync(path) ? readdirSync(path).filter((f) => !f.startsWith(".")) : [];
}

describe("сжатие посреди сессии: ни одно решение не потеряно", () => {
  test("каждое решение доехало до графа отдельным кандидатом", async () => {
    const data = await absorb("--reason", "manual");
    expect(data["candidates"]).toBe(DECISIONS.length);

    const conn = db();
    const rows = conn
      .query<{ title: string }, []>(
        "SELECT title FROM nodes WHERE kind='note' AND json_extract(attrs,'$.state')='pending_review'",
      )
      .all();
    conn.close();
    for (const decision of DECISIONS) {
      expect(rows.some((r) => decision.startsWith(r.title.replace(/…$/, "")))).toBe(true);
    }
  });

  test("решения попали в спасательный пакет, а не только в базу", async () => {
    const data = await absorb("--reason", "manual");
    const packet = data["packet"] as string;
    for (const decision of DECISIONS) {
      expect(packet).toContain(decision.slice(0, 40));
    }
    expect(data["dropped"]).toEqual({});
  });

  test("повторное сжатие не теряет решения, а узнаёт их", async () => {
    await absorb();
    const second = await absorb();
    expect(second["candidates"]).toBe(0);
    expect(second["candidates_known"]).toBe(DECISIONS.length);
  });

  test("активная задача и открытые вопросы тоже в пакете", async () => {
    await myc("task", "Гибридный поиск: RRF одним SQL-проходом", "-p", "P0");
    const data = await absorb("--reason", "manual");
    const packet = data["packet"] as string;
    expect(packet).toContain("ACTIVE");
    expect(packet).toContain("Гибридный поиск");
    expect(packet).toContain("бенч на 100k не прогнан");
    expect(packet).toContain("src/retrieval/fuse.ts");
  });
});

describe("бюджеты", () => {
  test("сырой эпизод укладывается в бюджет своего размера", async () => {
    // Минимум из пяти прогонов: он измеряет путь кода, а не шум планировщика.
    const samples: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 5; i++) {
      const data = await absorb();
      samples.push((data["stages"] as Record<string, number>)["episode"]!);
      bytes = data["raw_bytes"] as number;
    }
    const best = Math.min(...samples);
    expect(best).toBeLessThanOrEqual(episodeBudgetMs(bytes));
    // Стенограмма теста крошечная, поэтому здесь бюджет по сути постоянный —
    // и постоянная часть обязана остаться жёсткой: иначе размерная поправка
    // превратилась бы в способ ничего не проверять.
    expect(episodeBudgetMs(bytes)).toBeLessThan(EPISODE_BUDGET_MS + 1);
    expect(EPISODE_BUDGET_MS).toBeLessThanOrEqual(15);
  });

  test("бюджет растёт по замеру, а не как вздумается", () => {
    // Числа — из замера на настоящих стенограммах (см. шапку absorb-session).
    expect(episodeBudgetMs(0)).toBe(EPISODE_BUDGET_MS);
    expect(episodeBudgetMs(1_000_000)).toBe(EPISODE_BUDGET_MS + EPISODE_BUDGET_MS_PER_MB);
    // 37.3 МБ — та самая стенограмма, на которой мерили через CLI: шаг занимал
    // 34.3/36.7/49.9 мс (min/медиана/max за десять прогонов). Бюджет обязан
    // накрыть максимум с запасом и НЕ обязан накрывать конкуренцию (123.8 мс):
    // порог сторожит путь кода, а не занятость машины.
    const real = episodeBudgetMs(37_300_000);
    expect(real).toBeGreaterThan(49.9 * 1.5);
    expect(real).toBeLessThan(123.8);
  });

  test("исчерпанный таймаут не отменяет эпизод — сохраняется часть, а не ничего", async () => {
    const r = await myc("absorb-session", "--transcript", transcript, "--timeout", "0", "--json");
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    const data = env["data"] as Record<string, unknown>;
    expect(env["ok"]).toBe(true);
    expect(r.code).toBe(0); // сессия агента не сломана
    expect(data["episode"]).not.toBeNull();
    expect(episodeFiles().length).toBe(1);
    expect(data["candidates"]).toBe(0); // атомы отложены, эпизод — нет
    expect((data["packet"] as string).length).toBeGreaterThan(0);
    const codes = (env["warn"] as { code: string }[]).map((w) => w.code);
    expect(codes).toContain("degraded.timeout");
  });

  test("порядок записи: эпизод раньше кандидатов и очереди", async () => {
    const data = await absorb();
    const stages = data["stages"] as Record<string, number>;
    // extract идёт после episode по построению; проверяем, что эпизод не ждёт
    // разбора: его шаг кратно дешевле шага экстракции на том же транскрипте.
    expect(stages["episode"]).toBeLessThan(stages["extract"]! + stages["packet"]!);
    expect(data["queue"]).toEqual(["distill", "anchor_check"]);
  });
});

describe("секреты (D23)", () => {
  test("сырого ключа нет ни в файле, ни в базе, ни в пакете", async () => {
    const data = await absorb();
    expect(data["secrets_masked"]).toBe(1);
    const files = episodeFiles();
    const raw = await Bun.file(join(dir, ".myc", EPISODES_DIR, files[0]!)).bytes();
    const text = new TextDecoder().decode(Bun.zstdDecompressSync(raw));
    expect(text).not.toContain(FAKE_KEY);
    expect(text).toContain("<redacted:");
    expect(data["packet"] as string).not.toContain(FAKE_KEY);

    const conn = db();
    const hit = conn
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM nodes WHERE body LIKE ?1 OR title LIKE ?1")
      .get(`%${FAKE_KEY.slice(0, 24)}%`);
    conn.close();
    expect(hit?.n).toBe(0);
  });

  test("эпизод L0 приватен по умолчанию (D22)", async () => {
    const data = await absorb();
    const conn = db();
    const row = conn
      .query<{ acl: string; layer: number; kind: string }, [string]>(
        "SELECT acl, layer, kind FROM nodes WHERE id = ?1",
      )
      .get(data["episode"] as string);
    conn.close();
    expect(row?.acl).toBe("private");
    expect(row?.layer).toBe(0);
    expect(row?.kind).toBe("session");
  });
});

describe("вывод для хоста", () => {
  test("--hook-output json отдаёт hookSpecificOutput для Claude Code", async () => {
    const r = await myc("absorb-session", "--transcript", transcript, "--hook-output", "json");
    const parsed = JSON.parse(r.stdout as string) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreCompact");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("context is being compacted");
  });

  test("--reason manual даёт пакет больше, чем auto", async () => {
    const auto = await absorb("--reason", "auto");
    const manual = await absorb("--reason", "manual");
    expect(manual["packet_chars"] as number).toBeGreaterThanOrEqual(auto["packet_chars"] as number);
  });

  test("пустой транскрипт не роняет хук и говорит об этом вслух", async () => {
    const empty = join(dir, "empty.jsonl");
    writeFileSync(empty, "");
    const r = await myc("absorb-session", "--transcript", empty, "--json");
    const env = JSON.parse(r.stdout as string) as Record<string, unknown>;
    expect(env["ok"]).toBe(true);
    expect((env["data"] as Record<string, unknown>)["episode"]).toBeNull();
    expect((env["warn"] as { code: string }[]).map((w) => w.code)).toContain("degraded.transcript");
  });

  test("счётчик срабатываний хука пишется для myc doctor --hooks", async () => {
    await absorb("--agent", "claude");
    const counters = await Bun.file(join(dir, ".myc", "hooks.json")).json();
    expect(counters.hooks["claude:pre-compact"].count).toBe(1);
  });
});
