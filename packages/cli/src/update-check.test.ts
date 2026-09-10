/**
 * Проверка обновлений: исходы, отключаемость и — главное — что «реестр
 * недоступен» НИКОГДА не превращается в «обновлений нет» (И2).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cachedVerdict,
  checkForUpdate,
  maybeSpawnUpdateCheck,
  PACKAGE_NAME,
  probeRegistry,
  readUpdateCache,
  registryUrl,
  shouldAutoCheck,
  updateCachePath,
  updateCheckMode,
  updateNotice,
  UPDATE_CHECK_TTL_MS,
  type FetchLike,
} from "./update-check.ts";

let home: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "myc-upd-"));
  mkdirSync(join(home, ".myc"), { recursive: true });
  env = { MYC_HOME: home };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Реестр, отвечающий заданной версией. */
function registryAnswering(latest: unknown): FetchLike {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ "dist-tags": { latest } }),
  });
}

describe("режим: умолчание manual, обе стороны выключателя", () => {
  test("без переменной — manual: сама в сеть myc не ходит", () => {
    expect(updateCheckMode({})).toBe("manual");
  });

  test("0/off/false/no — off", () => {
    for (const v of ["0", "off", "false", "no", "OFF", " no "]) {
      expect(updateCheckMode({ MYC_UPDATE_CHECK: v })).toBe("off");
    }
  });

  test("1/on/true/yes/auto — auto", () => {
    for (const v of ["1", "on", "true", "yes", "auto", "AUTO"]) {
      expect(updateCheckMode({ MYC_UPDATE_CHECK: v })).toBe("auto");
    }
  });
});

describe("сравнение версий — числами, через compareSemver", () => {
  test("0.10.0 в реестре против 0.9.0 собранной — ЕСТЬ обновление", async () => {
    const v = await checkForUpdate({
      current: "0.9.0",
      env,
      fetchImpl: registryAnswering("0.10.0"),
    });
    expect(v.status).toBe("update_available");
    expect(v.latest).toBe("0.10.0");
    expect(v.upgrade).toContain(PACKAGE_NAME);
  });

  test("0.9.0 в реестре против 0.10.0 собранной — обновления НЕТ", async () => {
    const v = await checkForUpdate({
      current: "0.10.0",
      env,
      fetchImpl: registryAnswering("0.9.0"),
    });
    expect(v.status).toBe("ahead");
  });

  test("равные версии — up_to_date", async () => {
    const v = await checkForUpdate({ current: "0.1.1", env, fetchImpl: registryAnswering("0.1.1") });
    expect(v.status).toBe("up_to_date");
  });
});

describe("И2: «не смогли проверить» ≠ «обновлений нет»", () => {
  const failures: [string, FetchLike, string][] = [
    [
      "сеть отвалилась",
      async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
      "network unavailable",
    ],
    [
      "код ответа 503",
      async () => ({ ok: false, status: 503, json: async () => ({}) }),
      "the registry answered 503",
    ],
    [
      "тело не JSON",
      async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token <");
        },
      }),
      "did not parse as JSON",
    ],
    [
      "в ответе нет dist-tags.latest",
      async () => ({ ok: true, status: 200, json: async () => ({ name: PACKAGE_NAME }) }),
      "has no dist-tags.latest",
    ],
    [
      "версия из реестра не разбирается",
      registryAnswering("latest"),
      "could not be parsed",
    ],
  ];

  for (const [name, impl, reasonPart] of failures) {
    test(`${name} → unreachable с причиной, а не up_to_date`, async () => {
      const v = await checkForUpdate({ current: "0.1.1", env, fetchImpl: impl });
      expect(v.status).toBe("unreachable");
      expect(v.status).not.toBe("up_to_date");
      expect(v.reason ?? "").toContain(reasonPart);
      expect(v.latest).toBeUndefined();
      // Человеческая строка тоже обязана СКАЗАТЬ, а не промолчать.
      expect(updateNotice(v)).toContain("not checked");
    });
  }

  test("таймаут — тоже unreachable, и в причине названо ожидание", async () => {
    const slow: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    const v = await checkForUpdate({ current: "0.1.1", env, fetchImpl: slow, timeoutMs: 30 });
    expect(v.status).toBe("unreachable");
    expect(v.reason).toContain("did not answer within 30 ms");
  });

  test("провал записан в кеш как провал: следующий вызов не увидит «свежо»", async () => {
    await checkForUpdate({
      current: "0.1.1",
      env,
      fetchImpl: async () => {
        throw new Error("ENETDOWN");
      },
    });
    const entry = readUpdateCache(env);
    expect(entry?.latest).toBeNull();
    // Причина — кодом и с автором-сборкой, а не готовой фразой.
    expect(entry?.failure).toEqual({ code: "network", detail: "ENETDOWN" });
    expect(entry?.build).toBe("0.1.1");
    expect(cachedVerdict({ current: "0.1.1", env }).status).toBe("unreachable");
  });

  test("неразобранная версия в кеш НЕ попадает", async () => {
    await checkForUpdate({ current: "0.1.1", env, fetchImpl: registryAnswering("не версия") });
    expect(readUpdateCache(env)?.latest).toBeNull();
  });
});

describe("отключаемость: переменная и флаг, обе сильнее явного --check", () => {
  test("MYC_UPDATE_CHECK=0 — сеть не трогается даже при --check", async () => {
    let calls = 0;
    const v = await checkForUpdate({
      current: "0.1.1",
      env: { ...env, MYC_UPDATE_CHECK: "0" },
      fetchImpl: async () => {
        calls++;
        return { ok: true, status: 200, json: async () => ({ "dist-tags": { latest: "9.9.9" } }) };
      },
    });
    expect(calls).toBe(0);
    expect(v.status).toBe("disabled");
    expect(v.reason).toContain("MYC_UPDATE_CHECK");
    // Запрет — это НЕ «обновлений нет».
    expect(v.status).not.toBe("up_to_date");
  });

  test("--offline делает то же для одного вызова", async () => {
    let calls = 0;
    const v = await checkForUpdate({
      current: "0.1.1",
      env,
      offline: true,
      fetchImpl: async () => {
        calls++;
        return { ok: true, status: 200, json: async () => ({ "dist-tags": { latest: "9.9.9" } }) };
      },
    });
    expect(calls).toBe(0);
    expect(v.status).toBe("disabled");
    expect(v.reason).toContain("--offline");
  });

  test("реестр переопределяется MYC_REGISTRY (закрытый контур со своим зеркалом)", () => {
    expect(registryUrl({ MYC_REGISTRY: "https://npm.internal/" })).toBe(
      "https://npm.internal/@aistastudio%2fmyc",
    );
  });
});

describe("кеш: вердикт без сети", () => {
  test("кеша нет — never_checked, а не «обновлений нет»", () => {
    const v = cachedVerdict({ current: "0.1.1", env });
    expect(v.status).toBe("never_checked");
    expect(v.source).toBe("none");
  });

  test("кеш есть — вердикт из него, с возрастом", () => {
    const now = 1_000_000_000;
    writeFileSync(
      updateCachePath(env),
      JSON.stringify({ package: PACKAGE_NAME, latest: "0.2.0", checked_at: now - 5_000, error: null }),
    );
    const v = cachedVerdict({ current: "0.1.1", env, now });
    expect(v.status).toBe("update_available");
    expect(v.source).toBe("cache");
    expect(v.age_ms).toBe(5_000);
  });

  test("битый кеш — never_checked, а не молчаливое «свежо»", () => {
    writeFileSync(updateCachePath(env), "{не json");
    expect(cachedVerdict({ current: "0.1.1", env }).status).toBe("never_checked");
  });

  test("кеш от другого пакета игнорируется", () => {
    writeFileSync(
      updateCachePath(env),
      JSON.stringify({ package: "@someone/else", latest: "9.9.9", checked_at: Date.now(), error: null }),
    );
    expect(cachedVerdict({ current: "0.1.1", env }).status).toBe("never_checked");
  });

  /**
   * Кеш личный и переживает смену сборки. 0.3.1 писала в него ГОТОВУЮ фразу
   * по-русски, и сборка с английским выводом печатала её как есть — в
   * `myc version`, `init` и `wire`. Запись ниже — дословная форма 0.3.1.
   * Мутация «снова печатать кешированный текст» роняет этот тест.
   */
  test("кеш с русской причиной от другой сборки — в выводе ни одной кириллической буквы", () => {
    const now = 1_000_000_000;
    writeFileSync(
      updateCachePath(env),
      JSON.stringify({
        package: PACKAGE_NAME,
        latest: null,
        checked_at: now - 3 * 3_600_000,
        error: "сеть недоступна: Unable to connect. Is the computer able to access the url?",
      }),
    );
    const v = cachedVerdict({ current: "0.4.0", env, now });
    // Факт отказа не потерян: это по-прежнему «не смогли проверить», а не «свежо».
    expect(v.status).toBe("unreachable");
    expect(v.reason).toBe(
      "the last attempt failed; its reason was recorded by another myc build (re-check: `myc version --check`)",
    );
    const notice = updateNotice(v);
    expect(notice).toBe(
      "updates not checked: the last attempt failed; its reason was recorded by another myc build (re-check: `myc version --check`) (3 h ago)",
    );
    expect(`${v.reason}\n${notice}`).not.toMatch(/[Ѐ-ӿ]/);
  });

  test("свободный текст из записи печатает только записавшая её сборка", () => {
    const now = 1_000_000_000;
    // Новая форма, но сообщение рантайма у записавшей сборки — на её языке.
    const entry = (build: string) =>
      JSON.stringify({
        package: PACKAGE_NAME,
        latest: null,
        checked_at: now - 60_000,
        build,
        failure: { code: "network", detail: "не удалось соединиться" },
      });
    writeFileSync(updateCachePath(env), entry("0.3.9"));
    const foreign = cachedVerdict({ current: "0.4.0", env, now });
    expect(foreign.reason).toBe("network unavailable");
    expect(updateNotice(foreign)).toBe("updates not checked: network unavailable (1 min ago)");
    // Та же запись своей сборки — с хвостом: отсекает сборка, а не код.
    writeFileSync(updateCachePath(env), entry("0.4.0"));
    expect(cachedVerdict({ current: "0.4.0", env, now }).reason).toBe("network unavailable: не удалось соединиться");
  });

  test("код без свободного текста — фраза этой сборки при любом авторе", () => {
    const now = 1_000_000_000;
    writeFileSync(
      updateCachePath(env),
      JSON.stringify({ package: PACKAGE_NAME, latest: null, checked_at: now, build: "0.1.0", failure: { code: "http_status", status: 503 } }),
    );
    expect(cachedVerdict({ current: "0.4.0", env, now }).reason).toBe("the registry answered 503");
    // Код, которого эта сборка не знает, — «не знаем почему», а не выдумка.
    writeFileSync(
      updateCachePath(env),
      JSON.stringify({ package: PACKAGE_NAME, latest: null, checked_at: now, build: "0.4.0", failure: { code: "из будущего" } }),
    );
    expect(cachedVerdict({ current: "0.4.0", env, now }).reason).toBe("the last attempt failed, no reason recorded");
  });

  test("запись в кеш: сборка и код, готовой фразы нет", async () => {
    await checkForUpdate({
      current: "0.4.0",
      env,
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    });
    const disk = JSON.parse(readFileSync(updateCachePath(env), "utf8")) as Record<string, unknown>;
    expect(disk).toEqual({
      package: PACKAGE_NAME,
      latest: null,
      checked_at: disk["checked_at"],
      build: "0.4.0",
      failure: { code: "http_status", status: 503 },
    });
    await checkForUpdate({ current: "0.4.0", env, fetchImpl: registryAnswering("0.4.1") });
    const ok = JSON.parse(readFileSync(updateCachePath(env), "utf8")) as Record<string, unknown>;
    expect(ok).toEqual({ package: PACKAGE_NAME, latest: "0.4.1", checked_at: ok["checked_at"], build: "0.4.0", failure: null });
  });

  test("cachedVerdict сеть не трогает НИКОГДА — даже с живым fetch", () => {
    // Ловушка на глобальный fetch: cachedVerdict его не знает и знать не должен.
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (() => {
      calls++;
      throw new Error("сеть из cachedVerdict");
    }) as unknown as typeof fetch;
    try {
      cachedVerdict({ current: "0.1.1", env });
      cachedVerdict({ current: "0.1.1", env: { ...env, MYC_UPDATE_CHECK: "auto" } });
    } finally {
      globalThis.fetch = real;
    }
    expect(calls).toBe(0);
  });
});

describe("автопроверка: не чаще суток и только в режиме auto", () => {
  function cache(checkedAt: number): void {
    mkdirSync(join(home, ".myc"), { recursive: true });
    writeFileSync(
      updateCachePath(env),
      JSON.stringify({ package: PACKAGE_NAME, latest: "0.1.1", checked_at: checkedAt, error: null }),
    );
  }

  test("manual — не проверяем автоматически никогда", () => {
    expect(shouldAutoCheck(env, Date.now())).toBe(false);
  });

  test("auto без кеша — пора", () => {
    expect(shouldAutoCheck({ ...env, MYC_UPDATE_CHECK: "1" }, Date.now())).toBe(true);
  });

  test("auto со свежим кешем — не пора (TTL сутки)", () => {
    const now = 2_000_000_000;
    cache(now - (UPDATE_CHECK_TTL_MS - 1));
    expect(shouldAutoCheck({ ...env, MYC_UPDATE_CHECK: "1" }, now)).toBe(false);
    cache(now - UPDATE_CHECK_TTL_MS);
    expect(shouldAutoCheck({ ...env, MYC_UPDATE_CHECK: "1" }, now)).toBe(true);
  });

  test("спавн отсоединённый: команда не ждёт ни сети, ни процесса", () => {
    const spawned: string[][] = [];
    const started = maybeSpawnUpdateCheck({ ...env, MYC_UPDATE_CHECK: "1" }, (argv) => {
      spawned.push(argv);
    });
    expect(started).toBe(true);
    expect(spawned).toHaveLength(1);
    // Проверку исполняет ОТДЕЛЬНЫЙ процесс той же командой, что набирает
    // человек, — второго сетевого пути в коде нет.
    expect(spawned[0]).toContain("version");
    expect(spawned[0]).toContain("--check");
  });

  test("manual и off не спавнят ничего", () => {
    const spawned: string[][] = [];
    const push = (argv: string[]): void => {
      spawned.push(argv);
    };
    expect(maybeSpawnUpdateCheck(env, push)).toBe(false);
    expect(maybeSpawnUpdateCheck({ ...env, MYC_UPDATE_CHECK: "0" }, push)).toBe(false);
    expect(spawned).toEqual([]);
  });
});

describe("probeRegistry просит сокращённый документ", () => {
  test("заголовок accept и адрес с закодированной областью", async () => {
    let seenUrl = "";
    let seenAccept = "";
    await probeRegistry({
      env,
      fetchImpl: async (url, init) => {
        seenUrl = url;
        seenAccept = init?.headers?.["accept"] ?? "";
        return { ok: true, status: 200, json: async () => ({ "dist-tags": { latest: "0.1.1" } }) };
      },
    });
    expect(seenUrl).toBe("https://registry.npmjs.org/@aistastudio%2fmyc");
    expect(seenAccept).toBe("application/vnd.npm.install-v1+json");
  });
});

describe("имя пакета не разъезжается со сборкой", () => {
  test("PACKAGE_NAME совпадает с манифестом scripts/pack-npm.ts", () => {
    // Разъедутся — проверка молча спросит несуществующий пакет и навсегда
    // получит 404, то есть «не смогли проверить» на пустом месте.
    const pack = readFileSync(join(import.meta.dir, "..", "..", "..", "scripts", "pack-npm.ts"), "utf8");
    const m = /name:\s*"(@[^"]+)"/.exec(pack);
    expect(m?.[1]).toBe(PACKAGE_NAME);
  });
});
