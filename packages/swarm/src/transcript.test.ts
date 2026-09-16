/**
 * Разбор стенограммы: расход попытки и ГРОМКИЙ отказ при несовпадении.
 *
 * Стенограмма — чужой формат. Все тесты ниже сторожат одно: молчаливого
 * нуля быть не может. Ноль неотличим от «не смогли прочитать», и ось цены
 * в `myc report models` осталась бы пустой ровно так же, как была, — но
 * теперь ещё и с видимостью работы.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkTranscriptModels,
  findSessionTranscript,
  findTaskTranscripts,
  findUsagePrefix,
  locateSessionTranscript,
  readTranscriptUsage,
  taskNeedle,
  transcriptDir,
  transcriptRoot,
  TranscriptError,
} from "./transcript.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myc-transcript-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface UsageLike {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
}

/** Запись стенограммы в том же виде, в каком её пишет Claude Code. */
function assistant(
  msgId: string,
  usage: UsageLike | undefined,
  extra: { timestamp?: string; requestId?: string | null; model?: string } = {},
): string {
  const message: Record<string, unknown> = {
    model: extra.model ?? "claude-opus-5",
    id: msgId,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "…" }],
  };
  if (usage !== undefined) message["usage"] = usage;
  const rec: Record<string, unknown> = {
    type: "assistant",
    uuid: `${msgId}-${Math.random().toString(16).slice(2)}`,
    timestamp: extra.timestamp ?? "2026-09-06T18:02:27.702Z",
    sessionId: "s",
    message,
  };
  if (extra.requestId !== null) rec["requestId"] = extra.requestId ?? `req_${msgId}`;
  return JSON.stringify(rec);
}

function usage(inTok: number, out: number, read: number, write: number): UsageLike {
  return {
    input_tokens: inTok,
    output_tokens: out,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  };
}

function writeTranscript(name: string, lines: readonly string[]): string {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function failure(fn: () => unknown): TranscriptError {
  try {
    fn();
  } catch (e) {
    if (e instanceof TranscriptError) return e;
    throw e;
  }
  throw new Error("ожидался отказ, а разбор прошёл");
}

describe("readTranscriptUsage: расход", () => {
  test("суммирует четыре поля usage по всем ответам", () => {
    const path = writeTranscript("a.jsonl", [
      assistant("msg_1", usage(2, 243, 26443, 50980)),
      assistant("msg_2", usage(5, 100, 77000, 1000)),
    ]);
    const u = readTranscriptUsage(path);
    expect(u.tokensIn).toBe(7);
    expect(u.tokensOut).toBe(343);
    expect(u.tokensCacheRead).toBe(103443);
    expect(u.tokensCacheWrite).toBe(51980);
    expect(u.responses).toBe(2);
    expect(u.sessionId).toBe("a");
    expect(u.models).toEqual(["claude-opus-5"]);
  });

  test("копии одного ответа склеиваются по message.id, а не складываются", () => {
    // Так стенограмма и выглядит: рассуждение, текст и вызов инструмента —
    // три записи с ОДНИМ message.id и одной и той же копией usage. Наивная
    // сумма завышает расход в ~1.6 раза (замер: 119953 против 68803).
    const path = writeTranscript("dup.jsonl", [
      assistant("msg_1", usage(2, 243, 26443, 50980)),
      assistant("msg_1", usage(2, 243, 26443, 50980)),
      assistant("msg_1", usage(2, 243, 26443, 50980)),
    ]);
    const u = readTranscriptUsage(path);
    expect(u.tokensOut).toBe(243);
    expect(u.tokensCacheRead).toBe(26443);
    expect(u.responses).toBe(1);
    expect(u.usageRecords).toBe(3);
  });

  test("частичные записи стриминга: по группе берётся максимум", () => {
    const path = writeTranscript("stream.jsonl", [
      assistant("msg_1", usage(3, 1, 18396, 0)),
      assistant("msg_1", usage(3, 89, 18396, 0)),
    ]);
    const u = readTranscriptUsage(path);
    expect(u.tokensOut).toBe(89);
    expect(u.tokensIn).toBe(3);
  });

  test("оборванная последняя строка живого файла не роняет разбор", () => {
    const path = join(dir, "tail.jsonl");
    writeFileSync(path, `${assistant("msg_1", usage(2, 10, 100, 5))}\n{"type":"assis`);
    expect(readTranscriptUsage(path).tokensOut).toBe(10);
  });

  test("огромные числа не теряют точности: чтения кеша в миллиардах", () => {
    const big = 2_053_192_236;
    const path = writeTranscript("big.jsonl", [
      assistant("msg_1", usage(0, 1, big, 0)),
      assistant("msg_2", usage(0, 1, big, 0)),
    ]);
    expect(readTranscriptUsage(path).tokensCacheRead).toBe(big * 2);
  });

  test("время и число записей отражают файл целиком", () => {
    const path = writeTranscript("t.jsonl", [
      JSON.stringify({ type: "user", timestamp: "2026-09-06T18:00:00.000Z" }),
      assistant("msg_1", usage(1, 2, 3, 4), { timestamp: "2026-09-06T18:02:00.000Z" }),
      JSON.stringify({ type: "user", timestamp: "2026-09-06T18:31:00.000Z" }),
    ]);
    const u = readTranscriptUsage(path);
    expect(u.startedAt).toBe("2026-09-06T18:00:00.000Z");
    expect(u.endedAt).toBe("2026-09-06T18:31:00.000Z");
    expect(u.records).toBe(3);
  });
});

describe("readTranscriptUsage: отказ, а не ноль", () => {
  test("файла нет — отказ", () => {
    const e = failure(() => readTranscriptUsage(join(dir, "нет.jsonl")));
    expect(e.code).toBe("transcript.missing");
  });

  test("ни одного usage — отказ, а НЕ нулевой расход", () => {
    // Главная мутация задачи: заменить этот отказ на нулевой расход.
    const path = writeTranscript("nousage.jsonl", [
      JSON.stringify({ type: "user", message: { role: "user", content: "привет" } }),
      assistant("msg_1", undefined),
    ]);
    const e = failure(() => readTranscriptUsage(path));
    expect(e.code).toBe("transcript.no_usage");
    expect(e.message).toContain("not zero");
  });

  test("usage есть, но без знакомых полей — отказ", () => {
    const path = writeTranscript("renamed.jsonl", [
      assistant("msg_1", { } as UsageLike),
      JSON.stringify({
        type: "assistant",
        requestId: "r2",
        message: { id: "msg_2", usage: { in_tokens: 5, out_tokens: 7 } },
      }),
    ]);
    const e = failure(() => readTranscriptUsage(path));
    expect(e.code).toBe("transcript.no_fields");
  });

  test("переименовали одно поле — отказ, а не тихий ноль по нему", () => {
    // Занижение по чтениям кеша — самая дорогая статья расхода; молча
    // записанный по ней ноль занизил бы стоимость в разы.
    const path = writeTranscript("lost.jsonl", [
      assistant("msg_1", {
        input_tokens: 2,
        output_tokens: 243,
        cache_creation_input_tokens: 50980,
      }),
    ]);
    const e = failure(() => readTranscriptUsage(path));
    expect(e.code).toBe("transcript.missing_field");
    expect(e.message).toContain("cache_read_input_tokens");
  });

  test("поле есть, но не целое ≥ 0 — отказ", () => {
    for (const bad of ["243", -1, 1.5, null]) {
      const path = writeTranscript(`bad-${String(bad)}.jsonl`, [
        assistant("msg_1", { ...usage(2, 243, 10, 0), output_tokens: bad }),
      ]);
      const e = failure(() => readTranscriptUsage(path));
      expect(e.code).toBe("transcript.bad_field");
    }
  });

  test("число за пределом точных целых — отказ, а не округление", () => {
    // 2^53 — целое, но уже НЕ точное: соседние значения неразличимы.
    const path = writeTranscript("huge.jsonl", [assistant("msg_1", usage(0, 1, 2 ** 53, 0))]);
    expect(failure(() => readTranscriptUsage(path)).code).toBe("transcript.bad_field");

    const two = writeTranscript("huge2.jsonl", [
      assistant("msg_1", usage(0, 1, Number.MAX_SAFE_INTEGER - 1, 0)),
      assistant("msg_2", usage(0, 1, Number.MAX_SAFE_INTEGER - 1, 0)),
    ]);
    expect(failure(() => readTranscriptUsage(two)).code).toBe("transcript.overflow");
  });

  test("у записи с usage нет ключа склейки — отказ, а не завышенная сумма", () => {
    const path = writeTranscript("nokey.jsonl", [
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", usage: usage(2, 243, 10, 0) },
      }),
    ]);
    expect(failure(() => readTranscriptUsage(path)).code).toBe("transcript.no_key");
  });

  test("requestId выручает, когда message.id пропал", () => {
    const path = writeTranscript("req.jsonl", [
      JSON.stringify({
        type: "assistant",
        requestId: "req_1",
        message: { role: "assistant", usage: usage(2, 243, 10, 1) },
      }),
      JSON.stringify({
        type: "assistant",
        requestId: "req_1",
        message: { role: "assistant", usage: usage(2, 243, 10, 1) },
      }),
    ]);
    expect(readTranscriptUsage(path).tokensOut).toBe(243);
  });

  test("пустой файл — отказ", () => {
    const path = writeTranscript("empty.jsonl", []);
    expect(failure(() => readTranscriptUsage(path)).code).toBe("transcript.empty");
  });

  test("разобрано, а расход ноль — отказ: у настоящей сессии так не бывает", () => {
    const path = writeTranscript("zeros.jsonl", [assistant("msg_1", usage(0, 0, 0, 0))]);
    const e = failure(() => readTranscriptUsage(path));
    expect(e.code).toBe("transcript.no_tokens");
  });
});

describe("поиск стенограммы", () => {
  test("по uuid сессии; нет такой — отказ", () => {
    writeTranscript("11111111-2222-3333-4444-555555555555.jsonl", [
      assistant("msg_1", usage(1, 2, 3, 4)),
    ]);
    expect(findSessionTranscript(dir, "11111111-2222-3333-4444-555555555555")).toContain(
      "11111111",
    );
    // и с расширением, и без — одно и то же
    expect(findSessionTranscript(dir, "11111111-2222-3333-4444-555555555555.jsonl")).toContain(
      "11111111",
    );
    expect(failure(() => findSessionTranscript(dir, "нет-такой")).code).toBe("notfound.session");
    expect(failure(() => findSessionTranscript(join(dir, "нет"), "x")).code).toBe(
      "transcript.dir_missing",
    );
  });

  test("по задаче: строка брифа, порядок по времени, свою сессию исключаем", () => {
    const brief = JSON.stringify({
      type: "user",
      message: { role: "user", content: `${taskNeedle("memory-abc")}\nделай так` },
    });
    const first = writeTranscript("aaa.jsonl", [brief, assistant("m1", usage(1, 2, 3, 4))]);
    const second = writeTranscript("bbb.jsonl", [brief, assistant("m2", usage(1, 2, 3, 4))]);
    const coordinator = writeTranscript("ccc.jsonl", [brief]);
    writeTranscript("ddd.jsonl", [assistant("m3", usage(1, 2, 3, 4))]);
    utimesSync(first, new Date(1000), new Date(1000));
    utimesSync(second, new Date(2000), new Date(2000));
    utimesSync(coordinator, new Date(3000), new Date(3000));

    expect(findTaskTranscripts(dir, "memory-abc")).toEqual([first, second, coordinator]);
    expect(findTaskTranscripts(dir, "memory-abc", { exclude: "ccc" })).toEqual([first, second]);
    expect(findTaskTranscripts(dir, "memory-abc", { exclude: "ccc.jsonl" })).toEqual([
      first,
      second,
    ]);
    expect(findTaskTranscripts(dir, "memory-нет")).toEqual([]);
  });
});

describe("transcriptDir", () => {
  test("слаг проекта: '/' → '-', и переопределение окружением", () => {
    expect(transcriptDir("/Users/x/src/memory", {})).toEndWith(
      "/.claude/projects/-Users-x-src-memory",
    );
    expect(transcriptDir("/Users/x", { MYC_TRANSCRIPT_DIR: "/tmp/т" })).toBe("/tmp/т");
  });

  // Слаг Claude Code меняет на '-' всё, кроме букв и цифр: worktree из
  // `.claude/worktrees/x` лежит в `…--claude-worktrees-x` (так в
  // ~/.claude/projects на этой машине). Прежний «'/' → '-'» давал `-.claude-`.
  test("точка и подчёркивание в пути — тоже '-' (worktree в .claude/worktrees)", () => {
    expect(transcriptDir("/Users/x/src/docs/.claude/worktrees/local_doc", {})).toEndWith(
      "/.claude/projects/-Users-x-src-docs--claude-worktrees-local-doc",
    );
  });

  test("$CLAUDE_CONFIG_DIR переносит корень каталогов проектов, как у Claude Code", () => {
    expect(transcriptRoot({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/projects");
    expect(transcriptDir("/Users/x/app", { CLAUDE_CONFIG_DIR: "/cfg" })).toBe("/cfg/projects/-Users-x-app");
  });
});

describe("locateSessionTranscript: сессия по uuid в любом каталоге проекта", () => {
  const ID = "0e1a4c33-5b7d-4a7e-9d61-2f3b8c9d0a11";

  test("стенограмма исполнителя в каталоге его worktree находится из каталога координатора", () => {
    const env = { CLAUDE_CONFIG_DIR: dir };
    const wtDir = join(dir, "projects", "-repo--claude-worktrees-feat");
    mkdirSync(wtDir, { recursive: true });
    mkdirSync(join(dir, "projects", "-repo"), { recursive: true });
    writeFileSync(join(wtDir, `${ID}.jsonl`), `${assistant("m1", usage(1, 2, 3, 4))}\n`);
    expect(locateSessionTranscript(ID, "/repo", env)).toBe(join(wtDir, `${ID}.jsonl`));
    expect(failure(() => locateSessionTranscript("нет-такой", "/repo", env)).code).toBe("notfound.session");
  });

  test("быстрый путь — каталог cwd; $MYC_TRANSCRIPT_DIR — только он", () => {
    const near = join(dir, "projects", "-repo");
    mkdirSync(near, { recursive: true });
    writeFileSync(join(near, `${ID}.jsonl`), `${assistant("m1", usage(1, 2, 3, 4))}\n`);
    expect(locateSessionTranscript(ID, "/repo", { CLAUDE_CONFIG_DIR: dir })).toBe(join(near, `${ID}.jsonl`));
    const pinned = join(dir, "pinned");
    mkdirSync(pinned);
    expect(
      failure(() => locateSessionTranscript(ID, "/repo", { CLAUDE_CONFIG_DIR: dir, MYC_TRANSCRIPT_DIR: pinned })).code,
    ).toBe("notfound.session");
  });
});

describe("readTranscriptUsage { until }: стенограмма на момент финиша", () => {
  test("ответы позже среза не считаются, записи без времени — считаются", () => {
    const path = writeTranscript("until.jsonl", [
      assistant("m1", usage(1, 10, 100, 1000), { timestamp: "2026-09-07T09:00:00.000Z" }),
      assistant("m2", usage(2, 20, 200, 2000), { timestamp: "2026-09-07T11:00:00.000Z" }),
    ]);
    const all = readTranscriptUsage(path);
    expect(all.tokensCacheRead).toBe(300);
    const cut = readTranscriptUsage(path, { until: Date.parse("2026-09-07T10:00:00.000Z") });
    expect(cut).toMatchObject({ tokensIn: 1, tokensOut: 10, tokensCacheRead: 100, tokensCacheWrite: 1000, responses: 1 });
    expect(cut.endedAt).toBe("2026-09-07T09:00:00.000Z");
  });
});

describe("findUsagePrefix: был ли расход прочитан из этой стенограммы", () => {
  test("совпадение четырёх сумм на префиксе файла — да; копии одного ответа не удваивают", () => {
    const path = writeTranscript("prefix.jsonl", [
      assistant("m1", usage(1, 10, 100, 1000), { timestamp: "2026-09-07T09:00:00.000Z" }),
      assistant("m1", usage(1, 12, 100, 1000), { timestamp: "2026-09-07T09:00:01.000Z" }),
      assistant("m2", usage(2, 20, 200, 2000), { timestamp: "2026-09-07T09:05:00.000Z" }),
    ]);
    expect(findUsagePrefix(path, { tokensIn: 1, tokensOut: 12, tokensCacheRead: 100, tokensCacheWrite: 1000 })).toEqual({
      records: 2,
      at: "2026-09-07T09:00:01.000Z",
    });
    expect(findUsagePrefix(path, { tokensIn: 3, tokensOut: 32, tokensCacheRead: 300, tokensCacheWrite: 3000 })?.records).toBe(3);
    // похоже, но не то: ни один префикс не даёт ровно этих чисел
    expect(findUsagePrefix(path, { tokensIn: 3, tokensOut: 31, tokensCacheRead: 300, tokensCacheWrite: 3000 })).toBeNull();
    expect(findUsagePrefix(join(dir, "нет.jsonl"), { tokensIn: 1, tokensOut: 1, tokensCacheRead: 1, tokensCacheWrite: 1 })).toBeNull();
  });
});

describe("checkTranscriptModels: чей это расход", () => {
  const sonnet = { modelId: "sonnet", family: "claude-sonnet" };

  test("своя модель — ok; служебная <synthetic> не в счёт", () => {
    expect(checkTranscriptModels(["claude-sonnet-5"], sonnet).ok).toBe(true);
    expect(checkTranscriptModels(["<synthetic>", "claude-sonnet-4-5-20250929"], sonnet).ok).toBe(true);
  });

  test("чужая модель — не ok и названа (att_6289a214d584: sonnet, в стенограмме opus)", () => {
    const r = checkTranscriptModels(["claude-opus-5"], sonnet);
    expect(r.ok).toBe(false);
    expect(r.foreign).toEqual(["claude-opus-5"]);
    expect(checkTranscriptModels(["claude-sonnet-5", "claude-haiku-4-5-20251001"], sonnet).foreign).toEqual([
      "claude-haiku-4-5-20251001",
    ]);
  });

  test("семейство или хвост id модели; без единой модели проверить нечем", () => {
    expect(checkTranscriptModels(["claude-opus-4-5-20251101"], { modelId: "opus", family: "" }).ok).toBe(true);
    expect(checkTranscriptModels(["p/big"], { modelId: "p/big", family: "big" }).ok).toBe(true);
    expect(checkTranscriptModels(["<synthetic>"], sonnet).ok).toBe(false);
    expect(checkTranscriptModels([], sonnet).ok).toBe(false);
  });
});

describe("исключение сессии координатора: промах и неоднозначность — отказ", () => {
  test("префикс, не подходящий ни одной стенограмме, отвергается", () => {
    // Тихое «никого не исключили» добавляет к расходу задачи весь день
    // координатора (замерено: 1.2 млрд чтений кеша против 20 млн у агента),
    // то есть ответ становится не приблизительным, а бессмысленным.
    writeTranscript("aaaa1111-x.jsonl", [assistant("m1", usage(1, 2, 3, 4)), '{"т":"Задача myc: t-1"}']);
    expect(failure(() => findTaskTranscripts(dir, "t-1", { exclude: "нет-такого" })).code).toBe(
      "transcript.exclude_miss",
    );
  });

  test("префикс, подходящий двум стенограммам, отвергается", () => {
    writeTranscript("aaaa1111-x.jsonl", [assistant("m1", usage(1, 2, 3, 4)), '{"т":"Задача myc: t-1"}']);
    writeTranscript("aaaa2222-y.jsonl", [assistant("m2", usage(1, 2, 3, 4)), '{"т":"Задача myc: t-1"}']);
    expect(failure(() => findTaskTranscripts(dir, "t-1", { exclude: "aaaa" })).code).toBe(
      "transcript.exclude_ambiguous",
    );
  });

  test("однозначный префикс исключает ровно одну", () => {
    writeTranscript("aaaa1111-x.jsonl", [assistant("m1", usage(1, 2, 3, 4)), '{"т":"Задача myc: t-1"}']);
    writeTranscript("bbbb2222-y.jsonl", [assistant("m2", usage(1, 2, 3, 4)), '{"т":"Задача myc: t-1"}']);
    const found = findTaskTranscripts(dir, "t-1", { exclude: "aaaa1111" });
    expect(found.length).toBe(1);
    expect(found[0]!).toContain("bbbb2222");
  });
});
