/**
 * СТОРОЖ ЕДИНОГО СПИСКА ХАРНЕССОВ (memory-7vywv63wma61).
 *
 * Зачем сторож, а не аккуратность. Списков было два — `HARNESSES` в ростере
 * и `ALL_AGENTS` в `myc wire` — и они разъехались молча, в обе стороны сразу:
 * wire ставил конфиг Codex, попытку под которым ростер записать отказывался
 * («неизвестный харнесс "codex"»), а Kimi числился в ростере, но wire его не
 * настраивал вовсе — агент под Kimi работал без скилла и без MCP. Ни один
 * тест этого не видел, потому что каждая половина по отдельности была
 * зелёной. Устроен сторож по образцу `register.test.ts` («написанное обязано
 * быть подключённым») и `site-identity.wiring.test.ts» (полнота подключения):
 * корпус СОБИРАЕТСЯ ИЗ ИСХОДНИКА, комментарии из него вырезаются, и пустым
 * он себе стать не даёт.
 *
 * Три половины, и все обязательны.
 *
 *   1. ТЕКСТ. Ни одна единица кода, кроме самого `swarm/src/harness.ts` и
 *      замороженных DDL миграций, не имеет права ПЕРЕЧИСЛЯТЬ имена
 *      харнессов. Перечислением считается единица верхнего уровня, где
 *      встречаются два и более РАЗНЫХ имени харнесса строковыми литералами.
 *      Вернёшь в wire.ts свой `["claude","codex","opencode"]` — красный.
 *
 *   2. WIRE. Текст лжив: список можно прочитать из одного места и всё равно
 *      обслуживать не всех. Поэтому каждый харнесс из HARNESSES обязан
 *      что-то ставить (`--agents <имя>` даёт непустой план), а имя вне
 *      списка обязано отвергаться до записи.
 *
 *   3. РОСТЕР. С другого конца: `myc model add --harness <имя>` обязан
 *      проходить для КАЖДОГО харнесса. Это ловит забытую миграцию — домен
 *      пропустит, а CHECK схемы отвергнет (см. swarm/src/harness.ts).
 *
 * Мутационная проверка (отчёт): удаление любого имени из HARNESSES, лишнее
 * имя в нём, возврат отдельного списка в wire.ts и снятие миграции 8 роняют
 * половины 1–3 по отдельности и с разными сообщениями.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { HARNESSES } from "@myc/swarm";
import { run, type RunResult } from "./index.ts";
import { Registry } from "./registry.ts";
import { createAbsorbSessionCommand } from "./hooks/absorb-session.ts";
import { createPrimeCommand } from "./commands/prime.ts";
import { createInitCommand } from "./commands/init.ts";
import { createModelCommand } from "./commands/roster.ts";
import { createUnwireCommand, createWireCommand } from "./commands/wire.ts";

// ---------------------------------------------------------------------------
// Половина 1: в исходниках список ровно один
// ---------------------------------------------------------------------------

const PACKAGES = resolve(import.meta.dir, "..", "..");

/**
 * Имя харнесса строковым литералом: `"claude"`, `'claude'`. Кавычки не
 * украшение — они отделяют перечисление от пути (`.kimi-code/...`) и от
 * ключа объекта (`claude: planClaude`), который и без того привязан к списку
 * типом `Record<Harness, …>` и разъехаться молча не может.
 */
function harnessTokens(text: string): Set<string> {
  const found = new Set<string>();
  for (const harness of HARNESSES) {
    if (new RegExp(`["']${harness}["']`).test(text)) found.add(harness);
  }
  return found;
}

/** Тот же приём, что в site-identity.wiring.test.ts: упоминание — не код. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const TOP_LEVEL =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

interface Unit {
  readonly file: string;
  readonly fn: string;
  readonly body: string;
  readonly line: number;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      sourceFiles(p, out);
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.includes(".test.")) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    out.push(p);
  }
  return out;
}

function unitsOf(path: string): Unit[] {
  const rel = relative(PACKAGES, path);
  const lines = readFileSync(path, "utf8").split("\n");
  const units: Unit[] = [];
  let name = "(module)";
  let start = 0;
  const flush = (end: number): void => {
    if (end <= start) return;
    units.push({ file: rel, fn: name, body: stripComments(lines.slice(start, end).join("\n")), line: start + 1 });
  };
  for (let i = 0; i < lines.length; i++) {
    const m = TOP_LEVEL.exec(lines[i]!);
    if (m === null) continue;
    flush(i);
    name = m[1]!;
    start = i;
  }
  flush(lines.length);
  return units;
}

/**
 * Кому перечислять МОЖНО и почему — каждый с причиной прямо здесь, как
 * список исключений в register.test.ts.
 *
 *   harness.ts — сам список, источник истины.
 *   migrations/001, 003 — CHECK схемы; текст применённой миграции заморожен
 *     чек-суммой (swarm/src/schema.ts) и правке не подлежит вообще.
 *   migrations/008 — перестройка тех же таблиц под расширенный CHECK.
 *     Тоже замороженный DDL: следующий харнесс потребует миграции 9, а не
 *     правки восьмой. Что список в схеме совпадает с HARNESSES, доказывает
 *     не текст, а поведение — swarm/src/roster.test.ts, «CHECK схемы
 *     принимает ровно HARNESSES».
 */
const MAY_ENUMERATE: ReadonlyMap<string, string> = new Map([
  ["swarm/src/harness.ts", "источник истины"],
  ["swarm/src/migrations/001-swarm-model.ts", "замороженный DDL"],
  ["swarm/src/migrations/003-swarm-attempt.ts", "замороженный DDL"],
  ["swarm/src/migrations/008-harness-codex.ts", "замороженный DDL"],
]);

function enumerations(): Unit[] {
  const found: Unit[] = [];
  for (const file of sourceFiles(PACKAGES)) {
    for (const unit of unitsOf(file)) {
      if (harnessTokens(unit.body).size >= 2) found.push(unit);
    }
  }
  return found;
}

describe("список харнессов в исходниках ровно один", () => {
  test("перечисляет имена только harness.ts и замороженные миграции", () => {
    const found = enumerations();

    // Корпус обязан быть непустым и обязан содержать известные места: если
    // разбор сломается, пустой список сойдётся с пустым «нет лишних» и
    // сторож станет декорацией.
    const files = new Set(found.map((u) => u.file));
    for (const known of MAY_ENUMERATE.keys()) expect([...files]).toContain(known);

    const strangers = found
      .filter((u) => !MAY_ENUMERATE.has(u.file))
      .map((u) => `${u.file}::${u.fn}:${u.line}`);
    expect(strangers).toEqual([]);
  });

  test("harness.ts перечисляет ИМЕННО HARNESSES, а не подмножество", () => {
    const text = readFileSync(join(PACKAGES, "swarm/src/harness.ts"), "utf8");
    expect(harnessTokens(stripComments(text))).toEqual(new Set(HARNESSES));
  });
});

// ---------------------------------------------------------------------------
// Половины 2 и 3: список не только один, но и обслуживается целиком
// ---------------------------------------------------------------------------

let dir: string;
let registry: Registry;

function myc(...args: string[]): Promise<RunResult> {
  return run(["-C", dir, ...args], { registry, env: { ...process.env, MYC_ACTOR: "tester" } });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-harness-"));
  mkdirSync(join(dir, ".myc"), { recursive: true });
  registry = new Registry();
  registry.register(createPrimeCommand());
  registry.register(createAbsorbSessionCommand());
  registry.register(createInitCommand());
  registry.register(createModelCommand());
  registry.register(createWireCommand(registry));
  registry.register(createUnwireCommand());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("wire обслуживает каждый харнесс", () => {
  for (const harness of HARNESSES) {
    test(`--agents ${harness} даёт непустой план`, async () => {
      const r = await myc("wire", "--agents", harness, "--dry-run", "--json");
      expect(r.code).toBe(0);
      const data = JSON.parse(r.stdout as string).data as {
        agents: string[];
        actions: { path: string }[];
      };
      expect(data.agents).toEqual([harness]);
      // Пустой план — это и есть «wire его не настраивает вовсе», ровно
      // тот баг, с которого началась задача.
      expect(data.actions.length).toBeGreaterThan(0);
    });
  }

  test("имя вне HARNESSES отвергается до записи", async () => {
    const r = await myc("wire", "--agents", "vim", "--dry-run");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(HARNESSES.join(", "));
  });

  test("без --agents обслуживаются ВСЕ харнессы", async () => {
    const r = await myc("wire", "--dry-run", "--json");
    expect(r.code).toBe(0);
    expect((JSON.parse(r.stdout as string).data as { agents: string[] }).agents).toEqual([...HARNESSES]);
  });
});

describe("ростер принимает каждый харнесс", () => {
  test("myc model add --harness <имя> проходит для всех", async () => {
    expect((await myc("init")).code).toBe(0);
    for (const harness of HARNESSES) {
      const r = await myc(
        "model",
        "add",
        `p/m-${harness}`,
        "--family",
        "test",
        "--harness",
        harness,
        "--price-in",
        "1",
        "--price-out",
        "2",
        "--json",
      );
      expect([harness, r.code]).toEqual([harness, 0]);
      expect((JSON.parse(r.stdout as string).data as { harness: string }).harness).toBe(harness);
    }
  }, 30_000);
});
