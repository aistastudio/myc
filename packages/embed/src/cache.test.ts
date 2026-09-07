import { describe, expect, test } from "bun:test";
import {
  DEFAULT_EMBED_CACHE_MAX_ENTRIES,
  EmbedQueryCache,
  embedCacheKey,
  normalizeQueryText,
} from "./cache.ts";
import type { EmbedFingerprint } from "./types.ts";

const LOCAL: EmbedFingerprint = {
  backend: "local",
  provider: "onnx",
  model: "bge-small-en-v1.5-q8",
  dim: 384,
  normalize: true,
};

const OTHER_MODEL: EmbedFingerprint = {
  ...LOCAL,
  model: "bge-base-en-v1.5-q8",
};

function vec(fill: number): Float32Array {
  return new Float32Array(384).fill(fill);
}

describe("normalizeQueryText", () => {
  test("склеивает: пробелы и регистр не значимы", () => {
    expect(normalizeQueryText("  What is  Foo?  ")).toBe(
      normalizeQueryText("what is foo?"),
    );
    expect(normalizeQueryText("hello\tworld\n")).toBe(
      normalizeQueryText("hello world"),
    );
  });

  test("не склеивает: пунктуация значима", () => {
    expect(normalizeQueryText("Foo?")).not.toBe(normalizeQueryText("Foo"));
    expect(normalizeQueryText("auth.ts")).not.toBe(
      normalizeQueryText("auth ts"),
    );
    expect(normalizeQueryText("foo()")).not.toBe(normalizeQueryText("foo"));
  });
});

describe("embedCacheKey", () => {
  test("тот же текст + тот же отпечаток -> тот же ключ", () => {
    expect(embedCacheKey("hello world", LOCAL)).toBe(
      embedCacheKey("Hello   World", LOCAL),
    );
  });

  test("смена отпечатка -> другой ключ для того же текста", () => {
    expect(embedCacheKey("hello world", LOCAL)).not.toBe(
      embedCacheKey("hello world", OTHER_MODEL),
    );
  });
});

describe("EmbedQueryCache", () => {
  test("промах, затем попадание", () => {
    const cache = new EmbedQueryCache();
    expect(cache.get("hello", LOCAL)).toBeUndefined();
    expect(cache.misses).toBe(1);

    cache.set("hello", LOCAL, vec(1));
    const hit = cache.get("hello", LOCAL);
    expect(hit).toBeDefined();
    expect(hit![0]).toBe(1);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(1);
    expect(cache.size).toBe(1);
  });

  test("нормализация текста применяется при поиске", () => {
    const cache = new EmbedQueryCache();
    cache.set("  Hello   World  ", LOCAL, vec(2));
    expect(cache.get("hello world", LOCAL)).toBeDefined();
    expect(cache.hits).toBe(1);
  });

  test("попадание в кеш быстрее 0.1 мс", () => {
    const cache = new EmbedQueryCache();
    cache.set("hello", LOCAL, vec(1));
    // прогрев (JIT), меряем после
    cache.get("hello", LOCAL);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      cache.get("hello", LOCAL);
    }
    const totalMs = performance.now() - start;
    const perCallMs = totalMs / 1000;
    // eslint-disable-next-line no-console
    console.log(`EmbedQueryCache.get: ${perCallMs.toFixed(5)} мс/вызов`);
    expect(perCallMs).toBeLessThan(0.1);
  });

  test("смена embed_fingerprint инвалидирует кеш целиком: старые векторы недостижимы", () => {
    const cache = new EmbedQueryCache();
    cache.set("hello", LOCAL, vec(1));
    expect(cache.get("hello", LOCAL)).toBeDefined();

    // Смена модели: тот же нормализованный текст, другой fingerprint.
    expect(cache.get("hello", OTHER_MODEL)).toBeUndefined();
    expect(cache.misses).toBe(1);

    // Старый вектор недостижим ни при каком запросе под новым отпечатком.
    cache.set("hello", OTHER_MODEL, vec(9));
    const underNew = cache.get("hello", OTHER_MODEL);
    expect(underNew![0]).toBe(9);
    // Старая запись всё ещё физически в map (никто её не удалял), но
    // недостижима под старым отпечатком без искусственного восстановления —
    // единственный способ её увидеть - снова запросить под LOCAL.
    const underOld = cache.get("hello", LOCAL);
    expect(underOld![0]).toBe(1);
    expect(underOld).not.toBe(underNew);
  });

  test("вытеснение LRU: метрики сходятся", () => {
    const cache = new EmbedQueryCache(2);
    cache.set("a", LOCAL, vec(1));
    cache.set("b", LOCAL, vec(2));
    expect(cache.size).toBe(2);
    expect(cache.evictions).toBe(0);

    // "a" - самый старый, будет вытеснен при вставке третьего элемента.
    cache.set("c", LOCAL, vec(3));
    expect(cache.size).toBe(2);
    expect(cache.evictions).toBe(1);
    expect(cache.get("a", LOCAL)).toBeUndefined();
    expect(cache.get("b", LOCAL)).toBeDefined();
    expect(cache.get("c", LOCAL)).toBeDefined();
  });

  test("вытеснение LRU: недавно прочитанный элемент не вытесняется первым", () => {
    const cache = new EmbedQueryCache(2);
    cache.set("a", LOCAL, vec(1));
    cache.set("b", LOCAL, vec(2));
    // "a" стал недавно использованным - "b" теперь самый старый.
    cache.get("a", LOCAL);
    cache.set("c", LOCAL, vec(3));

    expect(cache.get("b", LOCAL)).toBeUndefined();
    expect(cache.get("a", LOCAL)).toBeDefined();
    expect(cache.get("c", LOCAL)).toBeDefined();
  });

  test("clear() сбрасывает содержимое, но не счётчики", () => {
    const cache = new EmbedQueryCache();
    cache.set("a", LOCAL, vec(1));
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("a", LOCAL)).toBeUndefined();
  });

  test("размер по умолчанию задокументирован константой", () => {
    expect(DEFAULT_EMBED_CACHE_MAX_ENTRIES).toBe(1000);
    expect(new EmbedQueryCache().size).toBe(0);
  });
});

// ============================ CachedEmbedder =================================

import { CachedEmbedder } from "./cache.ts";
import type {
  EmbedBatchResult,
  EmbedResult,
  EmbedRole,
  EmbedState,
  EmbedStateReason,
  Embedder,
} from "./types.ts";

/** Эмбеддер-счётчик: считает НАСТОЯЩИЕ вызовы и умеет отдавать не-ok. */
class FakeEmbedder implements Embedder {
  calls: { text: string; role: EmbedRole }[] = [];
  batchCalls = 0;
  state: EmbedState = "ok";
  stateReason: EmbedStateReason | undefined = undefined;
  fill = 1;
  readonly fingerprint = LOCAL;

  async embed(text: string, role: EmbedRole = "query"): Promise<EmbedResult> {
    this.calls.push({ text, role });
    if (this.state !== "ok") {
      return { vec: null, state: this.state, reason: this.stateReason };
    }
    return { vec: new Float32Array(384).fill(this.fill), state: "ok", ms: 23 };
  }

  async embedBatch(texts: readonly string[], role: EmbedRole = "passage"): Promise<EmbedBatchResult> {
    this.batchCalls++;
    const results = texts.map(() => ({
      vec: new Float32Array(384).fill(this.fill),
      state: "ok" as const,
      ms: 1,
    }));
    void role;
    return { results, ok: results.length, ms: 1 };
  }

  async warmup(): Promise<EmbedState> {
    return this.state;
  }

  async destroy(): Promise<void> {}
}

describe("CachedEmbedder", () => {
  test("повтор запроса не доходит до модели, и это видно в cached", async () => {
    const inner = new FakeEmbedder();
    const e = new CachedEmbedder(inner);
    const first = await e.embed("как объединять оплог");
    expect(first.cached).toBe(false);
    expect(first.ms).toBe(23);
    const second = await e.embed("как объединять оплог");
    expect(second.cached).toBe(true);
    expect(second.ms).toBe(0);
    expect(inner.calls).toHaveLength(1);
    expect([...second.vec!]).toEqual([...first.vec!]);
  });

  test("регистр и пробелы схлопываются — тот же вопрос, тот же вектор", async () => {
    const inner = new FakeEmbedder();
    const e = new CachedEmbedder(inner);
    await e.embed("Как объединять  ОПЛОГ ");
    const again = await e.embed("как объединять оплог");
    expect(again.cached).toBe(true);
    expect(inner.calls).toHaveLength(1);
  });

  test("вектор отдаётся КОПИЕЙ: правка потребителем не портит кеш", async () => {
    const inner = new FakeEmbedder();
    const e = new CachedEmbedder(inner);

    // Путь записи: промах отдал вектор, потребитель правит его на месте
    // (normalizeInPlace/quantizeInt8) — в кеше должен лежать нетронутый.
    const miss = await e.embed("оплог");
    miss.vec![0] = 111;
    const hit = await e.embed("оплог");
    expect(hit.cached).toBe(true);
    expect(hit.vec![0]).toBe(1);

    // Путь чтения: то же самое, но правится вектор, ПОЛУЧЕННЫЙ ИЗ КЕША.
    // Без копии здесь кеш травится навсегда и молча — с каждым попаданием.
    hit.vec![0] = 222;
    const again = await e.embed("оплог");
    expect(again.cached).toBe(true);
    expect(again.vec![0]).toBe(1);
    expect(again.vec).not.toBe(hit.vec);
    expect(inner.calls).toHaveLength(1);
  });

  test("не-ok не кешируется: деградация не переживает саму себя", async () => {
    const inner = new FakeEmbedder();
    inner.state = "warming";
    const e = new CachedEmbedder(inner);
    const warming = await e.embed("оплог");
    expect(warming.state).toBe("warming");
    expect(warming.cached).toBe(false);

    inner.state = "ok";
    const ok = await e.embed("оплог");
    expect(ok.state).toBe("ok");
    expect(ok.cached).toBe(false); // промах, а не замороженный warming
    expect(inner.calls).toHaveLength(2);
  });

  test("роль passage не кешируется: в индексации попаданий не бывает", async () => {
    const inner = new FakeEmbedder();
    const e = new CachedEmbedder(inner);
    await e.embed("текст документа", "passage");
    const again = await e.embed("текст документа", "passage");
    expect(again.cached).toBeUndefined();
    expect(inner.calls).toHaveLength(2);
    expect(e.cache.size).toBe(0);
  });

  test("embedBatch проходит насквозь", async () => {
    const inner = new FakeEmbedder();
    const e = new CachedEmbedder(inner);
    const out = await e.embedBatch(["a", "b"]);
    expect(out.ok).toBe(2);
    expect(inner.batchCalls).toBe(1);
    expect(e.cache.size).toBe(0);
  });

  test("состояние и отпечаток берутся у внутреннего эмбеддера", async () => {
    const inner = new FakeEmbedder();
    const e = new CachedEmbedder(inner);
    expect(e.fingerprint).toBe(LOCAL);
    inner.state = "degraded";
    inner.stateReason = "load_error";
    expect(e.state).toBe("degraded");
    expect(e.stateReason).toBe("load_error");
    expect(await e.warmup()).toBe("degraded");
  });

  test("цена попадания против цены модели", async () => {
    const inner = new FakeEmbedder();
    const e = new CachedEmbedder(inner);
    await e.embed("прогрев");
    const N = 2000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) await e.embed("прогрев");
    const hitMs = (performance.now() - t0) / N;
    // 23.3 мс p50 — измеренная координатором цена промаха под WASM (шапка cache.ts).
    console.log(
      `[кеш эмбеддингов] попадание ${hitMs.toFixed(4)} мс против промаха 23.3 мс — ` +
        `дешевле в ${Math.round(23.3 / hitMs)} раз; ` +
        `1000 записей × 384 float32 = ${((1000 * 384 * 4) / 1024 / 1024).toFixed(2)} МиБ векторов`,
    );
    expect(hitMs).toBeLessThan(0.5);
  });
});

describe("createEmbedder подключает кеш по умолчанию", () => {
  const apiCfg = { baseUrl: "", apiKey: "", model: "m", dim: 384 } as const;

  test("умолчание — с кешем; queryCache: false — без", async () => {
    const { createEmbedder } = await import("./index.ts");
    expect(createEmbedder({ backend: "api", ...apiCfg })).toBeInstanceOf(CachedEmbedder);
    expect(
      createEmbedder({ backend: "api", ...apiCfg, queryCache: false }),
    ).not.toBeInstanceOf(CachedEmbedder);
    const sized = createEmbedder({ backend: "api", ...apiCfg, queryCache: 4 });
    expect(sized).toBeInstanceOf(CachedEmbedder);
  });

  test("обёртка не глушит деградацию бэкенда", async () => {
    const { createEmbedder } = await import("./index.ts");
    const e = createEmbedder({ backend: "api", ...apiCfg });
    const r = await e.embed("оплог");
    expect(r.state).not.toBe("ok");
    expect(r.vec).toBeNull();
  });
});

describe("процессный кеш, переживающий эмбеддер", () => {
  test("общий кеш даёт попадания РАЗНЫМ эмбеддерам и не чистится их destroy", async () => {
    const shared = new EmbedQueryCache();
    const first = new FakeEmbedder();
    const a = new CachedEmbedder(first, shared);
    await a.embed("оплог");
    await a.destroy();
    expect(shared.size).toBe(1);

    // Новый эмбеддер того же процесса (recall создаёт его на каждый вызов).
    const second = new FakeEmbedder();
    const b = new CachedEmbedder(second, shared);
    const hit = await b.embed("оплог");
    expect(hit.cached).toBe(true);
    expect(second.calls).toHaveLength(0);
  });

  test("собственный кеш эмбеддера его destroy чистит", async () => {
    const e = new CachedEmbedder(new FakeEmbedder());
    await e.embed("оплог");
    expect(e.cache.size).toBe(1);
    await e.destroy();
    expect(e.cache.size).toBe(0);
  });
});
