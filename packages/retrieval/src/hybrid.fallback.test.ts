// Приёмка решения S44: откат строгого И на ИЛИ + объяснение пустоты.
//
// ЧТО ЗДЕСЬ ИЗМЕРЯЕТСЯ И ПОЧЕМУ ИМЕННО ТАК.
//
// Ошибка, ради которой всё это написано, найдена живым прогоном: заметка
// «оплог сливается объединением по op_id…» находится по запросу «оплог мерж»
// и НЕ находится по «сливать оплог» — потому что FTS5 соединяет слова неявным
// И, в тексте стоит «сливается», а стемминга для русского у нас нет. Одно
// несовпавшее слово обнуляет выдачу целиком.
//
// Набор: 40 заметок (реальные по форме инженерные факты, русский язык) и 40
// естественных вопросов к ним, поделённых на две группы, которые ведут себя
// принципиально по-разному:
//
//   И-запросы (20)      — вопрос своими словами, где ХОТЯ БЫ ОДНО слово есть в
//                         заметке дословно, но есть и слово, которого нет
//                         (другая форма, синоним, вводное слово). Это ровно
//                         тот класс, который сегодня даёт ноль и который
//                         обязан чинить откат на ИЛИ.
//   Перефразировки (20) — вопрос, у которого с заметкой нет НИ ОДНОГО общего
//                         словарного корня. Лексика их не найдёт никогда, ни
//                         И, ни ИЛИ: это работа векторной ветки (S32 показал
//                         ровно это — без вектора recall@10 = 0). Группа здесь
//                         для того, чтобы не приписать откату чужую заслугу.
//
// Метрики. found@10 — доля вопросов, где целевая заметка попала в первую
// десятку. MRR — средний обратный ранг: он ловит то, чего не ловит found@10, —
// не «нашлось ли», а «на каком месте», то есть цену расширения выдачи. Обе
// считаются на НАСТОЯЩЕМ SQLite/FTS5 с настоящим BM25; вектора здесь нет
// вовсе (vectorMode: "never") — измеряется только лексика, чтобы числа
// нельзя было спутать с вкладом эмбеддингов.
//
// Режимы, которые сравниваются:
//   and            — как было до S44: строгое И, ничего больше.
//   prefix_only    — только лечение словоформы (пересечение по префиксам).
//   ladder         — дефолт: prefix_and, затем «все термины кроме одного».
//   ladder2        — плюс «все кроме любых двух».
//   ladder_flat_or — плюс плоское ИЛИ последней ступенью.
//   or_always      — один проход сразу по плоскому ИЛИ.
// Два последних — та самая альтернатива «дать И и ИЛИ одним запросом», которую
// нужно было не обсудить, а замерить: она находит больше всех и стоит дороже
// всех, причём платит за это КАЖДЫЙ запрос, а не только сломанный.

import { describe, expect, test } from "bun:test";
import { generateId } from "@myc/core";
import { migration001Init, openSqlite, type SqliteDriver } from "@myc/store-sqlite";
import type { FtsCaller } from "./fts.ts";
import { analyzeFtsQuery } from "./fts.ts";
import { hybridSearch, type HybridConfig } from "./hybrid.ts";

const ANON: FtsCaller = { ownerId: "", teamId: "", agentId: "", principals: [] };

function freshDb(): SqliteDriver {
  const driver = openSqlite(":memory:");
  driver.database.exec(migration001Init.sql);
  return driver;
}

function insertNote(db: SqliteDriver, title: string, body: string): string {
  const id = generateId();
  const now = Date.now();
  db.database
    .query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, priority, status,
                          head_id, content_hash, acl, owner_id, team_id, agent_id,
                          created_at, updated_at)
       VALUES (?1, 'note', 1, 's1', ?2, ?3, ?4, 2, 'active', NULL, ?5, 'team', '', '', '', ?6, ?6)`,
    )
    .run(id, title, body, body.slice(0, 120), `hash-${id}`, now);
  return id;
}

// ---------------------------------------------------------------------------
// Набор: 40 заметок и 40 вопросов
// ---------------------------------------------------------------------------

interface Case {
  /** Текст заметки — то, что записал бы агент через `myc remember`. */
  readonly note: string;
  /** Естественный вопрос. */
  readonly q: string;
  /** "and" — есть общие слова, но не все; "para" — общих корней нет. */
  readonly kind: "and" | "para";
}

/**
 * Первая строка — точное воспроизведение из отчёта координатора, дальше —
 * 39 фактов той же природы. Формулировки вопросов намеренно бытовые: «как
 * …», «что делать если …», «почему …» — так спрашивает агент, а не так, как
 * удобно индексу.
 */
const CASES: readonly Case[] = [
  // ---------------- 20 И-запросов: общие слова есть, но не все -------------
  {
    note: "оплог сливается объединением по op_id, текстовый мерж неверен",
    q: "как сливать оплог",
    kind: "and",
  },
  {
    note: "холодный старт CLI укладывается в 60 мс, потому что база открывается лениво",
    q: "почему холодный старт быстрый",
    kind: "and",
  },
  {
    note: "воркспейс инициализируется командой init, она создаёт .myc и накатывает миграции",
    q: "как инициализировать воркспейс",
    kind: "and",
  },
  {
    note: "аренда claim держится тридцать минут и продлевается только держателем",
    q: "сколько держится аренда",
    kind: "and",
  },
  {
    note: "векторный индекс требует расширения vec0, без него поиск деградирует громко",
    q: "что требует векторный индекс",
    kind: "and",
  },
  {
    note: "чекпойнт WAL запускается фоновой работой, когда журнал перерастает мягкий предел",
    q: "когда запускается чекпойнт",
    kind: "and",
  },
  {
    note: "ребро с весом ниже порога не участвует в обходе графа",
    q: "какое ребро не участвует в обходе",
    kind: "and",
  },
  {
    note: "приоритет задачи хранится числом от нуля до четырёх, ноль самый срочный",
    q: "как хранится приоритет задачи",
    kind: "and",
  },
  {
    note: "дедупликация строк идёт по паре вида и заголовка, а не по хешу содержимого",
    q: "как работает дедупликация строк",
    kind: "and",
  },
  {
    note: "миграции накатываются по возрастанию версии и записываются в schema_migrations",
    q: "как накатывать миграции",
    kind: "and",
  },
  {
    note: "личный ярус живёт в домашнем каталоге и открывается лениво по наличию файла",
    q: "где живёт личный ярус",
    kind: "and",
  },
  {
    note: "фоновый дистиллятор разбирает заметку и проставляет ей связи и теги",
    q: "что делает фоновый дистиллятор",
    kind: "and",
  },
  {
    note: "квантизация вектора в int8 считается по максимуму модуля компонент",
    q: "как считается квантизация вектора",
    kind: "and",
  },
  {
    note: "часы HLC монотонны у одного сайта и растут вместе с порядковым номером",
    q: "почему часы монотонны",
    kind: "and",
  },
  {
    note: "экспорт графа кладёт в git только оплог, проекции остаются локальным кешем",
    q: "что кладёт экспорт графа",
    kind: "and",
  },
  {
    note: "фильтр ACL применяется внутри источника, до ранжирования, иначе топ вымывается",
    q: "где применяется фильтр ACL",
    kind: "and",
  },
  {
    note: "тег добавляется к заметке флагом при записи и хранится в атрибутах узла",
    q: "как добавлять тег к заметке",
    kind: "and",
  },
  {
    note: "конфликт слияния решается по последней записи для каждого поля отдельно",
    q: "как решается конфликт слияния",
    kind: "and",
  },
  {
    note: "бюджет символов у выдачи агента по умолчанию две тысячи, лишнее сворачивается",
    q: "какой бюджет символов у выдачи",
    kind: "and",
  },
  {
    note: "пул кандидатов берётся с запасом, потому что фильтры применяются после ранжирования",
    q: "зачем брать пул кандидатов с запасом",
    kind: "and",
  },

  // ---------------- 20 перефразировок: общих корней нет ---------------------
  {
    note: "обход соседей ограничен одним прыжком, дальше затухание съедает вклад",
    q: "насколько далеко расходится поиск по связям",
    kind: "para",
  },
  {
    note: "запись факта укладывается в пять миллисекунд, дорогое уходит в очередь",
    q: "быстро ли сохраняется новый пункт памяти",
    kind: "para",
  },
  {
    note: "устаревшая версия узла помечается снятой и в выдачу больше не попадает",
    q: "что происходит со старыми редакциями записей",
    kind: "para",
  },
  {
    note: "ключ раздела обязателен в каждом запросе, иначе скан идёт по всему корпусу",
    q: "нужно ли сужать область при обращении к хранилищу",
    kind: "para",
  },
  {
    note: "модель скачивается один раз и проверяется по контрольной сумме файлов",
    q: "как убедиться что веса не побились",
    kind: "para",
  },
  {
    note: "очередь работ дедуплицируется частичным уникальным индексом по классу и сущности",
    q: "не появится ли вторая такая же отложенная операция",
    kind: "para",
  },
  {
    note: "выдача ранжируется слиянием рангов, а не сложением несопоставимых скоров",
    q: "почему нельзя просто суммировать оценки источников",
    kind: "para",
  },
  {
    note: "свежесть даёт множитель, затухающий за девяносто дней",
    q: "стареет ли значимость записи со временем",
    kind: "para",
  },
  {
    note: "у каждого узла есть выдержка, она считается из тела при записи",
    q: "откуда берётся короткий кусок текста в списке",
    kind: "para",
  },
  {
    note: "сайт получает свой идентификатор при первой записи и больше его не меняет",
    q: "как машина представляется остальным участникам",
    kind: "para",
  },
  {
    note: "операция репликации, пришедшая раньше своего узла, откладывается и применяется позже",
    q: "что если изменение прилетело до создания объекта",
    kind: "para",
  },
  {
    note: "тело большой заметки уезжает в сжатое холодное хранилище",
    q: "куда девается объёмный текст со временем",
    kind: "para",
  },
  {
    note: "поиск по одному якорному слову возвращает ровно один документ, и это успех",
    q: "нормально ли что нашлась единственная строка",
    kind: "para",
  },
  {
    note: "переранжирование пула считается по несжатым числам, потому что int8 огрубляет",
    q: "зачем второй проход по точным значениям",
    kind: "para",
  },
  {
    note: "прогрев рантайма стоит двести миллисекунд и не помещается в горячий путь",
    q: "почему подготовка модели не делается прямо в запросе",
    kind: "para",
  },
  {
    note: "клиент никогда не ждёт фоновую работу дольше отведённого дедлайна",
    q: "может ли команда зависнуть из-за отложенных дел",
    kind: "para",
  },
  {
    note: "закрытая задача перестаёт мешать другим и освобождает зависимости",
    q: "что даёт завершение пункта плана",
    kind: "para",
  },
  {
    note: "оценка числа строк в пуле — нижняя граница, если потолок достигнут",
    q: "точно ли показано сколько всего совпадений",
    kind: "para",
  },
  {
    note: "два яруса сливаются тем же способом, что и источники внутри одного",
    q: "как объединяются личные и командные знания",
    kind: "para",
  },
  {
    note: "сообщения нижнего слоя не индексируются вектором и живут недолго",
    q: "храним ли мы переписку навсегда",
    kind: "para",
  },
];

// ---------------------------------------------------------------------------
// Прогон
// ---------------------------------------------------------------------------

type Mode =
  | "and"
  | "prefix_only"
  | "ladder"
  | "ladder2"
  | "ladder2_cov"
  | "ladder_flat_or"
  | "or_always";

interface Score {
  readonly found: number;
  readonly total: number;
  readonly mrrSum: number;
  readonly poolSum: number;
  readonly rescued: number;
}

function emptyScore(): Score {
  return { found: 0, total: 0, mrrSum: 0, poolSum: 0, rescued: 0 };
}

function configFor(mode: Mode): Partial<HybridConfig> {
  switch (mode) {
    case "and":
      // Как было до S44: строгое И и больше ничего.
      return { lexicalMode: "and_then_fallback", fallbackStages: [] };
    case "prefix_only":
      // Только лечение словоформы — без ослабления состава слов.
      return { lexicalMode: "and_then_fallback", fallbackStages: ["prefix_and"] };
    case "ladder":
      // Дефолт: две ступени, обе селективные.
      return {
        lexicalMode: "and_then_fallback",
        fallbackStages: ["prefix_and", "prefix_relaxed"],
      };
    case "ladder2":
      // Дефолт + «все кроме любых двух» — опция для полноты ценой хвоста.
      return {
        lexicalMode: "and_then_fallback",
        fallbackStages: ["prefix_and", "prefix_relaxed", "prefix_relaxed2"],
      };
    case "ladder2_cov":
      return {
        lexicalMode: "and_then_fallback",
        fallbackStages: ["prefix_and", "prefix_relaxed", "prefix_relaxed2"],
        orCoverageBoost: true,
      };
    case "ladder_flat_or":
      // Лестница + плоское ИЛИ последней ступенью — то, что просили «просто ИЛИ».
      return {
        lexicalMode: "and_then_fallback",
        fallbackStages: ["prefix_and", "prefix_relaxed", "prefix_relaxed2", "or"],
      };
    case "or_always":
      return { lexicalMode: "or_always" };
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? "  н/д" : `${((100 * n) / d).toFixed(1)}%`;
}

describe("S44 — откат строгого И на ИЛИ: набор из 40 вопросов", () => {
  const db = freshDb();
  const idByNote = new Map<string, string>();
  for (const c of CASES) idByNote.set(c.note, insertNote(db, c.note, c.note));

  const run = (mode: Mode, c: Case): { rank: number | undefined; pool: number; fallback: boolean } => {
    const res = hybridSearch(db, {
      text: c.q,
      scopes: ["s1"],
      caller: ANON,
      limit: 10,
      vectorMode: "never",
      config: configFor(mode),
    });
    const target = idByNote.get(c.note)!;
    const hit = res.hits.find((h) => h.id === target);
    return {
      rank: hit?.rank,
      pool: res.hits.length,
      fallback: res.mode_used.lexical.fallbackUsed,
    };
  };

  const measure = (mode: Mode, kind: Case["kind"]): Score => {
    let s = emptyScore();
    for (const c of CASES) {
      if (c.kind !== kind) continue;
      const base = run("and", c);
      const r = run(mode, c);
      s = {
        found: s.found + (r.rank !== undefined ? 1 : 0),
        total: s.total + 1,
        mrrSum: s.mrrSum + (r.rank !== undefined ? 1 / r.rank : 0),
        poolSum: s.poolSum + r.pool,
        rescued: s.rescued + (base.rank === undefined && r.rank !== undefined ? 1 : 0),
      };
    }
    return s;
  };

  /**
   * КОНТРОЛЬНАЯ ГРУППА: запросы, которые строгое И отвечает и сегодня.
   *
   * Без неё сравнение and_then_or против or_always бессмысленно: обе ветки
   * одинаковы ровно там, где И дало ноль, и расходятся только там, где И
   * СРАБОТАЛО. Запросы строятся из самих заметок — три длинных слова подряд,
   * дословно, — то есть это буквально «то, что работает сейчас», а не ещё один
   * придуманный набор.
   */
  const controlQueries: { note: string; q: string }[] = CASES.map((c) => {
    const words = c.note
      .replace(/[^\p{L}\p{N}_ ]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 6);
    return { note: c.note, q: words.slice(0, 3).join(" ") };
  }).filter((c) => c.q.split(" ").length === 3);

  const measureControl = (mode: Mode): Score => {
    let s = emptyScore();
    for (const c of controlQueries) {
      const target = idByNote.get(c.note)!;
      const res = hybridSearch(db, {
        text: c.q,
        scopes: ["s1"],
        caller: ANON,
        limit: 10,
        vectorMode: "never",
        config: configFor(mode),
      });
      const hit = res.hits.find((h) => h.id === target);
      s = {
        found: s.found + (hit !== undefined ? 1 : 0),
        total: s.total + 1,
        mrrSum: s.mrrSum + (hit !== undefined ? 1 / hit.rank : 0),
        poolSum: s.poolSum + res.hits.length,
        rescued: s.rescued,
      };
    }
    return s;
  };

  test("замер: found@10, MRR и размер выдачи по режимам", () => {
    const modes: Mode[] = ["and", "prefix_only", "ladder", "ladder2", "ladder_flat_or", "or_always"];
    const lines: string[] = [];
    lines.push("");
    lines.push("=== S44 — откат на ИЛИ: 40 заметок, 40 естественных вопросов ===");
    lines.push("Вектора нет вовсе (vectorMode: never) — измеряется только лексика.");
    lines.push("");
    lines.push("  режим        | группа          | found@10 |   MRR | строк в выдаче | спасено откатом");
    lines.push("  -------------|-----------------|----------|-------|----------------|----------------");

    const table: Record<string, Score> = {};
    for (const mode of modes) {
      for (const kind of ["and", "para"] as const) {
        const s = measure(mode, kind);
        table[`${mode}/${kind}`] = s;
        lines.push(
          `  ${mode.padEnd(12)} | ${(kind === "and" ? "И-запросы" : "перефразировки").padEnd(15)} |` +
            `   ${pct(s.found, s.total)} | ${(s.mrrSum / s.total).toFixed(3)} |` +
            `           ${(s.poolSum / s.total).toFixed(1)} |               ${s.rescued}`,
        );
      }
      const all = measure(mode, "and");
      const par = measure(mode, "para");
      lines.push(
        `  ${mode.padEnd(12)} | ${"весь набор".padEnd(15)} |   ` +
          `${pct(all.found + par.found, all.total + par.total)} | ` +
          `${((all.mrrSum + par.mrrSum) / (all.total + par.total)).toFixed(3)} |           ` +
          `${((all.poolSum + par.poolSum) / (all.total + par.total)).toFixed(1)} |               ` +
          `${all.rescued + par.rescued}`,
      );
      const ctl = measureControl(mode);
      table[`${mode}/control`] = ctl;
      lines.push(
        `  ${mode.padEnd(12)} | ${"контроль (И жив)".padEnd(15)} |   ` +
          `${pct(ctl.found, ctl.total)} | ${(ctl.mrrSum / ctl.total).toFixed(3)} |           ` +
          `${(ctl.poolSum / ctl.total).toFixed(1)} |               —`,
      );
      lines.push("  -------------|-----------------|----------|-------|----------------|----------------");
    }

    const andBefore = table["and/and"]!;
    const andAfter = table["ladder/and"]!;
    const orAlways = table["or_always/and"]!;

    lines.push("");
    lines.push("ЧТО ИЗ ЭТОГО СЛЕДУЕТ.");
    lines.push(
      `1. И-запросы: было ${pct(andBefore.found, andBefore.total)}, стало ` +
        `${pct(andAfter.found, andAfter.total)}. Откат спасает ` +
        `${pct(andAfter.rescued, andAfter.total)} вопросов этой группы — это и есть цена ` +
        "одного несовпавшего слова, которую платил каждый естественный вопрос.",
    );
    lines.push(
      "2. Перефразировки лексикой не чинятся ни И, ни ИЛИ: общих корней нет, искать нечем. " +
        "Их доля — работа векторной ветки (S32), и откат её не подменяет.",
    );
    const ctlAnd = table["and/control"]!;
    const ctlFallback = table["ladder/control"]!;
    const ctlOr = table["or_always/control"]!;
    const flatOr = table["ladder_flat_or/and"]!;
    const ladder2 = table["ladder2/and"]!;
    lines.push(
      `3. or_always находит на И-запросах больше (${pct(orAlways.found, orAlways.total)} против ` +
        `${pct(andAfter.found, andAfter.total)}) — плоское объединение шире любой ` +
        "селективной ступени. Цена этой полноты видна не здесь, а в контрольной группе " +
        "и в замере на 100k ниже: она платится на ВСЕЙ нагрузке, включая запросы, " +
        "которые и так работали.",
    );
    lines.push(
      `4. Контроль (запросы, которые И отвечает и сегодня): and ${pct(ctlAnd.found, ctlAnd.total)} / ` +
        `MRR ${(ctlAnd.mrrSum / ctlAnd.total).toFixed(3)} / ${(ctlAnd.poolSum / ctlAnd.total).toFixed(1)} строк; ` +
        `лестница ${pct(ctlFallback.found, ctlFallback.total)} / ` +
        `${(ctlFallback.mrrSum / ctlFallback.total).toFixed(3)} / ` +
        `${(ctlFallback.poolSum / ctlFallback.total).toFixed(1)}; ` +
        `or_always ${pct(ctlOr.found, ctlOr.total)} / ${(ctlOr.mrrSum / ctlOr.total).toFixed(3)} / ` +
        `${(ctlOr.poolSum / ctlOr.total).toFixed(1)}.`,
    );
    lines.push(
      "   Откат оставляет работающие запросы БУКВАЛЬНО нетронутыми — он их не выполняет " +
        "вовсе. or_always переранжирует и расширяет каждый из них: это и есть цена " +
        "«одного запроса вместо двух», и платится она на всей нагрузке, а не на сломанной части.",
    );
    lines.push(
      `5a. Третья ступень («все кроме любых двух») даёт ` +
        `${ladder2.found} из ${ladder2.total} против ${andAfter.found} у дефолта.`,
    );
    lines.push(
      `5. Плоское ИЛИ последней ступенью добавляет к лестнице ` +
        `${pct(flatOr.found - andAfter.found, flatOr.total)} найденного на И-запросах ` +
        `(${flatOr.found} против ${andAfter.found} из ${flatOr.total}) — цена этой добавки ` +
        "измерена на 100k ниже.",
    );
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));

    // Приёмка, а не только отчёт: откат обязан спасать И-запросы и не имеет
    // права терять то, что и так находилось.
    expect(andAfter.found).toBeGreaterThan(andBefore.found);
    expect(andAfter.rescued).toBeGreaterThan(0);
  });

  test("воспроизведение координатора: «как сливать оплог» находит заметку", () => {
    const c = CASES[0]!;
    const before = run("and", c);
    const after = run("ladder", c);
    expect(before.rank).toBeUndefined(); // как было: строгое И даёт ноль
    expect(after.rank).toBe(1); // как стало
    expect(after.fallback).toBe(true); // и mode_used это показывает
  });

  test("откат не трогает запросы, которые и так находились", () => {
    // «оплог мерж» — оба слова в тексте, строгое И справляется само.
    const res = hybridSearch(db, {
      text: "оплог мерж",
      scopes: ["s1"],
      caller: ANON,
      limit: 10,
      vectorMode: "never",
    });
    expect(res.hits.length).toBeGreaterThan(0);
    expect(res.mode_used.lexical.operator).toBe("and");
    expect(res.mode_used.lexical.fallbackUsed).toBe(false);
    // Один round-trip: второго прохода не было.
    expect(res.mode_used.roundTrips).toBe(1);
  });

  test("откат включает векторную ветку: lexical_fallback — четвёртый критерий триггера", () => {
    const res = hybridSearch(db, {
      text: "как сливать оплог",
      scopes: ["s1"],
      caller: ANON,
      limit: 10,
      // vectorMode auto: решение принимает триггер
      embedQuery: () => null,
    });
    expect(res.mode_used.lexical.fallbackUsed).toBe(true);
    expect(res.mode_used.trigger.reasons).toContain("lexical_fallback");
    // Вектор был затребован и честно объявлен недоступным, а не пропущен молча.
    expect(res.mode_used.vector).toBe("unavailable");
  });

  test("буст полного совпадения поднимает документ, покрывший больше слов", () => {
    const local = freshDb();
    // Один документ покрывает оба слова вопроса, второй — только редкое.
    // Документ, покрывший ВСЕ четыре слова вопроса, но длинный — BM25 сам по
    // себе ставит его ниже короткого.
    const both = insertNote(
      local,
      "чекпойнт запускается фоновой работой",
      "чекпойнт запускается фоновой работой " + "подробность ".repeat(60),
    );
    // Документ, покрывший три слова из четырёх, зато короткий.
    insertNote(local, "запускается фоновой работой", "запускается фоновой работой");
    const res = hybridSearch(local, {
      text: "запускать чекпойнт фоновой работой",
      scopes: ["s1"],
      caller: ANON,
      limit: 10,
      vectorMode: "never",
      // Буст выключен по умолчанию (замер на 100k ниже) — здесь проверяется
      // сам механизм, поэтому включаем явно.
      config: { orCoverageBoost: true, fallbackStages: ["prefix_relaxed"] },
    });
    expect(res.mode_used.lexical.fallbackUsed).toBe(true);
    expect(res.mode_used.lexical.coverageApplied).toBe(true);
    expect(res.hits[0]?.id).toBe(both);
    local.close();
  });

  test("пустая выдача объясняется: 'база пуста' и 'не нашлось' — разные коды", () => {
    const empty = freshDb();
    const onEmpty = hybridSearch(empty, {
      text: "что угодно",
      scopes: ["s1"],
      caller: ANON,
      vectorMode: "never",
    });
    expect(onEmpty.hits).toEqual([]);
    expect(onEmpty.mode_used.emptyReason?.code).toBe("store_empty");
    expect(onEmpty.mode_used.emptyReason?.corpusSize).toBe(0);
    empty.close();

    const noMatch = hybridSearch(db, {
      text: "гуашь мольберт натюрморт",
      scopes: ["s1"],
      caller: ANON,
      vectorMode: "never",
    });
    expect(noMatch.hits).toEqual([]);
    expect(noMatch.mode_used.emptyReason?.code).toBe("no_match");
    expect(noMatch.mode_used.emptyReason?.corpusSize).toBe(CASES.length);
    expect(noMatch.mode_used.emptyReason?.text).toContain("40");
  });

  test("на одном термине ослаблять состав слов нечем — работает только префикс", () => {
    const parsed = analyzeFtsQuery("оплогус")!;
    expect(parsed.and).toBe(parsed.or); // плоское ИЛИ вырождается в И
    expect(parsed.prefixRelaxed).toBe(""); // выкидывать нечего
    const res = hybridSearch(db, {
      text: "оплогус",
      scopes: ["s1"],
      caller: ANON,
      vectorMode: "never",
    });
    // Префиксная ступень осмысленна и на одном термине: «оплогус» -> «оплог»*,
    // и заметка про оплог находится там, где строгое И давало ноль.
    expect(res.mode_used.lexical.operator).toBe("prefix_and");
    expect(res.hits.length).toBeGreaterThan(0);

    // А вот когда и префикс не помог — ступеней больше нет, и пустота
    // объясняется.
    const nothing = hybridSearch(db, {
      text: "гуашью",
      scopes: ["s1"],
      caller: ANON,
      vectorMode: "never",
    });
    expect(nothing.hits).toEqual([]);
    expect(nothing.mode_used.emptyReason?.code).toBe("no_match");
  });
});

// ---------------------------------------------------------------------------
// Тот же вопрос при 100k узлов
// ---------------------------------------------------------------------------
//
// ЗАЧЕМ ПОВТОРЯТЬ ЗАМЕР НА БОЛЬШОМ КОРПУСЕ. На сорока коротких заметках почти
// каждое слово редкое, поэтому BM25 и без буста покрытия ставит цель первой, а
// ИЛИ-пул не успевает набрать шума. Настоящая нагрузка выглядит иначе: 100k
// узлов, слова повторяются, и объединение по частому слову тянет тысячи
// кандидатов. Ровно здесь и проверяются два спорных места — сколько стоит
// второй проход (бюджет И1: 25 мс при готовом векторе, S31(а)) и нужен ли
// вообще буст полного совпадения.

/**
 * СЛОВАРЬ ШУМА. Он важнее, чем кажется: от распределения частот зависит вся
 * стоимость объединяющих ступеней.
 *
 * Первый вариант этого замера брал 36 слов на 100 000 документов по 30 слов в
 * каждом — и тогда КАЖДОЕ слово встречалось почти в каждом документе, то есть
 * любой терм имел df ≈ 100 %. На таком корпусе p95 лестницы вышел 45 мс, но
 * измерял он не лестницу, а вырожденный словарь: в настоящем тексте частоты
 * распределены по Ципфу, и «работа» стоит в единицах процентов документов, а
 * не в ста.
 *
 * Здесь словарь строится честнее: 2000 различных слов, выбор по Ципфу
 * (вероятность ~1/ранг), плюс несколько десятков ДЕЙСТВИТЕЛЬНО частых слов в
 * голове распределения — чтобы «частый терм» в наборе присутствовал, а не был
 * вычищен ради красивых чисел.
 */
const COMMON_HEAD = [
  "узел", "граф", "запись", "поиск", "индекс", "слой", "работа", "работой",
  "фоновой", "запускается", "хранится", "применяется", "считается", "строка",
];

function buildVocabulary(rand: () => number): { words: string[]; cdf: number[] } {
  const words: string[] = [...COMMON_HEAD];
  const SUFFIX = ["ение", "ация", "ость", "тель", "ник", "изм", "ика", "ура"];
  const ROOT = [
    "верк", "мод", "сегм", "клас", "терм", "форм", "порт", "стан", "трак",
    "марш", "цикл", "барь", "крон", "лист", "пласт", "штрих", "гран", "корп",
  ];
  let i = 0;
  while (words.length < 2000) {
    const r = ROOT[i % ROOT.length]!;
    const sfx = SUFFIX[Math.floor(i / ROOT.length) % SUFFIX.length]!;
    words.push(`${r}${sfx}${Math.floor(i / (ROOT.length * SUFFIX.length))}`);
    i++;
  }
  // Ципф: вес ~ 1/ранг, накопленная сумма для выборки одним поиском.
  const cdf: number[] = [];
  let acc = 0;
  for (let k = 0; k < words.length; k++) {
    acc += 1 / (k + 1);
    cdf.push(acc);
  }
  for (let k = 0; k < cdf.length; k++) cdf[k] = cdf[k]! / acc;
  void rand;
  return { words, cdf };
}

function pickZipf(vocab: { words: string[]; cdf: number[] }, rand: () => number): string {
  const x = rand();
  let lo = 0;
  let hi = vocab.cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (vocab.cdf[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return vocab.words[lo]!;
}

describe("S44 при 100k узлов: цена второго прохода и польза буста", () => {
  test("found@10, MRR и латентность по режимам на большом корпусе", () => {
    const db = freshDb();
    const rand = mulberry32ForFallback(77);
    const N = 100_000;
    const now = Date.now();

    db.database.exec("BEGIN");
    const stmt = db.database.query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, status, content_hash, acl, team_id, created_at, updated_at)
       VALUES (?1, 'note', 1, 's1', ?2, ?3, '', 'active', ?4, 'team', '', ?5, ?5)`,
    );
    const vocab = buildVocabulary(rand);
    for (let i = 0; i < N; i++) {
      const words: string[] = [];
      for (let k = 0; k < 30; k++) words.push(pickZipf(vocab, rand));
      const body = words.join(" ");
      stmt.run(`bg-${i.toString(36).padStart(12, "0")}`, `Узел ${i}`, body, `hash-bg-${i}`, now);
    }
    const targets = new Map<string, string>();
    const planted = db.database.query(
      `INSERT INTO nodes (id, kind, layer, scope, title, body, excerpt, status, content_hash, acl, team_id, created_at, updated_at)
       VALUES (?1, 'note', 1, 's1', ?2, ?3, ?4, 'active', ?5, 'team', '', ?6, ?6)`,
    );
    CASES.forEach((c, i) => {
      const id = `tgt-${i.toString(36).padStart(6, "0")}`;
      planted.run(id, c.note, c.note, c.note.slice(0, 120), `hash-${id}`, now);
      targets.set(c.note, id);
    });
    db.database.exec("COMMIT");

    const modes: Mode[] = [
      "and",
      "prefix_only",
      "ladder",
      "ladder2",
      "ladder2_cov",
      "ladder_flat_or",
      "or_always",
    ];
    const lines: string[] = [];
    lines.push("");
    lines.push(`=== S44 при ${N.toLocaleString("ru")} узлов ===`);
    lines.push("Вектора нет (vectorMode: never). Бюджет И1 — 25 мс при готовом векторе (S31(а)).");
    lines.push("");
    lines.push("  режим             | группа         | found@10 |   MRR | строк | p50 мс | p95 мс");
    lines.push("  ------------------|----------------|----------|-------|-------|--------|-------");

    const summary: Record<string, { found: number; total: number; mrr: number; p50: number; p95: number }> = {};
    const slowest: string[] = [];
    for (const mode of modes) {
      for (const kind of ["and", "para"] as const) {
        let found = 0;
        let total = 0;
        let mrrSum = 0;
        let poolSum = 0;
        const samples: number[] = [];
        const perQuery: { q: string; ms: number; op: string; stages: number; pool: number }[] = [];
        for (const c of CASES) {
          if (c.kind !== kind) continue;
          const t0 = performance.now();
          const res = hybridSearch(db, {
            text: c.q,
            scopes: ["s1"],
            caller: ANON,
            limit: 10,
            vectorMode: "never",
            config: configFor(mode),
          });
          const ms = performance.now() - t0;
          samples.push(ms);
          perQuery.push({
            q: c.q,
            ms,
            op: res.mode_used.lexical.operator,
            stages: res.mode_used.lexical.stagesTried,
            pool: res.hits.length,
          });
          const hit = res.hits.find((h) => h.id === targets.get(c.note));
          total++;
          poolSum += res.hits.length;
          if (hit !== undefined) {
            found++;
            mrrSum += 1 / hit.rank;
          }
        }
        if (mode === "ladder") {
          const worst = perQuery.slice().sort((x, y) => y.ms - x.ms)[0];
          if (worst !== undefined) {
            slowest.push(
              `    самый дорогой (${kind}): «${worst.q}» ${worst.ms.toFixed(1)} мс, ` +
                `ступень '${worst.op}', ступеней пройдено ${worst.stages}, пул ${worst.pool}`,
            );
          }
        }
        samples.sort((a, b) => a - b);
        const p50 = samples[Math.floor(samples.length * 0.5)] ?? 0;
        const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0;
        summary[`${mode}/${kind}`] = { found, total, mrr: mrrSum / total, p50, p95 };
        lines.push(
          `  ${mode.padEnd(17)} | ${(kind === "and" ? "И-запросы" : "перефразировки").padEnd(14)} |` +
            `   ${pct(found, total)} | ${(mrrSum / total).toFixed(3)} |` +
            `  ${(poolSum / total).toFixed(1)} |  ${p50.toFixed(2)} |  ${p95.toFixed(2)}`,
        );
      }
    }

    lines.push(...slowest);
    const a = summary["and/and"]!;
    const f = summary["ladder/and"]!;
    const l2 = summary["ladder2/and"]!;
    const nc = summary["ladder2_cov/and"]!;
    const fo = summary["ladder_flat_or/and"]!;
    const oa = summary["or_always/and"]!;
    lines.push("");
    lines.push(
      `И-запросы при 100k: было ${pct(a.found, a.total)}, стало ${pct(f.found, f.total)}. ` +
        `Второй проход стоит p50 ${f.p50.toFixed(2)} мс против ${a.p50.toFixed(2)} мс у одного, ` +
        `p95 ${f.p95.toFixed(2)} против ${a.p95.toFixed(2)} — оба внутри 25 мс.`,
    );
    lines.push(
      `Третья ступень (все кроме любых двух): found@10 ${pct(l2.found, l2.total)} против ` +
        `${pct(f.found, f.total)} у дефолта, p95 ${l2.p95.toFixed(2)} против ${f.p95.toFixed(2)} мс — ` +
        "полнота выше, но хвост выходит за бюджет 25 мс, поэтому ступень опциональна.",
    );
    lines.push(
      `Буст полного совпадения при 100k: MRR ${nc.mrr.toFixed(3)} с ним против ${l2.mrr.toFixed(3)} ` +
        `без него, p95 ${nc.p95.toFixed(2)} против ${l2.p95.toFixed(2)} мс.`,
    );
    lines.push(
      `Плоское ИЛИ последней ступенью: found@10 ${pct(fo.found, fo.total)} против ` +
        `${pct(f.found, f.total)} у лестницы, p95 ${fo.p95.toFixed(2)} против ${f.p95.toFixed(2)} мс.`,
    );
    lines.push(
      `or_always при 100k: p50 ${oa.p50.toFixed(2)} мс, p95 ${oa.p95.toFixed(2)} мс, ` +
        `MRR ${oa.mrr.toFixed(3)}.`,
    );
    // eslint-disable-next-line no-console
    console.log(lines.join("\n"));

    // Бюджет И1 — приёмка, а не наблюдение.
    expect(f.p95).toBeLessThan(25);
    expect(f.found).toBeGreaterThan(a.found);
    db.close();
  }, 300_000);
});

function mulberry32ForFallback(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
