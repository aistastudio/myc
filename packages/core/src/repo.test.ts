/**
 * Охват репозитория (S59): таблица истинности разбора, вывод из пути и
 * ЗЕРКАЛЬНОСТЬ SQL. Последнее — главное: `readRepo` (JS) и `repoPredicate`
 * (SQL) отвечают на один и тот же вопрос, и расхождение между ними означает,
 * что `ready` фильтрует по одному правилу, а печатает по другому.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  deriveRepo,
  readRepo,
  repoAttrs,
  repoColumns,
  repoFromColumns,
  repoPredicate,
  repoReasonText,
  repoTag,
  unknownRepoPredicate,
  visibleInRepo,
  REPO_KEY,
} from "./repo.ts";
import type { JsonValue } from "./oplog.ts";

// ---------------------------------------------------------------------------
// Разбор
// ---------------------------------------------------------------------------

describe("readRepo: три состояния, а не два", () => {
  test("ключа нет — охват НЕ ОПРЕДЕЛЁН, а не общий (И2)", () => {
    expect(readRepo({})).toEqual({ repo: "", state: "unknown", by: "absent" });
    expect(readRepo(undefined)).toEqual({ repo: "", state: "unknown", by: "absent" });
    // Узел, записанный до S59, несёт другие ключи и ни одного `repo`.
    expect(readRepo({ reach: "project", type: "task" })).toEqual({
      repo: "",
      state: "unknown",
      by: "absent",
    });
  });

  test("ключ есть и пуст — ОБЩИЙ охват: узел про всю экосистему", () => {
    expect(readRepo({ [REPO_KEY]: "" })).toEqual({ repo: "", state: "root", by: "recorded" });
  });

  test("ключ есть и непуст — охват этого репозитория", () => {
    expect(readRepo({ [REPO_KEY]: "collector" })).toEqual({
      repo: "collector",
      state: "repo",
      by: "recorded",
    });
  });

  test("общий и неопределённый различимы: одинаковое имя, разное состояние", () => {
    const root = readRepo({ [REPO_KEY]: "" });
    const unknown = readRepo({});
    expect(root.repo).toBe(unknown.repo); // оба пустые по имени
    expect(root.state).not.toBe(unknown.state); // и это единственное, что их различает
    expect(repoTag(root)).toBe("все");
    expect(repoTag(unknown)).toBe("?");
  });

  test("метка строки выдачи: имя репозитория как есть", () => {
    expect(repoTag(readRepo({ [REPO_KEY]: "messaging-server" }))).toBe("messaging-server");
  });
});

describe("visibleInRepo: экосистемное и неопределённое видно отовсюду", () => {
  const collector = readRepo({ [REPO_KEY]: "collector" });
  const other = readRepo({ [REPO_KEY]: "xplace-proxy" });
  const root = readRepo({ [REPO_KEY]: "" });
  const unknown = readRepo({});

  test("без фильтра видно всё", () => {
    for (const info of [collector, other, root, unknown]) {
      expect(visibleInRepo(info, "")).toBe(true);
    }
  });

  test("под фильтром: свой да, чужой нет, общий и неопределённый да", () => {
    expect(visibleInRepo(collector, "collector")).toBe(true);
    expect(visibleInRepo(other, "collector")).toBe(false);
    expect(visibleInRepo(root, "collector")).toBe(true);
    expect(visibleInRepo(unknown, "collector")).toBe(true);
  });

  test("`all` — то же самое, что отсутствие фильтра", () => {
    expect(visibleInRepo(other, "all")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Вывод из пути
// ---------------------------------------------------------------------------

describe("deriveRepo: охват берётся из ПУТИ, а не из слага воркспейса", () => {
  const repos = new Set(["/ws/collector", "/ws/messaging-server"]);
  const isRepo = (p: string): boolean => repos.has(p);

  test("корень воркспейса — общий охват", () => {
    expect(deriveRepo("/ws", "/ws", isRepo)).toEqual({ repo: "", reason: "", from: "/ws" });
  });

  test("каталог репозитория и любая глубина внутри — его имя", () => {
    expect(deriveRepo("/ws", "/ws/collector", isRepo).repo).toBe("collector");
    expect(deriveRepo("/ws", "/ws/collector/src/deep/er", isRepo).repo).toBe("collector");
    expect(deriveRepo("/ws", "/ws/messaging-server/server", isRepo).repo).toBe("messaging-server");
  });

  test("ДВА разных репозитория дают ДВА разных охвата: различение существует", () => {
    const a = deriveRepo("/ws", "/ws/collector/src", isRepo).repo;
    const b = deriveRepo("/ws", "/ws/messaging-server/src", isRepo).repo;
    expect(a).not.toBe(b);
  });

  test("обычный подкаталог корня — общий охват, а не имя каталога", () => {
    // /ws/docs репозиторием не является: он часть корневого репозитория.
    expect(deriveRepo("/ws", "/ws/docs/design", isRepo)).toEqual({
      repo: "",
      reason: "",
      from: "/ws/docs/design",
    });
  });

  test("вложенный репозиторий внутри репозитория остаётся охватом ВНЕШНЕГО", () => {
    const nested = new Set([...repos, "/ws/collector/vendor/x"]);
    expect(deriveRepo("/ws", "/ws/collector/vendor/x/src", (p) => nested.has(p)).repo).toBe(
      "collector",
    );
  });

  test("путь вне воркспейса — НЕ ОПРЕДЕЛЁН, и причина названа", () => {
    const d = deriveRepo("/ws", "/tmp/elsewhere", isRepo);
    expect(d.repo).toBeUndefined();
    expect(d.reason).toBe("outside-workspace");
    expect(repoReasonText(d)).toContain("/tmp/elsewhere");
  });

  test("сосед по префиксу — не «внутри»: /wsx не принадлежит /ws", () => {
    expect(deriveRepo("/ws", "/wsx/collector", isRepo).repo).toBeUndefined();
  });

  test("корня воркспейса нет — НЕ ОПРЕДЕЛЁН, и причина другая", () => {
    const d = deriveRepo(undefined, "/ws/collector", isRepo);
    expect(d.repo).toBeUndefined();
    expect(d.reason).toBe("no-workspace");
    expect(repoReasonText(d)).toBe("корень воркспейса неизвестен");
  });

  test("хвостовой слэш корня не ломает вывод", () => {
    expect(deriveRepo("/ws/", "/ws/collector", isRepo).repo).toBe("collector");
  });

  test("удача вывода не даёт текста причины", () => {
    expect(repoReasonText(deriveRepo("/ws", "/ws/collector", isRepo))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Зеркальность SQL и JS
// ---------------------------------------------------------------------------

describe("repoPredicate: SQL отвечает ровно то же, что JS", () => {
  let db: Database;

  const CASES: Array<{ name: string; attrs: Record<string, JsonValue> }> = [
    { name: "своего репозитория", attrs: { [REPO_KEY]: "collector" } },
    { name: "чужого репозитория", attrs: { [REPO_KEY]: "xplace-proxy" } },
    { name: "общий", attrs: { [REPO_KEY]: "" } },
    { name: "не определён", attrs: {} },
    { name: "не определён, но с другими ключами", attrs: { reach: "project" } },
  ];

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, attrs TEXT NOT NULL)");
    const ins = db.prepare("INSERT INTO nodes (id, attrs) VALUES (?1, ?2)");
    CASES.forEach((c, i) => ins.run(`n${i}`, JSON.stringify(c.attrs)));
  });

  afterEach(() => db.close());

  for (const target of ["", "collector", "xplace-proxy", "unrelated"]) {
    test(`фильтр '${target || "(нет)"}': SQL и JS согласны построчно`, () => {
      const rows = db
        .query<{ id: string; keep: number }, [string]>(
          `SELECT id, ${repoPredicate("nodes", 1)} AS keep FROM nodes ORDER BY id`,
        )
        .all(target);
      expect(rows.length).toBe(CASES.length);
      rows.forEach((row, i) => {
        const js = visibleInRepo(readRepo(CASES[i]!.attrs), target);
        expect(`${row.id}:${row.keep === 1}`).toBe(`${row.id}:${js}`);
      });
    });
  }

  test("unknownRepoPredicate считает ровно ветку absent из readRepo", () => {
    const rows = db
      .query<{ id: string; unk: number }, []>(
        `SELECT id, ${unknownRepoPredicate("nodes")} AS unk FROM nodes ORDER BY id`,
      )
      .all();
    rows.forEach((row, i) => {
      const js = readRepo(CASES[i]!.attrs).by === "absent";
      expect(`${row.id}:${row.unk === 1}`).toBe(`${row.id}:${js}`);
    });
  });

  test("repoColumns/repoFromColumns дают тот же разбор, что readRepo из attrs", () => {
    const rows = db
      .query<{ id: string; repo_raw: string | null }, []>(
        `SELECT id, ${repoColumns("nodes")} FROM nodes ORDER BY id`,
      )
      .all();
    rows.forEach((row, i) => {
      expect(repoFromColumns(row)).toEqual(readRepo(CASES[i]!.attrs));
    });
  });

  test("общий охват не сливается с неопределённым в SQL", () => {
    const unknown = db
      .query<{ n: number }, []>(
        `SELECT count(*) AS n FROM nodes WHERE ${unknownRepoPredicate("nodes")}`,
      )
      .get()!;
    // Два случая без ключа — и ни одного из тех, где ключ есть и пуст.
    expect(unknown.n).toBe(2);
  });
});

describe("repoAttrs", () => {
  test("пустое имя пишется КЛЮЧОМ, а не отсутствием ключа", () => {
    expect(repoAttrs("")).toEqual({ [REPO_KEY]: "" });
    expect(readRepo(repoAttrs("")).state).toBe("root");
  });

  test("имя репозитория читается обратно без потерь", () => {
    expect(readRepo(repoAttrs("collector"))).toEqual({
      repo: "collector",
      state: "repo",
      by: "recorded",
    });
  });
});
