import { describe, expect, test } from "bun:test";
import {
  ClockSkewError,
  HLC_MAX_SKEW_MS,
  HlcClock,
  HlcOverflowError,
  Site,
  assertClockSkew,
  compareClock,
  compareHlc,
  edgeKey,
  emptyState,
  isEdgeAlive,
  joinStates,
  liveEdges,
  liveTags,
  merge,
  packHlc,
  parseEdgeKey,
  readCounter,
  readField,
  snapshot,
  unpackHlc,
  type Hlc,
  type Op,
  type OplogState,
} from "./oplog.ts";

// ---------------------------------------------------------------------------
// Утилиты: детерминированный PRNG (mulberry32) и фейковые часы
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  shuffle<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
  /** Разбить массив на случайные непустые пакеты, сохраняя порядок. */
  chunks<T>(arr: readonly T[]): T[][] {
    const out: T[][] = [];
    let i = 0;
    while (i < arr.length) {
      const n = 1 + this.int(Math.min(7, arr.length - i));
      out.push(arr.slice(i, i + n));
      i += n;
    }
    return out;
  }
}

/** Управляемое физическое время. */
class FakeTime {
  ms: number;
  constructor(ms: number) {
    this.ms = ms;
  }
  now = (): number => this.ms;
}

function hlc(ts: number, ctr = 0): Hlc {
  return { ts, ctr };
}

function mkSet(
  site: string,
  seq: number,
  h: Hlc,
  entity: string,
  field: string,
  value: string,
): Op {
  return { op: "set", op_id: `${site}:${seq}`, seq, hlc: h, site_id: site, entity_id: entity, field, value };
}

// ---------------------------------------------------------------------------
// HLC
// ---------------------------------------------------------------------------

describe("HlcClock", () => {
  test("send: advances with physical time, counts within the same ms", () => {
    const t = new FakeTime(1000);
    const c = new HlcClock({ now: t.now });
    expect(c.now()).toEqual(hlc(1000, 0));
    expect(c.now()).toEqual(hlc(1000, 1));
    t.ms = 1001;
    expect(c.now()).toEqual(hlc(1001, 0));
  });

  test("send: never goes backwards when physical clock jumps back", () => {
    const t = new FakeTime(5000);
    const c = new HlcClock({ now: t.now });
    c.now();
    t.ms = 4000;
    expect(c.now()).toEqual(hlc(5000, 1));
    expect(c.now()).toEqual(hlc(5000, 2));
  });

  test("recv: classic rules for all four branches", () => {
    const t = new FakeTime(1000);
    const c = new HlcClock({ now: t.now });
    // m == phys, larger than both → ctr 0
    expect(c.recv(hlc(900, 7))).toEqual(hlc(1000, 0));
    // m == local == remote → max(ctr)+1
    expect(c.recv(hlc(1000, 5))).toEqual(hlc(1000, 6));
    // m == local only → local ctr + 1
    expect(c.recv(hlc(999, 40))).toEqual(hlc(1000, 7));
    // m == remote only (remote ahead, within skew) → remote ctr + 1
    expect(c.recv(hlc(1500, 3))).toEqual(hlc(1500, 4));
    // and the clock stays there even though physical is behind
    expect(c.now()).toEqual(hlc(1500, 5));
  });

  test("recv: result is strictly greater than both local and remote", () => {
    const rng = new Rng(7);
    const t = new FakeTime(10_000);
    const c = new HlcClock({ now: t.now });
    for (let i = 0; i < 2000; i++) {
      const before = c.state;
      const remote = hlc(9_000 + rng.int(HLC_MAX_SKEW_MS + 1000), rng.int(50));
      t.ms += rng.int(3);
      const r = c.recv(remote);
      expect(compareHlc(r, before)).toBe(1);
      expect(compareHlc(r, remote)).toBe(1);
    }
  });

  test("counter overflow is an explicit error", () => {
    const t = new FakeTime(1);
    const c = new HlcClock({ now: t.now, initial: hlc(1, 0xfffe) });
    c.now(); // 0xffff
    expect(() => c.now()).toThrow(HlcOverflowError);
  });

  test("pack/unpack roundtrip and ordering of packed values", () => {
    const a = hlc(1_727_352_841_001, 5);
    const b = hlc(1_727_352_841_001, 6);
    const c = hlc(1_727_352_841_002, 0);
    expect(unpackHlc(packHlc(a))).toEqual(a);
    expect(packHlc(a) < packHlc(b)).toBe(true);
    expect(packHlc(b) < packHlc(c)).toBe(true);
    expect(packHlc(hlc(1, 0))).toBe(65536n);
  });
});

describe("clock skew", () => {
  // Семантика (решение координатора, docs/design/01-core-data-model.md §9.2):
  // операция принимается ВСЕГДА, но наши часы не подтягиваются за чужими
  // дальше порога, а расхождение копится для отчёта. Отказ был бы хуже:
  // отвергнутая операция — это расхождение реплик, которое не срастётся само.
  test("чужие часы дальше порога: операция принята, часы зажаты", () => {
    const t = new FakeTime(1_000_000);
    const c = new HlcClock({ now: t.now });
    const got = c.recv(hlc(1_000_000 + HLC_MAX_SKEW_MS + 60_000));
    expect(got.ts).toBe(1_000_000 + HLC_MAX_SKEW_MS);
    expect(c.skew.count).toBe(1);
    expect(c.skew.maxObservedMs).toBe(HLC_MAX_SKEW_MS + 60_000);
  });

  test("ровно на пороге — не расхождение", () => {
    const t = new FakeTime(1_000_000);
    const c = new HlcClock({ now: t.now });
    expect(c.recv(hlc(1_000_000 + HLC_MAX_SKEW_MS)).ts).toBe(
      1_000_000 + HLC_MAX_SKEW_MS,
    );
    expect(c.skew.count).toBe(0);
  });

  test("строгая проверка для --strict по-прежнему бросает", () => {
    try {
      assertClockSkew(hlc(500_000), 100_000);
      throw new Error("unreachable");
    } catch (e) {
      expect(e).toBeInstanceOf(ClockSkewError);
      expect((e as ClockSkewError).skewMs).toBe(400_000);
    }
  });

  test("чужие часы в прошлом — это просто медленный пир", () => {
    const t = new FakeTime(1_000_000);
    const c = new HlcClock({ now: t.now });
    expect(() => c.recv(hlc(1))).not.toThrow();
    expect(c.skew.count).toBe(0);
  });

  test("пакет со съехавшей операцией применяется целиком, деградация видна", () => {
    const t = new FakeTime(1_000_000);
    const clock = new HlcClock({ now: t.now });
    const good = mkSet("A", 1, hlc(1_000_000), "n1", "title", "ok");
    const bad = mkSet("B", 1, hlc(1_000_000 + HLC_MAX_SKEW_MS + 61_000), "n1", "body", "skewed");
    const s0 = emptyState();
    const s1 = merge(s0, [good, bad], { clock });
    expect(readField(s1, "n1", "title")?.value).toBe("ok");
    expect(readField(s1, "n1", "body")?.value).toBe("skewed");
    expect(clock.skew.count).toBe(1);
  });

  test("порог настраивается", () => {
    const t = new FakeTime(0);
    const c = new HlcClock({ now: t.now, maxSkewMs: 10 });
    expect(c.recv(hlc(50)).ts).toBe(10);
    expect(c.skew.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// seq vs hlc
// ---------------------------------------------------------------------------

describe("seq", () => {
  test("monotonic per site, independent of hlc, drives since()", () => {
    const t = new FakeTime(100);
    const site = new Site("A", { clock: new HlcClock({ now: t.now }), lastSeq: 41 });
    const a = site.set("n1", "title", "x");
    t.ms = 50; // physical clock went back: hlc keeps going, seq keeps going
    const b = site.set("n1", "body", "y");
    const c = site.inc("n1", "seen_count");
    expect([a.seq, b.seq, c.seq]).toEqual([42, 43, 44]);
    expect(site.lastSeq).toBe(44);
    expect(site.since(42).map((o) => o.seq)).toEqual([43, 44]);
    expect(site.since(44)).toEqual([]);
    expect(compareHlc(b.hlc, a.hlc)).toBe(1);
    expect(a.op_id).toBe("A:42");
  });
});

// ---------------------------------------------------------------------------
// LWW
// ---------------------------------------------------------------------------

describe("per-field LWW", () => {
  test("higher hlc wins regardless of arrival order", () => {
    const older = mkSet("A", 1, hlc(100), "n1", "title", "old");
    const newer = mkSet("B", 1, hlc(200), "n1", "title", "new");
    const s1 = merge(emptyState(), [older, newer]);
    const s2 = merge(emptyState(), [newer, older]);
    expect(readField(s1, "n1", "title")?.value).toBe("new");
    expect(snapshot(s1)).toBe(snapshot(s2));
  });

  test("fields of one entity are independent", () => {
    const a = mkSet("A", 1, hlc(200), "n1", "priority", "1");
    const b = mkSet("B", 1, hlc(100), "n1", "body", "text");
    const s = merge(emptyState(), [a, b]);
    expect(readField(s, "n1", "priority")?.value).toBe("1");
    expect(readField(s, "n1", "body")?.value).toBe("text");
  });

  test("equal hlc: site_id breaks the tie identically on both sides", () => {
    const fromA = mkSet("site-a", 1, hlc(500, 3), "n1", "status", "from A");
    const fromB = mkSet("site-b", 1, hlc(500, 3), "n1", "status", "from B");
    const onA = merge(merge(emptyState(), [fromA]), [fromB]);
    const onB = merge(merge(emptyState(), [fromB]), [fromA]);
    expect(readField(onA, "n1", "status")?.value).toBe("from B");
    expect(readField(onB, "n1", "status")?.value).toBe("from B");
    expect(snapshot(onA)).toBe(snapshot(onB));
    expect(compareClock(fromA.hlc, "site-a", fromB.hlc, "site-b")).toBe(-1);
  });

  test("tie-break is by code units, not locale", () => {
    // 'Z' < 'a' by code unit; a locale-aware compare would put 'a' first.
    expect(compareClock(hlc(1), "Z", hlc(1), "a")).toBe(-1);
    expect(compareClock(hlc(1), "a", hlc(1), "Z")).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// OR-Set
// ---------------------------------------------------------------------------

describe("add-wins OR-Set", () => {
  const t = () => new FakeTime(1000);

  test("add then remove: gone", () => {
    const time = t();
    const a = new Site("A", { clock: new HlcClock({ now: time.now }) });
    a.edgeAdd("n1", "blocks", "n2");
    expect(isEdgeAlive(a.state, edgeKey("n1", "blocks", "n2"))).toBe(true);
    a.edgeDel("n1", "blocks", "n2");
    expect(isEdgeAlive(a.state, edgeKey("n1", "blocks", "n2"))).toBe(false);
  });

  test("a remove that never saw the concurrent add does NOT remove it", () => {
    const time = t();
    const a = new Site("A", { clock: new HlcClock({ now: time.now }) });
    const b = new Site("B", { clock: new HlcClock({ now: time.now }) });
    const key = edgeKey("n1", "blocks", "n2");

    // A adds, B learns about it.
    a.edgeAdd("n1", "blocks", "n2");
    b.receive(a.ops);
    expect(isEdgeAlive(b.state, key)).toBe(true);

    // Concurrently: B removes (it saw tag A:1), A re-adds with a fresh tag.
    time.ms = 2000;
    const del = b.edgeDel("n1", "blocks", "n2");
    expect(del.value.tags).toEqual(["A:1"]);
    const readd = a.edgeAdd("n1", "blocks", "n2");
    expect(readd.value.tag).toBe("A:2");

    // Exchange in both orders: edge survives on both sides.
    a.receive(b.since(0));
    b.receive(a.since(1));
    expect(isEdgeAlive(a.state, key)).toBe(true);
    expect(isEdgeAlive(b.state, key)).toBe(true);
    expect(liveTags(a.state, key)).toEqual(["A:2"]);
    expect(snapshot(a.state)).toBe(snapshot(b.state));
  });

  test("a remove with a later hlc still loses to an add it did not observe", () => {
    // Timestamps say the delete is 'newer', but OR-Set is not LWW.
    const key = edgeKey("x", "relates", "y");
    const add: Op = {
      op: "edge_add", op_id: "C:1", seq: 1, hlc: hlc(100), site_id: "C",
      entity_id: key, field: "relates", value: { tag: "C:1" },
    };
    const del: Op = {
      op: "edge_del", op_id: "B:9", seq: 9, hlc: hlc(999), site_id: "B",
      entity_id: key, field: "relates", value: { tags: ["A:1"] },
    };
    expect(isEdgeAlive(merge(emptyState(), [add, del]), key)).toBe(true);
    expect(isEdgeAlive(merge(emptyState(), [del, add]), key)).toBe(true);
  });

  test("remove delivered before the add it observed still kills that add", () => {
    const key = edgeKey("x", "relates", "y");
    const add: Op = {
      op: "edge_add", op_id: "A:1", seq: 1, hlc: hlc(100), site_id: "A",
      entity_id: key, field: "relates", value: { tag: "A:1" },
    };
    const del: Op = {
      op: "edge_del", op_id: "B:1", seq: 1, hlc: hlc(200), site_id: "B",
      entity_id: key, field: "relates", value: { tags: ["A:1"] },
    };
    expect(isEdgeAlive(merge(emptyState(), [del, add]), key)).toBe(false);
    expect(isEdgeAlive(merge(emptyState(), [add, del]), key)).toBe(false);
  });

  test("edgeKey roundtrip", () => {
    expect(parseEdgeKey(edgeKey("myc-a", "blocks", "myc-b"))).toEqual({
      src: "myc-a", type: "blocks", dst: "myc-b",
    });
  });
});

// ---------------------------------------------------------------------------
// G-counter
// ---------------------------------------------------------------------------

describe("G-counter", () => {
  test("no increment is lost in any merge order", () => {
    const time = new FakeTime(1);
    const sites = ["A", "B", "C"].map(
      (id) => new Site(id, { clock: new HlcClock({ now: time.now }) }),
    );
    const rng = new Rng(11);
    let total = 0;
    for (let i = 0; i < 300; i++) {
      const d = 1 + rng.int(5);
      rng.pick(sites).inc("n1", "seen_count", d);
      total += d;
    }
    const all = sites.flatMap((s) => s.ops);
    for (let k = 0; k < 20; k++) {
      const order = rng.shuffle(all);
      let s = emptyState();
      for (const chunk of rng.chunks(order)) s = merge(s, chunk);
      expect(readCounter(s, "n1", "seen_count")).toBe(total);
    }
  });

  test("replayed ops do not double count", () => {
    const a = new Site("A", { clock: new HlcClock({ now: () => 1 }) });
    a.inc("n1", "seen_count", 2);
    a.inc("n1", "seen_count", 3);
    const s = merge(merge(emptyState(), a.ops), a.ops);
    expect(readCounter(s, "n1", "seen_count")).toBe(5);
    expect(readCounter(merge(s, [a.ops[0]!]), "n1", "seen_count")).toBe(5);
  });

  test("rejects non-positive increments", () => {
    const a = new Site("A");
    expect(() => a.inc("n1", "c", 0)).toThrow();
    expect(() => a.inc("n1", "c", -1)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Свойства merge: коммутативность, ассоциативность, идемпотентность
// ---------------------------------------------------------------------------

const ENTITIES = ["n1", "n2", "n3"];
const FIELDS = ["title", "status", "priority"];
const EDGES: [string, string, string][] = [
  ["n1", "blocks", "n2"],
  ["n2", "relates", "n3"],
  ["n1", "parent", "n3"],
];

interface Scenario {
  readonly seed: number;
  readonly sites: Site[];
  readonly ops: readonly Op[];
}

/**
 * Три сайта с общим или расходящимся физическим временем, случайные операции
 * всех четырёх видов и случайные частичные синхронизации между сайтами по ходу
 * генерации, чтобы edge_del видел чужие теги, а LWW сталкивался на равных hlc.
 */
function generateScenario(seed: number): Scenario {
  const rng = new Rng(seed);
  // Половина сценариев — на «замороженном» времени: максимум коллизий hlc.
  const frozen = rng.chance(0.5);
  const time = new FakeTime(1_000_000);
  const sites = ["site-a", "site-b", "site-c"].map(
    (id) => new Site(id, { clock: new HlcClock({ now: time.now }) }),
  );
  const nOps = 10 + rng.int(40);
  for (let i = 0; i < nOps; i++) {
    if (!frozen && rng.chance(0.4)) time.ms += rng.int(5);
    const site = rng.pick(sites);
    const kind = rng.int(5);
    if (kind === 0 || kind === 1) {
      site.set(rng.pick(ENTITIES), rng.pick(FIELDS), `v${seed}-${i}`);
    } else if (kind === 2) {
      site.inc(rng.pick(ENTITIES), "seen_count", 1 + rng.int(3));
    } else if (kind === 3) {
      const [s, t, d] = rng.pick(EDGES);
      site.edgeAdd(s, t, d, rng.chance(0.5) ? rng.int(10) / 10 : undefined);
    } else {
      const [s, t, d] = rng.pick(EDGES);
      site.edgeDel(s, t, d);
    }
    // Частичная синхронизация: сайт получает случайный префикс чужого лога.
    if (rng.chance(0.3)) {
      const from = rng.pick(sites);
      const to = rng.pick(sites);
      if (from !== to) {
        const prefix = from.ops.slice(0, rng.int(from.ops.length + 1));
        to.receive(prefix);
      }
    }
  }
  return { seed, sites, ops: sites.flatMap((s) => s.ops) };
}

function applyInChunks(ops: readonly Op[], rng: Rng): OplogState {
  let s = emptyState();
  for (const chunk of rng.chunks(ops)) s = merge(s, chunk);
  return s;
}

describe("merge convergence (property-based, seeded)", () => {
  const SCENARIOS = 250;
  const PERMUTATIONS = 4;

  test(`commutativity: ${SCENARIOS} scenarios × ${PERMUTATIONS} permutations converge`, () => {
    let checked = 0;
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const sc = generateScenario(seed);
      const rng = new Rng(seed * 7919);
      const reference = snapshot(applyInChunks(sc.ops, rng));
      for (let p = 0; p < PERMUTATIONS; p++) {
        const order = rng.shuffle(sc.ops);
        const got = snapshot(applyInChunks(order, rng));
        if (got !== reference) {
          throw new Error(`seed=${seed} permutation=${p} diverged:\n${reference}\n---\n${got}`);
        }
        checked++;
      }
      // Настоящие сайты, досинхронизировавшись, приходят к тому же состоянию.
      for (const site of sc.sites) site.receive(sc.ops);
      for (const site of sc.sites) {
        expect(snapshot(site.state)).toBe(reference);
      }
    }
    expect(checked).toBe(SCENARIOS * PERMUTATIONS);
  });

  test("associativity: (A ⊔ B) ⊔ C == A ⊔ (B ⊔ C) for states and for op batches", () => {
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const sc = generateScenario(seed);
      const rng = new Rng(seed * 104_729);
      const [a, b, c] = rng.shuffle(sc.sites) as [Site, Site, Site];
      const sa = merge(emptyState(), a.ops);
      const sb = merge(emptyState(), b.ops);
      const scc = merge(emptyState(), c.ops);
      const left = joinStates(joinStates(sa, sb), scc);
      const right = joinStates(sa, joinStates(sb, scc));
      expect(snapshot(left)).toBe(snapshot(right));
      // и через merge пакетами
      const viaOps1 = merge(merge(merge(emptyState(), a.ops), b.ops), c.ops);
      const viaOps2 = merge(emptyState(), [...c.ops, ...b.ops, ...a.ops]);
      expect(snapshot(viaOps1)).toBe(snapshot(left));
      expect(snapshot(viaOps2)).toBe(snapshot(left));
    }
  });

  test("idempotency: re-feeding the same ops changes nothing", () => {
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const sc = generateScenario(seed);
      const rng = new Rng(seed * 31);
      const once = merge(emptyState(), sc.ops);
      const twice = merge(once, sc.ops);
      const partial = merge(once, rng.shuffle(sc.ops).slice(0, rng.int(sc.ops.length)));
      const self = joinStates(once, once);
      expect(snapshot(twice)).toBe(snapshot(once));
      expect(snapshot(partial)).toBe(snapshot(once));
      expect(snapshot(self)).toBe(snapshot(once));
    }
  });

  test("merge does not mutate its input", () => {
    const sc = generateScenario(42);
    const base = merge(emptyState(), sc.ops.slice(0, 5));
    const before = snapshot(base);
    merge(base, sc.ops);
    joinStates(base, merge(emptyState(), sc.ops));
    expect(snapshot(base)).toBe(before);
  });

  test("scenario generator actually exercises every op kind and hlc collisions", () => {
    const kinds = new Set<string>();
    let collisions = 0;
    let liveAfterDel = 0;
    for (let seed = 1; seed <= SCENARIOS; seed++) {
      const sc = generateScenario(seed);
      for (const op of sc.ops) kinds.add(op.op);
      const seen = new Map<string, string>();
      for (const op of sc.ops) {
        if (op.op !== "set") continue;
        const k = `${op.entity_id}/${op.field}/${op.hlc.ts}.${op.hlc.ctr}`;
        const prev = seen.get(k);
        if (prev !== undefined && prev !== op.site_id) collisions++;
        seen.set(k, op.site_id);
      }
      const final = merge(emptyState(), sc.ops);
      const hadDel = sc.ops.some((o) => o.op === "edge_del" && o.value.tags.length > 0);
      if (hadDel && liveEdges(final).length > 0) liveAfterDel++;
    }
    expect([...kinds].sort()).toEqual(["edge_add", "edge_del", "inc", "set"]);
    expect(collisions).toBeGreaterThan(50);
    expect(liveAfterDel).toBeGreaterThan(20);
  });
});
