/**
 * И1 — «сети в горячем пути нет» — доказывается ЗДЕСЬ, и доказывается тем,
 * что сеть перекрыта НАСТОЯЩЕМУ процессу myc, а не обещанием в комментарии.
 *
 * ПОЧЕМУ ПРОЦЕССОМ. Утверждение живёт между процессами: команду запускает
 * хук, агент, оболочка. Однопоточная подмена `globalThis.fetch` внутри теста
 * проверяет модуль, а не бой, — а именно в бою и появится однажды строка
 * `await fetch(...)` в prime.ts. Поэтому каждая команда запускается через
 * `bun --preload net-trap.preload.ts`: ловушка встаёт ДО загрузки CLI, пишет
 * любой сетевой вызов в лог и бросает.
 *
 * ЧТО ИМЕННО УТВЕРЖДАЕТСЯ, тремя независимыми способами:
 *  1. Ловушка РАБОТАЕТ: `myc version --check` под ней пишет строку в лог и
 *     честно говорит «не смогли проверить». Без этой проверки пустой лог у
 *     остальных команд не значил бы ничего.
 *  2. Горячий путь под перекрытой сетью НЕ ХОДИТ В СЕТЬ (лог пуст) и даёт
 *     ТЕ ЖЕ ЧИСЛА, что без ловушки — сравнение конвертов после снятия
 *     заведомо изменчивых полей (время, сессия, кеш).
 *  3. Замыкание импортов команд горячего пути внутри packages/cli НЕ содержит
 *     модуля проверки обновлений и не тянет сетевые модули node.
 *
 * МУТАЦИЯ, КОТОРУЮ ЭТОТ ФАЙЛ ОБЯЗАН ЛОВИТЬ: любой сетевой вызов, вернувшийся
 * в prime/ready/recall/show/list/search, — красит и (2), и (3).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { cliTestEnv } from "@myc/core";

const CLI_SRC = import.meta.dir;
const REPO = resolve(CLI_SRC, "..", "..", "..");
const MAIN = join(CLI_SRC, "main.ts");
const TRAP = join(CLI_SRC, "net-trap.preload.ts");

/** Команды, которые агент зовёт в работе. Сеть здесь запрещена инвариантом И1. */
const HOT_PATH = ["prime", "ready", "recall", "show", "list", "search"] as const;

let dir: string;
let home: string;
let taskId = "";

interface Run {
  readonly code: number;
  readonly stdout: string;
  readonly netCalls: readonly string[];
}

function runMyc(
  args: string[],
  opts: { trap: boolean; env?: Record<string, string> },
): Run {
  const log = join(home, `trap-${Math.random().toString(36).slice(2)}.log`);
  const argv = opts.trap
    ? [process.execPath, "--preload", TRAP, MAIN, ...args]
    : [process.execPath, MAIN, ...args];
  const proc = Bun.spawnSync(argv, {
    cwd: dir,
    env: cliTestEnv({
      MYC_HOME: home,
      MYC_ACTOR: "tester",
      MYC_NET_TRAP_LOG: log,
      ...(opts.env ?? {}),
    }),
  });
  const netCalls = existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter((l) => l.trim().length > 0)
    : [];
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), netCalls };
}

/**
 * «Те же числа» упирается в вопрос, что считать шумом. Список изменчивых полей,
 * выписанный руками, — это допущение: он молча прощает поле, которое на самом
 * деле изменилось от правки, и краснеет на поле, которое просто тикает.
 *
 * Поэтому шум ЗАМЕРЯЕТСЯ, а не назначается: два КОНТРОЛЬНЫХ прогона подряд
 * дают ровно те пути, которые меняются сами по себе (время, `took_ms`,
 * `chars` от строки со временем внутри). Прогон с перекрытой сетью обязан
 * совпасть с контрольным ВЕЗДЕ, КРОМЕ этих путей. Если контроль совпал сам с
 * собой полностью — сравнение точное, поблажек нет вовсе.
 */
function flatten(value: unknown, prefix = "", out = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) {
    out.set(`${prefix}.length`, value.length);
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix === "" ? k : `${prefix}.${k}`, out);
    }
    return out;
  }
  out.set(prefix, value);
  return out;
}

/**
 * Единственное НАЗНАЧЕННОЕ исключение — стенное время (`*_ms`, `now`). Двух
 * контрольных прогонов не хватает, чтобы замерить его шум: `took_ms` совпадает
 * у соседних запусков случайно и расходится тоже случайно. Латентность здесь
 * не предмет — у неё свои бюджетные тесты (prime.cache-latency.test.ts,
 * ready.repo-latency.test.ts); предмет здесь — ОТВЕТЫ.
 */
const WALL_CLOCK = /(?:^|\.)(?:now|[a-z_]*_ms)$/;

function differingPaths(a: unknown, b: unknown): Set<string> {
  const fa = flatten(a);
  const fb = flatten(b);
  const paths = new Set<string>();
  for (const key of new Set([...fa.keys(), ...fb.keys()])) {
    if (WALL_CLOCK.test(key)) continue;
    if (!Object.is(fa.get(key), fb.get(key))) paths.add(key);
  }
  return paths;
}

function envelope(run: Run): unknown {
  return JSON.parse(run.stdout);
}

function argsFor(cmd: string): string[] {
  switch (cmd) {
    case "recall":
      return ["recall", "сеть", "--json"];
    case "search":
      return ["search", "сеть", "--json"];
    case "show":
      return ["show", taskId, "--json"];
    default:
      return [cmd, "--json"];
  }
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "myc-hot-home-"));
  dir = mkdtempSync(join(tmpdir(), "myc-hot-ws-"));
  expect(runMyc(["init"], { trap: false }).code).toBe(0);
  expect(runMyc(["task", "первая задача про сеть", "-p", "P1"], { trap: false }).code).toBe(0);
  expect(runMyc(["task", "вторая задача", "-p", "P2"], { trap: false }).code).toBe(0);
  expect(runMyc(["remember", "решение: сеть в горячем пути запрещена"], { trap: false }).code).toBe(0);
  const ready = JSON.parse(runMyc(["ready", "--json"], { trap: false }).stdout) as {
    data: { items: { id: string }[] };
  };
  taskId = ready.data.items[0]!.id;
  expect(taskId.length).toBeGreaterThan(0);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("измеритель: ловушка сети действительно ловит", () => {
  test("`myc version --check` под ловушкой пишет вызов и честно деградирует", () => {
    // MYC_UPDATE_CHECK здесь ВКЛЮЧАЕТСЯ явно: cliTestEnv гасит его наравне с
    // остальным фоном, и без этой строки «сети не было» означало бы всего лишь
    // «проверка выключена» — измеритель мерил бы себя.
    const r = runMyc(["version", "--check"], { trap: true, env: { MYC_UPDATE_CHECK: "1" } });
    // Если этот тест зелёный, пустой лог у горячего пути что-то значит.
    expect(r.netCalls).toHaveLength(1);
    expect(r.netCalls[0]).toContain("registry.npmjs.org");
    expect(r.stdout).toContain("updates NOT checked");
    expect(r.stdout).not.toContain("nothing to update to");
  });

  test("`myc version` без --check под ловушкой не трогает сеть", () => {
    const r = runMyc(["version"], { trap: true, env: { MYC_UPDATE_CHECK: "1" } });
    expect(r.netCalls).toEqual([]);
    expect(r.code).toBe(0);
  });

  test("даже с MYC_UPDATE_CHECK=1 горячий путь остаётся без сети", () => {
    // Самый опасный режим: автопроверка включена, кеша нет — значит «пора».
    // Горячий путь всё равно обязан молчать: точки подключения у него нет.
    for (const cmd of HOT_PATH) {
      const r = runMyc(argsFor(cmd), { trap: true, env: { MYC_UPDATE_CHECK: "1" } });
      expect([cmd, r.netCalls]).toEqual([cmd, []]);
      expect([cmd, r.code]).toEqual([cmd, 0]);
    }
  });
});

describe("И1: горячий путь под перекрытой сетью", () => {
  for (const cmd of HOT_PATH) {
    test(`${cmd}: сети нет и числа те же`, () => {
      // Прогрев: первый вызов наполняет кеши, и разница «промах/попадание» не
      // приписывается ловушке. Дальше — ЧЕРЕДОВАНИЕ control → trap → control:
      // шум замеряется теми же двумя контрольными прогонами, между которыми
      // стоит измеряемый.
      runMyc(argsFor(cmd), { trap: false });
      const control = runMyc(argsFor(cmd), { trap: false });
      const trapped = runMyc(argsFor(cmd), { trap: true });
      const control2 = runMyc(argsFor(cmd), { trap: false });

      expect([cmd, trapped.netCalls]).toEqual([cmd, []]);
      expect([cmd, trapped.code]).toEqual([cmd, control.code]);
      expect([cmd, trapped.code]).toEqual([cmd, 0]);

      const noise = differingPaths(envelope(control), envelope(control2));
      const changed = [...differingPaths(envelope(control), envelope(trapped))]
        .filter((p) => !noise.has(p))
        .sort();
      // Ноль путей, разошедшихся сверх собственного шума команды.
      expect([cmd, changed]).toEqual([cmd, []]);
    });
  }

  test("пишущие команды агента тоже не ходят в сеть", () => {
    // Их вывод сравнивать нельзя (создаётся новый узел), но утверждение о
    // сети к ним относится ровно так же: их зовёт агент в работе.
    for (const args of [
      ["task", "третья задача", "-p", "P2"],
      ["remember", "ещё одно решение"],
      ["claim", taskId],
      ["close", taskId],
    ]) {
      const r = runMyc([...args, "--json"], { trap: true });
      expect([args[0], r.netCalls]).toEqual([args[0], []]);
      expect([args[0], r.code]).toEqual([args[0], 0]);
    }
  });
});

// ---------------------------------------------------------------------------
// Статическая половина: замыкание импортов
// ---------------------------------------------------------------------------

/** Разрешение спецификатора импорта внутри packages/cli/src. */
function resolveLocal(spec: string, from: string): string | null {
  if (!spec.startsWith(".")) return null;
  const p = resolve(dirname(from), spec);
  return existsSync(p) && p.startsWith(CLI_SRC) ? p : null;
}

/**
 * Все модули packages/cli, достижимые из команд горячего пути — статически ИЛИ
 * динамическим `import()`: тихо ввести сеть можно и вторым способом.
 *
 * ЕДИНСТВЕННОЕ ИСКЛЮЧЕНИЕ — `register.ts`. Это ТАБЛИЦА отложенной загрузки, и
 * её динамические импорты по устройству материализуются по одной команде за
 * вызов (`Registry.materialize` по имени из argv). Раскрывать их значило бы
 * объявить замыканием `prime` «все 38 команд разом» — ровно то, чего
 * отложенная регистрация и избегает (замер в register.ts: 2.85 мс из 24 мс
 * холодного старта). Узлом в замыкании register.ts остаётся, раскрытым — нет.
 */
const LAZY_TABLE = join(CLI_SRC, "register.ts");

function hotPathClosure(): string[] {
  const seen = new Set<string>();
  const queue = HOT_PATH.map((c) => join(CLI_SRC, "commands", `${c}.ts`));
  queue.push(join(CLI_SRC, "commands", "tasks.ts"), join(CLI_SRC, "commands", "remember.ts"));
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === LAZY_TABLE) continue;
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+["']([^"']+)["']/g)) {
      const r = resolveLocal(m[1]!, file);
      if (r !== null) queue.push(r);
    }
    for (const m of src.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
      const r = resolveLocal(m[1]!, file);
      if (r !== null) queue.push(r);
    }
  }
  return [...seen].map((f) => relative(REPO, f)).sort();
}

describe("замыкание импортов горячего пути", () => {
  test("модуля проверки обновлений там нет — ни статически, ни динамически", () => {
    const closure = hotPathClosure();
    expect(closure.length).toBeGreaterThan(5);
    expect(closure).not.toContain("packages/cli/src/update-check.ts");
    expect(closure).not.toContain("packages/cli/src/commands/version.ts");
  });

  test("сетевые модули node в замыкание не входят", () => {
    const offenders: string[] = [];
    for (const rel of hotPathClosure()) {
      const src = readFileSync(join(REPO, rel), "utf8");
      const hits = src.match(/["']node:(http|https|net|tls|dgram|http2)["']/g);
      if (hits !== null) offenders.push(`${rel}: ${hits.join(",")}`);
    }
    expect(offenders).toEqual([]);
  });

  test("и наоборот: update-check действительно достижим из `version`", () => {
    // Сторож самого сторожа: если бы замыкание считалось неверно (например,
    // всегда пустым), два теста выше были бы зелёными ни о чём.
    const src = readFileSync(join(CLI_SRC, "commands", "version.ts"), "utf8");
    expect(src).toContain('from "../update-check.ts"');
  });
});
