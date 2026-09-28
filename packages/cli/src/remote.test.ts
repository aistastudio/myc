/**
 * Разбор адреса сервера и решение «локально или удалённо» — без сети и без
 * базы. Это та часть клиента, которая ошибается ТИХО: неверно понятый адрес
 * уводит команду к чужому воркспейсу, а незамеченный `--server` — к локальной
 * базе вместо общей.
 */

import { describe, expect, test } from "bun:test";
import { ExitCode } from "./exit.ts";
import { parseServer, remoteTarget } from "./remote.ts";
import type { CommandContext } from "./registry.ts";

function ctx(flags: Record<string, string | boolean | number> = {}): CommandContext {
  return {
    args: [],
    flags,
    globals: { json: true, ndjson: false, strict: false, quiet: false, color: false },
    warn: () => {},
    diagnostics: { add: () => {} } as unknown as CommandContext["diagnostics"],
  };
}

describe("адрес сервера", () => {
  test("воркспейс берётся из пути адреса", () => {
    expect(parseServer("https://myc.example/cherry")).toEqual({
      url: "https://myc.example",
      ws: "cherry",
    });
    // Хвостовой слеш и порт не меняют разбора.
    expect(parseServer("http://127.0.0.1:8080/portal/")).toEqual({
      url: "http://127.0.0.1:8080",
      ws: "portal",
    });
  });

  test("не http(s) — не адрес сервера", () => {
    // Особенно важно про file: и postgres: — их легко подставить по привычке
    // из соседних флагов, и молча сходить «никуда» нельзя.
    for (const bad of ["не адрес", "file:///tmp/x", "postgres://localhost/myc", ""]) {
      expect(parseServer(bad)).toBeUndefined();
    }
  });
});

describe("выбор режима", () => {
  const env = (o: Record<string, string>): Record<string, string> => o;

  test("без сервера — локальный режим, и это не ошибка", () => {
    expect(remoteTarget(ctx(), env({})).kind).toBe("none");
    expect(remoteTarget(ctx(), env({ MYC_SERVER: "  " })).kind).toBe("none");
  });

  test("флаг сильнее переменной окружения", () => {
    const r = remoteTarget(
      ctx({ server: "https://flag.example/one" }),
      env({ MYC_SERVER: "https://env.example/two", MYC_TOKEN: "myc_abc" }),
    );
    expect(r.kind).toBe("remote");
    if (r.kind !== "remote") return;
    expect([r.target.url, r.target.ws]).toEqual(["https://flag.example", "one"]);
  });

  test("воркспейс: --ws сильнее адреса, а без обоих — отказ", () => {
    const withFlag = remoteTarget(
      ctx({ server: "https://myc.example/one", ws: "two" }),
      env({ MYC_TOKEN: "myc_abc" }),
    );
    expect(withFlag.kind === "remote" && withFlag.target.ws).toBe("two");

    const none = remoteTarget(ctx({ server: "https://myc.example" }), env({ MYC_TOKEN: "myc_abc" }));
    expect(none.kind).toBe("bad");
    if (none.kind !== "bad") return;
    expect(none.failure.code).toBe("usage.ws");
    expect(none.failure.exit).toBe(ExitCode.USAGE);
  });

  test("сервер без токена — precond, а не тихий локальный режим", () => {
    const r = remoteTarget(ctx({ server: "https://myc.example/cherry" }), env({}));
    expect(r.kind).toBe("bad");
    if (r.kind !== "bad") return;
    expect(r.failure.code).toBe("precond.no_token");
    // Подсказка называет ту команду, которой токен выдают.
    expect(r.failure.hint).toContain("--add-token");
  });

  test("испорченный при копировании токен виден до сети", () => {
    // Значение с пробелом или не-ASCII в заголовок не кладётся вовсе: без
    // этой проверки человек читал бы «сервер не ответил» и чинил бы сеть.
    for (const bad of ["myc_с кириллицей", "myc_abc def", "myc_abc\n"]) {
      const r = remoteTarget(ctx({ server: "https://myc.example/cherry" }), env({ MYC_TOKEN: bad }));
      expect([bad, r.kind]).toEqual([bad, "bad"]);
      if (r.kind !== "bad") continue;
      expect(r.failure.code).toBe("usage.token");
    }
  });

  test("токен из окружения, а не из аргументов", () => {
    // Аргументы видны в `ps`, в истории оболочки и в журналах хуков. Флага
    // --token у CLI нет вовсе, и этот тест держит его отсутствие.
    const r = remoteTarget(
      ctx({ server: "https://myc.example/cherry", token: "myc_from_argument" }),
      env({ MYC_TOKEN: "myc_from_env" }),
    );
    expect(r.kind === "remote" && r.target.token).toBe("myc_from_env");
  });
});
