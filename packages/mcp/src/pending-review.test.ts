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

function jobsOf(id: string): string[] {
  const conn = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return conn
      .query<{ kind: string }, [string]>("SELECT kind FROM jobs WHERE entity_id = ?1 ORDER BY kind")
      .all(id)
      .map((r) => r.kind);
  } finally {
    conn.close();
  }
}

// Разбор через MCP (memory-79mq6fccg0jm) — без нового инструмента: список —
// режим очереди myc_ready, действие — операции myc_update. Та же команда CLI,
// что у человека.
describe("MCP: разбор кандидатов — myc_ready{review} и myc_update confirm/reject", () => {
  test("myc_ready{review:true} — список кандидатов текстом CLI и структурой", async () => {
    const cand = candidateId();
    const r = await d("myc_ready", { review: true });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).toContain("PENDING REVIEW 1");
    expect(r.content[0]!.text).toContain(cand);
    const sc = r.structuredContent as { total: number; items: { id: string }[] };
    expect(sc.total).toBe(1);
    expect(sc.items.map((i) => i.id)).toEqual([cand]);
  });

  test("myc_ready{review:true} с параметрами задач — отказ, а не молчаливый игнор", async () => {
    const r = await d("myc_ready", { review: true, claim: true });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("usage.invalid");
  });

  // Мутация «убрать ветку confirm из toolUpdate» роняет этот тест (usage.invalid).
  test("myc_update{op:confirm}: знание в myc_recall, embed и absorb в очереди", async () => {
    const cand = candidateId();
    const r = await d("myc_update", { id: cand, op: "confirm" });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as { id: string; review: string; changed: boolean; queued: string[] };
    expect(sc).toMatchObject({ id: cand, review: "confirmed", changed: true, queued: ["embed", "absorb"] });
    expect(r.content[0]!.text).toContain(`${cand} confirmed · recall and prime return it now`);
    expect(jobsOf(cand)).toEqual(["absorb", "embed"]);
    const recall = await d("myc_recall", { query: DECISION });
    expect((recall.structuredContent as { rows: { id: string }[] }).rows[0]!.id).toBe(cand);
    const list = await d("myc_ready", { review: true });
    expect((list.structuredContent as { total: number }).total).toBe(0);
  });

  test("myc_update{op:reject}: причина обязательна; отклонённый не в выдаче и не в списке", async () => {
    const cand = candidateId();
    const noReason = await d("myc_update", { id: cand, op: "reject" });
    expect(noReason.isError).toBe(true);
    expect(noReason.content[0]!.text).toContain("usage.missing");

    const r = await d("myc_update", { id: cand, op: "reject", reason: "пересказ задачи, не решение" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ id: cand, review: "rejected", status: "retracted" });
    const recall = await d("myc_recall", { query: DECISION });
    expect((recall.structuredContent as { rows: { id: string }[] }).rows.map((x) => x.id)).not.toContain(cand);
    const list = await d("myc_ready", { review: true });
    expect((list.structuredContent as { total: number }).total).toBe(0);
  });

  test("myc_update{op:confirm} не-кандидата — отказ движка доезжает как есть", async () => {
    const note = await cli("remember", "обычная заметка, не кандидат вовсе", "--reach", "project", "--json");
    const id = (JSON.parse(note.stdout) as { data: { id: string } }).data.id;
    const r = await d("myc_update", { id, op: "confirm" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("precond.not_candidate");
  });
});

// memory-0p3d8n1efwtv через MCP: myc_recall — это CLI recall, и отозванная
// заметка до него больше не доезжает.
describe("MCP: отозванная заметка", () => {
  test("myc_recall её не отдаёт, живую — отдаёт", async () => {
    const FACT = "Порог косинуса для связанных заметок держим на ноль восемьсот сорок пять";
    const made = await cli("remember", FACT, "--reach", "project", "--json");
    const id = (JSON.parse(made.stdout) as { data: { id: string } }).data.id;
    const before = await d("myc_recall", { query: FACT });
    expect((before.structuredContent as { rows: { id: string }[] }).rows.map((x) => x.id)).toContain(id);
    expect((await cli("update", id, "--status", "retracted")).code).toBe(0);
    const after = await d("myc_recall", { query: FACT });
    expect((after.structuredContent as { rows: { id: string }[] }).rows.map((x) => x.id)).not.toContain(id);
  });
});
