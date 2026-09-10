/**
 * Приёмка `myc callers` и `myc skeleton` (memory-wrntvzwx8dh0) — двух команд,
 * ради которых в CLAUDE.md этого проекта держали graft.
 *
 * Мутации, которые обязаны уронить проверки ниже:
 *
 *   МУТАЦИЯ «группировки нет» — печатать по строке на вхождение вместо ребра
 *   на владельца: краснеет «одна группа на зовущего», где на трёх вхождениях
 *   одного владельца ожидается ОДНА группа.
 *
 *   МУТАЦИЯ «направление игнорируется» — отдавать на `--direction out` тот же
 *   ответ, что на `in`: краснеет «out отвечает на другой вопрос».
 *
 *   МУТАЦИЯ «глубина игнорируется» — всегда ходить на один шаг: краснеет
 *   «--depth 2 приводит деда»; всегда ходить до упора — краснеет
 *   «--depth 1 деда не приводит».
 *
 *   МУТАЦИЯ «неоднозначность проглочена» — убрать WARN о нескольких
 *   определениях имени: краснеет «одноимённые методы названы, а не выбраны
 *   наугад».
 *
 *   МУТАЦИЯ «пусто без причины» — вернуть пустой ответ там, где ссылки просто
 *   не построены: краснеет «пустой индекс отличается от «никто не зовёт»».
 *
 *   МУТАЦИЯ «скелет = файл» — печатать спаны целиком: краснеет «скелет дешевле
 *   файла», где отношение байтов проверяется числом.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { ExitCode } from "../exit.ts";
import { run, type RunResult } from "../index.ts";
import { Registry } from "../registry.ts";
import { createCodeCommand } from "./code.ts";
import { createCallersCommand } from "./callers.ts";
import { createSkeletonCommand } from "./skeleton.ts";

const CHAIN = `export function leaf(n: number): number {
  return n + 1;
}

export function mid(n: number): number {
  const a = leaf(n);
  const b = leaf(a);
  return leaf(b);
}

export function top(n: number): number {
  return mid(n);
}
`;

const TWINS = `export class Left {
  close(): number {
    return 1;
  }
}

export class Right {
  close(): number {
    return 2;
  }
}
`;

/** Файл с настоящими телами: на нём и меряется «дешевле файла». */
const FAT = `import { leaf } from "./chain.ts";

export function fat(n: number): number {
${Array.from({ length: 40 }, (_, i) => `  const v${i} = leaf(${i});`).join("\n")}
  const label = String(n);
  return n + label.length;
}
`;

let dir: string;
let home: string;
let registry: Registry;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "myc-callers-cli-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(dir, ".myc"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "chain.ts"), CHAIN);
  writeFileSync(join(dir, "src", "twins.ts"), TWINS);
  writeFileSync(join(dir, "src", "fat.ts"), FAT);
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
  registry = new Registry();
  registry.register(createCodeCommand());
  registry.register(createCallersCommand());
  registry.register(createSkeletonCommand());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "tester", MYC_HOME: home } });
}

interface Envelope {
  ok: boolean;
  data: Record<string, unknown>;
  warn: { code: string; msg: string }[];
}

async function envelope(...args: string[]): Promise<Envelope> {
  const r = await myc(...args, "--json");
  return JSON.parse(r.stdout as string) as Envelope;
}

async function data(...args: string[]): Promise<Record<string, unknown>> {
  const env = await envelope(...args);
  expect(env.ok).toBe(true);
  return env.data;
}

async function indexed(): Promise<void> {
  const r = await myc("code", "index");
  expect(r.code).toBe(ExitCode.OK);
}

// ---------------------------------------------------------------------------
// myc callers
// ---------------------------------------------------------------------------

describe("myc callers — ребро графа вместо списка совпадений", () => {
  test("одна группа на зовущего, все его строки внутри", async () => {
    await indexed();
    const d = await data("callers", "leaf", "--kind", "call");
    const edges = d["edges"] as Array<{ caller: string; sites: unknown[]; path: string }>;
    const mid = edges.filter((e) => e.caller === "mid");
    expect(mid.length).toBe(1);
    expect(mid[0]!.sites.length).toBe(3);
    // Три вхождения — одна группа: без группировки здесь было бы три.
    expect(d["sites"]).toBeGreaterThan(d["total_edges"] as number);
  });

  test("строка исходника приезжает с ответом, --no-source её убирает", async () => {
    await indexed();
    const withText = await data("callers", "leaf", "--kind", "call");
    const first = (withText["edges"] as Array<{ sites: Array<{ text?: string }> }>)[0]!;
    expect(first.sites[0]!.text).toContain("leaf(");
    expect(withText["files_read"]).toBeGreaterThan(0);

    const without = await data("callers", "leaf", "--kind", "call", "--no-source");
    const bare = (without["edges"] as Array<{ sites: Array<{ text?: string }> }>)[0]!;
    expect(bare.sites[0]!.text).toBeUndefined();
    expect(without["files_read"]).toBe(0);
  });

  test("человеческий вывод называет зовущего и место, а не только строки", async () => {
    await indexed();
    const r = await myc("callers", "leaf", "--kind", "call");
    const out = r.stdout as string;
    expect(out).toContain("mid");
    expect(out).toContain("src/chain.ts");
    expect(out).toContain("callers · depth 1");
  });
});

describe("направление: out отвечает на другой вопрос", () => {
  test("in даёт зовущих, out — зовомых", async () => {
    await indexed();
    const inbound = await data("callers", "mid", "--kind", "call");
    const outbound = await data("callers", "mid", "--direction", "out", "--kind", "call");
    expect((inbound["edges"] as Array<{ caller: string }>).map((e) => e.caller)).toContain("top");
    expect((outbound["edges"] as Array<{ callee: string }>).map((e) => e.callee)).toEqual(["leaf"]);
    expect(inbound["direction"]).toBe("in");
    expect(outbound["direction"]).toBe("out");
  });

  test("out по имени без определения отказывает с причиной, а не пустотой", async () => {
    await indexed();
    const r = await myc("callers", "нетакого", "--direction", "out");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.stderr ?? "").toContain("its body is not in this repo");
  });

  test("умолчание видов у out — вызовы: чтения локалей не выдаются за граф", async () => {
    await indexed();
    const d = await data("callers", "fat", "--direction", "out");
    expect(d["kinds"]).toEqual(["call", "new"]);
    const all = await data("callers", "fat", "--direction", "out", "--kind", "all");
    expect((all["kinds"] as string[]).length).toBe(6);
    expect(all["sites"]).toBeGreaterThan(d["sites"] as number);
  });
});

describe("глубина: считается, а не декларируется", () => {
  test("--depth 1 деда не приводит, --depth 2 приводит", async () => {
    await indexed();
    const one = await data("callers", "leaf", "--kind", "call");
    expect((one["edges"] as Array<{ caller: string }>).map((e) => e.caller)).not.toContain("top");

    const two = await data("callers", "leaf", "--kind", "call", "--depth", "2");
    const callers = (two["edges"] as Array<{ caller: string; depth: number }>).filter(
      (e) => e.caller === "top",
    );
    expect(callers.length).toBe(1);
    expect(callers[0]!.depth).toBe(2);
    expect(two["depth"]).toBe(2);
  });

  test("--depth all исчерпывает граф и называет прирост по шагам", async () => {
    await indexed();
    const d = await data("callers", "leaf", "--kind", "call", "--depth", "all");
    expect(d["depth"]).toBe("all");
    expect(d["nodes"]).toBeGreaterThanOrEqual(2);
    expect(d["stopped"]).toBeNull();
    const levels = d["levels"] as number[];
    expect(levels[levels.length - 1]).toBe(0);
  });

  test("--max-nodes обрывает обход и говорит об этом, а не молчит", async () => {
    await indexed();
    const env = await envelope("callers", "leaf", "--kind", "call", "--depth", "all", "--max-nodes", "1");
    expect(env.ok).toBe(true);
    expect(env.data["stopped"]).toEqual({ reason: "nodes", limit: 1 });
    expect(env.warn.map((w) => w.code)).toContain("callers.truncated");
  });

  test("--limit печатает часть и называет остаток", async () => {
    await indexed();
    const d = await data("callers", "leaf", "--kind", "call", "--limit", "1");
    expect(d["shown"]).toBe(1);
    expect(d["total_edges"]).toBeGreaterThan(1);
    const r = await myc("callers", "leaf", "--kind", "call", "--limit", "1");
    expect(r.stdout as string).toContain("shown 1 of");
  });
});

describe("честность выдачи: пустое и неоднозначное названы", () => {
  test("одноимённые методы названы, а не выбраны наугад", async () => {
    await indexed();
    const env = await envelope("callers", "close");
    expect(env.ok).toBe(true);
    expect(env.data["ambiguous"]).toBe(true);
    expect((env.data["defs"] as unknown[]).length).toBe(2);
    expect(env.warn.map((w) => w.code)).toContain("callers.ambiguous");
    expect(env.warn.find((w) => w.code === "callers.ambiguous")!.msg).toContain("NOT split");
  });

  test("внешнее имя: вхождения есть, определения нет, и это сказано", async () => {
    await indexed();
    const env = await envelope("callers", "String");
    expect(env.ok).toBe(true);
    expect((env.data["defs"] as unknown[]).length).toBe(0);
    expect(env.warn.map((w) => w.code)).toContain("callers.external");
  });

  test("индекса нет — отказ с командой, а не «никто не зовёт»", async () => {
    const r = await myc("callers", "leaf");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr ?? "").toContain("is not built");
  });

  test("ссылок нет при живом индексе — отдельная причина, а не пустой список", async () => {
    await indexed();
    const raw = new Database(join(dir, ".myc", "myc.db"));
    raw.run("DELETE FROM code_ref_sites");
    raw.close();
    const r = await myc("callers", "leaf");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr ?? "").toContain("code_ref_sites table is empty");
  });

  test("имени нет нигде — notfound с числами просмотренного", async () => {
    await indexed();
    const r = await myc("callers", "совсем-нет-такого-имени");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.stderr ?? "").toContain("scanned");
  });

  test("аргумента нет и флаги проверяются", async () => {
    expect((await myc("callers")).code).toBe(ExitCode.USAGE);
    expect((await myc("callers", "leaf", "--direction", "вбок")).code).toBe(ExitCode.USAGE);
    expect((await myc("callers", "leaf", "--depth", "-1")).code).toBe(ExitCode.USAGE);
    expect((await myc("callers", "leaf", "--kind", "выдумка")).code).toBe(ExitCode.USAGE);
  });
});

// ---------------------------------------------------------------------------
// myc skeleton
// ---------------------------------------------------------------------------

describe("myc skeleton — API файла вместо файла", () => {
  test("объявления с видом, спаном и сигнатурой", async () => {
    await indexed();
    const d = await data("skeleton", "src/chain.ts");
    const entries = d["entries"] as Array<{ name: string; signature: string; span_start: number }>;
    expect(entries.map((e) => e.name)).toEqual(["leaf", "mid", "top"]);
    expect(entries[0]!.signature).toBe("export function leaf(n: number): number");
    expect(entries[0]!.span_start).toBe(1);
  });

  test("скелет дешевле файла, и во сколько раз — числом", async () => {
    await indexed();
    const d = await data("skeleton", "src/fat.ts");
    expect(d["skeleton_bytes"]).toBeGreaterThan(0);
    expect(d["file_bytes"]).toBeGreaterThan(d["skeleton_bytes"] as number);
    expect(d["cheaper"]).toBeGreaterThan(10);
    const r = await myc("skeleton", "src/fat.ts");
    expect(r.stdout as string).toContain("× cheaper");
  });

  test("вложенность: метод класса сдвинут относительно класса", async () => {
    await indexed();
    const d = await data("skeleton", "src/twins.ts");
    const entries = d["entries"] as Array<{ name: string; nesting: number }>;
    expect(entries.find((e) => e.name === "Left")!.nesting).toBe(0);
    expect(entries.filter((e) => e.name === "close").every((e) => e.nesting === 1)).toBe(true);
  });

  test("--exported оставляет то, что видно снаружи", async () => {
    await indexed();
    const all = await data("skeleton", "src/twins.ts");
    const pub = await data("skeleton", "src/twins.ts", "--exported");
    expect((pub["entries"] as unknown[]).length).toBeLessThan((all["entries"] as unknown[]).length);
    expect((pub["entries"] as Array<{ name: string }>).map((e) => e.name)).toEqual(["Left", "Right"]);
    expect(pub["hidden"]).toBeGreaterThan(0);
  });

  test("файл изменился после индексации — WARN, а не молча съехавшие строки", async () => {
    await indexed();
    writeFileSync(join(dir, "src", "chain.ts"), `// правка мимо индекса\n${CHAIN}`);
    const env = await envelope("skeleton", "src/chain.ts");
    expect(env.ok).toBe(true);
    expect(env.data["stale"]).toBe(true);
    expect(env.warn.map((w) => w.code)).toContain("skeleton.stale");
  });

  test("файла нет в индексе — notfound с числом просмотренного", async () => {
    await indexed();
    const r = await myc("skeleton", "src/нет.ts");
    expect(r.code).toBe(ExitCode.NOTFOUND);
    expect(r.stderr ?? "").toContain("scanned");
  });

  test("индекса нет — отказ с командой", async () => {
    const r = await myc("skeleton", "src/chain.ts");
    expect(r.code).toBe(ExitCode.PRECOND);
    expect(r.stderr ?? "").toContain("myc code index");
  });

  test("аргумента нет — usage", async () => {
    expect((await myc("skeleton")).code).toBe(ExitCode.USAGE);
  });
});
