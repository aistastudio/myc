import type { ExitCode } from "./exit.ts";
import type { Diagnostics } from "./diagnostics.ts";
import type { FlagSpec, FlagValue } from "./flags.ts";

/** Разрешённые глобальные опции после разбора argv. */
export type Globals = {
  json: boolean;
  ndjson: boolean;
  strict: boolean;
  quiet: boolean;
  /** цвет разрешён только при TTY, без --no-color и без NO_COLOR */
  color: boolean;
  db?: string;
  directory?: string;
};

/** Что получает обработчик команды. */
export type CommandContext = {
  /** позиционные аргументы после пути команды */
  args: readonly string[];
  /** все флаги: глобальные и команды, одним словарём */
  flags: Readonly<Record<string, FlagValue>>;
  globals: Readonly<Globals>;
  /** сообщить о деградации: WARN-строка в человеческом выводе,
   *  warn[] и meta.degraded[] в конверте; при --strict — код выхода 7 */
  warn(code: string, msg: string): void;
  diagnostics: Diagnostics;
};

export type CommandSuccess = {
  ok: true;
  /** JSON-значение или Iterable JSON-значений (стримится через --ndjson) */
  data: unknown;
  meta?: Record<string, unknown>;
};

export type CommandFailure = {
  ok: false;
  /** стабильное пространство кодов: usage.*, notfound.*, conflict.*, … */
  code: string;
  msg: string;
  /** один из десяти фиксированных кодов выхода */
  exit: ExitCode;
  hint?: string;
};

export type CommandResult = CommandSuccess | CommandFailure;

/** Кастомная отрисовка человеческого вывода; по умолчанию — плотная таблица. */
export type HumanRenderer = (
  data: unknown,
  ctx: CommandContext,
) => string | Iterable<string>;

export type Command = {
  name: string;
  /** одна строка для реестра в --help */
  summary: string;
  /** абзац для `<command> --help` */
  help?: string;
  flags?: readonly FlagSpec[];
  /** вложенность не глубине двух уровней: `dep` → `dep add` */
  subcommands?: readonly Command[];
  handler?: (ctx: CommandContext) => CommandResult | Promise<CommandResult>;
  renderHuman?: HumanRenderer;
};

/**
 * Загрузчик команды: возвращает готовый `Command`. Держится в реестре ВМЕСТО
 * команды до первого обращения — см. `registerLazy`.
 */
export type CommandLoader = () => Promise<Command>;

/**
 * Метка отложенной команды на её заглушке. Символ, а не поле: заглушка обязана
 * оставаться обычным `Command` для всего, что читает имя (help, подсказки,
 * `wire`, блок bootstrap), и при этом отличаться от настоящей команды для
 * реестра.
 */
const LAZY = Symbol.for("myc.cli.lazy");

type Stub = Command & { [LAZY]: CommandLoader };

function loaderOf(command: Command | undefined): CommandLoader | undefined {
  return (command as Stub | undefined)?.[LAZY];
}

/**
 * Реестр команд. Следующие задачи подключают команды через
 * `defaultRegistry.register(...)` (или собственный инстанс в тестах),
 * не трогая каркас.
 *
 * ОТЛОЖЕННАЯ РЕГИСТРАЦИЯ (`registerLazy`). Статический импорт всех команд
 * заставлял КАЖДЫЙ запуск, включая `myc --version`, прогонять инициализацию
 * всего графа модулей: замером — 2.85 мс p50 из 24 мс холодного старта, и
 * каждая новая команда добавляла бы ещё. Поэтому реестр хранит ИМЯ и
 * загрузчик, а модуль команды подтягивается динамическим import только когда
 * команда действительно вызвана (`materialize`) или когда нужен полный
 * список — `--help`, подсказка по опечатке (`materializeAll`).
 *
 * До материализации в реестре лежит ЗАГЛУШКА: настоящее имя, пустой summary,
 * без флагов и обработчика. Этого достаточно `hasTop`/`paths`/`top.map(name)`
 * и недостаточно для help — поэтому `run()` материализует всё, прежде чем
 * печатать общий help или подсказку. Сторож на рассинхрон таблицы и модуля —
 * в `materialize` (имя обязано совпасть) и в register.test.ts.
 */
export class Registry {
  #top = new Map<string, Command>();

  register(command: Command): void {
    this.#top.set(command.name, command);
  }

  /**
   * Зарегистрировать команду по имени, не загружая её модуль. `name` обязано
   * совпасть с именем команды, которую вернёт загрузчик — иначе `myc <name>`
   * молча уехал бы на чужой обработчик.
   */
  registerLazy(name: string, load: CommandLoader): void {
    const stub: Stub = { name, summary: "", [LAZY]: load };
    this.#top.set(name, stub);
  }

  /** Сколько команд ещё не загружено. */
  get pending(): number {
    let n = 0;
    for (const c of this.#top.values()) if (loaderOf(c)) n++;
    return n;
  }

  /** Загрузить одну команду, если она отложена. Неизвестное имя — no-op. */
  async materialize(name: string | undefined): Promise<void> {
    if (name === undefined) return;
    const load = loaderOf(this.#top.get(name));
    if (!load) return;
    const command = await load();
    if (command.name !== name) {
      throw new Error(
        `реестр: команда '${name}' загрузилась под именем '${command.name}' — таблица в register.ts разошлась с модулем`,
      );
    }
    this.#top.set(name, command);
  }

  /** Загрузить все отложенные команды: нужно help и подсказкам по опечатке. */
  async materializeAll(): Promise<void> {
    const names = [...this.#top.keys()];
    await Promise.all(names.map((n) => this.materialize(n)));
  }

  get top(): Command[] {
    return [...this.#top.values()];
  }

  hasTop(name: string): boolean {
    return this.#top.has(name);
  }

  /** Все пути до двух уровней — для --help и подсказок. */
  paths(): string[] {
    const out: string[] = [];
    for (const c of this.#top.values()) {
      out.push(c.name);
      for (const s of c.subcommands ?? []) out.push(`${c.name} ${s.name}`);
    }
    return out;
  }

  /** Максимально глубокая команда по пути; глубже двух уровней не бывает. */
  resolve(path: readonly string[]): Command | undefined {
    const first = path[0];
    if (first === undefined) return undefined;
    const top = this.#top.get(first);
    if (!top) return undefined;
    if (path.length === 1) return top;
    const second = path[1];
    if (second === undefined) return top;
    return top.subcommands?.find((s) => s.name === second) ?? undefined;
  }

  /** Флаги всего пути: унаследованные + собственного уровня. */
  flagsFor(path: readonly string[]): FlagSpec[] {
    const out: FlagSpec[] = [];
    const top = this.#top.get(path[0] ?? "");
    if (!top) return out;
    out.push(...(top.flags ?? []));
    const sub = top.subcommands?.find((s) => s.name === path[1]);
    if (sub) out.push(...(sub.flags ?? []));
    return out;
  }
}

export const defaultRegistry = new Registry();
