import { GLOBAL_FLAGS } from "./flags.ts";
import {
  findFlag,
  findFlagByShort,
  type FlagSpec,
  type FlagValue,
} from "./flags.ts";
import type { Registry } from "./registry.ts";

export type ParsedArgv = {
  commandPath: string[];
  flags: Record<string, FlagValue>;
  positionals: string[];
};

export type ParseFailure = {
  msg: string;
  hint?: string;
  /** флаги, успевшие разобраться до ошибки — чтобы отрисовать конверт */
  flags: Record<string, FlagValue>;
};

export type ParseResult =
  | { ok: true; argv: ParsedArgv }
  | { ok: false; failure: ParseFailure };

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, k) => k);
  let curr: number[] = new Array<number>(b.length + 1);
  for (let ai = 1; ai <= a.length; ai++) {
    curr[0] = ai;
    for (let bi = 1; bi <= b.length; bi++) {
      const cost = a.charCodeAt(ai - 1) === b.charCodeAt(bi - 1) ? 0 : 1;
      curr[bi] = Math.min(
        prev[bi]! + 1,
        curr[bi - 1]! + 1,
        prev[bi - 1]! + cost,
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

/** Ближайший кандидат по расстоянию Левенштейна, если он достаточно близок. */
export function suggest(
  input: string,
  candidates: readonly string[],
): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = levenshtein(input, c);
    if (d < bestDist || (d === bestDist && best !== undefined && c < best)) {
      best = c;
      bestDist = d;
    }
  }
  if (best === undefined) return undefined;
  return bestDist <= Math.max(1, Math.floor(input.length / 2)) ? best : undefined;
}

function flagHint(name: string, specs: readonly FlagSpec[]): string | undefined {
  const guess = suggest(
    name,
    specs.map((f) => f.name),
  );
  return guess !== undefined ? `did you mean --${guess}?` : undefined;
}

function storeValue(
  spec: FlagSpec,
  raw: string,
  flags: Record<string, FlagValue>,
): string | undefined {
  if (spec.value === "number") {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return `flag --${spec.name} expects a number, got '${raw}'`;
    }
    flags[spec.name] = n;
    return undefined;
  }
  flags[spec.name] = raw;
  return undefined;
}

/**
 * Имя команды из argv БЕЗ реестра — ровно затем, чтобы реестр мог загрузить
 * один нужный модуль вместо всех (см. register.ts).
 *
 * Повторяет ту же грамматику, что и `parseArgv`, но только в части, которая
 * от команд не зависит: до имени команды легальны ТОЛЬКО глобальные флаги,
 * а они известны статически. Поэтому «первый непрефиксный токен, если
 * пропустить глобальные флаги и их значения» — это в точности то, что
 * `parseArgv` положит в `commandPath[0]`.
 *
 * Ошибаться безопасно в одну сторону: если здесь угадано не то (неизвестный
 * флаг перед именем, `--` раньше команды), `parseArgv` всё равно вернёт
 * failure, а `run()` на любом failure догружает реестр целиком и разбирает
 * заново — сообщение и подсказка получаются те же, что при жадной загрузке.
 */
export function peekCommandName(argv: readonly string[]): string | undefined {
  let i = 0;
  while (i < argv.length) {
    const token = argv[i++]!;
    if (token === "--") return undefined;
    if (token.startsWith("--") && token.length > 2) {
      const body = token.slice(2);
      if (body.includes("=")) continue;
      const spec = findFlag(GLOBAL_FLAGS, body);
      if (spec?.value !== undefined) i++;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      const spec = findFlagByShort(GLOBAL_FLAGS, token.slice(1, 2));
      if (spec?.value !== undefined && token.length === 2) i++;
      continue;
    }
    return token;
  }
  return undefined;
}

/**
 * Разбор argv без внешних зависимостей.
 *
 * Грамматика: myc [глобальные] <команда> [подкоманда] [аргументы] [флаги]
 * До имени команды распознаются только глобальные флаги; после — глобальные
 * плюс флаги команды. `--` прекращает разбор флагов, дальше всё позиционное.
 * Неизвестный флаг или команда — код выхода 2 с подсказкой.
 */
export function parseArgv(argv: readonly string[], registry: Registry): ParseResult {
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  const commandPath: string[] = [];
  let endOfFlags = false;

  const fail = (msg: string, hint?: string): ParseResult => ({
    ok: false,
    failure: { msg, hint, flags },
  });

  // Флаг команды идёт ПЕРВЫМ: findFlag берёт первое совпадение по имени, и
  // при коллизии имён (например, свой --version у `model add`) обязана
  // выигрывать команда, а не глобальный флаг с тем же именем (S-red313) —
  // иначе у команды нет способа объявить легитимный флаг с таким именем.
  const knownFlags = (): FlagSpec[] =>
    commandPath.length > 0
      ? [...registry.flagsFor(commandPath), ...GLOBAL_FLAGS]
      : [...GLOBAL_FLAGS];

  let i = 0;
  while (i < argv.length) {
    const token = argv[i++]!;

    if (endOfFlags) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      endOfFlags = true;
      continue;
    }

    if (token.startsWith("--") && token.length > 2) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      const inlineValue = eq === -1 ? undefined : body.slice(eq + 1);
      const spec = findFlag(knownFlags(), name);
      if (!spec) {
        return fail(`unknown flag --${name}`, flagHint(name, knownFlags()));
      }
      if (spec.value) {
        let raw = inlineValue;
        if (raw === undefined) {
          if (i >= argv.length) {
            return fail(`flag --${spec.name} requires a value`);
          }
          raw = argv[i++]!;
        }
        const err = storeValue(spec, raw, flags);
        if (err) return fail(err);
      } else {
        if (inlineValue !== undefined) {
          return fail(`flag --${spec.name} does not take a value`);
        }
        flags[spec.name] = true;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      const ch = token.slice(1, 2)!;
      const rest = token.slice(2);
      const spec = findFlagByShort(knownFlags(), ch);
      if (!spec) {
        return fail(`unknown flag -${ch}`);
      }
      if (spec.value) {
        let raw = rest;
        if (raw === "") {
          if (i >= argv.length) {
            return fail(`flag -${spec.short} requires a value`);
          }
          raw = argv[i++]!;
        }
        const err = storeValue(spec, raw, flags);
        if (err) return fail(err);
      } else {
        if (rest !== "") {
          return fail(`unknown flag -${ch}${rest} (combined short flags are not supported)`);
        }
        flags[spec.name] = true;
      }
      continue;
    }

    // Позиционный токен: путь команды или аргумент.
    if (commandPath.length === 0) {
      if (registry.hasTop(token)) {
        commandPath.push(token);
        continue;
      }
      const guess = suggest(token, registry.paths());
      return fail(
        `unknown command '${token}'`,
        guess !== undefined ? `did you mean '${guess}'?` : undefined,
      );
    }
    const node = registry.resolve(commandPath);
    if (!node) {
      return fail(`unknown command '${commandPath.join(" ")}'`);
    }
    const sub = node.subcommands?.find((s) => s.name === token);
    if (sub) {
      commandPath.push(token);
      continue;
    }
    if (node.subcommands && node.subcommands.length > 0 && !node.handler) {
      const guess = suggest(
        token,
        node.subcommands.map((s) => s.name),
      );
      return fail(
        `unknown subcommand '${token}' for ${commandPath.join(" ")}`,
        guess !== undefined
          ? `did you mean '${guess}'?`
          : `subcommands: ${node.subcommands.map((s) => s.name).join(", ")}`,
      );
    }
    positionals.push(token);
  }

  return { ok: true, argv: { commandPath, flags, positionals } };
}
