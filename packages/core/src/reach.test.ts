/**
 * Охват памяти (S58): разбор, предикат и их СОГЛАСОВАННОСТЬ.
 *
 * Главный тест здесь — не «readReach возвращает то, что ждём», а таблица
 * истинности, прогнанная ОДНОВРЕМЕННО через JS-разбор и через настоящий
 * SQLite. Расхождение между ними — самая дорогая ошибка этой задачи: `prime`
 * фильтровал бы по одному правилу, а печатал метки по другому, и чужое
 * сессионное знание попадало бы в контекст (или своё — исчезало) молча.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  EPISODE_KEY,
  REACH_KEY,
  SESSION_KEY,
  episodeSessionKey,
  reachAttrs,
  reachClause,
  reachFromColumns,
  reachPredicate,
  reachTag,
  readReach,
  resolveSession,
  sessionKeyFromTranscript,
  unknownReachPredicate,
  visibleInPrime,
} from "./reach.ts";
import type { JsonValue } from "./oplog.ts";

// ---------------------------------------------------------------------------
// Таблица истинности: все содержательно различные формы attrs
// ---------------------------------------------------------------------------

interface Case {
  readonly name: string;
  readonly attrs: Record<string, JsonValue>;
}

const CASES: readonly Case[] = [
  { name: "проектное", attrs: { [REACH_KEY]: "project" } },
  { name: "сессионное A", attrs: { [REACH_KEY]: "session", [SESSION_KEY]: "A" } },
  { name: "сессионное B", attrs: { [REACH_KEY]: "session", [SESSION_KEY]: "B" } },
  // Записать сессионный охват без ключа сессии reachAttrs не даёт, но чужая
  // репликация или ручная правка attrs могут принести и такое.
  { name: "сессионное без ключа", attrs: { [REACH_KEY]: "session" } },
  { name: "сессионное с пустым ключом", attrs: { [REACH_KEY]: "session", [SESSION_KEY]: "" } },
  { name: "кандидат сжатия (эпизод E1)", attrs: { [EPISODE_KEY]: "E1" } },
  { name: "кандидат сжатия (эпизод E2)", attrs: { [EPISODE_KEY]: "E2" } },
  {
    name: "кандидат сжатия с явным охватом",
    attrs: { [EPISODE_KEY]: "E1", [REACH_KEY]: "session", [SESSION_KEY]: "A" },
  },
  { name: "старый узел без охвата", attrs: { tags: ["x"] } },
  { name: "пустые attrs", attrs: {} },
  { name: "мусор в reach", attrs: { [REACH_KEY]: "whatever" } },
  { name: "пустой episode_id", attrs: { [EPISODE_KEY]: "" } },
];

const SESSIONS: string[] = ["A", "B", episodeSessionKey("E1"), ""];

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, attrs TEXT NOT NULL DEFAULT '{}')");
  const ins = db.prepare("INSERT INTO nodes (id, attrs) VALUES (?1, ?2)");
  CASES.forEach((c, i) => ins.run(`n${i}`, JSON.stringify(c.attrs)));
});

afterEach(() => {
  db.close();
});

describe("readReach — разбор охвата", () => {
  test("явный project", () => {
    expect(readReach({ [REACH_KEY]: "project" })).toEqual({
      reach: "project",
      session: "",
      by: "recorded",
    });
  });

  test("явный session несёт ключ сессии", () => {
    expect(readReach({ [REACH_KEY]: "session", [SESSION_KEY]: "A" })).toEqual({
      reach: "session",
      session: "A",
      by: "recorded",
    });
  });

  test("кандидат сжатия без reach — сессионный по происхождению, не по содержанию", () => {
    expect(readReach({ [EPISODE_KEY]: "E1" })).toEqual({
      reach: "session",
      session: "episode:E1",
      by: "episode",
    });
  });

  test("явный охват сильнее выведенного из эпизода", () => {
    expect(readReach({ [EPISODE_KEY]: "E1", [REACH_KEY]: "project" }).reach).toBe("project");
  });

  test("нет ни того, ни другого — unknown, а не «наверное проектное»", () => {
    expect(readReach({}).reach).toBe("unknown");
    expect(readReach(undefined).reach).toBe("unknown");
    expect(readReach({ tags: ["x"] }).by).toBe("absent");
  });

  test("неизвестное значение reach не считается записанным охватом", () => {
    expect(readReach({ [REACH_KEY]: "whatever" }).reach).toBe("unknown");
  });
});

describe("reachAttrs — что кладётся в узел", () => {
  test("project не тащит за собой ключ сессии", () => {
    expect(reachAttrs("project", "")).toEqual({ [REACH_KEY]: "project" });
  });

  test("session без ключа сессии не записывается вовсе (И2: пустая строка — не сессия)", () => {
    expect(() => reachAttrs("session", "")).toThrow(/session key/);
  });

  test("записанное читается обратно тем же", () => {
    const info = readReach(reachAttrs("session", "S-42"));
    expect(info).toEqual({ reach: "session", session: "S-42", by: "recorded" });
  });
});

describe("resolveSession — откуда берётся личность сессии", () => {
  test("флаг сильнее окружения", () => {
    expect(resolveSession("flag", { MYC_SESSION_ID: "env" })).toBe("flag");
  });

  test("MYC_SESSION_ID сильнее CLAUDE_SESSION_ID", () => {
    expect(resolveSession(undefined, { MYC_SESSION_ID: "a", CLAUDE_SESSION_ID: "b" })).toBe("a");
  });

  test("CLAUDE_SESSION_ID подхватывается", () => {
    expect(resolveSession(undefined, { CLAUDE_SESSION_ID: "b" })).toBe("b");
  });

  test("CLAUDE_CODE_SESSION_ID тоже: именно её кладёт Claude Code 2.1.x", () => {
    // Проверено на живом окружении: CLAUDE_CODE_SESSION_ID есть,
    // CLAUDE_SESSION_ID нет. Без этой строки `myc remember`, набранный
    // агентом в шелле сессии, писал охват «неизвестно».
    expect(resolveSession(undefined, { CLAUDE_CODE_SESSION_ID: "cc" })).toBe("cc");
    expect(resolveSession(undefined, { CLAUDE_SESSION_ID: "b", CLAUDE_CODE_SESSION_ID: "cc" })).toBe("b");
  });

  test("пробелы и пустая строка — это «неизвестна», а не сессия по имени пробел", () => {
    expect(resolveSession("   ", { MYC_SESSION_ID: "  " })).toBe("");
    expect(resolveSession(undefined, {})).toBe("");
  });
});

describe("reachTag — метка в плотной выдаче", () => {
  test("своё и чужое сессионное различимы", () => {
    const own = readReach(reachAttrs("session", "A"));
    expect(reachTag(own, "A")).toBe("ses");
    expect(reachTag(own, "B")).toBe("ses*");
    // Сессия неизвестна — любое сессионное для нас чужое.
    expect(reachTag(own, "")).toBe("ses*");
  });

  test("проектное и неопределённое не путаются", () => {
    expect(reachTag(readReach({ [REACH_KEY]: "project" }), "A")).toBe("prj");
    expect(reachTag(readReach({}), "A")).toBe("?");
  });
});

describe("SQL и JS видят охват ОДИНАКОВО", () => {
  /**
   * Ради этого теста всё и написано. Предикат из reach.ts исполняется
   * настоящим SQLite на тех же attrs, что разбирает readReach; результаты
   * обязаны совпасть на каждой паре (узел, сессия). Мутация в любой из двух
   * половин красит эту таблицу.
   */
  test.each(SESSIONS)("таблица истинности совпадает при сессии %p", (session: string) => {
    const sql = `SELECT id FROM nodes n WHERE 1${reachClause("n", 1)}`;
    const visibleSql = new Set(
      db.query<{ id: string }, [string]>(sql).all(session).map((r) => r.id),
    );
    const visibleJs = new Set(
      CASES.map((c, i) => [c, `n${i}`] as const)
        .filter(([c]) => visibleInPrime(readReach(c.attrs), session))
        .map(([, id]) => id),
    );
    expect([...visibleSql].sort()).toEqual([...visibleJs].sort());
    // Тест обязан что-то отсеивать, иначе он сходится вхолостую.
    if (session !== "") expect(visibleSql.size).toBeLessThan(CASES.length);
  });

  test("предикат неопределённого охвата совпадает с разбором", () => {
    const rows = db
      .query<{ id: string }, []>(`SELECT id FROM nodes n WHERE ${unknownReachPredicate("n")}`)
      .all()
      .map((r) => r.id);
    const js = CASES.map((c, i) => [c, `n${i}`] as const)
      .filter(([c]) => readReach(c.attrs).reach === "unknown")
      .map(([, id]) => id);
    expect(rows.sort()).toEqual(js.sort());
    expect(js.length).toBeGreaterThan(0);
  });

  test("reachFromColumns совпадает с readReach на тех же строках", () => {
    const rows = db
      .query<
        { id: string; reach_raw: string | null; session_raw: string | null; episode_raw: string | null },
        []
      >(
        `SELECT id,
                json_extract(attrs,'$.reach') AS reach_raw,
                json_extract(attrs,'$.session_id') AS session_raw,
                json_extract(attrs,'$.episode_id') AS episode_raw
           FROM nodes ORDER BY id`,
      )
      .all();
    for (const row of rows) {
      const i = Number(row.id.slice(1));
      expect(reachFromColumns(row)).toEqual(readReach(CASES[i]!.attrs));
    }
  });

  test("предикат нумерует плейсхолдеры так, как его зовут", () => {
    // Смысловая проверка: reachPredicate обязан использовать РОВНО указанный
    // номер, иначе defineQueries отвергнет запрос со сплошной нумерацией.
    expect(reachPredicate("n", 3)).toContain("?3");
    expect(reachPredicate("n", 3)).not.toContain("?1");
  });
});

describe("sessionKeyFromTranscript — ключ, переживающий сжатие", () => {
  const UUID = "a4814339-819f-40fd-964f-9f054a508e43";

  test("Claude Code: <uuid>.jsonl", () => {
    expect(
      sessionKeyFromTranscript(`/Users/x/.claude/projects/-Users-x-src-memory/${UUID}.jsonl`),
    ).toBe(UUID);
  });

  test("Codex: rollout-<дата>-<uuid>.jsonl", () => {
    expect(sessionKeyFromTranscript(`/x/sessions/rollout-2026-09-07T10-00-00-${UUID}.jsonl`)).toBe(
      UUID,
    );
  });

  test("регистр не создаёт вторую сессию из той же", () => {
    expect(sessionKeyFromTranscript(`/x/${UUID.toUpperCase()}.jsonl`)).toBe(UUID);
  });

  test("uuid берётся ТОЛЬКО из имени файла, а не из пути", () => {
    // Иначе каталог проекта с uuid в имени склеил бы все сессии в одну.
    expect(sessionKeyFromTranscript(`/tmp/${UUID}/transcript.jsonl`)).toBe("");
  });

  test("без uuid ключа нет — выдумывать его из имени файла нельзя", () => {
    // Два разных прогона с файлом `transcript.jsonl` слились бы в одну сессию.
    expect(sessionKeyFromTranscript("/x/transcript.jsonl")).toBe("");
    expect(sessionKeyFromTranscript("-")).toBe("");
    expect(sessionKeyFromTranscript("stdin")).toBe("");
    expect(sessionKeyFromTranscript("")).toBe("");
    expect(sessionKeyFromTranscript(undefined)).toBe("");
    expect(sessionKeyFromTranscript(`missing:/x/${UUID}.jsonl`)).toBe("");
  });

  test("ключ совпадает с тем, что хост кладёт в --session: prime и хук сходятся", () => {
    expect(sessionKeyFromTranscript(`/x/${UUID}.jsonl`)).toBe(resolveSession(UUID));
  });
});
