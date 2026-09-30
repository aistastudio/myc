// Лексический поиск по nodes_fts (FTS5, BM25). Схема и триггеры синхронизации
// живут в packages/store-sqlite/src/migrations/001-init.ts — этот модуль
// только запросы поверх готовой таблицы. Контракт {id, rank} — то, что ждёт
// будущий гибридный ретривал (myc-7yk, docs/design/02-retrieval-and-performance.md §2.2):
// rank — целочисленная позиция (1 = лучший), не сырой bm25-скор, потому что
// RRF комбинирует источники по рангу, а не по несопоставимым шкалам скоров.

import {
  defineQueries,
  historyClause,
  toPgDialectJsonb,
  type DbDriver,
  type Dialect,
  type Layer,
} from "@myc/core";
import { liveStatusPredicate, notPendingClause } from "./review.ts";

export interface FtsSearchHit {
  readonly id: string;
  readonly rank: number;
}

/**
 * Личность вызывающего для ACL-фильтра. Повторяет колонки nodes (owner_id,
 * team_id, agent_id) и acl_grants.principal (docs/design/01-core-data-model.md
 * §8.1.2, §8.1.9). Пустая строка в ownerId/teamId/agentId — намеренно валидное
 * значение: так же выглядит default колонки для узлов, у которых поле не
 * заполнено, поэтому анонимный вызывающий видит только такие же анонимные узлы.
 */
export interface FtsCaller {
  readonly ownerId: string;
  readonly teamId: string;
  readonly agentId: string;
  readonly principals: readonly string[];
}

export interface FtsSearchParams {
  readonly text: string;
  readonly scopes: readonly string[];
  readonly layerMin?: Layer;
  readonly layerMax?: Layer;
  readonly caller: FtsCaller;
  readonly limit?: number;
}

const DEFAULT_LIMIT = 12;
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_LIMIT);
}

export const ftsQueries = defineQueries({
  ftsSearch: {
    name: "ftsSearch",
    // Фильтры — внутри CTE источника, до ранжирования (§2.2: иначе top-N
    // источника вымывается фильтром уже после отбора). head_id IS NULL и
    // liveStatusPredicate убирают старые версии и снятые с учёта узлы —
    // заменённые, отозванные, отменённые (HIDDEN_STATUSES, ./review.ts),
    // notPendingClause — кандидатов на подтверждение (./review.ts, §6.2);
    // GROUP BY node_id страхует от дублей, если строка nodes_fts когда-либо
    // окажется не 1:1 с rowid узла.
    sql: `
      WITH matches AS (
        SELECT n.id AS node_id,
               bm25(nodes_fts, 10.0, 1.0, 1.0) AS bm25_score
        FROM nodes_fts f
        JOIN nodes n ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ?1
          AND n.deleted_at IS NULL
         ${historyClause("follow")}
          AND ${liveStatusPredicate("n")}
          AND n.scope IN (SELECT value FROM json_each(?2))
          AND n.layer BETWEEN ?3 AND ?4
          AND (
            (n.acl = 'private' AND n.owner_id = ?5)
            OR (n.acl = 'team' AND n.team_id = ?6)
            OR (n.acl = 'agent' AND n.agent_id = ?7)
            OR (n.acl = 'restricted' AND EXISTS (
                  SELECT 1 FROM acl_grants g
                  WHERE g.node_id = n.id
                    AND g.principal IN (SELECT value FROM json_each(?8))
                ))
          )${notPendingClause("n")}
      ),
      ranked AS (
        SELECT node_id, RANK() OVER (ORDER BY bm25_score ASC) AS r
        FROM matches
      )
      SELECT node_id AS id, MIN(r) AS rank
      FROM ranked
      GROUP BY node_id
      ORDER BY rank ASC
      LIMIT ?9
    `,
    // POSTGRES: та же выдача, другой источник лексики.
    //
    // Отдельный текст, а не механический перевод, потому что расходится
    // само устройство: в SQLite полнотекст — ОТДЕЛЬНАЯ таблица FTS5, к
    // которой присоединяются по rowid; в Postgres это КОЛОНКА `tsv`
    // (generated, GIN-индекс `ix_nodes_tsv`), и присоединяться не к чему.
    //
    // РАНГ — ПОЗИЦИЯ, А НЕ СКОР, и только поэтому две базы сравнимы.
    // `bm25()` растёт вниз (лучшее — самое отрицательное), `ts_rank_cd()` —
    // вверх; равенства чисел не будет никогда и не требуется (§8.3: «разные
    // тексты, наружу одинаковый {id, rank}»). Одинаковым обязан быть
    // ПОРЯДОК, поэтому здесь `DESC`, а там `ASC`.
    //
    // Веса колонок повторяют bm25(nodes_fts, 10.0, 1.0, 1.0): заголовок
    // весит десятикратно против тела. В tsvector это метки A (title) и B
    // (body), а массив ts_rank_cd задаёт их как {D,C,B,A} — отсюда
    // {0.1, 0.2, 0.1, 1.0}, то есть A:B = 10:1.
    //
    // `::int` у ранга обязателен: BIGINT приходит из Postgres СТРОКОЙ, а
    // контракт FtsSearchHit.rank — число. Без приведения расхождение
    // всплыло бы не здесь, а у того, кто сравнит ранги.
    pg: toPgDialectJsonb(
      `
      WITH matches AS (
        SELECT n.id AS node_id,
               ts_rank_cd('{0.1, 0.2, 0.1, 1.0}', n.tsv, q.query) AS score
        FROM to_tsquery('simple', ?1) AS q(query), nodes n
        WHERE n.tsv @@ q.query
          AND n.deleted_at IS NULL
         ${historyClause("follow")}
          AND ${liveStatusPredicate("n")}
          AND n.scope IN (SELECT value FROM jsonb_array_elements_text(?2) AS value)
          AND n.layer BETWEEN ?3 AND ?4
          AND (
            (n.acl = 'private' AND n.owner_id = ?5)
            OR (n.acl = 'team' AND n.team_id = ?6)
            OR (n.acl = 'agent' AND n.agent_id = ?7)
            OR (n.acl = 'restricted' AND EXISTS (
                  SELECT 1 FROM acl_grants g
                  WHERE g.node_id = n.id
                    AND g.principal IN (SELECT value FROM jsonb_array_elements_text(?8) AS value)
                ))
          )${notPendingClause("n")}
      ),
      ranked AS (
        SELECT node_id, RANK() OVER (ORDER BY score DESC) AS r
        FROM matches
      )
      SELECT node_id AS id, MIN(r)::int AS rank
      FROM ranked
      GROUP BY node_id
      ORDER BY rank ASC
      LIMIT ?9
    `,
      // Списки приходят строкой JSON, и без двойного приведения драйвер
      // отправил бы их в jsonb СКАЛЯРОМ: «cannot extract elements from a
      // scalar». Правило одно на весь проект и живёт в toPgDialectJsonb.
      2,
      8,
    ),
    params: [
      "q",
      "scopes",
      "layer_min",
      "layer_max",
      "owner_id",
      "team_id",
      "agent_id",
      "principals",
      "limit",
    ],
  },
});

// --- подготовка пользовательского запроса под MATCH ------------------------
//
// Главная ловушка FTS5: строка от агента идёт прямиком в MATCH, а у FTS5 свой
// синтаксис операторов (AND/OR/NOT/NEAR, `*` префикс, `^` начало столбца,
// `:` колонка, скобки, `-` как часть NOT в некоторых грамматиках). Необработанный
// ввод — это одновременно syntax error (кавычка/скобка не закрыты) и инъекция
// (пользователь дописывает себе NEAR/OR и меняет смысл запроса).
//
// Решение: никогда не передаём сырой текст в MATCH. Разбиваем ввод на слова
// (и явные "фразы в кавычках") и оборачиваем каждый кусок в двойные кавычки —
// внутри кавычек FTS5 не распознаёт операторы, это буквальный текст. Явный
// префиксный поиск ("foo*") сохраняется как `"foo"*` — единственная валидная
// форма префикса вне кавычек в FTS5 query grammar.

const WORD_RE = /[\p{L}\p{N}_][\p{L}\p{N}_.-]*/gu;

function tokenizeWords(input: string): string[] {
  const matches = input.match(WORD_RE);
  return matches ?? [];
}

/**
 * Разобранный запрос: те же термины в трёх видах.
 *
 * ЗАЧЕМ ТРИ ВИДА (решение S44). FTS5 соединяет соседние термины НЕЯВНЫМ И,
 * поэтому одно отсутствующее слово обнуляет выдачу целиком: «оплог мерж»
 * находит заметку «оплог сливается объединением…», а «сливать оплог» — нет,
 * потому что в тексте «сливается», и стемминга для русского у нас нет.
 * Естественный вопрос агента почти всегда содержит хотя бы одно слово, форма
 * которого не совпала, — и получает ноль при непустой базе.
 *
 * Лечение — тот же набор терминов, соединённый ИЛИ. Строка `or` строится ЗДЕСЬ,
 * а не склейкой на месте вызова: термины уже обезврежены (закавычены), и
 * повторная сборка из сырого текста означала бы второй, расходящийся парсер.
 */
export interface PreparedFtsQuery {
  /** Термины, готовые к подстановке в MATCH: `"оплог"`, `"distrib"*`, `"две слова"`. */
  readonly terms: readonly string[];
  /** Строгое И — неявное соединение пробелом, как было до S44. */
  readonly and: string;
  /**
   * И по ПРЕФИКСАМ: `"слива"* "оплог"*`. Лечит причину, а не следствие —
   * отсутствие стемминга. «сливать» и «сливается» имеют общий префикс, и
   * пересечение по префиксам остаётся ПЕРЕСЕЧЕНИЕМ: точность та же, что у
   * строгого И, а цена — та же, потому что префиксный терм в FTS5 ищется по
   * индексу термов, а не сканом.
   */
  readonly prefixAnd: string;
  /**
   * «Все термины кроме одного», по префиксам:
   * `("b"* "c"*) OR ("a"* "c"*) OR ("a"* "b"*)`. Лечит ЛИШНЕЕ слово в вопросе
   * («как», «почему», «что делать если»), которого в тексте нет вовсе.
   *
   * Каждое слагаемое — по-прежнему пересечение, поэтому оно селективно; в этом
   * вся разница с плоским ИЛИ, где одно частое слово тянет десятки тысяч
   * кандидатов. Пусто при одном термине: выкидывать нечего.
   */
  readonly prefixRelaxed: string;
  /** Мягкое ИЛИ — то же множество терминов, соединённое явным OR. */
  readonly or: string;
  /**
   * «Все термины кроме любых двух», по префиксам. Та же идея, что и
   * prefixRelaxed, на шаг шире: естественный вопрос часто добавляет к делу
   * ДВА лишних слова («как», «правильно»), а не одно.
   *
   * Пусто при менее чем четырёх терминах — и это не осторожность: при трёх
   * слагаемое выродилось бы в одиночный терм, то есть в то же плоское ИЛИ,
   * которое здесь и не хочется. Пока в каждом слагаемом остаётся хотя бы два
   * термина, оно остаётся пересечением и остаётся дешёвым.
   */
  readonly prefixRelaxed2: string;
  /** ИЛИ по префиксам — последняя ступень, самая широкая и самая дорогая. */
  readonly prefixOr: string;
}

/**
 * Префиксная форма термина.
 *
 * ДЛИНА ОТРЕЗАНИЯ. Русская словоформа отличается от начальной хвостом в 2-4
 * буквы («сливать» / «сливается», «запускать» / «запускается»), поэтому режем
 * на три символа, но не короче пяти: префикс в четыре буквы и меньше в русском
 * тексте перестаёт быть словом и начинает совпадать с чем попало. Слова короче
 * шести символов не режем вовсе — у них нет запаса, а «опло»* поймал бы больше
 * мусора, чем пользы.
 *
 * Термин, у которого пользователь сам попросил префикс (`foo*`), и фраза в
 * кавычках («две слова») не трогаются: там намерение уже выражено явно.
 */
function prefixTerm(term: Term): Term {
  if (term.prefix || term.words.length !== 1) return term;
  const word = term.words[0]!;
  if (word.length < 6) return term;
  return { words: [word.slice(0, Math.max(5, word.length - 3))], prefix: true };
}

/**
 * ТЕРМИН БЕЗ ДИАЛЕКТА. Разбор ввода даёт слова и намерение (фраза, префикс),
 * а операторы и кавычки навешивает рендерер того диалекта, в который запрос
 * поедет: у FTS5 это `"слово"*` и неявное И пробелом, у Postgres —
 * `'слово':*` и `&`. Лестница откатов (И → префиксное И → «все кроме
 * одного» → …) от диалекта не зависит и живёт в одном месте — иначе у двух
 * баз разошлись бы не тексты, а СМЫСЛ отката, и расхождение было бы
 * незаметным.
 */
interface Term {
  /** Одно слово, либо несколько — тогда это фраза «слова подряд». */
  readonly words: readonly string[];
  readonly prefix: boolean;
}

/** Как термины и операторы выглядят в конкретном диалекте. */
interface LexicalSyntax {
  term(t: Term): string;
  readonly and: string;
  readonly or: string;
}

const FTS5: LexicalSyntax = {
  term: (t) => {
    const inner = t.words.join(" ").replace(/"/g, '""');
    return t.prefix ? `"${inner}"*` : `"${inner}"`;
  },
  and: " ",
  or: " OR ",
};

/**
 * tsquery: лексема в одинарных кавычках, префикс через `:*`, фраза — цепочка
 * `<->` (расстояние 1), которую обязательно скобить, иначе `&` и `|` соседей
 * свяжутся не с тем. Конфигурация 'simple' — та же, что у генерируемой
 * колонки `tsv` в db/schema.postgres.sql: другая означала бы, что запрос
 * ищет не то, что проиндексировано.
 */
const TSQUERY: LexicalSyntax = {
  term: (t) => {
    const lex = (w: string): string => `'${w.replace(/'/g, "''")}'`;
    if (t.words.length > 1) return `(${t.words.map(lex).join(" <-> ")})`;
    return t.prefix ? `${lex(t.words[0]!)}:*` : lex(t.words[0]!);
  },
  and: " & ",
  or: " | ",
};

/**
 * «Все кроме k» — объединение всех сочетаний, где выброшено ровно k терминов.
 * Возвращает пустую строку, когда в слагаемом осталось бы меньше двух
 * терминов: слагаемое из одного терма — это уже плоское ИЛИ, ради ухода от
 * которого лестница и построена.
 */
function dropEach(terms: readonly Term[], k: number, syn: LexicalSyntax): string {
  if (terms.length - k < 2) return "";
  const parts: string[] = [];
  const combos: number[][] = [];
  const pick = (start: number, acc: number[]): void => {
    if (acc.length === k) {
      combos.push([...acc]);
      return;
    }
    for (let i = start; i < terms.length; i++) {
      acc.push(i);
      pick(i + 1, acc);
      acc.pop();
    }
  };
  pick(0, []);
  for (const skip of combos) {
    const kept = terms.filter((_, i) => !skip.includes(i));
    parts.push(`(${kept.map(syn.term).join(syn.and)})`);
  }
  return parts.join(syn.or);
}

/**
 * Строит безопасную MATCH-строку из пользовательского ввода. Возвращает null,
 * если после разбора не осталось ни одного термина (пустая строка или строка
 * из одних стоп-символов вроде `-- ** ((` ) — вызывающий обязан в этом случае
 * вернуть пустой результат без обращения к FTS5, а не подставлять "" в MATCH
 * (пустая строка — syntax error в fts5).
 */
export function prepareFtsQuery(rawInput: string, dialect: Dialect = "sqlite"): string | null {
  return analyzeFtsQuery(rawInput, dialect)?.and ?? null;
}

/** Разбор ввода в термины без диалекта. null — ни одного термина не осталось. */
function parseTerms(rawInput: string): Term[] | null {
  const raw = rawInput.trim();
  if (raw.length === 0) return null;

  const terms: Term[] = [];
  let i = 0;
  const n = raw.length;
  while (i < n) {
    const ch = raw[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && raw[j] !== '"') j++;
      const phraseWords = tokenizeWords(raw.slice(i + 1, j));
      if (phraseWords.length > 0) terms.push({ words: phraseWords, prefix: false });
      i = j < n ? j + 1 : j;
      continue;
    }
    WORD_RE.lastIndex = i;
    const match = WORD_RE.exec(raw);
    if (match === null || match.index !== i) {
      i++;
      continue;
    }
    const word = match[0];
    const end = i + word.length;
    if (raw[end] === "*") {
      terms.push({ words: [word], prefix: true });
      i = end + 1;
    } else {
      terms.push({ words: [word], prefix: false });
      i = end;
    }
  }
  return terms.length === 0 ? null : terms;
}

/**
 * Тот же разбор, что и prepareFtsQuery, но отдаёт термины и все формы (S44) —
 * в синтаксисе того диалекта, в который запрос поедет.
 *
 * ЛЕСТНИЦА ОДНА НА ОБА ДИАЛЕКТА, и это не экономия строк: «все термины кроме
 * одного» — правило отката, а не текст. Вторая его запись под Postgres
 * означала бы, что на сервере откат ведёт себя иначе, чем локально, и
 * заметить это можно было бы только по разной выдаче.
 */
export function analyzeFtsQuery(
  rawInput: string,
  dialect: Dialect = "sqlite",
): PreparedFtsQuery | null {
  const terms = parseTerms(rawInput);
  if (terms === null) return null;
  const syn = dialect === "pg" ? TSQUERY : FTS5;
  const prefixes = terms.map(prefixTerm);
  const render = (list: readonly Term[], op: string): string =>
    list.map(syn.term).join(op);
  return {
    terms: terms.map(syn.term),
    and: render(terms, syn.and),
    prefixAnd: render(prefixes, syn.and),
    prefixRelaxed: dropEach(prefixes, 1, syn),
    prefixRelaxed2: dropEach(prefixes, 2, syn),
    or: render(terms, syn.or),
    prefixOr: render(prefixes, syn.or),
  };
}

export function ftsSearch(db: DbDriver, params: FtsSearchParams): FtsSearchHit[] {
  // Диалект спрашивается У ДРАЙВЕРА, а не передаётся вызывающим: строка
  // запроса обязана быть в том же синтаксисе, что и текст SQL, который её
  // примет, и связывает их одно — соединение, в которое всё это уедет.
  const match = prepareFtsQuery(params.text, db.dialect);
  if (match === null) return [];
  if (params.scopes.length === 0) return [];

  const layerMin = params.layerMin ?? 0;
  const layerMax = params.layerMax ?? 3;
  const limit = clampLimit(params.limit);

  return db.all<FtsSearchHit>(ftsQueries.ftsSearch, [
    match,
    JSON.stringify(params.scopes),
    layerMin,
    layerMax,
    params.caller.ownerId,
    params.caller.teamId,
    params.caller.agentId,
    JSON.stringify(params.caller.principals),
    limit,
  ]);
}
