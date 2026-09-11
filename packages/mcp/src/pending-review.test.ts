/**
 * Кандидаты хука сжатия (§6.2, memory-7j8zgjnd0bjz) через MCP-поверхность:
 * инструменты агента зовут те же команды CLI, поэтому здесь диспетчер
 * работает поверх НАСТОЯЩЕГО `run()` со всем реестром команд (как в
 * command.ts), а не поверх подменного runCli dispatch.test.ts.
 *
 *   myc_recall — кандидат не отдаётся (фильтр ретривала, @myc/retrieval);
 *   myc_show   — по id показан, но помечен: `review: pending_review`;
 *   myc_prime  — это `myc bootstrap`: правила работы, а не память, и
 *                кандидату туда дороги нет; проверяется, что так и осталось.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRegistry, registerAll, run } from "@myc/cli";
import { migrate, migrations } from "@myc/store-sqlite";
import { createDispatcher, type Dispatch } from "./dispatch.ts";

const DECISION = "Выбрали хранить вектор внутри SQLite, потому что отдельный сервис ломает офлайн";

let dir: string;
let home: string;
let d: Dispatch;

async function cli(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  // Реестр наполняет только main.ts; процесс теста наполняет его сам — тот же
  // приём, что у веба (packages/web/src/mutate.ts).
  if (defaultRegistry.top.length === 0) registerAll(defaultRegistry);
  const r = await run(["-C", dir, ...argv], { env: { MYC_ACTOR: "tester", MYC_HOME: home } });
  return {
    code: r.code,
    stdout: typeof r.stdout === "string" ? r.stdout : [...r.stdout].join(""),
    stderr: r.stderr ?? "",
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-mcp-review-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  process.env.MYC_HOME = home;
  process.env.MYC_ACTOR = "tester";
  d = createDispatcher({ runCli: (argv) => cli(...argv) });

  const transcript = join(dir, "t.jsonl");
  writeFileSync(
    transcript,
    `${[
      { type: "user", message: { role: "user", content: "где держим векторы" } },
      { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: DECISION }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n")}\n`,
  );
  const hook = await cli("absorb-session", "--transcript", transcript, "--reason", "manual", "--session", "S-mcp");
  expect(hook.code).toBe(0);
});

afterEach(() => {
  delete process.env.MYC_HOME;
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

function candidateId(): string {
  const conn = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  const row = conn
    .query<{ id: string }, []>("SELECT id FROM nodes WHERE json_extract(attrs,'$.state')='pending_review'")
    .get();
  conn.close();
  expect(row).not.toBeNull();
  return row!.id;
}

describe("MCP: кандидат хука сжатия", () => {
  // Мутация «снять фильтр из hybridLexicalPass» роняет этот тест.
  test("myc_recall по дословному тексту кандидата его не отдаёт", async () => {
    const cand = candidateId();
    const r = await d("myc_recall", { query: DECISION });
    const rows = (r.structuredContent as { rows: { id: string }[] }).rows;
    expect(rows.map((x) => x.id)).not.toContain(cand);
    expect(rows).toEqual([]);
    expect(r.content[0]!.text).not.toContain(cand);
  });

  test("myc_show по id показывает кандидата с пометкой", async () => {
    const cand = candidateId();
    const r = await d("myc_show", { ids: [cand] });
    expect(r.content[0]!.text).toContain("unconfirmed compaction candidate");
    const nodes = (r.structuredContent as { nodes: { id: string; review?: string }[] }).nodes;
    expect(nodes[0]!.id).toBe(cand);
    expect(nodes[0]!.review).toBe("pending_review");
  });

  // Однострочный remember попадает в точный дубль кандидата и подтверждает
  // его; ответ обязан сказать именно это, а не «записано новое».
  test("myc_remember текста кандидата: verdict duplicate, written false, подтверждён", async () => {
    const cand = candidateId();
    const r = await d("myc_remember", { text: DECISION });
    const sc = r.structuredContent as { id: string; verdict: string; written: boolean; review_confirmed?: boolean };
    expect(sc.id).toBe(cand);
    expect(sc.verdict).toBe("duplicate");
    expect(sc.written).toBe(false);
    expect(sc.review_confirmed).toBe(true);
    expect(r.content[0]!.text).toContain("unconfirmed compaction candidate — confirmed now");
    const recall = await d("myc_recall", { query: DECISION });
    expect((recall.structuredContent as { rows: { id: string }[] }).rows[0]!.id).toBe(cand);
  });

  test("myc_prime — блок bootstrap, кандидата в нём нет", async () => {
    const r = await d("myc_prime", {});
    expect(r.content[0]!.text).not.toContain("сервис ломает офлайн");
  });
});
