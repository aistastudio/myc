/**
 * `myc absorb` против настоящего SQLite во временном воркспейсе, через
 * публичный run(). Эмбеддер подменён: «тема» текста задаётся словом-меткой
 * (alpha/beta/…), вектор темы — детерминированный псевдослучайный орт, так
 * что косинус одной темы ≈ 1, разных ≈ 0. Правила классификации проверяет
 * core/absorb.test.ts; здесь проверяется СТЫК: очередь, кандидаты, действия
 * в графе по классу, строка узла и — отдельным блоком — И2: без векторов
 * ничего не сливается и деградация видна в узле, в myc_health и в конверте.
 *
 * Векторный путь (kNN, nodes_vec) требует vec0; без него в среде эти тесты
 * проверяют лексический исход — оба исхода описаны явно, как в
 * store.vector.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { GraphStore, migrate, migrations, ensureSqliteRuntime, openSqlite } from "@myc/store-sqlite";
import { DEFAULT_ABSORB_THRESHOLDS, generateId } from "@myc/core";
import type { EmbedFingerprint } from "@myc/embed/fingerprint";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import {
  createAbsorbCommand,
  absorbQueries,
  absorbText,
  ftsMatchOf,
  realAbsorbDeps,
  type AbsorbData,
  type AbsorbDeps,
} from "./absorb.ts";

const VEC0 = ensureSqliteRuntime().vec.loaded;

let dir: string;
let home: string;

// ---------------------------------------------------------------------------
// Подменный эмбеддер
// ---------------------------------------------------------------------------

const TOPICS = ["alpha", "beta", "gamma", "delta"];

function seeded(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

function topicVector(topic: string): Float32Array {
  const rnd = seeded(topic);
  const v = new Float32Array(384);
  let norm = 0;
  for (let i = 0; i < v.length; i++) {
    v[i] = rnd() - 0.5;
    norm += v[i]! * v[i]!;
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

function fakeEmbed(text: string): Float32Array {
  const lower = text.toLowerCase();
  const topic = TOPICS.find((t) => lower.includes(t)) ?? "zeta";
  return topicVector(topic);
}

let embedCalls = 0;

const FAKE_FINGERPRINT: EmbedFingerprint = {
  backend: "local",
  provider: "onnx-wasm",
  model: "fake-model-a",
  dim: 384,
  normalize: true,
};

function deps(overrides: Partial<AbsorbDeps> = {}, fingerprint: EmbedFingerprint = FAKE_FINGERPRINT): AbsorbDeps {
  return {
    ...realAbsorbDeps,
    resolveEmbedder: async () => ({
      ok: true,
      embedder: {
        fingerprint,
        embed: async (text) => {
          embedCalls++;
          return fakeEmbed(text);
        },
        destroy: async () => {},
      },
    }),
    ...overrides,
  };
}

const noEmbedder: Partial<AbsorbDeps> = {
  resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
};

function makeRegistry(d: AbsorbDeps): Registry {
  const r = new Registry();
  r.register(createRememberCommand({ ...realRememberDeps, chatLlm: () => false }));
  r.register(createAbsorbCommand(d));
  return r;
}

let registry: Registry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-absorb-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  embedCalls = 0;
  registry = makeRegistry(deps());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

interface Envelope<T = Record<string, unknown>> {
  ok: boolean;
  data: T;
  meta: Record<string, unknown> & { degraded: string[] };
  warn: { code: string; msg: string }[];
  error?: { code: string; msg: string; exit: number; hint?: string };
}

async function mycJson<T = Record<string, unknown>>(...args: string[]): Promise<{ code: number; env: Envelope<T> }> {
  const r = await myc(...args, "--json");
  return { code: r.code, env: JSON.parse(text(r.stdout)) as Envelope<T> };
}

async function remember(fact: string): Promise<string> {
  const { env } = await mycJson("remember", fact);
  return env.data["id"] as string;
}

interface NodeRow {
  id: string;
  status: string;
  head_id: string | null;
  seen_count: number;
  confidence: number;
  attrs: string;
}

function db<T>(fn: (d: Database) => T): T {
  const d = new Database(join(dir, ".myc", "myc.db"), { readonly: true });
  try {
    return fn(d);
  } finally {
    d.close();
  }
}

// nodes_vec — виртуальная таблица модуля vec0: обычному `new Database()` он
// не загружен (Database.setCustomSQLite/vec0 применяются к соединению
// openSqlite'ом), поэтому трогать её из теста нужно только через него.
function vec<T>(fn: (d: Database) => T): T {
  const driver = openSqlite({ path: join(dir, ".myc", "myc.db") });
  try {
    return fn(driver.database);
  } finally {
    driver.close();
  }
}

function node(id: string): NodeRow & { absorb: Record<string, unknown> | undefined; degraded_at: number | undefined } {
  const row = db((d) =>
    d.query("SELECT id, status, head_id, seen_count, confidence, attrs FROM nodes WHERE id = ?1").get(id),
  ) as NodeRow;
  const attrs = JSON.parse(row.attrs) as Record<string, unknown>;
  return {
    ...row,
    absorb: attrs["absorb"] as Record<string, unknown> | undefined,
    degraded_at: attrs["degraded_at"] as number | undefined,
  };
}

function edges(): { src: string; type: string; dst: string; weight: number }[] {
  return db((d) =>
    d.query("SELECT src, type, dst, weight FROM edges WHERE deleted_at IS NULL ORDER BY type, src").all(),
  ) as { src: string; type: string; dst: string; weight: number }[];
}

function jobs(kind: string): string[] {
  return (db((d) => d.query("SELECT entity_id FROM jobs WHERE kind = ?1").all(kind)) as { entity_id: string }[]).map(
    (r) => r.entity_id,
  );
}

function health(): { state: string; reason: string } | null {
  return db((d) => d.query("SELECT state, reason FROM myc_health WHERE component = 'absorb'").get()) as {
    state: string;
    reason: string;
  } | null;
}

// ---------------------------------------------------------------------------

const ALPHA_OLD =
  "alpha: миграции только вперёд, версия целочисленная, таблица schema_migrations с checksum, при расхождении exit 4.";

describe("myc absorb — очередь и классы", () => {
  test("разбирает очередь absorb, чужие работы не трогает, повтор пуст", async () => {
    const a = await remember(ALPHA_OLD);
    const b = await remember("beta: рецепт блинов — 200 г муки, 2 яйца, 300 мл молока, щепотка соли.");
    expect(jobs("absorb").sort()).toEqual([a, b].sort());

    const { code, env } = await mycJson<AbsorbData>("absorb");
    expect(code).toBe(ExitCode.OK);
    expect(env.data.processed).toBe(2);
    expect(env.data.by_class.new).toBe(2);
    expect(jobs("absorb")).toEqual([]);
    // embed закрыт только там, где вектор действительно лёг в nodes_vec.
    if (VEC0) expect(jobs("embed")).toEqual([]);
    expect(env.data.thresholds).toEqual(DEFAULT_ABSORB_THRESHOLDS);

    const again = await mycJson<AbsorbData>("absorb");
    expect(again.env.data.processed).toBe(0);
  });

  test("duplicate: узел не плодится в выдаче — head_id на канонический, seen_count растёт", async () => {
    const a = await remember(ALPHA_OLD);
    await myc("absorb");
    const dup = await remember(
      "alpha: миграции только вперёд, версия целочисленная, таблица schema_migrations с checksum, при расхождении exit 4",
    );
    const { env } = await mycJson<AbsorbData>("absorb");
    const r = env.data.nodes[0]!;
    expect(r.id).toBe(dup);
    expect(r.class).toBe("duplicate");
    expect(r.target).toBe(a);
    if (VEC0) expect(r.quality).toBe("embedded");

    const d = node(dup);
    expect(d.head_id).toBe(a);
    expect(d.status).toBe("superseded");
    expect(d.absorb?.["class"]).toBe("duplicate");
    expect(node(a).seen_count).toBe(2);
    expect(edges()).toContainEqual(expect.objectContaining({ src: dup, type: "duplicates", dst: a }));
  });

  test("update: цепочка supersedes, head_id у всей цепочки", async () => {
    const a = await remember(ALPHA_OLD);
    await myc("absorb");
    const b = await remember(
      "alpha: миграции только вперёд, версия целочисленная, таблица schema_migrations с checksum; коды выхода теперь exit 6 вместо 4.",
    );
    const { env } = await mycJson<AbsorbData>("absorb");
    const r = env.data.nodes[0]!;
    if (!VEC0) {
      // Без vec0 векторов нет: обновление не объявляется, ничего не спрятано (И2).
      expect(r.class).toBe("related");
      expect(node(a).head_id).toBeNull();
      return;
    }
    expect(r.class).toBe("update");
    expect(r.target).toBe(a);
    expect(node(a).head_id).toBe(b);
    expect(node(a).status).toBe("superseded");
    expect(node(b).head_id).toBeNull();
    expect(edges()).toContainEqual(expect.objectContaining({ src: b, type: "supersedes", dst: a }));

    // Третье звено: голова цепочки переезжает у обоих предков (§6.3).
    const c = await remember(
      "alpha: миграции только вперёд, версия целочисленная, таблица schema_migrations с checksum; коды выхода пересмотрены: exit 7.",
    );
    await myc("absorb");
    expect(node(a).head_id).toBe(c);
    expect(node(b).head_id).toBe(c);
    expect(node(c).head_id).toBeNull();
  });

  test("contradiction: ребро contradicts, оба узла живут, confidence × 0.7", async () => {
    const a = await remember("alpha: перед вставкой ребра blocks проверяем, что не образуется цикл, обход ограничен по глубине.");
    await myc("absorb");
    const b = await remember("alpha: перед вставкой ребра blocks цикл не проверяем, обход ограничен по глубине.");
    const { env } = await mycJson<AbsorbData>("absorb");
    const r = env.data.nodes[0]!;
    if (!VEC0) {
      expect(r.class).toBe("related");
      return;
    }
    expect(r.class).toBe("contradiction");
    expect(node(a).head_id).toBeNull();
    expect(node(b).head_id).toBeNull();
    expect(node(a).status).toBe("active");
    expect(node(a).confidence).toBeCloseTo(0.7, 2);
    expect(node(b).confidence).toBeCloseTo(0.7, 2);
    expect(edges()).toContainEqual(expect.objectContaining({ src: b, type: "contradicts", dst: a }));
  });

  test("related: ребро relates с весом = косинус; new: ничего", async () => {
    const a = await remember("alpha: myc models fetch скачивает модель один раз и проверяет sha256.");
    await myc("absorb");
    const b = await remember("alpha: myc models list печатает каталог моделей с размером и признаком скачана.");
    const c = await remember("gamma: встреча с командой перенесена на четверг, повестка — план найма.");
    const { env } = await mycJson<AbsorbData>("absorb");
    const byId = new Map(env.data.nodes.map((n) => [n.id, n]));
    if (VEC0) {
      expect(byId.get(b)?.class).toBe("related");
      expect(byId.get(b)?.target).toBe(a);
      const e = edges().find((x) => x.src === b && x.type === "relates" && x.dst === a);
      expect(e).toBeDefined();
      expect(e!.weight).toBeCloseTo(byId.get(b)!.cos!, 3);
    }
    expect(byId.get(c)?.class).toBe("new");
    expect(edges().filter((x) => x.src === c)).toEqual([]);
    expect(node(c).absorb?.["class"]).toBe("new");
  });

  test("--dry-run классифицирует, но ничего не меняет", async () => {
    const a = await remember(ALPHA_OLD);
    await myc("absorb");
    const dup = await remember(`${ALPHA_OLD.toUpperCase()}`);
    const { env } = await mycJson<AbsorbData>("absorb", "--dry-run");
    expect(env.data.dry_run).toBe(true);
    expect(env.data.nodes[0]?.class).toBe("duplicate");
    expect(env.data.nodes[0]?.actions).toEqual([]);
    expect(node(dup).head_id).toBeNull();
    expect(node(a).seen_count).toBe(1);
    expect(jobs("absorb")).toEqual([dup]);
  });

  test("явный id разбирается и без работы в очереди", async () => {
    const a = await remember(ALPHA_OLD);
    await myc("absorb");
    const { env } = await mycJson<AbsorbData>("absorb", a);
    expect(env.data.nodes[0]?.id).toBe(a);
    expect(env.data.nodes[0]?.class).toBe("new");
  });

  test("пороги читаются из workspace.toml [absorb]", async () => {
    writeFileSync(
      join(dir, ".myc", "workspace.toml"),
      `slug = "myc"\n[absorb]\ndup_cos = 0.5\ncand_cos = 0.4\nmax_related = 1\n`,
    );
    const { env } = await mycJson<AbsorbData>("absorb");
    expect(env.data.thresholds.dup_cos).toBe(0.5);
    expect(env.data.thresholds.cand_cos).toBe(0.4);
    expect(env.data.thresholds.max_related).toBe(1);
    expect(env.data.thresholds.dup_jac).toBe(DEFAULT_ABSORB_THRESHOLDS.dup_jac);
  });
});

describe("И2 — без векторов ничего не теряется и деградация видна", () => {
  test("эмбеддера нет: кандидаты становятся relates, узел помечен, myc_health degraded, конверт кричит", async () => {
    const a = await remember(ALPHA_OLD);
    registry = makeRegistry(deps(noEmbedder));
    await myc("absorb");
    // Почти дословный повтор, но не точный: с векторами это duplicate.
    const b = await remember(
      "alpha: миграции только вперёд, версия целочисленная, таблица schema_migrations с checksum, при расхождении — exit 4.",
    );
    const { code, env } = await mycJson<AbsorbData>("absorb");
    expect(code).toBe(ExitCode.OK);
    const r = env.data.nodes[0]!;
    expect(r.id).toBe(b);
    expect(r.quality).toBe("lexical");
    expect(["related", "duplicate"]).toContain(r.class);
    // Слить можно только при jac ≥ 0.9; здесь текст переписан — related.
    if (r.class === "related") {
      expect(node(b).head_id).toBeNull();
      expect(node(a).head_id).toBeNull();
      expect(edges()).toContainEqual(expect.objectContaining({ src: b, type: "relates", dst: a }));
    }
    // Качество — в строке узла и видно запросом.
    const n = node(b);
    expect(n.absorb?.["quality"]).toBe("lexical");
    expect(typeof n.absorb?.["degraded"]).toBe("string");
    expect(n.degraded_at).toBeGreaterThan(0);
    // В myc_health и в конверте.
    expect(health()?.state).toBe("degraded");
    expect(health()?.reason).toContain("эмбеддер отключён");
    expect(env.data.degraded).toContain("эмбеддер отключён");
    expect(env.meta.degraded).toContain("degraded.embed");
    expect(env.warn.map((w) => w.code)).toContain("degraded.embed");
    expect(embedCalls).toBe(0);
  });

  test("--no-embed: тот же громкий лексический режим без загрузки эмбеддера", async () => {
    await remember(ALPHA_OLD);
    const { env } = await mycJson<AbsorbData>("absorb", "--no-embed");
    expect(env.data.nodes[0]?.quality).toBe("lexical");
    expect(env.meta.degraded).toContain("degraded.embed");
    expect(embedCalls).toBe(0);
  });

  test("после восстановления эмбеддера myc_health возвращается в ok", async () => {
    await remember(ALPHA_OLD);
    registry = makeRegistry(deps(noEmbedder));
    await myc("absorb");
    expect(health()?.state).toBe("degraded");
    registry = makeRegistry(deps());
    await remember("beta: новый факт после восстановления.");
    await myc("absorb");
    if (VEC0) expect(health()?.state).toBe("ok");
  });
});

describe("embed_fingerprint — запрет смешивать векторные пространства (myc-8ynerxk3311y)", () => {
  const MODEL_B: EmbedFingerprint = { ...FAKE_FINGERPRINT, model: "fake-model-b" };

  test("смена модели без reembed останавливает запись с внятной инструкцией; старые векторы целы", async () => {
    const a = await remember(ALPHA_OLD);
    await myc("absorb"); // модель A: пишет вектор, фиксирует embed_fingerprint в myc_meta
    if (!VEC0) return; // без vec0 эмбеддер не вызывается вовсе — отпечатку неоткуда взяться

    const before = vec((d) => d.query("SELECT count(*) AS n FROM nodes_vec").get()) as { n: number };
    expect(before.n).toBeGreaterThan(0);
    expect(node(a).absorb?.["class"]).toBe("new");

    // Модель подменена на B — тот же процесс, что реальная смена модели на диске.
    registry = makeRegistry(deps({}, MODEL_B));
    const b = await remember("beta: факт, появившийся уже после смены модели.");

    const { code, env } = await mycJson<AbsorbData>("absorb");
    expect(code).toBe(ExitCode.PRECOND);
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("embed.fingerprint_mismatch");
    expect(env.error?.msg).toContain("reembed");
    expect(env.error?.hint).toContain("reindex:vectors");
    expect(env.meta.degraded).toContain("degraded.fingerprint_mismatch");
    expect(env.warn.map((w) => w.code)).toContain("degraded.fingerprint_mismatch");

    // Громко и в myc doctor: myc_health для absorb ушёл в degraded.
    expect(health()?.state).toBe("degraded");
    expect(health()?.reason).toContain("reembed");

    // Ничего не потеряно: работа b осталась в очереди, а не пропала молча.
    expect(jobs("absorb")).toContain(b);
    expect(node(b).absorb).toBeUndefined();

    // Уже записанный вектор модели A не тронут — ни удалён, ни смешан с B.
    const after = vec((d) => d.query("SELECT count(*) AS n FROM nodes_vec").get()) as { n: number };
    expect(after.n).toBe(before.n);
  });

  test("после reembed текущей моделью запись снова разрешена", async () => {
    const a = await remember(ALPHA_OLD);
    await myc("absorb");
    if (!VEC0) return;

    registry = makeRegistry(deps({}, MODEL_B));
    const b = await remember("beta: факт после смены модели.");
    const blocked = await mycJson<AbsorbData>("absorb");
    expect(blocked.code).toBe(ExitCode.PRECOND);

    // Переиндексация корпуса моделью B (то, что делает scripts/reindex-vectors.ts):
    // старые векторы моделью A стёрты, отпечаток в myc_meta теперь совпадает с B.
    vec((d) => {
      d.exec("DELETE FROM nodes_vec");
      d.query(
        "INSERT INTO myc_meta (key, value) VALUES ('embed_fingerprint', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run(`local:${MODEL_B.provider}:${MODEL_B.model}:${MODEL_B.dim}:l2`);
    });

    const { code, env } = await mycJson<AbsorbData>("absorb");
    expect(code).toBe(ExitCode.OK);
    expect(env.data.nodes.map((n) => (n as { id: string }).id)).toContain(b);
    expect(node(a).absorb?.["class"]).toBe("new");
  });
});

describe("remember — фаза 0 absorb", () => {
  test("точный повтор не плодит узел: seen_count++ и пустая очередь", async () => {
    const a = await remember(ALPHA_OLD);
    const { env } = await mycJson("remember", ALPHA_OLD);
    expect(env.data["id"]).toBe(a);
    expect(env.data["duplicate_of"]).toBe(a);
    expect(env.data["seen_count"]).toBe(2);
    expect(env.data["queue"]).toEqual([]);
    expect(jobs("absorb")).toEqual([a]);
    const r = await myc("remember", ALPHA_OLD);
    expect(text(r.stdout)).toContain("duplicate · exact repeat, seen_count 3");
    expect(node(a).seen_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Кандидат хука сжатия (§6.2, memory-7j8zgjnd0bjz): `attrs.state =
// 'pending_review'`, из выдачи исключён. Стань он целью класса duplicate —
// канонический он (старше), новая явная заметка ушла бы в него superseded, и
// факт пропал бы из recall и prime целиком.
// ---------------------------------------------------------------------------

describe("кандидат хука сжатия — не цель дедупликации", () => {
  /** Кандидат в форме writeCandidates хука: note L2, без тела, salience 0. */
  function candidate(scope: string, title: string): { id: string; rowid: number } {
    const driver = openSqlite({ path: join(dir, ".myc", "myc.db") });
    try {
      const store = new GraphStore(driver, { newId: () => generateId(), siteId: "site-test", actor: "hook" });
      const n = store.createNode({
        kind: "note",
        layer: 2,
        acl: "private",
        salience: 0,
        scope,
        title,
        actor: "hook",
        attrs: { state: "pending_review", extracted_by: "precompact", episode_id: "ep-1", reach: "session", session_id: "S-1" },
      });
      const rowid = driver.database.query<{ rowid: number }, [string]>("SELECT rowid FROM nodes WHERE id = ?1").get(n.id)!.rowid;
      return { id: n.id, rowid };
    } finally {
      driver.close();
    }
  }

  function scopeOf(id: string): string {
    return (db((d) => d.query("SELECT scope FROM nodes WHERE id = ?1").get(id)) as { scope: string }).scope;
  }

  function stateOf(id: string): unknown {
    return (JSON.parse(node(id).attrs) as Record<string, unknown>)["state"];
  }

  /**
   * Вектор кандидата — прямо в nodes_vec: `myc absorb <id кандидата>` его
   * больше не кладёт (он отказывает, см. тест ниже), а кандидат с вектором
   * бывает — старые базы, будущий фон. Без vec0 — ничего: путь лексический.
   */
  function embedCandidate(cand: { id: string; rowid: number }, scope: string, topic: string): void {
    if (!VEC0) return;
    const v = topicVector(topic);
    let max = 0;
    for (const x of v) max = Math.max(max, Math.abs(x));
    const q = new Int8Array(v.length);
    for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((127 * v[i]!) / max)));
    vec((d) => {
      d.query("DELETE FROM nodes_vec WHERE node_rowid = ?1").run(cand.rowid);
      d.query(
        "INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding) VALUES (?1, ?2, 2, 'note', 1, vec_int8(?3))",
      ).run(cand.rowid, scope, Buffer.from(q.buffer));
    });
  }

  // Кандидат найдётся и лексикой, и (при vec0) вектором. Мутация «снять
  // фильтр» из запроса fts ИЛИ из запроса knn absorb роняет этот тест: цель —
  // кандидат (класс duplicate при векторе, related без него), новая заметка
  // уходит в него.
  test("почти дословный повтор кандидата остаётся самостоятельной заметкой", async () => {
    const other = await remember("beta: рецепт блинов — 200 г муки, 2 яйца, 300 мл молока, щепотка соли.");
    await myc("absorb");
    const cand = candidate(scopeOf(other), ALPHA_OLD);
    embedCandidate(cand, scopeOf(other), "alpha");
    const fresh = await remember(
      "alpha: миграции только вперёд, версия целочисленная, таблица schema_migrations с checksum, при расхождении exit 4",
    );
    const { env } = await mycJson<AbsorbData>("absorb");
    const r = env.data.nodes.find((x) => x.id === fresh)!;
    expect(r.class).not.toBe("duplicate");
    expect(r.target).not.toBe(cand.id);
    const f = node(fresh);
    expect(f.status).toBe("active");
    expect(f.head_id).toBeNull();
    // Кандидат не тронут: ждёт разбора, повтором не засчитан.
    expect(node(cand.id).seen_count).toBe(1);
    expect(stateOf(cand.id)).toBe("pending_review");
    expect(edges()).not.toContainEqual(expect.objectContaining({ type: "duplicates", dst: cand.id }));
  });

  // Путь kNN — тем же текстом запроса, что исполняет команда: у кандидата и у
  // обычной заметки ОДИН И ТОТ ЖЕ вектор, запрос обязан вернуть только
  // заметку. Мутация «снять фильтр из запроса knn absorb» роняет этот тест.
  test.skipIf(!VEC0)("kNN absorb не возвращает кандидата при том же векторе", async () => {
    const plain = await remember(ALPHA_OLD);
    await myc("absorb"); // накатывает векторный набор миграций: nodes_vec появляется здесь
    const scope = scopeOf(plain);
    const cand = candidate(scope, "alpha: кандидат с тем же вектором темы");
    const v = topicVector("alpha");
    let max = 0;
    for (const x of v) max = Math.max(max, Math.abs(x));
    const q = new Int8Array(v.length);
    for (let i = 0; i < v.length; i++) q[i] = Math.max(-127, Math.min(127, Math.round((127 * v[i]!) / max)));
    const blob = Buffer.from(q.buffer);
    const found = vec((d) => {
      const plainRow = d.query<{ rowid: number }, [string]>("SELECT rowid FROM nodes WHERE id = ?1").get(plain)!.rowid;
      for (const rowid of [plainRow, cand.rowid]) {
        d.query("DELETE FROM nodes_vec WHERE node_rowid = ?1").run(rowid);
        d.query(
          "INSERT INTO nodes_vec (node_rowid, scope, layer, kind, head, embedding) VALUES (?1, ?2, 1, 'note', 1, vec_int8(?3))",
        ).run(rowid, scope, blob);
      }
      return d
        .query<{ id: string }, [Buffer, number, string, string, string]>(absorbQueries.knn.sql)
        .all(blob, 24, scope, "self-none", "note")
        .map((r) => r.id);
    });
    expect(found).toContain(plain);
    expect(found).not.toContain(cand.id);
  });
});

// ---------------------------------------------------------------------------
// Кандидат как ИСТОЧНИК классификации (memory-79mq6fccg0jm): названный по id
// или попавший в очередь, он не классифицируется — старше дубля, он стал бы
// каноническим, и явная заметка ушла бы в него.
// ---------------------------------------------------------------------------

describe("кандидат хука сжатия — не источник классификации", () => {
  function candidate(scope: string, title: string): string {
    const driver = openSqlite({ path: join(dir, ".myc", "myc.db") });
    try {
      const store = new GraphStore(driver, { newId: () => generateId(), siteId: "site-test", actor: "hook" });
      return store.createNode({
        kind: "note",
        layer: 2,
        acl: "private",
        salience: 0,
        scope,
        title,
        actor: "hook",
        attrs: { state: "pending_review", extracted_by: "precompact", episode_id: "ep-1", reach: "session", session_id: "S-1" },
      }).id;
    } finally {
      driver.close();
    }
  }

  function scopeOf(id: string): string {
    return (db((d) => d.query("SELECT scope FROM nodes WHERE id = ?1").get(id)) as { scope: string }).scope;
  }

  // Мутация «убрать отказ по id в команде absorb» роняет этот тест (узел
  // получает attrs.absorb, а младшая явная заметка — head_id на кандидата).
  test("`myc absorb <id кандидата>` — отказ precond с командой разбора; кандидат не тронут", async () => {
    const plain = await remember(ALPHA_OLD);
    const cand = candidate(scopeOf(plain), `${ALPHA_OLD} (кандидат)`);
    const { code, env } = await mycJson("absorb", cand);
    expect(code).toBe(ExitCode.PRECOND);
    expect(env.error?.code).toBe("precond.pending_review");
    expect(env.error?.hint).toBe(`myc review confirm ${cand}`);
    expect(node(cand).absorb).toBeUndefined();
    expect(node(plain).head_id).toBeNull();
  });

  // Работа очереди у кандидата (хук её не ставит, но старые базы и чужие
  // писатели — могут). Мутация «убрать пропуск кандидата в absorbOne» роняет
  // этот тест: кандидат получает attrs.absorb и класс, счётчики — единицу.
  test("работа очереди у кандидата: пропуск без записи, работа снята, деградации нет", async () => {
    const plain = await remember(ALPHA_OLD);
    await myc("absorb");
    const cand = candidate(scopeOf(plain), `${ALPHA_OLD} (кандидат из очереди)`);
    const driver = openSqlite({ path: join(dir, ".myc", "myc.db") });
    try {
      driver.database
        .query("INSERT INTO jobs (kind, entity_id, scope, priority, run_after, payload, created_at) VALUES ('absorb', ?1, ?2, 5, 0, '{}', 0)")
        .run(cand, scopeOf(plain));
    } finally {
      driver.close();
    }
    const { env } = await mycJson<AbsorbData>("absorb");
    const r = env.data.nodes.find((x) => x.id === cand)!;
    expect(r.skipped).toBe("pending_review");
    expect(r.actions).toEqual([]);
    expect(Object.values(env.data.by_class).reduce((a, b) => a + b, 0)).toBe(0);
    expect(env.data.degraded).toBeNull();
    expect(node(cand).absorb).toBeUndefined();
    expect(jobs("absorb")).not.toContain(cand);
  });
});

// ---------------------------------------------------------------------------
// Отозванная заметка — не цель дедупликации (memory-0p3d8n1efwtv): дубль ушёл
// бы в неё superseded, а её саму выдача больше не отдаёт.
// ---------------------------------------------------------------------------

describe("отозванная заметка — не цель дедупликации", () => {
  // Мутация «вернуть в запросы fts/knn absorb только <> 'superseded'» роняет
  // этот тест: цель — отозванная (duplicate при векторе, related без него).
  test("почти дословный повтор отозванной остаётся самостоятельной живой заметкой", async () => {
    await remember("beta: рецепт блинов — 200 г муки, 2 яйца, 300 мл молока, щепотка соли.");
    const gone = await remember(ALPHA_OLD);
    await myc("absorb"); // у отозванной есть вектор — она была знанием до отзыва
    const driver = openSqlite({ path: join(dir, ".myc", "myc.db") });
    try {
      new GraphStore(driver, { newId: () => generateId(), siteId: "site-test", actor: "tester" }).updateNode(gone, {
        status: "retracted",
      });
    } finally {
      driver.close();
    }
    const fresh = await remember(
      "alpha: миграции только вперёд, версия целочисленная, таблица schema_migrations с checksum, при расхождении exit 4",
    );
    const { env } = await mycJson<AbsorbData>("absorb");
    const r = env.data.nodes.find((x) => x.id === fresh)!;
    expect(r.target).not.toBe(gone);
    const f = node(fresh);
    expect(f.status).toBe("active");
    expect(f.head_id).toBeNull();
    expect(edges()).not.toContainEqual(expect.objectContaining({ src: fresh, dst: gone }));
  });
});

describe("вспомогательные", () => {
  test("absorbText не удваивает заголовок-обрезок", () => {
    expect(absorbText({ title: "Первая строка…", body: "Первая строка и дальше", excerpt: null })).toBe(
      "Первая строка и дальше",
    );
    expect(absorbText({ title: "Заголовок", body: "Тело", excerpt: null })).toBe("Заголовок\nТело");
    expect(absorbText({ title: "", body: null, excerpt: "выдержка" })).toBe("выдержка");
  });

  test("ftsMatchOf: длинные слова, кавычки, OR", () => {
    expect(ftsMatchOf("myc models fetch: sha256 и \"кавычки\" (скобки)")).toBe(
      '"кавычки" OR "models" OR "sha256" OR "скобки" OR "fetch" OR "myc"',
    );
    expect(ftsMatchOf("и в")).toBeNull();
  });
});
