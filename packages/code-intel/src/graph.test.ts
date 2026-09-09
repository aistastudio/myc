/**
 * Приёмка ГРАФА и СКЕЛЕТА (memory-wrntvzwx8dh0) — того слоя чтения, ради
 * которого в проекте держали graft.
 *
 * Каждая проверка ниже названа мутацией, которую она обязана уронить:
 *
 *   МУТАЦИЯ «группировки нет» — в `walk` перестать сливать вхождения одной
 *   пары (владелец, файл) в одно ребро (ключ = строка вместо владельца):
 *   краснеет «одно ребро на владельца», потому что рёбер становится столько
 *   же, сколько вхождений, и `callers` превращается в `grep -n`.
 *
 *   МУТАЦИЯ «владельца нет» — приписать ссылку файлу, а не охватывающему
 *   символу: краснеет «зовущий — символ, а не файл».
 *
 *   МУТАЦИЯ «направление одно» — заставить `walk` всегда идти по `in`:
 *   краснеет «out — это не in наоборот».
 *
 *   МУТАЦИЯ «глубина не работает» — игнорировать `depth` (всегда 1 или всегда
 *   до упора): краснеют обе проверки транзитивности, причём в разные стороны.
 *
 *   МУТАЦИЯ «потолок молчит» — вернуть `stopped: null` при обрыве обхода:
 *   краснеет «обрыв назван».
 *
 *   МУТАЦИЯ «скелет — это файл» — вернуть в сигнатуре весь спан целиком:
 *   краснеет «скелет дешевле файла в разы», потому что отношение схлопывается.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, migrations } from "@myc/store-sqlite";
import { runCodeIndex } from "./code_index.ts";
import { callGraph, fileSkeleton, refsWithin, symbolDefs } from "./read.ts";

/**
 * Цепочка `leaf ← mid ← top`, где `mid` зовёт `leaf` ДВАЖДЫ из одного тела:
 * без двух вызовов «одно ребро на владельца» доказать нечем.
 */
const CHAIN = `export function leaf(n: number): number {
  return n + 1;
}

export function mid(n: number): number {
  const a = leaf(n);
  return leaf(a);
}

export function top(n: number): number {
  return mid(n);
}
`;

/** Верхний уровень файла: импорт и вызов вне всякого символа. */
const USER = `import { leaf } from "./chain.ts";

export const seed = leaf(1);

export class Box {
  hold(): number {
    return leaf(2);
  }
}
`;

/** Одноимённые методы: то, чего разбор не различает и обязан назвать. */
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

export function shut(l: Left, r: Right): number {
  const a = l.close();
  return a + r.close();
}
`;

let work: string;
let dir: string;
let db: Database;

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "code-graph-"));
  dir = join(work, "tree");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "chain.ts"), CHAIN);
  writeFileSync(join(dir, "src", "user.ts"), USER);
  writeFileSync(join(dir, "src", "twins.ts"), TWINS);
  db = new Database(join(work, "myc.db"), { create: true });
  await migrate(db, { migrations, writable: true });
  await runCodeIndex(db, { repoId: "r", root: dir });
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

describe("группировка: ребро графа, а не строка grep", () => {
  test("одно ребро на владельца, все его вхождения внутри", () => {
    const g = callGraph(db, "r", "leaf", { kinds: ["call"] });
    const mid = g.edges.find((e) => e.caller === "mid");
    expect(mid).toBeDefined();
    // Два вызова из одного тела — ОДНО ребро с двумя строками, а не два ребра.
    expect(mid!.sites.map((s) => s.line)).toEqual([6, 7]);
    expect(g.edges.filter((e) => e.caller === "mid").length).toBe(1);
    // Всего вхождений больше, чем рёбер: ровно это и есть группировка.
    expect(g.sites).toBeGreaterThan(g.edges.length);
  });

  test("зовущий — символ, а не файл: метод класса назван методом", () => {
    const g = callGraph(db, "r", "leaf", { kinds: ["call"] });
    const owners = g.edges.map((e) => e.caller).sort();
    expect(owners).toContain("hold");
    expect(owners).toContain("mid");
    // `export const seed = leaf(1)` стоит на верхнем уровне: владельца нет, и
    // подставлять сюда имя файла нельзя — обход на этом узле кончается.
    expect(owners).toContain("");
    expect(owners).not.toContain("user.ts");
  });

  test("вид вхождения сохранён: импорт — не вызов", () => {
    const all = callGraph(db, "r", "leaf");
    const kinds = new Set(all.edges.flatMap((e) => e.sites.map((s) => s.kind)));
    expect(kinds.has("import")).toBe(true);
    expect(kinds.has("call")).toBe(true);
    // Фильтр по виду обязан РЕАЛЬНО отсекать, а не украшать выдачу.
    const calls = callGraph(db, "r", "leaf", { kinds: ["call"] });
    expect(calls.sites).toBeLessThan(all.sites);
    expect(calls.edges.flatMap((e) => e.sites).every((s) => s.kind === "call")).toBe(true);
  });
});

describe("направление: out — не in наоборот", () => {
  test("in даёт зовущих, out — зовомых, и множества разные", () => {
    const inbound = callGraph(db, "r", "mid", { kinds: ["call"] });
    const outbound = callGraph(db, "r", "mid", { direction: "out", kinds: ["call"] });
    expect(inbound.edges.map((e) => e.caller)).toContain("top");
    expect(outbound.edges.map((e) => e.callee)).toEqual(["leaf"]);
    expect(outbound.edges.map((e) => e.callee)).not.toContain("top");
  });

  test("out идёт по спану и берёт замыкания, которых не видит refsFrom", () => {
    writeFileSync(
      join(dir, "src", "closure.ts"),
      `import { leaf } from "./chain.ts";

export function wrapper(): () => number {
  const inner = (): number => leaf(3);
  return inner;
}
`,
    );
    return runCodeIndex(db, { repoId: "r", root: dir, now: Date.now() + 1000 }).then(() => {
      const out = callGraph(db, "r", "wrapper", { direction: "out", kinds: ["call"] });
      const leafEdge = out.edges.find((e) => e.callee === "leaf");
      expect(leafEdge).toBeDefined();
      // Владелец строки — вложенный `inner`, и он назван, а не подменён на
      // `wrapper`: «внутри чего именно» читатель узнаёт из ответа.
      expect(leafEdge!.caller).toBe("inner");
    });
  });
});

describe("глубина: транзитивность считается, а не декларируется", () => {
  test("глубина 1 не выходит за прямых соседей", () => {
    const g = callGraph(db, "r", "leaf", { depth: 1, kinds: ["call"] });
    expect(g.edges.map((e) => e.caller)).not.toContain("top");
    expect(g.depthReached).toBe(1);
  });

  test("глубина 2 доходит до зовущего зовущего", () => {
    const g = callGraph(db, "r", "leaf", { depth: 2, kinds: ["call"] });
    expect(g.edges.map((e) => e.caller)).toContain("top");
    expect(g.edges.find((e) => e.caller === "top")!.depth).toBe(2);
    expect(g.levels[0]).toBeGreaterThan(0);
  });

  test("all исчерпывает граф и останавливается сам", () => {
    const g = callGraph(db, "r", "leaf", { depth: Number.POSITIVE_INFINITY, kinds: ["call"] });
    expect(g.nodes).toContain("top");
    expect(g.stopped).toBeNull();
    // Последний шаг не дал новых символов — иначе обход бы продолжался.
    expect(g.levels[g.levels.length - 1]).toBe(0);
  });

  test("потолок обхода назван, а не проглочен", () => {
    const g = callGraph(db, "r", "leaf", {
      depth: Number.POSITIVE_INFINITY,
      kinds: ["call"],
      maxNodes: 1,
    });
    expect(g.stopped).toEqual({ reason: "nodes", limit: 1 });
  });
});

describe("неоднозначность: данных нет, и это сказано", () => {
  test("одноимённые методы разных классов — два определения одного имени", () => {
    const defs = symbolDefs(db, "r", "close");
    expect(defs.length).toBe(2);
    expect(defs.map((d) => d.spanStart)).toEqual([2, 8]);
    // Ссылки по имени между ними НЕ разделены: оба вызова в `shut` приходят на
    // одно имя, и выбрать за читателя здесь нечем — поэтому и ребро одно.
    const g = callGraph(db, "r", "close");
    const shut = g.edges.filter((e) => e.caller === "shut");
    expect(shut.length).toBe(1);
    expect(shut[0]!.sites.map((s) => s.line)).toEqual([14, 15]);
  });

  test("два вхождения на одной строке — одно (дедуп разбора, refs.ts п. 6)", async () => {
    writeFileSync(
      join(dir, "src", "sameline.ts"),
      `import { leaf } from "./chain.ts";\n\nexport function twice(): number {\n  return leaf(1) + leaf(2);\n}\n`,
    );
    await runCodeIndex(db, { repoId: "r", root: dir, now: Date.now() + 1000 });
    const g = callGraph(db, "r", "leaf", { kinds: ["call"] });
    const twice = g.edges.find((e) => e.caller === "twice");
    // Не «нашли один вызов», а «строка одна»: граница разбора названа в
    // refs.ts и обязана быть видимой в приёмке, а не всплыть у читателя.
    expect(twice!.sites.map((s) => s.line)).toEqual([4]);
  });

  test("внешнее имя: ссылки есть, определения нет", () => {
    const g = callGraph(db, "r", "console");
    expect(symbolDefs(db, "r", "console")).toEqual([]);
    expect(g.edges.length).toBe(0);
  });
});

describe("refsWithin: спан символа, а не только его собственные строки", () => {
  test("возвращает вхождения из тела вместе с их владельцами", () => {
    const rows = refsWithin(db, "r", "mid", { kinds: ["call"] });
    expect(rows.map((r) => r.name)).toEqual(["leaf", "leaf"]);
    expect(rows.every((r) => r.from === "mid")).toBe(true);
  });
});

describe("скелет файла: API дешевле файла, и на сколько — числом", () => {
  test("объявления с видом, спаном и сигнатурой", () => {
    const sk = fileSkeleton(db, "r", "src/chain.ts", dir);
    expect(sk.entries.map((e) => e.name)).toEqual(["leaf", "mid", "top"]);
    expect(sk.entries[0]!.signature).toBe("export function leaf(n: number): number");
    expect(sk.entries[0]!.spanStart).toBe(1);
    expect(sk.entries[0]!.exported).toBe(true);
    expect(sk.onDisk).toBe(true);
    expect(sk.stale).toBe(false);
  });

  test("вложенность видна: метод класса не равен функции модуля", () => {
    const sk = fileSkeleton(db, "r", "src/twins.ts", dir);
    const byName = new Map(sk.entries.map((e) => [e.name, e]));
    expect(byName.get("Left")!.nesting).toBe(0);
    expect(byName.get("shut")!.nesting).toBe(0);
    expect(sk.entries.filter((e) => e.name === "close").every((e) => e.nesting === 1)).toBe(true);
  });

  test("скелет дешевле файла: сигнатура — не тело", async () => {
    // Файл с НАСТОЯЩИМИ телами: на трёх строках тела экономить нечего, и
    // проверять на них «дешевле» значило бы проверять форматирование.
    const body = Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i} * 2;`).join("\n");
    writeFileSync(
      join(dir, "src", "fat.ts"),
      `export function fat(n: number): number {\n${body}\n  return n;\n}\n` +
        `export function fat2(n: number): number {\n${body}\n  return n;\n}\n`,
    );
    await runCodeIndex(db, { repoId: "r", root: dir, now: Date.now() + 2000 });
    const sk = fileSkeleton(db, "r", "src/fat.ts", dir);
    expect(sk.entries.map((e) => e.name)).toEqual(["fat", "fat2"]);
    expect(sk.skeletonBytes).toBeGreaterThan(0);
    // Не «меньше», а «меньше в разы»: разница ради которой команда есть.
    expect(sk.fileBytes / sk.skeletonBytes).toBeGreaterThan(10);
  });

  test("файл разошёлся с индексом — это сказано, а не сглажено", () => {
    writeFileSync(join(dir, "src", "chain.ts"), `// правка мимо индекса\n${CHAIN}`);
    const sk = fileSkeleton(db, "r", "src/chain.ts", dir);
    expect(sk.stale).toBe(true);
  });

  test("файла нет на диске: спаны из индекса, сигнатур нет", () => {
    rmSync(join(dir, "src", "chain.ts"));
    const sk = fileSkeleton(db, "r", "src/chain.ts", dir);
    expect(sk.onDisk).toBe(false);
    expect(sk.entries.length).toBeGreaterThan(0);
    expect(sk.entries.every((e) => e.signature === "")).toBe(true);
  });
});
