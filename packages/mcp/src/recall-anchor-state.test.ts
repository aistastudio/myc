/**
 * Плашка состояния якоря через MCP `myc_recall` (docs/design/01 §7.3,
 * memory-ndw1r1kch4px). Инструмент зовёт CLI `recall` дважды — текстом и
 * конвертом, — поэтому здесь диспетчер работает поверх НАСТОЯЩЕГО `run()` со
 * всем реестром команд (тот же приём, что в pending-review.test.ts): агент
 * обязан увидеть и плашку в тексте, и поля в structuredContent.
 *
 * Мутации «не переносить» (retrieve.ts) и «без плашки» (recall.ts headPrefix)
 * роняют этот тест так же, как CLI-тест recall.anchor-state.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateId } from "@myc/core";
import { defaultRegistry, registerAll, run } from "@myc/cli";
import { GraphStore, migrate, migrations, openSqlite } from "@myc/store-sqlite";
import { createDispatcher, type Dispatch } from "./dispatch.ts";

const FACT = "Слияние RRF: константа сглаживания шестьдесят, код которой удалили";

let dir: string;
let home: string;
let d: Dispatch;

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  if (defaultRegistry.top.length === 0) registerAll(defaultRegistry);
  const r = await run(["-C", dir, ...argv], { env: { MYC_ACTOR: "tester", MYC_HOME: home } });
  return {
    code: r.code,
    stdout: typeof r.stdout === "string" ? r.stdout : [...r.stdout].join(""),
    stderr: r.stderr ?? "",
  };
}

function git(...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
  });
  if (!p.success) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

let note: string;

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "myc-mcp-anchor-state-")));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "fuse.ts"), "export function fuse(a: number[]): number[] {\n  return a.map((x) => x / 60);\n}\n");
  writeFileSync(join(dir, ".gitignore"), ".myc/\nhome/\n");
  git("add", "-A");
  git("commit", "-qm", "init");
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  process.env.MYC_HOME = home;
  process.env.MYC_ACTOR = "tester";
  d = createDispatcher({ runCli: (argv) => cli(...argv) });

  const made = await cli("remember", FACT, "--reach", "project", "--json");
  note = (JSON.parse(made.stdout) as { data: { id: string } }).data.id;
  expect((await cli("anchor", "add", note, "fuse.ts:1-3")).code).toBe(0);
  // Состояние — тем же путём, что проверка якорей: строка anchors и статус
  // узла-якоря через GraphStore (оплог).
  const driver = openSqlite(join(dir, ".myc", "myc.db"));
  try {
    const store = new GraphStore(driver, { newId: () => generateId(), siteId: "site-test", actor: "tester" });
    const a = driver.database
      .query<{ a: string }, [string]>("SELECT dst AS a FROM edges WHERE src = ?1 AND type = 'touches'")
      .get(note)!.a;
    driver.database.query("UPDATE anchors SET state = 'lost' WHERE node_id = ?1").run(a);
    store.updateNode(a, { status: "lost" });
  } finally {
    driver.close();
  }
});

afterEach(() => {
  delete process.env.MYC_HOME;
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

describe("MCP myc_recall: знание с потерянным кодом помечено", () => {
  test("текст несёт плашку и подсказку, structuredContent — поля строки и счёт", async () => {
    const r = await d("myc_recall", { query: "константа сглаживания удалили", mode: "bm25" });
    expect(r.isError).toBeUndefined();
    const text = r.content[0]!.text;
    const line = text.split("\n").find((l) => l.includes(note))!;
    expect(line).toContain("[code gone ×0.2] Слияние RRF");
    expect(text).toContain("1 code gone — unbind: myc anchor rm <id>");
    const sc = r.structuredContent as {
      rows: { id: string; anchor_state?: string; anchor_weight?: number }[];
      anchor_lost: number;
    };
    const row = sc.rows.find((x) => x.id === note)!;
    expect(row.anchor_state).toBe("lost");
    expect(row.anchor_weight).toBe(0.2);
    expect(sc.anchor_lost).toBe(1);
  });
});
