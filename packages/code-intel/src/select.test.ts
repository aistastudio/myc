/**
 * Выбор реализации код-интеллекта. Тесты стерегут три вещи, которые
 * ломаются незаметно и дорого (docs/design/05-code-intelligence.md §6.2,
 * §6.3, §12.1):
 *
 *   1. умолчание `builtin`, а не `auto` — иначе возвращается «у меня
 *      работает иначе», ради ухода от чего пакет и заведён;
 *   2. кеш детекта — иначе каждый вызов платит `which` и spawn graft;
 *   3. при `code_intel=graft` без graft отката к builtin НЕТ (И2).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CODE_INTEL_DEGRADED,
  DEFAULT_CODE_INTEL_MODE,
  DETECT_TTL_MS,
  MIN_GRAFT_VERSION,
  probeGraftPresence,
  readCodeIntelConfig,
  selectCodeIntel,
  statePath,
  type SelectEnv,
} from "./index.ts";

let dir: string;

const NOW = 1_700_000_000_000;

interface Spy extends SelectEnv {
  whichCalls: number;
  versionCalls: number;
}

function makeEnv(o: { bin?: string | null; version?: string | null; path?: string; now?: number } = {}): Spy {
  const spy: Spy = {
    path: o.path ?? "/usr/bin:/bin",
    whichCalls: 0,
    versionCalls: 0,
    which(cmd) {
      spy.whichCalls++;
      return cmd === "graft" ? (o.bin ?? null) : null;
    },
    graftVersion() {
      spy.versionCalls++;
      return o.version ?? "0.9.2";
    },
    now: () => o.now ?? NOW,
  };
  return spy;
}

function withGraftIndex(): void {
  mkdirSync(join(dir, "graft"), { recursive: true });
  writeFileSync(join(dir, "graft", "INDEX.md"), "# graft");
}

function setMode(mode: string): void {
  writeFileSync(join(dir, ".myc", "config.json"), JSON.stringify({ code_intel: mode }));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-code-intel-"));
  mkdirSync(join(dir, ".myc"), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Умолчание (§12.1)
// ---------------------------------------------------------------------------

describe("умолчание — builtin везде", () => {
  test("константа умолчания — builtin, а не auto", () => {
    expect(DEFAULT_CODE_INTEL_MODE).toBe("builtin");
  });

  test("без конфига выбран builtin даже там, где graft установлен и проиндексирован", () => {
    withGraftIndex();
    const env = makeEnv({ bin: "/usr/local/bin/graft" });
    const s = selectCodeIntel(dir, env, readCodeIntelConfig(dir, {}));
    expect(s.mode).toBe("builtin");
    expect(s.id).toBe("builtin");
    expect(s.state).toBe("ok");
    expect(s.source).toBe("default");
  });

  test("builtin не спавнит graft и вообще не смотрит в PATH", () => {
    withGraftIndex();
    const env = makeEnv({ bin: "/usr/local/bin/graft" });
    selectCodeIntel(dir, env, readCodeIntelConfig(dir, {}));
    expect({ which: env.whichCalls, version: env.versionCalls }).toEqual({ which: 0, version: 0 });
    expect(existsSync(statePath(dir))).toBe(false);
  });

  test("поведение одинаково в контейнере и в CI: переменные окружения ничего не решают", () => {
    withGraftIndex();
    const env = makeEnv({ bin: "/usr/local/bin/graft" });
    const ci = selectCodeIntel(dir, env, readCodeIntelConfig(dir, { CI: "true" }));
    const local = selectCodeIntel(dir, env, readCodeIntelConfig(dir, {}));
    expect(ci.id).toBe(local.id);
    expect(ci.mode).toBe(local.mode);
  });
});

// ---------------------------------------------------------------------------
// Конфиг
// ---------------------------------------------------------------------------

describe("ключ code_intel", () => {
  test("читается из .myc/config.json", () => {
    setMode("auto");
    expect(readCodeIntelConfig(dir, {}).mode).toBe("auto");
    expect(readCodeIntelConfig(dir, {}).source).toBe("config.json");
  });

  test("читается из workspace.toml, если config.json нет", () => {
    writeFileSync(join(dir, ".myc", "workspace.toml"), 'slug = "myc"\ncode_intel = "graft"\n');
    expect(readCodeIntelConfig(dir, {})).toMatchObject({ mode: "graft", source: "workspace.toml" });
  });

  test("MYC_CODE_INTEL перекрывает файлы", () => {
    setMode("auto");
    expect(readCodeIntelConfig(dir, { MYC_CODE_INTEL: "off" })).toMatchObject({
      mode: "off",
      source: "env",
    });
  });

  test("мусор в конфиге не проглатывается молча", () => {
    setMode("грaft");
    const cfg = readCodeIntelConfig(dir, {});
    expect(cfg.mode).toBe("builtin");
    expect(cfg.invalid).toBe("грaft");
    const s = selectCodeIntel(dir, makeEnv(), cfg);
    expect(s.degraded).toContain(CODE_INTEL_DEGRADED.badConfig);
    expect(s.reason).toContain("грaft");
  });
});

// ---------------------------------------------------------------------------
// Кеш детекта в .myc/state.json (§6.2)
// ---------------------------------------------------------------------------

describe("кеш детекта в .myc/state.json", () => {
  test("первый вызов детектит и пишет кеш, второй берёт из него", () => {
    setMode("auto");
    const env = makeEnv({ bin: "/usr/local/bin/graft" });
    const first = selectCodeIntel(dir, env, readCodeIntelConfig(dir, {}));
    expect(first.cache).toBe("miss");
    expect(existsSync(statePath(dir))).toBe(true);

    const second = selectCodeIntel(dir, env, readCodeIntelConfig(dir, {}));
    expect(second.cache).toBe("hit");
    expect({ which: env.whichCalls, version: env.versionCalls }).toEqual({ which: 1, version: 1 });
    expect(second.id).toBe("graft");
  });

  test("кеш экономит spawn: второй вызов не спрашивает версию graft заново", () => {
    // Ради этого кеш и существует: `graft --version` — порождённый процесс,
    // 40-300 мс против бюджета И1 в 30 мс на весь prime. Проверяем цену,
    // а не только ярлык cache:"hit".
    setMode("auto");
    const env = makeEnv({ bin: "/usr/local/bin/graft" });
    for (let i = 0; i < 5; i++) selectCodeIntel(dir, env, readCodeIntelConfig(dir, {}));
    expect({ which: env.whichCalls, version: env.versionCalls }).toEqual({ which: 1, version: 1 });
  });

  test("кеш сбрасывается по смене PATH: graft мог появиться", () => {
    setMode("auto");
    const before = makeEnv({ bin: null, path: "/usr/bin" });
    expect(selectCodeIntel(dir, before, readCodeIntelConfig(dir, {})).id).toBe("builtin");

    const after = makeEnv({ bin: "/opt/graft/bin/graft", path: "/usr/bin:/opt/graft/bin" });
    const s = selectCodeIntel(dir, after, readCodeIntelConfig(dir, {}));
    expect(s.cache).toBe("miss");
    expect(s.id).toBe("graft");
  });

  test("кеш протухает через 24 часа", () => {
    setMode("auto");
    selectCodeIntel(dir, makeEnv({ bin: null }), readCodeIntelConfig(dir, {}));
    const later = makeEnv({ bin: "/usr/local/bin/graft", now: NOW + DETECT_TTL_MS + 1 });
    expect(selectCodeIntel(dir, later, readCodeIntelConfig(dir, {})).cache).toBe("miss");

    const within = makeEnv({ bin: "/usr/local/bin/graft", now: NOW + DETECT_TTL_MS - 1 });
    // тот же файл кеша, что записал предыдущий вызов (at = NOW + TTL + 1):
    // «внутри окна» считается от записи, а не от начала времён
    expect(selectCodeIntel(dir, within, readCodeIntelConfig(dir, {})).cache).toBe("miss");
  });

  test("state.json — общий файл: чужие ключи переживают запись кеша", () => {
    writeFileSync(join(dir, ".myc", "state.json"), JSON.stringify({ v: 1, other: { keep: 1 } }));
    setMode("auto");
    selectCodeIntel(dir, makeEnv({ bin: null }), readCodeIntelConfig(dir, {}));
    const state = JSON.parse(readFileSync(statePath(dir), "utf8")) as Record<string, unknown>;
    expect(state["other"]).toEqual({ keep: 1 });
    expect(state["code_intel"]).toBeDefined();
  });

  test("нет воркспейса — кеш не пишется, выбор всё равно есть", () => {
    const bare = mkdtempSync(join(tmpdir(), "myc-code-intel-bare-"));
    try {
      const s = selectCodeIntel(bare, makeEnv({ bin: null }), "auto");
      expect(s.cache).toBe("off");
      expect(s.id).toBe("builtin");
      expect(existsSync(statePath(bare))).toBe(false);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Громкая деградация (§6.3, И2)
// ---------------------------------------------------------------------------

describe("деградация громкая, а не молчаливый фолбэк", () => {
  test("code_intel=graft без graft: state=missing, id остаётся graft, откат к builtin ЗАПРЕЩЁН", () => {
    setMode("graft");
    const s = selectCodeIntel(dir, makeEnv({ bin: null }), readCodeIntelConfig(dir, {}));
    expect(s.id).toBe("graft");
    expect(s.id).not.toBe("builtin");
    expect(s.state).toBe("missing");
    expect(s.degraded).toContain(CODE_INTEL_DEGRADED.missing);
    expect(s.reason).toContain("not found");
  });

  test("code_intel=graft со старым graft: incompatible, тоже не builtin", () => {
    setMode("graft");
    const s = selectCodeIntel(
      dir,
      makeEnv({ bin: "/usr/local/bin/graft", version: "0.0.1" }),
      readCodeIntelConfig(dir, {}),
    );
    expect(s.state).toBe("incompatible");
    expect(s.id).toBe("graft");
    expect(s.reason).toContain(MIN_GRAFT_VERSION);
  });

  test("auto без graft: builtin, но с кодом code_intel_builtin в degraded", () => {
    setMode("auto");
    const s = selectCodeIntel(dir, makeEnv({ bin: null }), readCodeIntelConfig(dir, {}));
    expect(s.id).toBe("builtin");
    expect(s.degraded).toContain(CODE_INTEL_DEGRADED.builtin);
    expect(s.reason).toContain("callers");
  });

  test("off: код-интеллекта нет вовсе, и это видно", () => {
    setMode("off");
    const s = selectCodeIntel(dir, makeEnv({ bin: "/usr/local/bin/graft" }), readCodeIntelConfig(dir, {}));
    expect(s.id).toBeNull();
    expect(s.state).toBe("off");
    expect(s.degraded).toContain(CODE_INTEL_DEGRADED.off);
  });

  test("builtin по умолчанию деградацией не считается: реализация обязательна и она есть", () => {
    const s = selectCodeIntel(dir, makeEnv({ bin: null }), readCodeIntelConfig(dir, {}));
    expect(s.degraded).toEqual([]);
  });

  test("graft есть, индекса нет — stale, а не тихое «всё хорошо»", () => {
    setMode("graft");
    const s = selectCodeIntel(dir, makeEnv({ bin: "/usr/local/bin/graft" }), readCodeIntelConfig(dir, {}));
    expect(s.state).toBe("stale");
    expect(s.reason).toContain("graft build");
  });
});

// ---------------------------------------------------------------------------
// Единый детект — то, над чем обёртки probeGraft/detectGraft
// ---------------------------------------------------------------------------

describe("probeGraftPresence", () => {
  test("различает каталог graft/ и собранный INDEX.md", () => {
    mkdirSync(join(dir, "graft"), { recursive: true });
    const only = probeGraftPresence(dir, makeEnv({ bin: null }));
    expect({ index: only.index, indexDir: only.indexDir }).toEqual({ index: false, indexDir: true });

    writeFileSync(join(dir, "graft", "INDEX.md"), "# graft");
    const built = probeGraftPresence(dir, makeEnv({ bin: null }));
    expect({ index: built.index, indexDir: built.indexDir }).toEqual({ index: true, indexDir: true });
  });

  test("процессов не порождает: версию не спрашивает", () => {
    const env = makeEnv({ bin: "/usr/local/bin/graft" });
    probeGraftPresence(dir, env);
    expect(env.versionCalls).toBe(0);
  });
});
