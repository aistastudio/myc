import { describe, expect, test } from "bun:test";
import { ExitCode } from "./exit.ts";
import { CLI_VERSION, run } from "./index.ts";
import { Registry, type Command } from "./registry.ts";

function makeRegistry(...commands: Command[]): Registry {
  const registry = new Registry();
  for (const command of commands) registry.register(command);
  return registry;
}

const listCmd: Command = {
  name: "list",
  summary: "list nodes",
  handler: () => ({
    ok: true as const,
    data: [
      { id: "myc-a3f8", status: "in_progress", title: "CLI skeleton" },
      { id: "myc-b1c2", status: "open", title: "Wire store" },
    ],
    meta: { count: 2 },
  }),
};

const warnCmd: Command = {
  name: "scan",
  summary: "scan with degradation",
  handler: (ctx) => {
    ctx.warn("index.partial", "3 anchors stale");
    return { ok: true as const, data: [{ id: "a" }, { id: "b" }] };
  },
};

const claimCmd: Command = {
  name: "claim",
  summary: "claim a task",
  flags: [
    { name: "steal", description: "take over an active claim" },
  ],
  handler: () => ({ ok: true as const, data: "claimed" }),
};

const depCmd: Command = {
  name: "dep",
  summary: "dependencies",
  subcommands: [
    {
      name: "add",
      summary: "add dependency",
      handler: () => ({ ok: true as const, data: "added" }),
    },
    {
      name: "rm",
      summary: "remove dependency",
      handler: () => ({ ok: true as const, data: "removed" }),
    },
  ],
};

function failCmd(code: string, exit: ExitCode): Command {
  return {
    name: "fail",
    summary: "always fails",
    handler: () => ({ ok: false as const, code, msg: "boom", exit }),
  };
}

describe("cli run: help and version", () => {
  test("--version prints version and exits 0", async () => {
    const result = await run(["--version"]);
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain("myc");
  });

  test("--help is generated from the registry, not hardcoded", async () => {
    const result = await run(["--help"], {
      registry: makeRegistry(listCmd, depCmd, claimCmd),
    });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain("Usage: myc");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("dep add");
    expect(result.stdout).toContain("dep rm");
    expect(result.stdout).toContain("claim");
  });

  test("empty registry says so in help", async () => {
    const result = await run(["--help"], { registry: new Registry() });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain("(none registered yet)");
  });

  test("no args prints help and exits 0", async () => {
    const result = await run([], { registry: new Registry() });
    expect(result.code).toBe(ExitCode.OK);
  });

  test("command help shows usage and command flags", async () => {
    const result = await run(["claim", "--help"], {
      registry: makeRegistry(claimCmd),
    });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain("Usage: myc claim");
    expect(result.stdout).toContain("--steal");
  });
});

// Флаг команды с тем же именем, что глобальный, обязан выигрывать
// (myc-red313wff9dr): `myc model add opus --version 5 ...` раньше молча
// возвращал версию бинаря с кодом 0, не выполнив команду вовсе — И2.
const addCmd: Command = {
  name: "add",
  summary: "add with its own --version",
  flags: [{ name: "version", value: "string", description: "own version, not the global one" }],
  handler: (ctx) => ({ ok: true as const, data: { version: ctx.flags["version"] } }),
};

describe("cli run: собственный --version команды не съедается глобальным", () => {
  test("--version со значением после команды — это флаг команды, не глобальный", async () => {
    const result = await run(["add", "--version", "5"], {
      registry: makeRegistry(addCmd),
    });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).not.toContain(`myc ${CLI_VERSION}`);

    const jsonResult = await run(["add", "--version", "5", "--json"], {
      registry: makeRegistry(addCmd),
    });
    expect(typeof jsonResult.stdout).toBe("string");
    const envelope = JSON.parse(jsonResult.stdout as string) as { data: { version: string } };
    expect(envelope.data).toEqual({ version: "5" });
  });

  test("--version у команды без своего одноимённого флага остаётся глобальным", async () => {
    const result = await run(["claim", "--version"], {
      registry: makeRegistry(claimCmd),
    });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toContain(`myc ${CLI_VERSION}`);
  });
});

describe("cli run: usage errors and suggestions", () => {
  test("unknown flag exits 2", async () => {
    const result = await run(["--bogus-flag"]);
    expect(result.code).toBe(ExitCode.USAGE);
  });

  test("unknown flag suggests the nearest known flag", async () => {
    const result = await run(["--jsn"], { registry: makeRegistry(listCmd) });
    expect(result.code).toBe(ExitCode.USAGE);
    expect(result.stderr).toContain("did you mean --json?");
  });

  test("unknown command suggests the nearest command", async () => {
    const result = await run(["clame"], { registry: makeRegistry(claimCmd) });
    expect(result.code).toBe(ExitCode.USAGE);
    expect(result.stderr).toContain("did you mean 'claim'?");
  });

  test("group without handler requires a subcommand", async () => {
    const result = await run(["dep"], { registry: makeRegistry(depCmd) });
    expect(result.code).toBe(ExitCode.USAGE);
    expect(result.stderr).toContain("requires a subcommand");
    expect(result.stderr).toContain("add, rm");
  });

  test("unknown subcommand of a group suggests the real one", async () => {
    const result = await run(["dep", "adx"], { registry: makeRegistry(depCmd) });
    expect(result.code).toBe(ExitCode.USAGE);
    expect(result.stderr).toContain("did you mean 'add'?");
  });

  test("--json and --ndjson are mutually exclusive", async () => {
    const result = await run(["list", "--json", "--ndjson"], {
      registry: makeRegistry(listCmd),
    });
    expect(result.code).toBe(ExitCode.USAGE);
  });

  test("value flag without a value exits 2", async () => {
    const result = await run(["list", "--db"], { registry: makeRegistry(listCmd) });
    expect(result.code).toBe(ExitCode.USAGE);
  });
});

describe("cli run: human output", () => {
  test("dense columnar table snapshot", async () => {
    const result = await run(["list"], { registry: makeRegistry(listCmd) });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toBe(
      "ID        STATUS       TITLE\n" +
        "myc-a3f8  in_progress  CLI skeleton\n" +
        "myc-b1c2  open         Wire store\n",
    );
  });

  test("subcommand dispatch", async () => {
    const result = await run(["dep", "add"], { registry: makeRegistry(depCmd) });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toBe("added\n");
  });

  test("-- makes everything after it positional", async () => {
    const echo: Command = {
      name: "echo",
      summary: "echo args",
      handler: (ctx) => ({ ok: true as const, data: ctx.args.join(" ") }),
    };
    const result = await run(["echo", "--", "--json"], {
      registry: makeRegistry(echo),
    });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toBe("--json\n");
  });

  test("-C/--directory and --db reach the handler", async () => {
    const cfg: Command = {
      name: "cfg",
      summary: "print config",
      handler: (ctx) => ({
        ok: true as const,
        data: { db: ctx.globals.db ?? null, dir: ctx.globals.directory ?? null },
      }),
    };
    const registry = makeRegistry(cfg);
    const a = await run(["--db", "/tmp/x.db", "-C", "/tmp", "cfg"], { registry });
    expect(a.stdout).toBe("db   /tmp/x.db\ndir  /tmp\n");
    const b = await run(["-C/tmp", "--db=/tmp/x.db", "cfg"], { registry });
    expect(b.stdout).toBe("db   /tmp/x.db\ndir  /tmp\n");
  });
});

describe("cli run: ANSI is TTY-only", () => {
  const ANSI = "\x1b[";

  test("no ANSI when not a TTY (piped)", async () => {
    const registry = makeRegistry(listCmd, warnCmd, failCmd("x.y", ExitCode.ERR));
    for (const argv of [["list"], ["scan"], ["fail"]]) {
      const result = await run(argv, { registry });
      expect(result.stdout).not.toContain(ANSI);
      expect(result.stderr ?? "").not.toContain(ANSI);
    }
  });

  test("moderate color on a TTY", async () => {
    const result = await run(["list"], { registry: makeRegistry(listCmd), tty: true });
    expect(result.stdout).toContain("\x1b[1mID");
  });

  test("--no-color and NO_COLOR disable color on a TTY", async () => {
    const registry = makeRegistry(listCmd);
    const flag = await run(["list", "--no-color"], { registry, tty: true });
    expect(flag.stdout).not.toContain(ANSI);
    const env = await run(["list"], { registry, tty: true, env: { NO_COLOR: "1" } });
    expect(env.stdout).not.toContain(ANSI);
  });
});

describe("cli run: degradation — one source, two renderings", () => {
  test("human: WARN line, exit 0 without --strict", async () => {
    const result = await run(["scan"], { registry: makeRegistry(warnCmd) });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toBe(
      "ID\na\nb\nWARN index.partial: 3 anchors stale\n",
    );
  });

  test("human: --strict turns degradation into exit 7, WARN still printed", async () => {
    const result = await run(["scan", "--strict"], {
      registry: makeRegistry(warnCmd),
    });
    expect(result.code).toBe(ExitCode.DEGRADED);
    expect(result.stdout).toContain("WARN index.partial");
  });

  test("json: warn[] and meta.degraded[] from the same source", async () => {
    const result = await run(["scan", "--json"], {
      registry: makeRegistry(warnCmd),
    });
    const envelope = JSON.parse(result.stdout as string);
    expect(envelope.warn).toEqual([
      { code: "index.partial", msg: "3 anchors stale" },
    ]);
    expect(envelope.meta.degraded).toEqual(["index.partial"]);
  });

  test("--quiet suppresses data but never the WARN", async () => {
    const result = await run(["scan", "--quiet"], {
      registry: makeRegistry(warnCmd),
    });
    expect(result.code).toBe(ExitCode.OK);
    expect(result.stdout).toBe("WARN index.partial: 3 anchors stale\n");
  });
});

describe("cli run: --json envelope", () => {
  test("exactly one object with the full contract", async () => {
    const result = await run(["list", "--json"], {
      registry: makeRegistry(listCmd),
    });
    expect(result.code).toBe(ExitCode.OK);
    const lines = (result.stdout as string).split("\n").filter((l) => l !== "");
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      ok: true,
      cmd: "list",
      data: [
        { id: "myc-a3f8", status: "in_progress", title: "CLI skeleton" },
        { id: "myc-b1c2", status: "open", title: "Wire store" },
      ],
      meta: { count: 2, degraded: [] },
      warn: [],
    });
  });

  test("failure: error envelope with exit code, on stdout", async () => {
    const registry = makeRegistry(failCmd("notfound.node", ExitCode.NOTFOUND));
    const result = await run(["fail", "--json"], { registry });
    expect(result.code).toBe(ExitCode.NOTFOUND);
    expect(JSON.parse(result.stdout as string)).toEqual({
      ok: false,
      cmd: "fail",
      data: null,
      meta: { degraded: [] },
      warn: [],
      error: { code: "notfound.node", msg: "boom", exit: ExitCode.NOTFOUND },
    });
  });

  test("usage error after --json still renders an envelope", async () => {
    const result = await run(["--json", "--jsn"], { registry: new Registry() });
    expect(result.code).toBe(ExitCode.USAGE);
    const envelope = JSON.parse(result.stdout as string);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("usage.invalid");
  });
});

describe("cli run: --ndjson stream", () => {
  test("one envelope per line, lazy — no buffering before consumption", async () => {
    let produced = 0;
    const dump: Command = {
      name: "dump",
      summary: "stream items",
      handler: () => ({
        ok: true as const,
        data: (function* () {
          for (const n of [1, 2, 3]) {
            produced++;
            yield { n };
          }
        })(),
      }),
    };
    const result = await run(["dump", "--ndjson"], {
      registry: makeRegistry(dump),
    });
    expect(typeof result.stdout).toBe("object");
    expect(produced).toBe(0);
    const chunks = [...(result.stdout as Iterable<string>)];
    expect(produced).toBe(3);
    expect(chunks.length).toBe(3);
    const first = JSON.parse(chunks[0]!);
    const last = JSON.parse(chunks[2]!);
    expect(first.data).toEqual({ n: 1 });
    expect(last.data).toEqual({ n: 3 });
    expect(first.ok).toBe(true);
  });

  test("non-iterable data in --ndjson is a single line", async () => {
    const result = await run(["claim", "--ndjson"], {
      registry: makeRegistry(claimCmd),
    });
    expect(typeof result.stdout).toBe("string");
    expect((result.stdout as string).trimEnd()).not.toBe("");
    JSON.parse(result.stdout as string);
  });
});

describe("cli run: every exit code 0-9 is reachable", () => {
  test("0 OK", async () => {
    const result = await run(["list"], { registry: makeRegistry(listCmd) });
    expect(result.code).toBe(0);
  });

  test("1 ERR: thrown error becomes internal failure", async () => {
    const boom: Command = {
      name: "boom",
      summary: "throws",
      handler: () => {
        throw new Error("kaboom");
      },
    };
    const result = await run(["boom"], { registry: makeRegistry(boom) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("internal.unexpected");
    expect(result.stderr).toContain("kaboom");
  });

  test("2 USAGE: unknown flag", async () => {
    expect((await run(["--bogus-flag"])).code).toBe(2);
  });

  const commandFailures: [ExitCode, string][] = [
    [ExitCode.PRECOND, "precond.schema_newer"],
    [ExitCode.USAGE, "usage.ambiguous_id"],
    [ExitCode.CONFLICT, "conflict.claimed"],
    [ExitCode.NOTFOUND, "notfound.node"],
    [ExitCode.DENIED, "auth.denied"],
    [ExitCode.TIMEOUT, "internal.aborted"],
  ];
  for (const [code, errCode] of commandFailures) {
    test(`${code} ${errCode}`, async () => {
      const result = await run(["fail"], {
        registry: makeRegistry(failCmd(errCode, code)),
      });
      expect(result.code).toBe(code);
      expect(result.stderr).toContain(errCode);
    });
  }

  test("6 DEGRADED: strict + warn", async () => {
    const result = await run(["scan", "--strict"], {
      registry: makeRegistry(warnCmd),
    });
    expect(result.code).toBe(ExitCode.DEGRADED);
  });
});
