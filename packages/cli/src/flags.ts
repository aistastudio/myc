import { ExitCode } from "./exit.ts";

export type FlagValue = string | number | boolean;

export type FlagSpec = {
  /** длинное имя без дефисов, например "db" */
  name: string;
  /** короткий псевдоним без дефиса, например "C" */
  short?: string;
  /** флаг со значением; без поля — булев флаг */
  value?: "string" | "number";
  /** одна строка для --help */
  description: string;
};

/** Глобальные флаги: работают у каждой команды, допустимы до имени команды. */
export const GLOBAL_FLAGS: readonly FlagSpec[] = [
  {
    name: "json",
    description: "single envelope object {ok,cmd,data,meta,warn} to stdout",
  },
  {
    name: "ndjson",
    description: "one envelope object per line, streamed (for large lists)",
  },
  {
    name: "strict",
    // Код берётся из ExitCode, а не пишется цифрой: текст говорил «7» (это
    // NOWS), а процесс выходил с 6 — справка разошлась с контрактом §2.2.
    description: `a degraded result exits with code ${ExitCode.DEGRADED} instead of 0; the WARN line still prints`,
  },
  {
    name: "db",
    value: "string",
    description: "database location (default .myc/myc.db)",
  },
  {
    name: "directory",
    short: "C",
    value: "string",
    description: "run as if started in <path>",
  },
  {
    name: "quiet",
    short: "q",
    description: "human mode: suppress data output; WARN lines still print",
  },
  {
    name: "no-color",
    description: "disable ANSI color even on a TTY",
  },
  { name: "help", description: "show help and exit" },
  { name: "version", description: "print version and exit" },
];

export function findFlag(
  specs: readonly FlagSpec[],
  name: string,
): FlagSpec | undefined {
  return specs.find((f) => f.name === name);
}

export function findFlagByShort(
  specs: readonly FlagSpec[],
  short: string,
): FlagSpec | undefined {
  return specs.find((f) => f.short === short);
}
