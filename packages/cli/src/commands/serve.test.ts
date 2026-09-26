/**
 * `myc serve`: то, что обязано работать без Postgres (и без сети), проверяется
 * здесь; всё, что про токены и арендаторов, — в packages/server/src/*.pg.test.ts
 * на живой базе.
 *
 * Главное утверждение файла — ОТКАЗЫ ВНЯТНЫЕ. Команда администрирует сервер, к
 * ней приходят в момент, когда что-то не поднялось, и «internal.unexpected» в
 * такой момент стоит человеку получаса.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ExitCode } from "../exit.ts";
import { run } from "../index.ts";
import { Registry } from "../registry.ts";
import { createServeCommand } from "./serve.ts";

function registry(write: (s: string) => void = () => {}, wait = async (): Promise<string> => "SIGINT"): Registry {
  const r = new Registry();
  r.register(createServeCommand({ write, wait }));
  return r;
}

// Команда НАМЕРЕННО берёт строку подключения из окружения, когда нет --pg: так
// живёт контейнер (deploy/compose.yml задаёт MYC_PG_URL). Поэтому файл, который
// говорит «без Postgres», обязан это условие СОЗДАТЬ: у разработчика с поднятой
// базой переменная в окружении есть, и тест без этого проверяет не то, что
// обещает. Поймано живьём — прогон с MYC_PG_URL уронил два теста.
const ENV_KEYS = ["MYC_PG_URL", "MYC_SERVE_PORT"] as const;
const saved = new Map<string, string | undefined>();

describe("myc serve без Postgres", () => {
  beforeAll(() => {
    for (const k of ENV_KEYS) {
      saved.set(k, process.env[k]);
      delete process.env[k];
    }
  });
  afterAll(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("токены и схема требуют --pg и говорят об этом кодом precond", async () => {
    for (const args of [
      ["serve", "--add-token", "acme:anna"],
      ["serve", "--add-tenant", "acme"],
      ["serve", "--tokens"],
      ["serve", "--revoke-token", "tok_1"],
      ["serve", "--apply-schema"],
    ]) {
      const out = await run(["--json", ...args], { registry: registry() });
      expect(out.code).toBe(ExitCode.PRECOND);
      const env = JSON.parse(out.stdout as string) as { error: { code: string; msg: string } };
      expect(env.error.code).toBe("precond.no_pg");
      expect(env.error.msg).toContain("--pg");
    }
  });

  test("форма --add-token проверяется до похода в базу", async () => {
    // Порядок важен: сначала форма, потом сеть. Иначе человек с опечаткой
    // ждёт таймаут подключения, чтобы узнать про двоеточие.
    const out = await run(["--json", "serve", "--pg", "postgres://user@127.0.0.1:1/x", "--add-token", "acme"], {
      registry: registry(),
    });
    expect(out.code).toBe(ExitCode.USAGE);
    const env = JSON.parse(out.stdout as string) as { error: { code: string; msg: string } };
    expect(env.error.code).toBe("usage.invalid");
    expect(env.error.msg).toContain("<tenant>:<name>");
  });

  test("проба живости без сервера — деградация с адресом, а не пустой отказ", async () => {
    const out = await run(["--json", "serve", "--port", "1", "--health-probe"], { registry: registry() });
    expect(out.code).toBe(ExitCode.DEGRADED);
    const env = JSON.parse(out.stdout as string) as { error: { code: string; msg: string } };
    expect(env.error.code).toBe("degraded.not_alive");
    expect(env.error.msg).toContain("127.0.0.1:1/v1/health");
  });

  test("без --pg сервер поднимается локальным срезом и честно это печатает", async () => {
    const said: string[] = [];
    const out = await run(["serve", "--port", "0"], {
      registry: registry((s) => said.push(s)),
    });
    expect(out.code).toBe(ExitCode.OK);
    const text = said.join("");
    expect(text).toContain("sqlite (local health slice)");
    // Без Postgres токенов нет — и обещать защиту, которой нет, нельзя.
    expect(text).toContain("no tokens");
    expect(text).not.toContain("admin:");
  });

  test("строка подключения из окружения — так живёт контейнер", async () => {
    // Без этого теста путь Docker держится на честном слове: --pg в
    // compose.yml не передаётся, есть только MYC_PG_URL.
    process.env["MYC_PG_URL"] = "postgres://myc_app:x@127.0.0.1:1/myc";
    try {
      const said: string[] = [];
      const out = await run(["serve", "--port", "0"], { registry: registry((s) => said.push(s)) });
      expect(out.code).toBe(ExitCode.OK);
      expect(said.join("")).toContain("postgres (team server)");
    } finally {
      delete process.env["MYC_PG_URL"];
    }
  });

  test("живой сервер отвечает на пробу, и она видит его же порт", async () => {
    let url = "";
    const registryWith = registry(
      (s) => {
        const m = /http:\/\/\S+/.exec(s);
        if (m !== null && url === "") url = m[0];
      },
      // Ждём, пока проба сходит к серверу, и только потом «сигнал».
      async () => {
        const port = Number(new URL(url).port);
        const probe = await run(["--json", "serve", "--port", String(port), "--health-probe"], {
          registry: registry(),
        });
        const env = JSON.parse(probe.stdout as string) as { data: { alive: boolean } };
        expect(probe.code).toBe(ExitCode.OK);
        expect(env.data.alive).toBe(true);
        return "SIGTERM";
      },
    );
    const out = await run(["serve", "--port", "0"], { registry: registryWith });
    expect(out.code).toBe(ExitCode.OK);
  });
});
