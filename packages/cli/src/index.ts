import { SCHEMA_VERSION } from "@myc/core";
import { ExitCode } from "./exit.ts";
import { Diagnostics } from "./diagnostics.ts";
import { envelopeLine, errorEnvelope, okEnvelope } from "./envelope.ts";
import { GLOBAL_FLAGS, type FlagSpec } from "./flags.ts";
import { parseArgv, peekCommandName, type ParseResult } from "./parse.ts";
import {
  defaultRegistry,
  Registry,
  type CommandContext,
  type CommandFailure,
  type CommandResult,
  type Globals,
} from "./registry.ts";
import {
  isIterable,
  renderDataHuman,
  renderErrorHuman,
  renderWarnLines,
} from "./render.ts";

export const CLI_VERSION = "0.3.0";

export type RunResult = {
  code: ExitCode;
  /** строка или ленивый Iterable строк — стриминг --ndjson без буферизации */
  stdout: string | Iterable<string>;
  stderr?: string;
};

export type RunOptions = {
  registry?: Registry;
  /** stdout является TTY; только тогда разрешён цвет */
  tty?: boolean;
  env?: Record<string, string | undefined>;
};

function flagTrue(parsed: ParseResult, name: string): boolean {
  const flags = parsed.ok ? parsed.argv.flags : parsed.failure.flags;
  return flags[name] === true;
}

function flagString(parsed: ParseResult, name: string): string | undefined {
  const flags = parsed.ok ? parsed.argv.flags : parsed.failure.flags;
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function flagLabel(flag: FlagSpec): string {
  const short = flag.short !== undefined ? `-${flag.short}, ` : "    ";
  const value = flag.value !== undefined ? ` <${flag.value}>` : "";
  return `  ${short}--${flag.name}${value}`;
}

function renderFlagHelp(flags: readonly FlagSpec[]): string {
  const labels = flags.map(flagLabel);
  const width = Math.max(...labels.map((l) => l.length));
  return flags
    .map((f, i) => `${labels[i]!.padEnd(width)}  ${f.description}`)
    .join("\n");
}

/** Справка собирается из реестра, а не зашита текстом. */
export function globalHelp(registry: Registry): string {
  const lines: string[] = [
    "myc — local-first knowledge base for coding agents",
    "",
    "Usage: myc [globals] <command> [subcommand] [args] [flags]",
    "",
    "Commands:",
  ];
  const commands = registry.top;
  if (commands.length === 0) {
    lines.push("  (none registered yet)");
  } else {
    const rows: [string, string][] = [];
    for (const c of commands) {
      const subs = c.subcommands ?? [];
      if (subs.length > 0) {
        // Команда с подкомандами может иметь и собственный обработчик
        // (`myc bootstrap` печатает блок, `myc bootstrap set` его правит);
        // без этой строки основная форма не видна в реестре вовсе.
        if (c.handler) rows.push([`  ${c.name}`, c.summary]);
        for (const s of subs) rows.push([`  ${c.name} ${s.name}`, s.summary]);
      } else {
        rows.push([`  ${c.name}`, c.summary]);
      }
    }
    const width = Math.max(...rows.map(([left]) => left.length));
    for (const [left, right] of rows) lines.push(`${left.padEnd(width)}  ${right}`);
  }
  lines.push("", "Globals:", renderFlagHelp(GLOBAL_FLAGS), "");
  lines.push("Run `myc <command> --help` for command details.");
  return `${lines.join("\n")}\n`;
}

export function commandHelp(registry: Registry, path: readonly string[]): string {
  const command = registry.resolve(path);
  const cmd = path.join(" ");
  if (!command) return globalHelp(registry);
  const lines: string[] = [
    `myc ${cmd} — ${command.summary}`,
    "",
    `Usage: myc ${cmd} [args] [flags]`,
  ];
  if (command.help) lines.push("", command.help);
  const flags = registry.flagsFor(path);
  if (flags.length > 0) {
    lines.push("", "Flags:", renderFlagHelp(flags));
  }
  const subs = command.subcommands ?? [];
  if (subs.length > 0) {
    lines.push("", "Subcommands:");
    const rows = subs.map((s) => [`  ${s.name}`, s.summary] as const);
    const width = Math.max(...rows.map(([left]) => left.length));
    for (const [left, right] of rows) lines.push(`${left.padEnd(width)}  ${right}`);
  }
  lines.push("", "Global flags: see `myc --help`.");
  return `${lines.join("\n")}\n`;
}

function usageFailure(
  msg: string,
  globals: Globals,
  cmd: string,
  hint?: string,
): RunResult {
  const error = { code: "usage.invalid", msg, exit: ExitCode.USAGE, hint };
  const diags = new Diagnostics();
  if (globals.json || globals.ndjson) {
    return {
      code: ExitCode.USAGE,
      stdout: envelopeLine(errorEnvelope(cmd, error, diags)),
    };
  }
  return {
    code: ExitCode.USAGE,
    stdout: "",
    stderr: renderErrorHuman(error, diags, globals.color),
  };
}

function failureEnvelopeLine(
  cmd: string,
  failure: CommandFailure,
  diags: Diagnostics,
): string {
  return envelopeLine(
    errorEnvelope(
      cmd,
      {
        code: failure.code,
        msg: failure.msg,
        exit: failure.exit,
        hint: failure.hint,
      },
      diags,
    ),
  );
}

export async function run(
  argv: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const registry = options.registry ?? defaultRegistry;

  // Отложенная загрузка команд (register.ts): до разбора argv в реестре лежат
  // только ИМЕНА. Разбору нужны флаги и подкоманды ровно одной команды — той,
  // которую просят, — поэтому она подтягивается здесь, по имени, угаданному из
  // argv одними глобальными флагами. `myc --version` не грузит ничего.
  await registry.materialize(peekCommandName(argv));

  let parsed = parseArgv(argv, registry);
  // Любая ошибка разбора печатает подсказку по всему составу реестра
  // (`did you mean 'dep tree'?`), а состав известен целиком только после
  // загрузки. Ошибка — не горячий путь, поэтому здесь можно позволить себе
  // догрузить всё и разобрать заново: текст ошибки обязан совпадать с тем,
  // что был при жадной регистрации.
  if (!parsed.ok && registry.pending > 0) {
    await registry.materializeAll();
    parsed = parseArgv(argv, registry);
  }
  const commandPath = parsed.ok ? parsed.argv.commandPath : [];
  const cmd = commandPath.join(" ");

  const globals: Globals = {
    json: flagTrue(parsed, "json"),
    ndjson: flagTrue(parsed, "ndjson"),
    strict: flagTrue(parsed, "strict"),
    quiet: flagTrue(parsed, "quiet"),
    color:
      (options.tty ?? false) &&
      !flagTrue(parsed, "no-color") &&
      !options.env?.NO_COLOR,
    db: flagString(parsed, "db"),
    directory: flagString(parsed, "directory"),
  };

  if (globals.json && globals.ndjson) {
    return usageFailure(
      "flags --json and --ndjson are mutually exclusive",
      globals,
      cmd,
    );
  }
  if (!parsed.ok) {
    return usageFailure(parsed.failure.msg, globals, cmd, parsed.failure.hint);
  }

  const { flags, positionals } = parsed.argv;

  // Глобальные --version/--help разбираются parseArgv тем же путём, что и
  // остальные флаги (S-red313): findFlag смотрит флаги команды раньше
  // глобальных, поэтому команда с ОДНОИМЁННЫМ своим флагом (`model add
  // --version <n>`) выигрывает — сюда попадает лишь настоящий глобальный
  // булев `--version`, со значением он уже не дойдёт (см. flags.ts).
  if (flags.version === true) {
    return {
      code: ExitCode.OK,
      stdout: `myc ${CLI_VERSION} (schema ${SCHEMA_VERSION})\n`,
    };
  }

  if (flags.help === true) {
    // Общий help перечисляет summary КАЖДОЙ команды — единственное место,
    // которому нужен весь реестр целиком, и не горячий путь.
    if (commandPath.length === 0) await registry.materializeAll();
    return {
      code: ExitCode.OK,
      stdout:
        commandPath.length > 0
          ? commandHelp(registry, commandPath)
          : globalHelp(registry),
    };
  }

  if (commandPath.length === 0) {
    if (positionals.length > 0) {
      // через `--` можно протащить имя команды мимо парсера
      return usageFailure(`unknown command '${positionals[0]}'`, globals, cmd);
    }
    await registry.materializeAll();
    return { code: ExitCode.OK, stdout: globalHelp(registry) };
  }

  const command = registry.resolve(commandPath);
  if (!command) {
    return usageFailure(`unknown command '${cmd}'`, globals, cmd);
  }
  if (!command.handler) {
    const subs = (command.subcommands ?? []).map((s) => s.name);
    return usageFailure(
      `command '${cmd}' requires a subcommand`,
      globals,
      cmd,
      `subcommands: ${subs.join(", ")}`,
    );
  }

  const diagnostics = new Diagnostics();
  const ctx: CommandContext = {
    args: positionals,
    flags,
    globals,
    warn: (code, msg) => diagnostics.add(code, msg),
    diagnostics,
  };

  let result: CommandResult;
  try {
    result = await command.handler(ctx);
  } catch (e) {
    result = {
      ok: false,
      code: "internal.unexpected",
      msg: e instanceof Error ? e.message : String(e),
      exit: ExitCode.ERR,
    };
  }

  // Хвост очереди jobs (решение S8, §12.2 D28): после успешной команды
  // дешёвые классы разбираются инлайн по бюджету времени, дорогой embed —
  // отсоединённым воркером. Дренаж — фон: он не меняет результат, не пишет
  // в вывод и никогда не бросает. До точек возврата без обработчика
  // (--version, --help, usage-ошибки) выполнение сюда не доходит — их
  // латентность не тронута.
  if (result.ok) {
    // Импорт ДИНАМИЧЕСКИЙ, и это не стиль, а бюджет холодного старта (И1).
    // drain.ts тянет @myc/store-sqlite и половину commands/ (absorb,
    // retrieve, store); статический импорт заставлял КАЖДЫЙ запуск, включая
    // `myc --version`, инициализировать этот граф до разбора argv, хотя до
    // дренажа доходят только успешные команды. Замер: 99 модулей вместо 45 в
    // старте, +2.4 мс p50 на пустом входе.
    const { drainAfterCommand } = await import("./drain.ts");
    await drainAfterCommand(globals, options.env);
  }

  const code = !result.ok
    ? result.exit
    : globals.strict && diagnostics.size > 0
      ? ExitCode.DEGRADED
      : ExitCode.OK;

  if (globals.json) {
    return {
      code,
      stdout: result.ok
        ? envelopeLine(okEnvelope(cmd, result.data, result.meta, diagnostics))
        : failureEnvelopeLine(cmd, result, diagnostics),
    };
  }

  if (globals.ndjson) {
    if (result.ok && isIterable(result.data)) {
      const items = result.data;
      const meta = result.meta;
      function* lines(): Iterable<string> {
        for (const item of items) {
          yield envelopeLine(okEnvelope(cmd, item, meta, diagnostics));
        }
      }
      return { code, stdout: lines() };
    }
    return {
      code,
      stdout: result.ok
        ? envelopeLine(okEnvelope(cmd, result.data, result.meta, diagnostics))
        : failureEnvelopeLine(cmd, result, diagnostics),
    };
  }

  if (!result.ok) {
    return {
      code,
      stdout: "",
      stderr: renderErrorHuman(result, diagnostics, globals.color),
    };
  }

  const warnBlock = renderWarnLines(diagnostics, globals.color);
  const rendered = command.renderHuman
    ? command.renderHuman(result.data, ctx)
    : renderDataHuman(result.data, globals.color);

  // Машинный stdout: его читает не человек, а хук агента — и читает ЦЕЛИКОМ,
  // как один JSON-документ. Строка WARN, приклеенная следом, ломает разбор, и
  // громкая деградация оборачивается полной потерей пакета
  // (memory-mgkkdrbt27fb). Поэтому здесь блок WARN уходит в stderr, а до хоста
  // деградация доезжает внутри самого документа — см. hooks/hook-output.ts.
  // Решает это КАРКАС, а не команда: правило одно на все хуки, и новый хук не
  // может забыть его в одном месте из двух.
  const machineStdout = command.machineStdout?.(ctx) === true;
  const stdoutWarn = machineStdout ? "" : warnBlock;
  const warnStderr = machineStdout && warnBlock.length > 0 ? { stderr: warnBlock } : {};

  if (typeof rendered === "string") {
    return { code, stdout: (globals.quiet ? "" : rendered) + stdoutWarn, ...warnStderr };
  }

  const dataChunks = globals.quiet ? [] : rendered;
  function* chunks(): Iterable<string> {
    yield* dataChunks;
    yield stdoutWarn;
  }
  return { code, stdout: chunks(), ...warnStderr };
}

/**
 * Реестр и его наполнение наружу: `@myc/web` пишет через `run()` в ТОМ ЖЕ
 * процессе, а `defaultRegistry` заполняет только `main.ts`. Сервер, поднятый
 * не бинарём `myc` (тест, встраивание, скрипт), получал пустой реестр — и
 * КАЖДАЯ запись падала с «путь записи вернул не конверт (код 2)», сообщением,
 * которое не называет ни причины, ни лечения (И2).
 */
export { defaultRegistry } from "./registry.ts";
export { registerAll } from "./register.ts";
