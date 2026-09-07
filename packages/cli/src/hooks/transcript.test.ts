/**
 * Разбор транскрипта и извлечение сигналов (§6.2, шаги 1 и 4).
 *
 * Отдельный файл, потому что это чистые функции без БД: их дешевле держать
 * под микроскопом здесь, чем ловить через полный прогон хука.
 */

import { describe, expect, test } from "bun:test";
import { extractSignals, parseTranscript } from "./transcript.ts";

function jsonl(...rows: unknown[]): string {
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
}

function assistant(text: string, tools: { name: string; input: unknown }[] = []): unknown {
  return {
    type: "assistant",
    message: {
      role: "assistant",
      content: [
        { type: "text", text },
        ...tools.map((t) => ({ type: "tool_use", name: t.name, input: t.input })),
      ],
    },
  };
}

describe("parseTranscript", () => {
  test("JSONL Claude Code: роли, текст, метаданные", () => {
    const raw = jsonl(
      { type: "user", cwd: "/repo", sessionId: "s1", message: { role: "user", content: "привет" } },
      assistant("готово"),
    );
    const t = parseTranscript(raw);
    expect(t.format).toBe("jsonl");
    expect(t.turns.length).toBe(2);
    expect(t.turns[0]!.role).toBe("user");
    expect(t.cwd).toBe("/repo");
    expect(t.sessionId).toBe("s1");
  });

  test("не-JSON строки не выбрасываются, а становятся ходами", () => {
    const t = parseTranscript("просто текст сессии\nвторая строка\n");
    expect(t.format).toBe("text");
    expect(t.turns.length).toBe(2);
  });

  test("битая JSON-строка не роняет разбор целиком", () => {
    const raw = `${jsonl(assistant("первое"))}{"type":"assistant", "mess\n${jsonl(assistant("второе"))}`;
    const t = parseTranscript(raw);
    expect(t.turns.some((x) => x.text.includes("первое"))).toBe(true);
    expect(t.turns.some((x) => x.text.includes("второе"))).toBe(true);
  });
});

describe("extractSignals", () => {
  test("русские решения находятся — \\b здесь не работает, границы через \\p{L}", () => {
    const raw = jsonl(
      assistant("Решили: k=60 в RRF оставляем.\nВыбрали sqlite-vec вместо Qdrant.\nОтказались от кеша."),
    );
    const s = extractSignals(parseTranscript(raw));
    expect(s.decisions.length).toBe(3);
    expect(s.decisions[0]).toContain("k=60");
  });

  test("счётчик правок считает только инструменты правки, не чтения", () => {
    const raw = jsonl(
      assistant("работаю", [
        { name: "Edit", input: { file_path: "src/a.ts" } },
        { name: "Read", input: { file_path: "src/b.ts" } },
        { name: "Read", input: { file_path: "src/b.ts" } },
        { name: "Write", input: { file_path: "src/a.ts" } },
      ]),
    );
    const s = extractSignals(parseTranscript(raw));
    expect(s.files).toEqual([{ path: "src/a.ts", count: 2 }]);
  });

  test("вызовы myc снимаются как готовые атомы", () => {
    const raw = jsonl(
      assistant("делаю", [{ name: "Bash", input: { command: 'myc remember "RRF k=60 оставляем"' } }]),
    );
    const s = extractSignals(parseTranscript(raw));
    expect(s.mycCalls[0]).toContain('myc remember "RRF k=60');
  });

  test("строка команды не попадает в решения — она уже снята как вызов myc", () => {
    const raw = jsonl(
      assistant("ок", [{ name: "Bash", input: { command: 'myc remember "k=60 оставляем"' } }]),
    );
    const s = extractSignals(parseTranscript(raw));
    expect(s.decisions).toEqual([]);
  });

  test("одно и то же решение не дублируется", () => {
    const raw = jsonl(assistant("Решили: k=60."), assistant("решили: K=60"));
    const s = extractSignals(parseTranscript(raw));
    expect(s.decisions.length).toBe(1);
  });

  test("документация, приехавшая как tool_result, решением не становится", () => {
    // Реальный случай с 14 МБ транскрипта этого репозитория: агент читает
    // docs/design через Read, текст доезжает как tool_result — и «Берём:
    // ready-очередь» из чужого файла попадало в РЕШЕНО как решение сессии.
    const raw = jsonl({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            content: "Берём: ready-очередь и атомарный claim.\nРешили: k=60 (это из документа, не из сессии).",
          },
        ],
      },
    });
    const s = extractSignals(parseTranscript(raw));
    expect(s.decisions).toEqual([]);
  });

  test("`myc close` из таблицы документации не считается вызовом", () => {
    const raw = jsonl({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "### 3.6 `myc close` — закрыть\n### 3.8 `myc remember` — записать факт" }],
      },
    });
    const s = extractSignals(parseTranscript(raw));
    expect(s.mycCalls).toEqual([]);
  });

  test("настоящий вызов myc из команды находится", () => {
    const raw = jsonl(
      assistant("пишу", [
        { name: "Bash", input: { command: 'cd /repo && myc remember "k=60 оставляем" --tag rrf' } },
      ]),
    );
    const s = extractSignals(parseTranscript(raw));
    expect(s.mycCalls.length).toBe(1);
    expect(s.mycCalls[0]).toContain("k=60");
  });

  test("открытые вопросы отделены от решений", () => {
    const raw = jsonl(assistant("TODO: бенч на 100k не прогнан."));
    const s = extractSignals(parseTranscript(raw));
    expect(s.open.length).toBe(1);
    expect(s.decisions).toEqual([]);
  });
});
