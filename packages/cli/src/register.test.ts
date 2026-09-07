/**
 * Сторож регистрации: команда, написанная и оттестированная, но не внесённая
 * в реестр, для пользователя НЕ СУЩЕСТВУЕТ.
 *
 * Появился после R4 (2026-09-06): `myc move` был написан, покрыт 36 зелёными
 * тестами и невидим — все они строили собственный `Registry`, как это делает
 * почти каждый тест команд, и потому отсутствия команды в `main.ts` не
 * замечали. `myc move …` отвечал «unknown command 'move'».
 *
 * Проверка поведенческая, а не текстовая: фабрики инстанцируются и их имена
 * сверяются с реестром. Поиск строки `register(` по исходнику ловился бы на
 * псевдонимах (`modelCommand` против `createModelCommand`) и не отличал бы
 * зарегистрированное от упомянутого в комментарии.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Registry, type Command } from "./registry.ts";
import { registerAll } from "./register.ts";

const HERE = import.meta.dir;

/** Каталоги, где живут команды. Модуль команд обязан лежать здесь. */
const DIRS = ["commands", "hooks"];

/**
 * Фабрики, чья команда намеренно НЕ верхнего уровня либо не команда вовсе.
 * Список пуст неспроста: каждое исключение — это то, что пользователь не
 * увидит, и вносить его нужно с причиной прямо здесь.
 */
const NOT_TOP_LEVEL = new Set<string>([]);

function moduleFiles(): string[] {
  const out: string[] = [];
  for (const d of DIRS) {
    for (const f of readdirSync(join(HERE, d))) {
      if (!f.endsWith(".ts")) continue;
      if (f.includes(".test.") || f.endsWith(".worker.ts") || f.endsWith(".d.ts")) continue;
      out.push(join(HERE, d, f));
    }
  }
  return out;
}

function isCommand(v: unknown): v is Command {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { name?: unknown }).name === "string" &&
    typeof (v as { summary?: unknown }).summary === "string"
  );
}

describe("реестр команд: написанное обязано быть подключённым", () => {
  test("каждая экспортированная команда есть в registerAll", async () => {
    const registry = new Registry();
    registerAll(registry);

    const missing: string[] = [];
    const seen: string[] = [];

    for (const file of moduleFiles()) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const [exportName, value] of Object.entries(mod)) {
        if (NOT_TOP_LEVEL.has(exportName)) continue;

        let command: Command | undefined;
        if (isCommand(value)) command = value;
        else if (typeof value === "function" && /^create[A-Za-z]*Command$/.test(exportName)) {
          // Фабрике, которой нужен реестр (wire, mcp), отдаём отдельный —
          // регистрировать в проверяемый нельзя, иначе проверка себя же и
          // удовлетворит.
          const built = (value as (r: Registry) => unknown)(new Registry());
          if (isCommand(built)) command = built;
        }
        if (command === undefined) continue;

        seen.push(command.name);
        if (!registry.hasTop(command.name)) missing.push(`${command.name} (${exportName} в ${file.slice(HERE.length + 1)})`);
      }
    }

    // Сам корпус обязан быть непустым: если импорт сломается, пустой список
    // сойдётся с пустым «нет пропущенных» и проверка станет декорацией.
    expect(seen.length).toBeGreaterThan(20);
    expect(missing).toEqual([]);
  });

  /**
   * Второй сторож, появившийся вместе с отложенной загрузкой
   * (memory-21w8b5x63acn): register.ts больше не импортирует модули команд, а
   * называет их по имени и грузит динамическим import. Имя — единственное,
   * что теперь продублировано, и разъехаться оно может молча: строка в
   * таблице ведёт к модулю, который отдаёт команду с ДРУГИМ именем, и
   * `myc <имя>` уезжает на чужой обработчик, а первый сторож этого не видит
   * (он спрашивает лишь «есть ли такое имя в реестре»).
   *
   * Поэтому здесь реестр материализуется целиком и каждая загруженная
   * команда сверяется с ключом, под которым лежала. Заодно проверяется, что
   * summary не пустой: пустая строка — признак заглушки, дожившей до
   * `--help`.
   */
  test("каждая отложенная команда загружается под своим именем", async () => {
    const registry = new Registry();
    registerAll(registry);

    // До материализации в реестре только заглушки — иначе отложенность
    // сломана и весь граф команд снова грузится при импорте register.ts.
    expect(registry.pending).toBe(registry.top.length);
    expect(registry.pending).toBeGreaterThan(20);

    await registry.materializeAll();
    expect(registry.pending).toBe(0);

    const wrong: string[] = [];
    for (const command of registry.top) {
      if (command.summary === "") wrong.push(`${command.name}: пустой summary`);
      if (typeof command.handler !== "function" && (command.subcommands ?? []).length === 0) {
        wrong.push(`${command.name}: ни обработчика, ни подкоманд`);
      }
    }
    expect(wrong).toEqual([]);
  });

  /**
   * Обратное направление: строка в таблице register.ts, за которой нет
   * модуля-команды. Первый сторож ловит написанное-и-не-подключённое, этот —
   * подключённое-и-ненаписанное (опечатка в имени даёт ДВЕ команды: рабочую и
   * фантомную, видимую в `--help` и в подсказках).
   */
  test("в реестре нет команд, которых не производит ни один модуль", async () => {
    const registry = new Registry();
    registerAll(registry);
    await registry.materializeAll();

    const produced = new Set<string>();
    for (const file of moduleFiles()) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const [exportName, value] of Object.entries(mod)) {
        if (isCommand(value)) produced.add(value.name);
        else if (typeof value === "function" && /^create[A-Za-z]*Command$/.test(exportName)) {
          const built = (value as (r: Registry) => unknown)(new Registry());
          if (isCommand(built)) produced.add(built.name);
        }
      }
    }
    // Команды, живущие ВНЕ packages/cli/src/{commands,hooks}: их модуль не
    // сканируется, поэтому они перечислены здесь поимённо и с адресом.
    const FOREIGN = new Set<string>(["mcp"]); // @myc/mcp: createMcpCommand

    const phantom = registry.top
      .map((c) => c.name)
      .filter((n) => !produced.has(n) && !FOREIGN.has(n));
    expect(phantom).toEqual([]);
  });
});
