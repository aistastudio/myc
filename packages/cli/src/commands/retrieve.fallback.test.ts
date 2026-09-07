/**
 * S44 на уровне CLI: то же, что проверял координатор руками.
 *
 * Здесь не перепроверяется лексика (у неё свои тесты в @myc/retrieval) — здесь
 * проверяется то, что видит пользователь: находится ли заметка по вопросу
 * своими словами, названа ли ступень отката в футере и объясняет ли себя
 * пустая выдача. Молчаливая пустота — главный запрет И2, и поймать её можно
 * только на этом уровне, потому что молчит именно вывод.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createInitCommand } from "./init.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { createRecallCommand } from "./recall.ts";
import { createSearchCommand } from "./search.ts";
import {
  embedDaemonEnabled,
  emptyDropCounts,
  emptyReasonOf,
  lexicalLabelOf,
  modeLabelOf,
  realRetrieveExtras,
  resolveQueryEmbedder,
  type RetrieveDeps,
  type WarmEmbedder,
} from "./retrieve.ts";
import { realStoreDeps } from "./store.ts";

let dir: string;
let home: string;
let registry: Registry;
/** Что вернёт прогретый демон в текущем тесте; undefined — демона нет вовсе. */
let warmVector: Float32Array | null = null;
let warmCalls = 0;
let warmStarted = 0;

function retrieveDeps(): RetrieveDeps {
  const warm: WarmEmbedder = {
    vector: async () => {
      warmCalls++;
      return warmVector === null
        ? { ok: false, daemon: "absent", reason: "в тесте демона нет" }
        : { ok: true, vec: warmVector };
    },
    warmInBackground: () => {
      warmStarted++;
      return "прогрев эмбеддера запущен в фоне (тест)";
    },
  };
  return {
    openStore: realStoreDeps.openStore,
    openPersonal: realRetrieveExtras.openPersonal,
    resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
    warmEmbedder: () => warm,
  };
}

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createInitCommand());
  r.register(createRememberCommand({ ...realRememberDeps, chatLlm: () => false }));
  r.register(createRecallCommand(retrieveDeps()));
  r.register(createSearchCommand(retrieveDeps()));
  return r;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-s44-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  process.env.MYC_HOME = home;
  process.env.MYC_ACTOR = "tester";
  mkdirSync(join(dir, ".myc"));
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = makeRegistry();
  warmVector = null;
  warmCalls = 0;
  warmStarted = 0;
});

afterEach(() => {
  delete process.env.MYC_HOME;
  delete process.env.MYC_ACTOR;
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["--directory", dir, ...args], { tty: false, env: process.env as never, registry });
}

interface RecallData {
  rows: { title: string }[];
  total: number;
  mode: string;
}

describe("S44 в CLI — воспроизведение координатора", () => {
  const NOTE = "оплог сливается объединением по op_id, текстовый мерж неверен";

  beforeEach(async () => {
    await myc("remember", NOTE);
  });

  test("«как сливать оплог» находит заметку, и футер называет ступень", async () => {
    const r = await myc("recall", "как сливать оплог", "--json");
    expect(r.code).toBe(0);
    const data = (JSON.parse(r.stdout as string) as { data: RecallData }).data;
    expect(data.total).toBe(1);
    expect(data.rows[0]?.title).toBe(NOTE);
    // mode_used не просто «нашлось», а ЧЕМ нашлось.
    expect(data.mode).toContain("И→");
  });

  test("«оплог мерж» по-прежнему отвечает строгим И — откат его не трогает", async () => {
    const r = await myc("recall", "оплог мерж", "--json");
    const data = (JSON.parse(r.stdout as string) as { data: RecallData }).data;
    expect(data.total).toBe(1);
    expect(data.mode).not.toContain("И→");
  });

  test("пустая выдача при НЕпустой базе объясняет причину прямо в футере", async () => {
    const r = await myc("recall", "гуашь мольберт натюрморт");
    const out = r.stdout as string;
    expect(out).toContain("пусто");
    // Три вещи, которые обязан различать пользователь: сколько узлов видно,
    // каким оператором искали и участвовала ли векторная ветка.
    expect(out).toMatch(/ни один из \d+ видимых узлов не совпал/);
    expect(out).toContain("векторная ветка не участвовала");
  });

  test("пустая выдача при ПУСТОЙ базе говорит именно это, а не «не нашлось»", async () => {
    const empty = mkdtempSync(join(tmpdir(), "myc-s44-empty-"));
    mkdirSync(join(empty, ".myc"));
    const raw = new Database(join(empty, ".myc", "myc.db"), { create: true });
    await migrate(raw, { migrations, writable: true });
    raw.close();
    const r = await run(["--directory", empty, "recall", "что угодно"], {
      tty: false,
      env: process.env as never,
      registry,
    });
    expect(r.stdout as string).toContain("нет ни одного видимого узла");
    rmSync(empty, { recursive: true, force: true });
  });

  test("всё отфильтровано — это третья причина, и она названа отдельно", async () => {
    const r = await myc("recall", "оплог", "--kind", "task");
    const out = r.stdout as string;
    expect(out).toContain("отсеяно");
    // Назван СРАБОТАВШИЙ фильтр и команда его снятия, а не дежурный список:
    // отсеял --kind, и совет говорит про --kind.
    expect(out).toContain("тип — 1");
    expect(out).toContain("убери --kind");
    // Ни одна ручка, которой здесь не крутили, в совет не попала.
    expect(out).not.toContain("--tag");
    expect(out).not.toContain("--layer");
    expect(out).not.toContain("--since");
  });
});

describe("S44 в CLI — прогретый эмбеддер", () => {
  beforeEach(async () => {
    await myc("remember", "оплог сливается объединением по op_id");
  });

  test("вектор берётся у прогретого демона, свой эмбеддер не поднимается", async () => {
    warmVector = new Float32Array(384).fill(0.1);
    const r = await myc("recall", "как объединять журнал операций");
    expect(warmCalls).toBe(1);
    // Демон дал вектор — фоновый прогрев поднимать незачем.
    expect(warmStarted).toBe(0);
    expect(r.code).toBe(0);
  });

  test("демона нет — команда не ждёт его, а запускает прогрев в фоне и говорит об этом", async () => {
    warmVector = null;
    const r = await myc("recall", "как объединять журнал операций");
    expect(warmCalls).toBe(1);
    expect(warmStarted).toBe(1);
    const said = `${r.stdout as string}${r.stderr ?? ""}`;
    expect(said).toContain("прогрев эмбеддера запущен в фоне");
    // Команда всё равно ответила — прогрев её не задержал и не уронил.
    expect(r.code).toBe(0);
  });

  test("под --strict отсутствие вектора остаётся деградацией, а не успехом", async () => {
    warmVector = null;
    const r = await myc("--strict", "recall", "как объединять журнал операций");
    expect(r.code).not.toBe(0);
  });
});

describe("S44 — чистые функции ярлыка и причины", () => {
  const modeOf = (lexical: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    // R3: mode_used — СПИСОК источников; `project` рядом остался производным
    // видом для поверхностей, знающих федерацию с S41.
    const mode = {
      sources: ["fts"],
      vector: "unavailable",
      lexical: {
        operator: "and",
        fallbackUsed: false,
        andHits: 1,
        hits: 1,
        terms: 2,
        stagesTried: 0,
        coverageApplied: false,
        ...lexical,
      },
      why: "",
      trigger: {
        fired: false,
        reasons: [],
        checks: {
          fewResults: false,
          lowBm25Spread: false,
          shortQueryNoAnchor: false,
          lexicalFallback: false,
        },
        anchorHit: false,
        metrics: { lexicalHits: 1, bm25Spread: 0, queryTerms: 2, anchorTerms: 0 },
      },
      roundTrips: 1,
      vectorRoundTrips: 0,
      degraded: [],
      graphSeeds: "lexical",
      ...extra,
    };
    return {
      sources: [{ id: "project", kind: "project", weight: 1, queried: true, mode, hits: 1 }],
      queried: 1,
      skipped: 0,
      cap: 8,
      deadlineMs: 18,
      took_ms: 0,
      project: mode,
      personalQueried: false,
      why: "",
    } as never;
  };

  test("ярлык называет ступень, а не факт отката", () => {
    expect(lexicalLabelOf(modeOf({ operator: "and" }))).toBeUndefined();
    expect(lexicalLabelOf(modeOf({ operator: "prefix_and", fallbackUsed: true }))).toBe(
      "И→префиксы",
    );
    expect(lexicalLabelOf(modeOf({ operator: "prefix_relaxed", fallbackUsed: true }))).toBe(
      "И→без одного слова",
    );
    expect(
      lexicalLabelOf(modeOf({ operator: "or", fallbackUsed: true, coverageApplied: true })),
    ).toBe("И→ИЛИ+покрытие");
  });

  const noKnobs = { flags: [], repo: "", layer: "" };
  const drops = (over: Partial<Record<string, number>> = {}) => ({
    ...emptyDropCounts(),
    ...over,
  });

  test("три причины пустоты не смешиваются", () => {
    // Нашлось, но отфильтровано.
    expect(emptyReasonOf(modeOf({}), 7, 0, drops({ kind: 7 }), noKnobs)).toContain("отсеяно");
    // Не нашлось: причина приходит из яруса.
    const noMatch = modeOf(
      {},
      {
        emptyReason: {
          code: "no_match",
          text: "ни один из 40 видимых узлов не совпал",
          corpusSize: 40,
          corpusAtLeast: false,
        },
      },
    );
    // R3: причина пустоты называет ИМЯ источника — на шестнадцати воркспейсах
    // «проект» уже не адрес.
    expect(emptyReasonOf(noMatch, 0, 0, drops(), noKnobs)).toContain("project: ни один из 40");
    // Выдача непуста — причины нет вовсе.
    expect(emptyReasonOf(modeOf({}), 3, 3, drops(), noKnobs)).toBeUndefined();
  });

  test("ярлык режима при пустой выдаче несёт причину", () => {
    expect(modeLabelOf(modeOf({}), 60)).toBe("bm25 only");
    expect(modeLabelOf(modeOf({}), 60, "база пуста")).toContain("пусто · база пуста");
  });

  test("myc-ye3.9: выдача только на векторе без лексики помечена в ярлыке", () => {
    const vectorOnly = modeOf(
      { operator: "and", hits: 0 },
      { sources: ["vector"], vector: "used", vectorOnly: true },
    );
    expect(modeLabelOf(vectorOnly, 60)).toContain("только вектор");

    // Тот же источник "vector", но лексика что-то нашла (сочетается с ним) —
    // ярлык не паникует по одному лишь наличию вектора в sources.
    const fused = modeOf(
      { operator: "and", hits: 1 },
      { sources: ["fts", "vector"], vector: "used", vectorOnly: false },
    );
    expect(modeLabelOf(fused, 60)).not.toContain("только вектор");
  });
});

describe("S44 — выключатели фонового прогрева", () => {
  test("NODE_ENV=test выключает демона сам", () => {
    expect(embedDaemonEnabled({ NODE_ENV: "test" } as never)).toBe(false);
  });

  test("MYC_EMBED_DAEMON выключает его явно", () => {
    expect(embedDaemonEnabled({} as never)).toBe(true);
    for (const v of ["0", "off", "false", "no", "OFF"]) {
      expect(embedDaemonEnabled({ MYC_EMBED_DAEMON: v } as never)).toBe(false);
    }
  });

  test("боевые зависимости несут прогрев, но в тестовом окружении он не поднимается", () => {
    expect(typeof realRetrieveExtras.warmEmbedder).toBe("function");
    expect(typeof realRetrieveExtras.openPersonal).toBe("function");
    expect(realRetrieveExtras.resolveEmbedder).toBe(resolveQueryEmbedder);
  });
});
