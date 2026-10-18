/**
 * Компактирование закрытых задач и `myc uncompact` (спека design01 §6.4(2),
 * задача retention/2).
 *
 * Ключевые вещи, которые обязаны быть доказаны:
 *   - обратимость байт-в-байт: compact → uncompact возвращает ТО ЖЕ тело;
 *   - guard открытых реляторов: открытая задача, держащая ребро
 *     blocks/parent/relates на закрытую, не даёт ей свернуться;
 *   - FTS живёт по триггеру: после compact слово тела не находится, после
 *     uncompact — снова находится;
 *   - саммари детерминированное и в пределах потолка.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createPruneCommand } from "./prune.ts";
import { createCompactCommand, createUncompactCommand, templateSummary, episodeDigest } from "./compact.ts";

const DAY = 86_400_000;

function registry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createCompactCommand());
  r.register(createUncompactCommand());
  r.register(createPruneCommand());
  return r;
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-compact-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Envelope {
  ok: boolean;
  data?: Record<string, number | boolean | string>;
  error?: { code: string; msg: string };
  code?: string;
}

async function call(argv: readonly string[]): Promise<Envelope> {
  const out = await run(["--json", "-C", dir, ...argv], {
    registry: registry(),
    env: { MYC_SERVER: "", MYC_TOKEN: "", NO_COLOR: "1" },
  });
  const stdout = typeof out.stdout === "string" ? out.stdout : [...out.stdout].join("");
  return JSON.parse(stdout) as Envelope;
}

function db(): Database {
  return new Database(join(dir, ".myc", "myc.db"));
}

let hashSeq = 0;

function seedTask(input: {
  id: string;
  status?: string;
  closedDaysAgo?: number;
  body: string;
  title?: string;
  attrs?: string;
}): void {
  const d = db();
  try {
    d.prepare(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, status,
                          priority, created_at, updated_at, closed_at, attrs)
       VALUES (?1, 'task', 1, 'p', ?2, ?3, ?4, ?5, 2, 1, 1, ?6, ?7)`,
    ).run(
      input.id,
      input.title ?? input.id,
      input.body,
      `h-${input.id}-${++hashSeq}`,
      input.status ?? "closed",
      input.closedDaysAgo === undefined ? null : Date.now() - input.closedDaysAgo * DAY,
      input.attrs ?? "{}",
    );
  } finally {
    d.close();
  }
}

function seedSession(id: string, body: string): void {
  const d = db();
  try {
    d.prepare(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, content_hash, status,
                          created_at, updated_at)
       VALUES (?1, 'session', 0, 'p', ?2, ?2, ?3, 'active', 1, 1)`,
    ).run(id, body, `h-${id}-${++hashSeq}`);
  } finally {
    d.close();
  }
}

function seedEdge(src: string, type: string, dst: string): void {
  const d = db();
  try {
    d.prepare(
      `INSERT INTO edges (src, type, dst, add_tag, created_at)
       VALUES (?1, ?2, ?3, 'tag-1', 1)`,
    ).run(src, type, dst);
  } finally {
    d.close();
  }
}

function nodeRow(id: string): { body: string | null; body_cold: number; compacted_at: number | null } {
  const d = db();
  try {
    return d
      .query("SELECT body, body_cold, compacted_at FROM nodes WHERE id = ?")
      .get(id) as { body: string | null; body_cold: number; compacted_at: number | null };
  } finally {
    d.close();
  }
}

function count(sql: string): number {
  const d = db();
  try {
    return (d.query(sql).get() as { n: number } | undefined)?.n ?? -1;
  } finally {
    d.close();
  }
}

function ftsHits(word: string): number {
  const d = db();
  try {
    const r = d
      .query("SELECT count(*) AS n FROM nodes_fts WHERE nodes_fts MATCH ?")
      .get(word) as { n: number } | undefined;
    return r?.n ?? -1;
  } finally {
    d.close();
  }
}

const LONG_BODY =
  "первые двести символов xylofon начинаются здесь и довольно длинно разворачиваются " +
  "здесь — задача была большой. ".repeat(6) +
  " середина опущена. " +
  "последние сто двадцать символов marimba завершают тело. ".repeat(4);

test("compact: тело уезжает в холод, телом становится саммари, FTS живёт по триггеру", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedTask({ id: "t1", closedDaysAgo: 40, body: LONG_BODY, title: "Большая задача" });
  expect(ftsHits("середина")).toBe(1); // слово середины тела ЖИВО в индексе до компактирования

  const r = await call(["compact"]);
  expect(r.ok).toBe(true);
  expect(r.data!.candidates).toBe(1);
  expect(r.data!.compacted).toBe(1);

  const row = nodeRow("t1");
  expect(row.body_cold).toBe(1);
  expect(row.compacted_at).not.toBeNull();
  expect(row.body!.length).toBeLessThanOrEqual(512);
  expect(row.body).toContain("Большая задача");
  expect(row.body).toContain("закрыта");
  expect(row.body).toContain("xylofon"); // голова тела
  expect(row.body).toContain("marimba"); // хвост тела

  // FTS перестроен триггером по саммари: слово середины тела (вне кусков)
  // больше не находится — а ДО компактирования оно было в индексе.
  expect(ftsHits("середина")).toBe(0);
  expect(ftsHits("xylofon")).toBe(1);

  // Холодная копия лежит и цельна.
  const d = db();
  const cold = d.query("SELECT algo, level, raw_len FROM bodies_cold WHERE node_id = 't1'").get() as {
    algo: string;
    level: number;
    raw_len: number;
  };
  d.close();
  expect(cold.algo).toBe("zstd");
  expect(cold.level).toBe(6);
  expect(cold.raw_len).toBe(LONG_BODY.length);
});

test("приёмка: compact → uncompact возвращает тело байт-в-байт", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedTask({ id: "t1", closedDaysAgo: 40, body: LONG_BODY });
  expect((await call(["compact"])).ok).toBe(true);

  const r = await call(["uncompact", "t1"]);
  expect(r.ok).toBe(true);
  expect(r.data!.restored).toBe(1);
  expect(r.data!.raw_len).toBe(LONG_BODY.length);

  const row = nodeRow("t1");
  expect(row.body).toBe(LONG_BODY);
  expect(row.body_cold).toBe(0);
  expect(row.compacted_at).toBeNull();

  // Холодная копия потреблена, FTS снова находит слово тела.
  const d = db();
  const coldLeft = d.query("SELECT count(*) AS n FROM bodies_cold WHERE node_id = 't1'").get() as { n: number };
  d.close();
  expect(coldLeft.n).toBe(0);
  expect(ftsHits("marimba")).toBe(1);
});

test("guard: открытый релятор (blocks/parent/relates) не даёт свернуться", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedTask({ id: "t1", closedDaysAgo: 40, body: LONG_BODY });
  seedTask({ id: "t2", closedDaysAgo: 40, body: "вторая закрытая" });
  seedTask({ id: "t3", closedDaysAgo: 40, body: "третья закрытая" });
  seedTask({ id: "open-relator", status: "open", body: "открытая, держит relate", title: "открытая" });
  seedTask({ id: "closed-relator", closedDaysAgo: 41, body: "тоже закрытая" });
  seedEdge("open-relator", "relates", "t1");
  seedEdge("closed-relator", "blocks", "t2");

  const r = await call(["compact"]);
  expect(r.ok).toBe(true);
  // t1 отсечён открытым релятором (skipped=1). Кандидаты — t2, t3 и сам
  // closed-relator: он закрыт и без входящих реляторов, ему самому ничего
  // не мешает свернуться.
  expect(r.data!.candidates).toBe(3);
  expect(r.data!.compacted).toBe(3);
  expect(r.data!.skipped).toBe(1);
  expect(nodeRow("t1").body_cold).toBe(0); // не тронута
  expect(nodeRow("t2").body_cold).toBe(1);
  expect(nodeRow("t3").body_cold).toBe(1);
  expect(nodeRow("closed-relator").body_cold).toBe(1);
});

test("не компактируются: свежезакрытые, открытые, не-задачи, уже компактированные", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedTask({ id: "fresh", closedDaysAgo: 5, body: "закрыта5дней" });
  seedTask({ id: "open", status: "open", body: "открытая" });
  seedSession("session1", "эпизод, не задача");
  seedTask({ id: "t1", closedDaysAgo: 40, body: LONG_BODY });
  expect((await call(["compact"])).ok).toBe(true);
  expect(nodeRow("t1").body_cold).toBe(1);

  // Повторный проход не трогает уже компактированную (и ничего не падает).
  const again = await call(["compact"]);
  expect(again.ok).toBe(true);
  expect(again.data!.candidates).toBe(0);

  expect(nodeRow("fresh").body).toBe("закрыта5дней");
  expect(nodeRow("fresh").body_cold).toBe(0);
  expect(nodeRow("open").body_cold).toBe(0);
  expect(nodeRow("session1").body).toBe("эпизод, не задача");
});

test("dry-run считает, но не меняет; limit ограничивает проход", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedTask({ id: "a", closedDaysAgo: 42, body: "тело-а" }); // самая старая
  seedTask({ id: "b", closedDaysAgo: 41, body: "тело-б" });
  seedTask({ id: "c", closedDaysAgo: 40, body: "тело-в" }); // самая свежая

  const dry = await call(["compact", "--dry-run"]);
  expect(dry.ok).toBe(true);
  expect(dry.data!.dry).toBe(true);
  expect(dry.data!.compacted).toBe(3);
  expect(nodeRow("a").body_cold).toBe(0); // ничего не тронуто

  const limited = await call(["compact", "--limit", "2"]);
  expect(limited.ok).toBe(true);
  expect(limited.data!.compacted).toBe(2);
  expect(nodeRow("a").body_cold).toBe(1); // самая старая первой (ORDER BY closed_at)
  expect(nodeRow("b").body_cold).toBe(1);
  expect(nodeRow("c").body_cold).toBe(0);
});

test("uncompact без холодной копии — честный отказ", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  const r = await call(["uncompact", "nope"]);
  expect(r.ok).toBe(false);
  expect(r.error?.code).toBe("compact.no_cold_copy");
});

describe("templateSummary", () => {
  const base = {
    title: "Заголовок",
    kind: "task",
    priority: 2,
    closedAt: Date.UTC(2026, 9, 1),
    commits: [] as string[],
  };

  test("короткое тело остаётся целиком", () => {
    const s = templateSummary({ ...base, body: "короткое тело" });
    expect(s).toContain("короткое тело");
    expect(s).toContain("закрыта 2026-10-01");
  });

  test("длинное тело — голова200 … хвост120, потолок512 соблюдён", () => {
    const s = templateSummary({ ...base, body: LONG_BODY });
    expect(s.length).toBeLessThanOrEqual(512);
    expect(s).toContain(" … ");
  });

  test("коммиты из attrs попадают в саммари, если кто-то их писал", () => {
    const s = templateSummary({ ...base, body: "тело", commits: ["c0ffee", "dead123"] });
    expect(s).toContain("коммиты: c0ffee, dead123");
  });

  test("пустое тело деградирует до заголовочной строки", () => {
    const s = templateSummary({ ...base, body: null });
    expect(s).toContain("Заголовок [task/P2] закрыта 2026-10-01");
  });

  test("детерминирована: два вызова — байт-в-байт одинаково", () => {
    const a = templateSummary({ ...base, body: LONG_BODY });
    const b = templateSummary({ ...base, body: LONG_BODY });
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Свёртка эпизодов L0 (§6.4(3), retention/4)
// ---------------------------------------------------------------------------

const TRANSCRIPT = "агент: делаем свёртку.\nпользователь: эпизод должен пережить prune, но не тело.";
const HEADER_LINE = JSON.stringify({
  v: 1, id: "ep1", reason: "compact", agent: "opencode",
  created_at: 1, raw_bytes: TRANSCRIPT.length, secrets_masked: 2,
});
const FILE_PLAIN = `${HEADER_LINE}\n${TRANSCRIPT}`;

function seedEpisode(id: string, daysAgo: number, withFile: boolean): void {
  const d = db();
  try {
    const attrs: Record<string, unknown> = {
      reason: "compact",
      agent: "opencode",
      raw_bytes: TRANSCRIPT.length,
      secrets_masked: 2,
      ...(withFile
        ? { episode_path: `episodes/${id}.zst`, episode_bytes: 1, compression: "zstd" }
        : { episode_path: "", episode_bytes: 1, compression: "zstd", episode_archived: true }),
    };
    d.prepare(
      `INSERT INTO nodes (id, kind, layer, acl, scope, title, body, content_hash, status,
                          created_at, updated_at, attrs)
       VALUES (?1, 'session', 0, 'private', 'p', ?2, '', ?3, 'active', ?4, ?4, ?5)`,
    ).run(id, `episode ${id} · compact · opencode`, `h-${id}`, Date.now() - daysAgo * DAY, JSON.stringify(attrs));
  } finally {
    d.close();
  }
}

function writeEpisodeFile(id: string): void {
  const dir = join(dir0(), "episodes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.zst`), Bun.zstdCompressSync(Buffer.from(FILE_PLAIN, "utf-8")));
}

function dir0(): string {
  return join(dir, ".myc");
}

function episodeFilePath(id: string): string {
  return join(dir0(), "episodes", `${id}.zst`);
}

function digestNoteOf(sessionId: string): { id: string; body: string; layer: number } | undefined {
  const d = db();
  try {
    return d
      .query("SELECT id, body, layer FROM nodes WHERE kind = 'note' AND json_extract(attrs, '$.episode_of') = ?")
      .get(sessionId) as { id: string; body: string; layer: number } | undefined;
  } finally {
    d.close();
  }
}

test("свёртка: файл уезжает в bodies_cold, появляется дайджест, узел эпизода цел", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedEpisode("ep1", 40, true);
  writeEpisodeFile("ep1");

  const r = await call(["compact", "--episodes"]);
  expect(r.ok).toBe(true);
  expect(r.data!.mode).toBe("episodes");
  expect(r.data!.compacted).toBe(1);

  // Файла нет; холодная копия несёт исходный текст (zstd, единый algo).
  expect(existsSync(episodeFilePath("ep1"))).toBe(false);
  const d = db();
  const cold = d.query("SELECT algo, raw_len FROM bodies_cold WHERE node_id = 'ep1'").get() as {
    algo: string;
    raw_len: number;
  };
  d.close();
  expect(cold.algo).toBe("zstd");
  expect(cold.raw_len).toBe(Buffer.byteLength(FILE_PLAIN, "utf-8"));

  // Дайджест: note layer=1, attrs.episode_of, ребро derived_from на эпизод.
  const note = digestNoteOf("ep1");
  expect(note).toBeDefined();
  expect(note!.layer).toBe(1);
  expect(note!.body).toContain("Эпизод ep1");
  expect(note!.body).toContain("compact");
  expect(
    count("SELECT count(*) AS n FROM edges WHERE type = 'derived_from' AND dst = 'ep1'"),
  ).toBe(1);

  // Узел эпизода цел: тело пустое (оно и было в файле), архивация помечена.
  const row = nodeRow("ep1");
  expect(row.body).toBe("");
  const d2 = db();
  const archived = d2
    .query("SELECT json_extract(attrs, '$.episode_archived') AS a, json_extract(attrs, '$.episode_path') AS p FROM nodes WHERE id = 'ep1'")
    .get() as { a: number; p: string };
  d2.close();
  expect(archived.a).toBe(1);
  expect(archived.p).toBe("");
});

test("свёрнутый не сворачивается повторно, свежий не трогается, dry-run не меняет", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedEpisode("ep-old", 40, true);
  writeEpisodeFile("ep-old");
  expect((await call(["compact", "--episodes"])).ok).toBe(true); // свёрнут, файла больше нет

  seedEpisode("ep-fresh", 5, true); // моложе срока — не кандидат
  writeEpisodeFile("ep-fresh");
  seedEpisode("ep-old2", 35, true); // кандидат
  writeEpisodeFile("ep-old2");

  // dry-run считает ровно кандидатов (ep-old без файла — skipped, ep-fresh вне
  // срока) и ничего не меняет.
  const dry = await call(["compact", "--episodes", "--dry-run"]);
  expect(dry.ok).toBe(true);
  expect(dry.data!.compacted).toBe(1);
  expect(existsSync(episodeFilePath("ep-old2"))).toBe(true);
  expect(existsSync(episodeFilePath("ep-fresh"))).toBe(true);

  const again = await call(["compact", "--episodes"]);
  expect(again.ok).toBe(true);
  expect(again.data!.compacted).toBe(1); // только ep-old2
  expect(existsSync(episodeFilePath("ep-old2"))).toBe(false);
  expect(existsSync(episodeFilePath("ep-fresh"))).toBe(true); // срок не истёк
  expect(
    count("SELECT count(*) AS n FROM nodes WHERE kind = 'note' AND json_extract(attrs, '$.episode_of') = 'ep-old'"),
  ).toBe(1); // дайджест один, не два
});

test("приёмка: uncompact возвращает текст эпизода байт-в-байт", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedEpisode("ep1", 40, true);
  writeEpisodeFile("ep1");
  expect((await call(["compact", "--episodes"])).ok).toBe(true);

  const r = await call(["uncompact", "ep1"]);
  expect(r.ok).toBe(true);
  const row = nodeRow("ep1");
  expect(row.body).toBe(FILE_PLAIN); // шапка + транскрипт, байт-в-байт
  expect(row.body_cold).toBe(0);
  expect(count("SELECT count(*) AS n FROM bodies_cold WHERE node_id = 'ep1'")).toBe(0);
});

test("приёмка: свёртка → prune → тело недоступно, узлы целы", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  seedEpisode("ep1", 40, true);
  writeEpisodeFile("ep1");
  expect((await call(["compact", "--episodes"])).ok).toBe(true);

  // Возраст холодной копии: за180 суток prune вправе её убрать.
  const d = db();
  d.prepare("UPDATE bodies_cold SET archived_at = ? WHERE node_id = 'ep1'").run(Date.now() - 181 * DAY);
  d.close();

  const pruned = await call(["prune"]);
  expect(pruned.ok).toBe(true);
  expect(pruned.data!.bodies_removed).toBe(1);

  // Тела нет: ни файла, ни холодной копии. Uncompact честно отказывает.
  expect(existsSync(episodeFilePath("ep1"))).toBe(false);
  expect(count("SELECT count(*) AS n FROM bodies_cold WHERE node_id = 'ep1'")).toBe(0);
  const un = await call(["uncompact", "ep1"]);
  expect(un.ok).toBe(false);
  expect(un.error?.code).toBe("compact.no_cold_copy");

  // УЗЛЫ ЦЕЛЫ: эпизод на месте (тело пустое — оно и не было в узле),
  // дайджест пережил prune и несёт содержание.
  expect(count("SELECT count(*) AS n FROM nodes WHERE id = 'ep1'")).toBe(1);
  const note = digestNoteOf("ep1");
  expect(note).toBeDefined();
  expect(note!.body.length).toBeGreaterThan(0);
});

test("retention.l0_days из конфига меняет срок без правки кода", async () => {
  expect((await call(["init", "--slug", "p"])).ok).toBe(true);
  writeFileSync(join(dir, ".myc", "workspace.toml"), 'slug = "p"\n\n[retention]\nl0_days = 1\n');
  seedEpisode("ep-recent", 5, true); // старше одного дня — попадает под срок
  writeEpisodeFile("ep-recent");

  const r = await call(["compact", "--episodes"]);
  expect(r.ok).toBe(true);
  expect(r.data!.compacted).toBe(1);
  expect(existsSync(episodeFilePath("ep-recent"))).toBe(false);
});

describe("episodeDigest", () => {
  test("шаблон детерминирован и называет факты", () => {
    const a = episodeDigest("ep1", Date.UTC(2026, 9, 1), { reason: "compact", agent: "opencode", raw_bytes: 100, secrets_masked: 2 });
    const b = episodeDigest("ep1", Date.UTC(2026, 9, 1), { reason: "compact", agent: "opencode", raw_bytes: 100, secrets_masked: 2 });
    expect(a).toBe(b);
    expect(a).toContain("2026-10-01");
    expect(a).toContain("масок секретов: 2");
  });
});
