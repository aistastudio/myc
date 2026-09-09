/**
 * Стенограмма доходит до `absorb-session` у КАЖДОГО харнесса (memory-pqtyqnej23b7).
 *
 * Тест существует потому, что дыра была найдена не здесь, а на живом проекте:
 * плагин opencode одиннадцать сжатий подряд звал `absorb-session` вообще без
 * ввода, честно получал статус `empty` — и ни одного эпизода в базе. Проверять
 * это сравнением строк шаблона бесполезно: сломаться может и получение
 * стенограммы, и её формат, и передача на stdin. Поэтому здесь запускается
 * СГЕНЕРИРОВАННЫЙ ФАЙЛ целиком, с настоящим `myc absorb-session` на другом
 * конце, а утверждение — про узел в базе, а не про текст шаблона.
 *
 * Мутация, снимающая передачу стенограммы (убрать вызов client.session.messages
 * у opencode, вернуть `--transcript "-"` без разрешения пути у Kimi), роняет
 * тесты этого файла: эпизод не появится.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { kimiHelper, opencodePlugin } from "./templates.ts";

const MAIN = join(import.meta.dir, "..", "main.ts");
const EVENTS = ["session-start", "pre-compact", "post-edit"] as const;

let dir: string;
/** Шим, которым `bin()` находит myc: настоящий CLI из исходников. */
let mycBin: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-harness-"));
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  mycBin = join(dir, "myc-shim.sh");
  writeFileSync(mycBin, `#!/bin/sh\nexec "${process.execPath}" run "${MAIN}" "$@"\n`);
  chmodSync(mycBin, 0o755);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface EpisodeRow {
  readonly attrs: string;
}

function episodes(): EpisodeRow[] {
  const db = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return db.query("SELECT attrs FROM nodes WHERE kind = 'session'").all() as EpisodeRow[];
  } finally {
    db.close();
  }
}

/** Ответ opencode на client.session.messages: форма из живого сервера 1.18.26. */
function fakeClient(calls: unknown[]): unknown {
  return {
    session: {
      messages: async (arg: unknown) => {
        calls.push(arg);
        return {
          data: [
            {
              info: { id: "msg_1", role: "user", modelID: "ling" },
              parts: [{ type: "text", text: "Реши задачу и запиши вывод." }],
            },
            {
              info: { id: "msg_2", role: "assistant", modelID: "ling" },
              parts: [
                { type: "text", text: "Решено: эпизод пишется из client.session.messages." },
                {
                  type: "tool",
                  tool: "edit",
                  state: { status: "completed", input: { filePath: "src/a.ts" }, output: "ok" },
                },
              ],
            },
          ],
        };
      },
    },
  };
}

async function loadPlugin(): Promise<{ hooks: any; calls: unknown[] }> {
  const file = join(dir, `plugin-${Math.random().toString(36).slice(2)}.ts`);
  writeFileSync(file, opencodePlugin({ events: [...EVENTS], hookOutput: "json" }));
  const mod = (await import(file)) as { MycPlugin: (input: unknown) => Promise<any> };
  const calls: unknown[] = [];
  const hooks = await mod.MycPlugin({ client: fakeClient(calls), directory: dir });
  return { hooks, calls };
}

test("opencode: хук сжатия берёт стенограмму у client и доводит её до эпизода", async () => {
  process.env["MYC_BIN"] = mycBin;
  const { hooks, calls } = await loadPlugin();
  const output = { context: [] as string[] };
  await hooks["experimental.session.compacting"]({ sessionID: "ses_live" }, output);

  // Стенограмму именно ПРОСИЛИ, и той формой, которую понимает 1.18.26.
  expect(calls).toEqual([{ path: { id: "ses_live" }, query: { directory: dir } }]);

  const rows = episodes();
  expect(rows.length).toBe(1);
  const attrs = JSON.parse(rows[0]!.attrs) as Record<string, unknown>;
  expect(attrs["agent"]).toBe("opencode");
  expect(attrs["origin"]).toBe("stdin");
  expect(attrs["reason"]).toBe("compact");
  // Ходы разобраны, а не свалены текстом: значит JSONL наш парсер понял.
  expect(attrs["transcript_format"]).toBe("jsonl");
  expect(attrs["turns"]).toBe(2);
  expect(attrs["raw_bytes"] as number).toBeGreaterThan(0);
  // Ключ сессии пришёл от хоста, а не выведен из эпизода (S58).
  expect(attrs["session_id"]).toBe("ses_live");
  // Правка файла из tool-части доехала: якоря опираются на неё.
  expect(attrs["files"]).toBe(1);

  // Спасательный пакет попал в единственную дверь, которая у opencode есть.
  expect(output.context.length).toBe(1);
  expect(output.context[0]!.length).toBeGreaterThan(0);
});

test("opencode: session.compacted пишет эпизод, если хука сжатия в сборке нет", async () => {
  process.env["MYC_BIN"] = mycBin;
  const { hooks } = await loadPlugin();
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ses_fb" } } });
  const rows = episodes();
  expect(rows.length).toBe(1);
  expect(JSON.parse(rows[0]!.attrs)["session_id"]).toBe("ses_fb");
});

test("opencode: два обработчика на одно сжатие не пишут два эпизода", async () => {
  process.env["MYC_BIN"] = mycBin;
  const { hooks } = await loadPlugin();
  await hooks["experimental.session.compacting"]({ sessionID: "ses_one" }, { context: [] });
  await hooks.event({ event: { type: "session.compacted", properties: { sessionID: "ses_one" } } });
  expect(episodes().length).toBe(1);
});

test("kimi: стенограмма находится по session_index.jsonl, а не читается из пустого stdin", async () => {
  const kimiHome = join(dir, "kimi-home");
  const sessionDir = join(kimiHome, "sessions", "wd_x", "session_abc");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  writeFileSync(
    join(sessionDir, "agents", "main", "wire.jsonl"),
    [
      JSON.stringify({ type: "metadata", protocol_version: "1.5" }),
      JSON.stringify({
        type: "context.append_message",
        agentId: "main",
        message: { role: "user", content: [{ type: "text", text: "Что делаем дальше?" }] },
      }),
      JSON.stringify({
        type: "context.append_message",
        agentId: "main",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Решено: стенограмму берём из wire.jsonl." }],
        },
      }),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(kimiHome, "session_index.jsonl"),
    `${JSON.stringify({ sessionId: "session_abc", sessionDir, workDir: dir })}\n`,
  );

  const helper = join(dir, "kimi-hooks.mjs");
  writeFileSync(helper, kimiHelper({ events: [...EVENTS], hookOutput: "text" }));

  const proc = Bun.spawn(["node", helper, "pre-compact"], {
    cwd: dir,
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: "PreCompact", session_id: "session_abc", cwd: dir, trigger: "auto" }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MYC_BIN: mycBin, KIMI_CODE_HOME: kimiHome },
  });
  await proc.exited;
  expect(proc.exitCode).toBe(0);

  const rows = episodes();
  expect(rows.length).toBe(1);
  const attrs = JSON.parse(rows[0]!.attrs) as Record<string, unknown>;
  expect(attrs["agent"]).toBe("kimi");
  expect(attrs["turns"]).toBe(2);
  expect(attrs["transcript_format"]).toBe("jsonl");
  expect(String(attrs["origin"])).toContain("wire.jsonl");
  expect(attrs["session_id"]).toBe("session_abc");
});

test("kimi: сессии нет в индексе — эпизода нет, и это видно по статусу, а не молча", async () => {
  const kimiHome = join(dir, "kimi-empty");
  mkdirSync(kimiHome, { recursive: true });
  writeFileSync(join(kimiHome, "session_index.jsonl"), "");
  const helper = join(dir, "kimi-hooks-2.mjs");
  writeFileSync(helper, kimiHelper({ events: [...EVENTS], hookOutput: "text" }));

  const proc = Bun.spawn(["node", helper, "pre-compact"], {
    cwd: dir,
    stdin: new TextEncoder().encode(
      JSON.stringify({ hook_event_name: "PreCompact", session_id: "нет-такой", cwd: dir }),
    ),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, MYC_BIN: mycBin, KIMI_CODE_HOME: kimiHome },
  });
  await proc.exited;
  expect(proc.exitCode).toBe(0);
  expect(episodes().length).toBe(0);
  const counters = JSON.parse(await Bun.file(join(dir, ".myc", "hooks.json")).text()) as {
    hooks: Record<string, { last_status: string }>;
  };
  expect(counters.hooks["kimi:pre-compact"]!.last_status).toBe("empty");
});
