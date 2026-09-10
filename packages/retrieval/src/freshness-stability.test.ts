// Ограждение обещания продукта: ФОН НЕ ПЕРЕСТАВЛЯЕТ ВЫДАЧУ
// (memory-tf9rgg0rkp6h).
//
// ЧТО СЛУЧИЛОСЬ. Хвост дренажа после команды классифицирует заметки (absorb) и
// дописывает в узел служебный `attrs.absorb`. Любая запись поля двигает
// `nodes.updated_at` на wall-clock (queries.ts: `UPDATE nodes SET <col>=?2,
// updated_at=?3`). `updated_at` кормит freshness-множитель boost(d), и
// поскольку возраст считался НЕПРЕРЫВНО, в миллисекундах, под кривой с
// постоянной времени 90 суток, — сдвиг на 200 мс менял счёт в 11-м разряде.
// Этого хватало, чтобы переставить строки местами: две одинаково релевантные
// записи никогда не получали ТОЧНО равный score, поэтому детерминированный
// тайбрейк по id (hybrid.ts, `all.sort`) не срабатывал НИ РАЗУ.
//
// Наблюдаемо это выглядело так: два агента спросили одно и то же с разницей в
// секунду и получили разный порядок, а в выдаче не было ничего, что бы это
// объясняло. Комментарий в cli/src/index.ts при этом обещает прямо обратное —
// «дренаж — фон: он не меняет результат».
//
// ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. Не «freshness считается по формуле», а четыре
// свойства, каждое из которых ломается своей мутацией:
//
//  1. Возврат `Math.floor` к обычному делению в boostOf роняет тесты 1 и 3.
//  2. Обнуление кванта до 1 мс роняет их же.
//  3. Расширение кванта настолько, что тест 4 перестаёт видеть старение,
//     ловится тестом 4 — квант обязан выбрасывать шум, а не сам сигнал.
//  4. Тест 2 закрепляет НАБЛЮДАЕМЫЙ контракт «равный счёт — порядок по id», а
//     не конкретную строку кода. Честная оговорка: сегодня этот порядок дают
//     ДВА независимых места сразу — `GROUP BY node_id` в fts.ts отдаёт равные
//     ранги в порядке id, и тайбрейк в `all.sort` требует того же. Поэтому
//     снятие ОДНОГО из них этот корпус не двигает, и выдавать такую мутацию за
//     пойманную было бы враньём. Тест сторожит саму гарантию: если порядок при
//     равном счёте когда-нибудь станет зависеть от порядка строк SQLite, он
//     упадёт.

import { describe, expect, test } from "bun:test";
import { migration001Init, openSqlite } from "@myc/store-sqlite";
import type { FtsCaller } from "./fts.ts";
import {
  boostOf,
  DEFAULT_HYBRID_CONFIG,
  FRESHNESS_QUANTUM_MS,
  hybridSearch,
} from "./hybrid.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };
const NOW = Date.UTC(2026, 8, 7);
const BASE = { priority: 2, layer: 1 };

/**
 * Три ОДИНАКОВО релевантные заметки — тот же корпус, на котором ловилось
 * расхождение веба и CLI: текст различается одним словом, не входящим в
 * запрос, поэтому bm25 у всех трёх совпадает и порядок решают только бусты.
 */
/**
 * ИДЕНТИФИКАТОРЫ ПОДОБРАНЫ, А НЕ ВЗЯТЫ НАУГАД. При точном равенстве bm25 слой
 * fts выдаёт всем строкам ОДИН ранг (здесь ftsRank=1 у всех трёх) и отдаёт их
 * в порядке, обратном rowid. Значит, чтобы тест на тайбрейк вообще что-то
 * проверял, алфавитный порядок id обязан отличаться от этого естественного:
 * id здесь возрастают ВМЕСТЕ с порядком вставки, то есть обратны выдаче fts.
 * Со снятым тайбрейком `all.sort` оставит порядок fts (n-3, n-2, n-1) и тест
 * упадёт; с тайбрейком порядок будет n-1, n-2, n-3.
 */
const NOTES = [
  { id: "n-1-perv", title: "первая заметка про тестовое покрытие" },
  { id: "n-2-vtor", title: "вторая заметка про тестовое покрытие" },
  { id: "n-3-tret", title: "третья заметка про тестовое покрытие" },
] as const;

function corpus(updatedAt: readonly number[]): ReturnType<typeof openSqlite> {
  const db = openSqlite(":memory:");
  db.database.exec(migration001Init.sql);
  const insert = db.database.query(
    `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                        head_id, content_hash, acl, owner_id, team_id, agent_id,
                        created_at, updated_at)
     VALUES (?1, 'note', 1, 's1', ?2, ?2, '', 2, 'active', NULL, ?3, 'team', '', '', '', ?4, ?5)`,
  );
  NOTES.forEach((n, i) => {
    insert.run(n.id, n.title, `h-${n.id}`, updatedAt[i]!, updatedAt[i]!);
  });
  return db;
}

function search(db: ReturnType<typeof openSqlite>): { id: string; score: number }[] {
  return hybridSearch(db, {
    text: "тестовое покрытие",
    scopes: ["s1"],
    caller: ANON,
    limit: 3,
    now: NOW,
    vectorMode: "never",
  }).hits.map((h) => ({ id: h.id, score: h.score }));
}

/** Ровно то, что делает absorbOne в хвосте дренажа: двигает updated_at. */
function drainTouches(db: ReturnType<typeof openSqlite>, ids: readonly string[], at: number): void {
  const upd = db.database.query(`UPDATE nodes SET updated_at = ?2 WHERE id = ?1`);
  for (const id of ids) upd.run(id, at);
}

describe("фон не переставляет выдачу", () => {
  // -------------------------------------------------------------------------
  // 1. Главное свойство: служебная запись фона не меняет НИ ПОРЯДОК, НИ СЧЁТ
  // -------------------------------------------------------------------------
  test("absorb в хвосте дренажа двигает updated_at — выдача не шелохнулась", () => {
    // Записаны с разницей в десятки мс, как три `myc remember` подряд.
    const db = corpus([NOW - 240, NOW - 200, NOW - 160]);
    const before = search(db);
    expect(before).toHaveLength(3);

    // Дренаж догнал очередь и проставил absorb всем трём: updated_at уехал
    // вперёд, причём на РАЗНЫЕ величины — именно это и переставляло строки.
    drainTouches(db, ["n-1-perv"], NOW - 30);
    drainTouches(db, ["n-2-vtor"], NOW - 20);
    drainTouches(db, ["n-3-tret"], NOW - 10);
    const after = search(db);

    expect(after.map((h) => h.id)).toEqual(before.map((h) => h.id));
    // Точное равенство, а не toBeCloseTo: округление скрыло бы ровно тот
    // разряд, в котором расхождение и жило.
    expect(after.map((h) => h.score)).toEqual(before.map((h) => h.score));
    db.close();
  });

  test("частичный дренаж (успел один узел из трёх) — тоже не двигает выдачу", () => {
    // Бюджет дренажа 50 мс, поэтому обычный случай — разобрана ЧАСТЬ очереди.
    // Один тронутый узел из трёх это худший случай: он один уезжает вперёд.
    const db = corpus([NOW - 240, NOW - 200, NOW - 160]);
    const before = search(db);
    drainTouches(db, ["n-3-tret"], NOW);
    expect(search(db)).toEqual(before);
    db.close();
  });

  // -------------------------------------------------------------------------
  // 2. Почему это работает: счёт равен ТОЧНО, и порядок задаёт id
  // -------------------------------------------------------------------------
  test("равная релевантность даёт побитово равный счёт, порядок — по id", () => {
    const db = corpus([NOW - 240, NOW - 200, NOW - 160]);
    const hits = search(db);
    const scores = new Set(hits.map((h) => h.score));
    expect(scores.size).toBe(1); // один и тот же double на все три

    // Раз счёт равен точно — порядок обязан быть детерминированным по id.
    expect(hits.map((h) => h.id)).toEqual([...hits.map((h) => h.id)].sort());
    db.close();
  });

  test("boostOf: сдвиг updated_at внутри кванта не меняет буст ни на бит", () => {
    // Узел в СЕРЕДИНЕ своих суток (возраст 5.5 суток), чтобы сдвиг проверял
    // инвариантность, а не поведение на границе — граница проверяется ниже
    // отдельно и НАМЕРЕННО ведёт себя иначе.
    const at = NOW - 5 * FRESHNESS_QUANTUM_MS - FRESHNESS_QUANTUM_MS / 2;
    const base = boostOf({ ...BASE, updatedAt: at }, NOW, DEFAULT_HYBRID_CONFIG);
    for (const shift of [1, 200, 999, 60_000, 3_600_000]) {
      expect(boostOf({ ...BASE, updatedAt: at + shift }, NOW, DEFAULT_HYBRID_CONFIG)).toBe(base);
    }
  });

  test("граница кванта: возраст, перешагнувший сутки, буст МЕНЯЕТ — и это верно", () => {
    // Честная граница, а не умолчание о ней. Квант убирает фантомное
    // «постарение» от служебной записи, но не отменяет настоящего старения:
    // ровно на переходе через сутки буст обязан шагнуть вниз. Для узла это
    // случается один раз в сутки и означает реальное изменение возраста, а не
    // чужую фоновую запись.
    const day = FRESHNESS_QUANTUM_MS;
    const inside = boostOf({ ...BASE, updatedAt: NOW - (day - 1) }, NOW, DEFAULT_HYBRID_CONFIG);
    const crossed = boostOf({ ...BASE, updatedAt: NOW - day }, NOW, DEFAULT_HYBRID_CONFIG);
    expect(crossed).toBeLessThan(inside);
  });

  test("дрожание самого now между двумя вызовами не меняет буст", () => {
    // Вторая нестабильность той же природы: на НЕИЗМЕННОЙ базе два вызова
    // recall расходились в счёте только потому, что now разный.
    const at = NOW - 5 * FRESHNESS_QUANTUM_MS;
    const base = boostOf({ ...BASE, updatedAt: at }, NOW, DEFAULT_HYBRID_CONFIG);
    for (const dt of [1, 250, 5_000, 3_600_000]) {
      expect(boostOf({ ...BASE, updatedAt: at }, NOW + dt, DEFAULT_HYBRID_CONFIG)).toBe(base);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Квант выбрасывает шум, а не сигнал: старение по-прежнему работает
  // -------------------------------------------------------------------------
  test("свежесть не убита: сутки разницы по-прежнему опускают узел", () => {
    const fresh = boostOf({ ...BASE, updatedAt: NOW }, NOW, DEFAULT_HYBRID_CONFIG);
    const day = boostOf({ ...BASE, updatedAt: NOW - FRESHNESS_QUANTUM_MS }, NOW, DEFAULT_HYBRID_CONFIG);
    const year = boostOf({ ...BASE, updatedAt: NOW - 365 * FRESHNESS_QUANTUM_MS }, NOW, DEFAULT_HYBRID_CONFIG);
    expect(day).toBeLessThan(fresh);
    expect(year).toBeLessThan(day);

    // Монотонность на всём диапазоне, а не только на трёх точках.
    let prev = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= 400; d += 7) {
      const b = boostOf({ ...BASE, updatedAt: NOW - d * FRESHNESS_QUANTUM_MS }, NOW, DEFAULT_HYBRID_CONFIG);
      expect(b).toBeLessThan(prev);
      prev = b;
    }
  });

  test("узел, тронутый фоном, обгоняет ЗАМЕТНО более старый — квант не всесилен", () => {
    // Обратная сторона: если разница в возрасте настоящая (сутки и больше),
    // она обязана решать. Иначе квант съел бы сам буст.
    const db = corpus([NOW - 400 * FRESHNESS_QUANTUM_MS, NOW - 200, NOW - 160]);
    const hits = search(db);
    expect(hits[hits.length - 1]!.id).toBe("n-1-perv"); // самый старый — внизу
    expect(new Set(hits.map((h) => h.score)).size).toBe(2); // старый отделён
    db.close();
  });

  test("будущее updated_at (перекос часов) не даёт буст больше максимума", () => {
    const max = boostOf({ ...BASE, updatedAt: NOW }, NOW, DEFAULT_HYBRID_CONFIG);
    expect(boostOf({ ...BASE, updatedAt: NOW + 10 * FRESHNESS_QUANTUM_MS }, NOW, DEFAULT_HYBRID_CONFIG)).toBe(max);
  });
});
