/**
 * СПРАВКА И ПОВЕДЕНИЕ ПОВТОРЁННОГО ФЛАГА ОБЯЗАНЫ СОВПАДАТЬ
 * (memory-jwpptwdqvgkq).
 *
 * Разбор argv брал последнее значение молча: `--in a --in b` искал только в
 * b, и первое место терялось без единого слова (И2). Починка — накопление у
 * флагов-списков и отказ у однозначных, но у неё есть слабое место: список
 * помечается в спецификации руками, а обещание запятой живёт в описании.
 * Разойдутся — и флаг снова начнёт молча терять значения.
 *
 * Поэтому сторож ходит по НАСТОЯЩЕМУ реестру и сверяет одно с другим: если
 * описание обещает запятую, флаг обязан быть списком.
 */

import { describe, expect, test } from "bun:test";
import { GLOBAL_FLAGS, type FlagSpec } from "./flags.ts";
import { Registry } from "./registry.ts";
import { registerAll } from "./register.ts";
import { parseArgv } from "./parse.ts";

/** Все флаги всех команд реестра плюс глобальные. */
async function allFlags(): Promise<Array<{ command: string; spec: FlagSpec }>> {
  const r = new Registry();
  registerAll(r);
  await r.materializeAll();
  const out: Array<{ command: string; spec: FlagSpec }> = GLOBAL_FLAGS.map((spec) => ({
    command: "(global)",
    spec,
  }));
  for (const c of r.top) {
    for (const spec of c.flags ?? []) out.push({ command: c.name, spec });
    for (const sub of c.subcommands ?? []) {
      for (const spec of sub.flags ?? []) out.push({ command: `${c.name} ${sub.name}`, spec });
    }
  }
  return out;
}

describe("флаги-списки", () => {
  test("описание обещает запятую ⇒ флаг накапливается", async () => {
    const bad = (await allFlags())
      // Ищем ОБЕЩАНИЕ, а не подстроку: «commands» тоже содержит «comma».
      .filter(({ spec }) => /comma[- ]separated|comma ok/i.test(spec.description) && spec.list !== true)
      .map(({ command, spec }) => `${command} --${spec.name}`);
    // Расхождение чинится одной строкой `list: true`, а не правкой этого
    // теста: описание — обещание пользователю, и оно старше.
    expect(bad).toEqual([]);
  });

  test("флаг-список: повтор накапливается через запятую", async () => {
    const r = new Registry();
    r.register({
      name: "проба",
      summary: "стенд",
      flags: [
        { name: "in", value: "string", list: true, description: "paths, comma-separated" },
        { name: "db2", value: "string", description: "одно значение" },
      ],
      handler: () => ({ ok: true as const, data: {} }),
    });
    const ok = parseArgv(["проба", "--in", "a", "--in", "b"], r);
    expect(ok.ok).toBe(true);
    expect(ok.ok && ok.argv.flags["in"]).toBe("a,b");
  });

  test("однозначный флаг: повтор — отказ, а не тихое последнее значение", async () => {
    const r = new Registry();
    r.register({
      name: "проба",
      summary: "стенд",
      flags: [{ name: "db2", value: "string", description: "одно значение" }],
      handler: () => ({ ok: true as const, data: {} }),
    });
    const bad = parseArgv(["проба", "--db2", "a", "--db2", "b"], r);
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.failure.msg).toContain("more than once");
  });
});
