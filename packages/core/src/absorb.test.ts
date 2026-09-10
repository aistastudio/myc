/**
 * absorb, ступень A — правила классификации на синтетических векторах и
 * реальных фразах. Пороги здесь не подбираются (это делает
 * bench/absorb-calibrate.ts на настоящей модели); проверяется, что правила
 * ведут себя так, как описано в absorb.ts, и что умолчания совпадают с
 * последним замером в bench/absorb-calibration.json.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ABSORB_CLASSES,
  DEFAULT_ABSORB_THRESHOLDS,
  absorbHash,
  absorbThresholdsFromToml,
  ABSORB_EDGE,
  absorbEdgeFor,
  absorbEdges,
  canonicalOf,
  classifyAbsorb,
  classifyPair,
  cosine,
  lexicalSignals,
  normalizeAbsorbText,
  trigramJaccard,
  trigramSet,
  type AbsorbText,
  type AbsorbVerdict,
} from "./absorb.ts";

// Синтетические векторы: одна «тема» — один орт, шум — вторая координата.
function vec(topic: number, noise = 0): Float32Array {
  const v = new Float32Array(8);
  v[topic] = 1;
  v[7] = noise;
  return v;
}

const T = DEFAULT_ABSORB_THRESHOLDS;

describe("нормализация и хеш", () => {
  test("NFKC, пробелы, концевая пунктуация, регистр", () => {
    expect(normalizeAbsorbText("  Тот   же   Факт.  ")).toBe("тот же факт");
    expect(normalizeAbsorbText("Факт!?…")).toBe("факт");
    // NFKC: полноширинная латиница и лигатура схлопываются в обычные буквы.
    expect(normalizeAbsorbText("ＡＢＣ ﬁ")).toBe("abc fi");
  });

  test("хеш склеивает варианты, которые уникальный индекс считает разными", () => {
    expect(absorbHash("Тот же факт.")).toBe(absorbHash("тот же факт"));
    expect(absorbHash("Тот же факт")).not.toBe(absorbHash("Тот же факт, но другой"));
  });
});

describe("триграммы и косинус", () => {
  test("жаккар: 1 на равных, симметричен, мал на разных", () => {
    expect(trigramJaccard("абв где", "абв где")).toBe(1);
    const a = trigramJaccard("миграции только вперёд", "миграции вперёд только");
    const b = trigramJaccard("миграции вперёд только", "миграции только вперёд");
    expect(a).toBe(b);
    expect(trigramJaccard("миграции только вперёд", "рецепт блинов на молоке")).toBeLessThan(0.1);
  });

  test("короткий текст даёт непустое множество", () => {
    expect(trigramSet("ab").size).toBeGreaterThan(0);
    expect(trigramSet("").size).toBe(0);
  });

  test("косинус: 1 на равных, 0 на ортогональных, ошибка на разной размерности", () => {
    expect(cosine(vec(0), vec(0))).toBeCloseTo(1, 6);
    expect(cosine(vec(0), vec(1))).toBeCloseTo(0, 6);
    expect(cosine(new Float32Array(3), new Float32Array(3))).toBe(0);
    expect(() => cosine(new Float32Array(3), new Float32Array(4))).toThrow(RangeError);
  });
});

describe("пороги из workspace.toml", () => {
  test("секция [absorb] переопределяет, прочее игнорируется", () => {
    const t = absorbThresholdsFromToml(`
slug = "memory"
[ready]
priority = 0.5
[absorb]
dup_cos = 0.95   # комментарий
cand_cos = 0.8
max_related = 5.7
unknown = 0.1
`);
    expect(t.dup_cos).toBe(0.95);
    expect(t.cand_cos).toBe(0.8);
    expect(t.max_related).toBe(5);
    expect(t.dup_jac).toBe(T.dup_jac);
  });

  test("мусорные значения не роняют и не меняют умолчания", () => {
    const t = absorbThresholdsFromToml(`[absorb]\ndup_cos = "x"\ncand_jac = 7\ndup_jac = -1\n`);
    expect(t).toEqual(T);
  });
});

describe("лексические сигналы", () => {
  test("маркер обновления с кириллицей и только в новом тексте", () => {
    const old = "Таймаут вызова 1500 мс, детект однократный.";
    expect(lexicalSignals(old, "Таймаут вызова теперь 3000 мс, детект однократный.").updateMarker).toBe(true);
    // Маркер есть в обоих текстах — это часть факта, а не сигнал о замене.
    const both = "fan_in считается при обновлении якоря";
    expect(lexicalSignals(both, `${both} и хранится числом`).updateMarker).toBe(false);
  });

  test("переворот полярности: отрицание над тем же словом", () => {
    expect(
      lexicalSignals("Перед вставкой ребра проверяем цикл.", "Перед вставкой ребра цикл не проверяем.")
        .polarityFlip,
    ).toBe(true);
    expect(
      lexicalSignals("Рекомендация: только явно.", "Рекомендация: не только явно.").polarityFlip,
    ).toBe(true);
    // «не» есть в обоих текстах, но над разными словами — это не переворот.
    expect(
      lexicalSignals("Загрузка не блокирует init.", "Загрузка не блокирует init, модель одна.")
        .polarityFlip,
    ).toBe(false);
  });

  test("антонимы по основе и расхождение чисел", () => {
    const s = lexicalSignals("Проверка включена, порог 5 мс.", "Проверка выключена, порог 5 мс.");
    expect(s.polarityFlip).toBe(true);
    expect(s.numberDrift).toBe(false);
    expect(lexicalSignals("порог 5 мс", "порог 8 мс").numberDrift).toBe(true);
    expect(lexicalSignals("порог 5 мс", "порог 5,0 мс").numberDrift).toBe(true);
  });
});

describe("classifyPair — порядок правил", () => {
  const same = "Миграции только вперёд, версия целочисленная, checksum в schema_migrations.";

  test("совпавший хеш — duplicate даже без векторов", () => {
    const v = classifyPair({ text: same, vector: null }, { text: `${same.toUpperCase()}.`, vector: null });
    expect(v.class).toBe("duplicate");
    expect(v.hashEqual).toBe(true);
    expect(v.quality).toBe("lexical");
  });

  test("без векторов: update и contradiction не объявляются никогда", () => {
    const upd = classifyPair(
      { text: same, vector: null },
      { text: "Миграции только вперёд, версия теперь строковая, checksum в schema_migrations.", vector: null },
    );
    expect(upd.class).toBe("related");
    expect(upd.quality).toBe("lexical");
    const contra = classifyPair(
      { text: same, vector: null },
      { text: "Миграции не только вперёд, версия целочисленная, checksum в schema_migrations.", vector: null },
    );
    expect(contra.class).toBe("related");
  });

  test("без векторов: почти дословный повтор — duplicate только выше dup_jac_noembed", () => {
    const v = classifyPair({ text: same, vector: null }, { text: `${same} `, vector: null });
    expect(v.hashEqual).toBe(true);
    const near = classifyPair(
      { text: same, vector: null },
      { text: "Миграции только вперёд, версия целочисленная, checksum в schema_migrations", vector: null },
    );
    expect(near.jac).toBeGreaterThanOrEqual(T.dup_jac_noembed);
    expect(near.class).toBe("duplicate");
  });

  test("duplicate с векторами: высокие cos и jac, но не при признаках изменения", () => {
    const v = classifyPair(
      { text: same, vector: vec(0) },
      { text: "Миграции только вперёд, версия целочисленная, checksum в schema_migrations", vector: vec(0) },
    );
    expect(v.class).toBe("duplicate");
    // Тот же текст с изменённым числом и маркером — НЕ дубликат, как бы ни
    // совпадали векторы: ложный duplicate молча теряет знание.
    const changed = classifyPair(
      { text: "Бюджет записи 5 мс, чтение 3 мс, checksum в schema_migrations.", vector: vec(0) },
      { text: "Бюджет записи теперь 8 мс, чтение 3 мс, checksum в schema_migrations.", vector: vec(0) },
    );
    expect(changed.class).toBe("update");
  });

  test("вне пояса похожести — new", () => {
    const v = classifyPair(
      { text: same, vector: vec(0) },
      { text: "Рецепт блинов: мука, яйца, молоко.", vector: vec(1) },
    );
    expect(v.class).toBe("new");
    expect(v.cos).toBeCloseTo(0, 6);
  });

  test("в поясе: маркер → update, отрицание → contradiction, числа → contradiction", () => {
    const upd = classifyPair(
      { text: "Таймаут вызова 1500 мс, детект однократный с кешем.", vector: vec(0) },
      { text: "Таймаут вызова пересмотрен: 3000 мс вместо 1500, детект однократный с кешем.", vector: vec(0) },
    );
    expect(upd.class).toBe("update");
    const contra = classifyPair(
      { text: "Перед вставкой ребра проверяем, что не образуется цикл.", vector: vec(0) },
      { text: "Перед вставкой ребра цикл не проверяем: обход слишком дорог.", vector: vec(0) },
    );
    expect(contra.class).toBe("contradiction");
    const numbers = classifyPair(
      { text: "Обход укладывается в 1–3 мс и не выводит выдачу за бюджет.", vector: vec(0) },
      { text: "Обход укладывается в 8–10 мс и не выводит выдачу за бюджет.", vector: vec(0) },
    );
    expect(numbers.class).toBe("contradiction");
    expect(numbers.reason).toContain("numbers diverged");
  });

  test("маркер без структурного сходства — не update: это другая задача", () => {
    const v = classifyPair(
      { text: "Команды задач: create, show, list, update, close, dep. Вывод как в спеке.", vector: vec(0) },
      { text: "viz теперь показывает номер версии схемы вместо 'v?' и не следует за хешем URL.", vector: vec(0) },
    );
    expect(v.class).not.toBe("update");
    expect(v.class).toBe("related");
  });

  test("новый текст содержит старый и длиннее — update без маркера", () => {
    const old = "Сценарий проходит и с установленным graft, и без него.";
    const v = classifyPair(
      { text: old, vector: vec(0) },
      { text: `${old} Проверяется на трёх репозиториях разного размера с замером доли восстановленных якорей.`, vector: vec(0) },
    );
    expect(v.class).toBe("update");
    expect(v.signals.coverage).toBeGreaterThanOrEqual(0.9);
  });

  test("тот же предмет, другое утверждение — related", () => {
    const v = classifyPair(
      { text: "myc models fetch скачивает модель один раз и проверяет sha256.", vector: vec(0) },
      { text: "myc models list печатает каталог моделей с размером и признаком «скачана».", vector: vec(0) },
    );
    expect(v.class).toBe("related");
  });
});

describe("classifyAbsorb — набор кандидатов", () => {
  const incoming: AbsorbText = {
    id: "n",
    text: "Таймаут вызова пересмотрен: 3000 мс вместо 1500, детект однократный с кешем.",
    vector: vec(0),
  };
  const cands: AbsorbText[] = [
    { id: "rel", text: "Детект graft однократный, кеш на 24 часа, адаптер только в фоне.", vector: vec(0) },
    { id: "old", text: "Таймаут вызова 1500 мс, детект однократный с кешем.", vector: vec(0) },
    { id: "far", text: "Рецепт блинов: мука, яйца, молоко.", vector: vec(1) },
    { id: "rel2", text: "Правило неудвоения: если graft подключён как MCP, myc не дублирует инструменты.", vector: vec(0) },
  ];

  test("сильнейший класс побеждает, остальные из пояса — в related", () => {
    const v = classifyAbsorb(incoming, cands);
    expect(v.class).toBe("update");
    expect(v.targetId).toBe("old");
    expect(v.related.map((r) => r.id).sort()).toEqual(["rel", "rel2"]);
    expect(v.considered).toBe(4);
    expect(v.quality).toBe("embedded");
  });

  test("max_related режет хвост, сам себя кандидат не видит", () => {
    const v = classifyAbsorb(incoming, [...cands, { ...incoming }], { ...T, max_related: 1 });
    expect(v.related.length).toBe(1);
    expect(v.considered).toBe(5);
  });

  test("без кандидатов — new; без вектора у входящего — quality lexical", () => {
    expect(classifyAbsorb(incoming, []).class).toBe("new");
    const v = classifyAbsorb({ ...incoming, vector: null }, cands);
    expect(v.quality).toBe("lexical");
    expect(["related", "new"]).toContain(v.class);
    expect(v.class).not.toBe("update");
  });

  test("dup побеждает update и related", () => {
    const v = classifyAbsorb(incoming, [
      ...cands,
      { id: "dup", text: `${incoming.text} `, vector: vec(0) },
    ]);
    expect(v.class).toBe("duplicate");
    expect(v.targetId).toBe("dup");
  });
});

describe("канонический дубликат", () => {
  test("ранний по created_at, затем больший confidence, затем меньший id", () => {
    expect(canonicalOf({ id: "b", createdAt: 1, confidence: 0.5 }, { id: "a", createdAt: 2, confidence: 1 })).toBe("b");
    expect(canonicalOf({ id: "b", createdAt: 1, confidence: 0.5 }, { id: "a", createdAt: 1, confidence: 0.9 })).toBe("a");
    expect(canonicalOf({ id: "b", createdAt: 1, confidence: 0.5 }, { id: "a", createdAt: 1, confidence: 0.5 })).toBe("a");
  });
});

describe("умолчания совпадают с замером", () => {
  test("DEFAULT_ABSORB_THRESHOLDS == bench/absorb-calibration.json, ложных duplicate там ноль", () => {
    const path = join(import.meta.dir, "..", "..", "..", "bench", "absorb-calibration.json");
    const report = JSON.parse(readFileSync(path, "utf8")) as {
      pairs: number;
      thresholds: typeof T;
      false_duplicate: number;
      false_update: number;
      matrix: Record<string, Record<string, number>>;
    };
    expect(report.thresholds).toEqual(T);
    expect(report.pairs).toBeGreaterThanOrEqual(60);
    expect(report.false_duplicate).toBe(0);
    expect(report.false_update).toBe(0);
    for (const c of ABSORB_CLASSES) expect(Object.keys(report.matrix[c]!)).toEqual([...ABSORB_CLASSES]);
  });
});

// ---------------------------------------------------------------------------
// Класс → ребро
// ---------------------------------------------------------------------------

function verdict(over: Partial<AbsorbVerdict> = {}): AbsorbVerdict {
  return {
    class: "contradiction",
    targetId: "myc-old",
    cos: 0.93,
    jac: 0.4,
    quality: "embedded",
    reason: "отрицание над тем же словом",
    related: [],
    considered: 1,
    ...over,
  };
}

describe("класс absorb пишется ребром (§6.2)", () => {
  test("у каждого класса, кроме new, есть своё ребро — и таблица покрывает все классы", () => {
    expect(Object.keys(ABSORB_EDGE).sort()).toEqual([...ABSORB_CLASSES].sort());
    expect(ABSORB_EDGE.duplicate).toBe("duplicates");
    expect(ABSORB_EDGE.update).toBe("supersedes");
    expect(ABSORB_EDGE.related).toBe("relates");
    expect(ABSORB_EDGE.new).toBeNull();
  });

  test("contradiction — это РЕБРО contradicts, а не пометка на узле", () => {
    // У memora противоречие только помечается и повисает без связи: вторую
    // сторону потом нечем найти. Одиннадцатый тип ребра заведён ровно под это.
    expect(absorbEdgeFor("contradiction")).toBe("contradicts");
    const edges = absorbEdges("myc-new", verdict());
    expect(edges).toEqual([
      { src: "myc-new", type: "contradicts", dst: "myc-old", weight: 0.93 },
    ]);
  });

  test("каждый класс с целью даёт ровно одно главное ребро", () => {
    for (const cls of ABSORB_CLASSES) {
      const edges = absorbEdges("myc-new", verdict({ class: cls, targetId: cls === "new" ? null : "myc-old" }));
      const main = edges.filter((e) => e.dst === "myc-old");
      expect(main).toHaveLength(cls === "new" ? 0 : 1);
      if (cls !== "new") expect(main[0]!.type).toBe(ABSORB_EDGE[cls]!);
    }
  });

  test("остальные кандидаты пояса становятся relates, цель не дублируется", () => {
    const edges = absorbEdges(
      "myc-new",
      verdict({
        related: [
          { id: "myc-old", weight: 0.9, cos: 0.9, jac: 0.4 },
          { id: "myc-x", weight: 0.87, cos: 0.87, jac: 0.3 },
          { id: "myc-new", weight: 0.99, cos: 0.99, jac: 0.9 },
        ],
      }),
    );
    expect(edges.map((e) => `${e.type} ${e.dst}`)).toEqual([
      "contradicts myc-old",
      "relates myc-x",
    ]);
  });

  test("вес ребра — косинус, без векторов жаккар, всегда в [0,1]", () => {
    expect(absorbEdges("myc-new", verdict({ cos: null, jac: 0.42 }))[0]!.weight).toBe(0.42);
    expect(absorbEdges("myc-new", verdict({ cos: 1.4 }))[0]!.weight).toBe(1);
    expect(absorbEdges("myc-new", verdict({ cos: -0.2, jac: 0 }))[0]!.weight).toBe(0);
  });

  test("класс new не пишет ничего", () => {
    expect(absorbEdges("myc-new", verdict({ class: "new", targetId: null }))).toEqual([]);
  });
});
