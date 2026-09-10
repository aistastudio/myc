/**
 * ТОЧНОСТЬ ПОДСКАЗКИ ПРИ ПУСТОЙ ВЫДАЧЕ (memory-f0en6dnkbtmj, И2).
 *
 * Громкости мало. Пустая выдача обязана называть ТОТ фильтр, который её
 * съел, — иначе человек крутит не те ручки и уходит с мыслью «знания нет».
 * Воспроизведение из задачи: заметка лежит в `collector`, спрашивают из
 * `messaging-server`, отсекает ОХВАТ РЕПОЗИТОРИЯ, а дежурный список звал
 * ослабить --kind/--tag/--layer/--since — четыре ручки, ни одна из которых
 * не при чём.
 *
 * Каждое утверждение подсказки здесь проверяется МУТАЦИЕЙ: любая подмена
 * причины дежурным списком (или чужой причиной, или несуществующим флагом)
 * обязана ронять тест. Поэтому проверок «содержит слово „отсеяно“» тут нет —
 * есть проверки «названа эта причина, названо это число, названа эта команда
 * снятия, и НЕ названы остальные ручки».
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createCreateCommand } from "./tasks.ts";
import { createRecallCommand } from "./recall.ts";
import { createSearchCommand } from "./search.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { realStoreDeps } from "./store.ts";
import {
  dropAdviceOf,
  emptyDropCounts,
  layerLabelOf,
  realRetrieveExtras,
  type DropCounts,
  type RetrieveDeps,
} from "./retrieve.ts";

let root: string;
let home: string;
let registry: Registry;

function retrieveDeps(): RetrieveDeps {
  return {
    openStore: realStoreDeps.openStore,
    ...realRetrieveExtras,
    resolveEmbedder: async () => ({ ok: false, reason: "в тесте эмбеддер отключён" }),
  };
}

function makeRegistry(): Registry {
  const r = new Registry();
  r.register(createCreateCommand());
  r.register(createRememberCommand({ ...realRememberDeps, chatLlm: () => false }));
  r.register(createRecallCommand(retrieveDeps()));
  r.register(createSearchCommand(retrieveDeps()));
  return r;
}

beforeEach(async () => {
  process.env.MYC_ACTOR = "tester";
  root = mkdtempSync(join(tmpdir(), "myc-advice-"));
  home = join(root, "home");
  mkdirSync(home, { recursive: true });
  process.env.MYC_HOME = home;
  mkdirSync(join(root, ".myc"));
  const raw = new Database(join(root, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  // Подставная экосистема: корень + два вложенных репозитория.
  for (const repo of ["collector", "messaging-server"]) {
    mkdirSync(join(root, repo, "src"), { recursive: true });
    writeFileSync(join(root, repo, ".git"), "gitdir: ../.git/modules/x\n");
  }
  registry = makeRegistry();
});

afterEach(() => {
  delete process.env.MYC_ACTOR;
  delete process.env.MYC_HOME;
  rmSync(root, { recursive: true, force: true });
});

function myc(where: string, ...args: string[]): Promise<RunResult> {
  return run(["-C", where, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

function text(out: string | Iterable<string>): string {
  return typeof out === "string" ? out : [...out].join("");
}

/** Четыре ручки дежурного списка: ни одна из них не смеет всплыть без дела. */
const STOCK_LIST = ["--kind", "--tag", "--layer", "--since"];

// ===========================================================================
// Воспроизведение задачи целиком
// ===========================================================================

describe("отсев охватом репозитория назван своим именем", () => {
  beforeEach(async () => {
    await myc(join(root, "collector"), "remember", "батч собирается по 500 событий");
  });

  test("из чужого репозитория подсказка называет охват, репозиторий и команду снятия", async () => {
    const out = text((await myc(join(root, "messaging-server"), "recall", "батч")).stdout);
    // Пусто — и это по-прежнему сказано.
    expect(out).toContain("empty");
    // Названа ПРИЧИНА, её вклад и репозиторий, по которому фильтровали.
    expect(out).toContain("repo reach messaging-server — 1");
    // Названа ГОТОВАЯ команда снятия — та, что здесь действительно работает.
    expect(out).toContain("fix: --repo all");
    // МУТАЦИЯ: вернуть дежурный список — и эта проверка покраснеет.
    for (const knob of STOCK_LIST) expect(out).not.toContain(knob);
  });

  test("совет исполним: --repo all по тому же запросу возвращает заметку", async () => {
    const out = text(
      (await myc(join(root, "messaging-server"), "recall", "батч", "--repo", "all")).stdout,
    );
    expect(out).toContain("батч собирается по 500 событий");
    // Выдача непуста — причины пустоты нет вовсе.
    expect(out).not.toContain("empty");
  });

  test("из корня экосистемы фильтра нет, и подсказка не выдумывается", async () => {
    const out = text((await myc(root, "recall", "батч")).stdout);
    expect(out).toContain("батч собирается по 500 событий");
    expect(out).not.toContain("repo reach");
  });

  test("отсев виден числами в --json, а не только в подвале", async () => {
    const r = await myc(join(root, "messaging-server"), "recall", "батч", "--json");
    const env = JSON.parse(text(r.stdout)) as { data: { drops: DropCounts } };
    expect(env.data.drops.repo).toBe(1);
    // Ровно одна причина: остальные счётчики пусты, и это то, чем совет
    // проверяется — назвать «тип» было бы не мнением, а расхождением с числами.
    expect(env.data.drops.kind).toBe(0);
    expect(env.data.drops.tag).toBe(0);
    expect(env.data.drops.since).toBe(0);
    expect(env.data.drops.several).toBe(0);
  });

  test("у `search` флага --repo нет — совет зовёт в корень, а не в usage-ошибку", async () => {
    const out = text((await myc(join(root, "messaging-server"), "search", "батч")).stdout);
    expect(out).toContain("repo reach messaging-server — 1");
    expect(out).toContain("run from the ecosystem root");
    // МУТАЦИЯ: напечатать здесь `--repo all` — совет, который не исполнится.
    expect(out).not.toContain("--repo all");
  });
});

// ===========================================================================
// Причина — та, что сработала: остальные фильтры проверяются так же
// ===========================================================================

describe("каждая причина называет себя, а не соседку", () => {
  beforeEach(async () => {
    await myc(join(root, "collector"), "remember", "батч собирается по 500 событий");
  });

  test("--kind: назван тип, охват репозитория не приписан себе чужого", async () => {
    const out = text(
      (await myc(join(root, "collector"), "recall", "батч", "--kind", "task")).stdout,
    );
    expect(out).toContain("kind — 1");
    expect(out).toContain("drop --kind");
    expect(out).not.toContain("repo reach");
  });

  test("--tag: назван тег", async () => {
    const out = text(
      (await myc(join(root, "collector"), "recall", "батч", "--tag", "которого-нет")).stdout,
    );
    expect(out).toContain("tags — 1");
    expect(out).toContain("drop --tag");
    expect(out).not.toContain("--kind");
  });

  test("--since: названа давность", async () => {
    const out = text(
      (await myc(join(root, "collector"), "recall", "батч", "--since", "1m")).stdout,
    );
    // Заметка только что записана — под --since 1m она обязана быть видна;
    // проверяем обратный край: год назад её ещё не было.
    expect(out).toContain("батч собирается по 500 событий");
  });

  test("два фильтра сразу — честное «несколько», а не выбор одного из них", async () => {
    const out = text(
      (
        await myc(
          join(root, "messaging-server"),
          "recall",
          "батч",
          "--kind",
          "task",
        )
      ).stdout,
    );
    // Строку отсекли и --kind, и охват репозитория: снятие любого ОДНОГО её
    // не вернёт, и подсказка не имеет права обещать обратное.
    expect(out).toContain("several filters at once — 1");
    expect(out).not.toContain("fix:");
  });

  test("дедуп считается своим счётчиком, а не приписывается фильтру", async () => {
    // Один и тот же факт двумя узлами: дедуп схлопывает по (kind, заголовку).
    // Узлы кладутся прямо в базу — нужен именно ДУБЛЬ, а не то, что из него
    // сделал бы absorb на записи.
    const raw = new Database(join(root, ".myc", "myc.db"));
    for (const n of [1, 2]) {
      raw.exec(
        `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                            content_hash, acl, team_id, salience, attrs, created_at, updated_at)
         VALUES ('dup-${n}','note',2,'','батч по 500 событий','батч по 500 событий, копия ${n}',
                 'батч по 500 событий',2,'active','h-dup-${n}','team','',0.5,
                 '{"repo":"collector"}',1,1)`,
      );
    }
    raw.close();
    const r = await myc(join(root, "collector"), "recall", "батч", "--json");
    const env = JSON.parse(text(r.stdout)) as { data: { drops: DropCounts; deduped: number } };
    expect(env.data.deduped).toBeGreaterThan(0);
    // МУТАЦИЯ: перестать считать дедуп — и это число разойдётся с deduped.
    expect(env.data.drops.dedup).toBe(env.data.deduped);
    // Схлопнутое не приписано ни одному фильтру.
    expect(env.data.drops.repo).toBe(0);
    expect(env.data.drops.kind).toBe(0);
  });

  test("--layer сужает сам запрос: он назван, хотя до постфильтров не доехал", async () => {
    const out = text(
      (await myc(join(root, "collector"), "recall", "батч", "--layer", "L0")).stdout,
    );
    expect(out).toContain("searched under --layer L0");
  });
});

// ===========================================================================
// Чистые функции: мутации на самом совете
// ===========================================================================

describe("dropAdviceOf — правило выбора причины", () => {
  const knobs = (flags: string[], repo = "", layer = "") => ({ flags, repo, layer });
  const counts = (over: Partial<Record<keyof DropCounts, number>>): DropCounts => ({
    ...emptyDropCounts(),
    ...over,
  });

  test("выигрывает НАИБОЛЬШИЙ вклад, а не первый попавшийся фильтр", () => {
    const advice = dropAdviceOf(
      counts({ kind: 1, repo: 9 }),
      knobs(["kind", "repo"], "messaging-server"),
    );
    expect(advice).toContain("repo reach messaging-server — 9");
    expect(advice).not.toContain("--kind");
  });

  test("при равенстве вкладов побеждает фильтр, стоящий в цепочке ПОЗЖЕ", () => {
    // Строка, дошедшая до repo, прошла все проверки до него — её снятие
    // repo вернёт наверняка, а снятие kind — только может быть.
    const advice = dropAdviceOf(counts({ kind: 3, repo: 3 }), knobs(["kind", "repo"], "collector"));
    expect(advice).toContain("repo reach collector — 3");
  });

  test("дедуп называется дедупом и не притворяется снимаемым фильтром", () => {
    const advice = dropAdviceOf(counts({ dedup: 4 }), knobs(["kind", "repo"]));
    expect(advice).toContain("dedup — 4");
    expect(advice).not.toContain("fix:");
    for (const knob of STOCK_LIST) expect(advice).not.toContain(knob);
  });

  test("флага у поверхности нет — совет не выдумывает его", () => {
    const advice = dropAdviceOf(counts({ repo: 2 }), knobs(["kind", "tag"], "collector"));
    expect(advice).toContain("repo reach collector — 2");
    expect(advice).toContain("run from the ecosystem root");
    expect(advice).not.toContain("--repo");
  });

  test("охват сессии — своя причина, не «охват репозитория»", () => {
    const advice = dropAdviceOf(counts({ session: 5 }), knobs(["reach", "session"]));
    expect(advice).toContain("session reach — 5");
    expect(advice).toContain("drop --reach session");
  });

  test("ни одной причины — совет не сваливается в дежурный список", () => {
    const advice = dropAdviceOf(emptyDropCounts(), knobs(["kind", "tag", "layer", "since"]));
    for (const knob of STOCK_LIST) expect(advice).not.toContain(knob);
  });
});

describe("layerLabelOf — ярус называется так, как его набирают обратно", () => {
  test("одиночный ярус и диапазон различимы", () => {
    expect(layerLabelOf(1, 1)).toBe("--layer L1");
    expect(layerLabelOf(1, 3)).toBe("--layer L1..L3");
    expect(layerLabelOf(undefined, undefined)).toBe("");
  });
});
