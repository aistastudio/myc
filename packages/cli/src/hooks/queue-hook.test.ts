/**
 * Разбор хука очереди (hooks/queue-hook.ts): что тяжёлое, что нет, куда
 * встаёт `myc run --`. Исполняется ТОТ ЖЕ текст QUEUE_CLASSIFIER_JS, что
 * вклеивается в helper, — через `new Function`, без копии.
 *
 * Хук настоящим процессом, как его зовёт хост, — в queue-hook.multiprocess.test.ts.
 *
 * Мутации, на которых этот файл обязан краснеть (проверены на приёмке):
 *   «точечный bun test тяжёлый» — `$` в шаблоне не читается (bare всегда
 *       false): падает «точечный прогон проходит мимо очереди»;
 *   «двойное оборачивание», две формы:
 *     — шаблон ищется в любом месте команды, а не с командного слова:
 *       `myc run -- bun test` превращается в `myc run -- myc run -- bun test`,
 *       падают «уже обёрнутое не трогается» и идемпотентность;
 *     — снят сторож queued(): падает «шаблон «+myc» … не myc run».
 */

import { describe, expect, test } from "bun:test";
import {
  HEAVY_PATTERNS,
  PREFILTER_WORDS,
  QUEUE_CLASSIFIER_JS,
  QUEUE_ENV,
  queueClassifierConfig,
  queueHelper,
  queueHookCommand,
} from "./queue-hook.ts";
import { DEFAULT_LANE, HELD_ENV } from "../run-queue.ts";

interface Classifier {
  plan(command: string, pats: unknown[]): number[];
  insert(command: string, at: number[], word: string): string;
  patterns(env: Record<string, string | undefined>): unknown[];
  held(env: Record<string, string | undefined>): boolean;
  mycWord(cmd: string, env: Record<string, string | undefined>, dir: string): string | null;
  hook(payload: unknown, env: Record<string, string | undefined>, dir: string, cmd: string): string;
  ruleOf(content: string): unknown;
  matchRule(rule: unknown, text: string): boolean;
}

/** Файлы настроек Claude Code для разбора: путь → текст (нет — null). */
type Files = Record<string, string>;

function classifier(exists: (p: string) => boolean = () => true, files: Files = {}): Classifier {
  const make = new Function(`${QUEUE_CLASSIFIER_JS}\nreturn makeQueueClassifier;`)() as (
    o: unknown,
    host: unknown,
  ) => Classifier;
  return make(queueClassifierConfig(), {
    exists,
    read: (p: string) => files[p] ?? null,
    join: (a: string, b: string) => `${a}/${b}`,
    resolve: (a: string, b: string) => (b.startsWith("/") ? b : `${a}/${b}`),
    delimiter: ":",
  });
}

const Q = classifier();
const BUILTIN = Q.patterns({});

/** Команда после хука: переписанная или та же. */
function wrap(command: string, env: Record<string, string | undefined> = {}): string {
  const at = Q.plan(command, Q.patterns(env));
  return at.length === 0 ? command : Q.insert(command, at, "myc");
}

describe("что тяжёлое", () => {
  test.each([
    ["bun test", "myc run -- bun test"],
    ["bun test --timeout 20000", "myc run -- bun test --timeout 20000"],
    ["bun test -t 'name pattern'", "myc run -- bun test -t 'name pattern'"],
    ["bun run build", "myc run -- bun run build"],
    ["bun run typecheck", "myc run -- bun run typecheck"],
    ["npm test", "myc run -- npm test"],
    ["pnpm -r test", "myc run -- pnpm -r test"],
    ["cargo test --release", "myc run -- cargo test --release"],
    ["cargo build", "myc run -- cargo build"],
    ["go test ./...", "myc run -- go test ./..."],
    ["go test -race ./...", "myc run -- go test -race ./..."],
    ["pytest", "myc run -- pytest"],
    ["python -m pytest -x", "myc run -- python -m pytest -x"],
    ["make", "myc run -- make"],
    ["make -j8 all", "myc run -- make -j8 all"],
    ["/usr/bin/make", "myc run -- /usr/bin/make"],
  ])("%s", (command, expected) => {
    expect(wrap(command)).toBe(expected);
  });
});

describe("что не тяжёлое", () => {
  test.each([
    // Точечный прогон — задача прямо так и говорит: `bun test path/file` НЕ тяжёлый.
    ["bun test path/file.test.ts"],
    ["bun test packages/cli/src/hooks/queue-hook.test.ts --timeout 20000"],
    ["bun test wire"],
    ["pytest tests/test_x.py"],
    ["python3 -m pytest tests/"],
    ["go test ./pkg"],
    ["bun run build:site"],
    ["bun install"],
    ["git diff packages/cli/src/commands/wire.test.ts"],
    ["ls -la"],
    ["echo 'bun test'"],
    // Наблюдатель держал бы слот, пока его не убьют.
    ["bun test --watch"],
  ])("%s", (command) => {
    expect(wrap(command)).toBe(command);
  });

  test("точечный прогон проходит мимо очереди, полный — через неё", () => {
    expect(Q.plan("bun test path/file.test.ts", BUILTIN)).toEqual([]);
    expect(Q.plan("bun test", BUILTIN)).toEqual([0]);
  });
});

describe("куда встаёт myc run", () => {
  test.each([
    ["cd packages/cli && bun test", "cd packages/cli && myc run -- bun test"],
    ["bun install && bun test", "bun install && myc run -- bun test"],
    ["bun test 2>&1 | tail -30", "myc run -- bun test 2>&1 | tail -30"],
    ["bun test > log.txt 2>&1", "myc run -- bun test > log.txt 2>&1"],
    ["CI=1 bun test", "CI=1 myc run -- bun test"],
    ["env CI=1 bun test", "env CI=1 myc run -- bun test"],
    ["time bun test", "time myc run -- bun test"],
    ["if bun test; then echo ok; fi", "if myc run -- bun test; then echo ok; fi"],
    ["for f in a b; do bun test; done", "for f in a b; do myc run -- bun test; done"],
    ["(cd x && bun test)", "(cd x && myc run -- bun test)"],
    ["{ bun test; }", "{ myc run -- bun test; }"],
    ["bun run build && bun run typecheck", "myc run -- bun run build && myc run -- bun run typecheck"],
    ["bun test\\\n  --bail", "myc run -- bun test\\\n  --bail"],
    ["'bun' test", "myc run -- 'bun' test"],
  ])("%s", (command, expected) => {
    expect(wrap(command)).toBe(expected);
  });

  test("тело here-doc — не команда, а команда после него — команда", () => {
    const command = "cat <<EOF > notes.txt\nbun test\nEOF\nbun test";
    expect(wrap(command)).toBe("cat <<EOF > notes.txt\nbun test\nEOF\nmyc run -- bun test");
  });

  test("комментарий и строка в кавычках — не команды", () => {
    expect(wrap("# bun test\nls")).toBe("# bun test\nls");
    expect(wrap('echo "bun test" && echo \'make\'')).toBe('echo "bun test" && echo \'make\'');
  });

  test("вне понятого подмножества shell — команда как есть", () => {
    for (const command of ['bun test "unterminated', "bun test >", "cat <<EOF\nbun test"]) {
      expect(wrap(command)).toBe(command);
    }
  });
});

describe("что хук не трогает никогда", () => {
  test("уже обёрнутое не трогается", () => {
    for (const command of [
      "myc run -- bun test",
      "myc run --max-wait 10m -- make",
      "./dist/myc run -- cargo test",
      "CI=1 myc run -- bun test",
      "cd x && '/opt/my tools/myc' run -- bun test",
    ]) {
      expect(wrap(command)).toBe(command);
    }
  });

  /**
   * Свой шаблон может назвать тяжёлыми команды самого myc (`myc reindex`,
   * `myc code index` — долгие), но `myc run` не станет тяжёлым никогда:
   * иначе хук обернул бы собственную обёртку.
   */
  test("шаблон «+myc» ставит в очередь myc reindex, но не myc run", () => {
    const env = { [QUEUE_ENV]: "+myc" };
    expect(wrap("myc reindex", env)).toBe("myc run -- myc reindex");
    expect(wrap("myc run -- bun test", env)).toBe("myc run -- bun test");
    expect(wrap("myc -C ../other run --max-wait 1m -- make", env)).toBe("myc -C ../other run --max-wait 1m -- make");
    expect(wrap("myc remember 'run tests before a release'", env)).toBe("myc run -- myc remember 'run tests before a release'");
  });

  /**
   * Идемпотентность — то же свойство с другой стороны: вывод хука, поданный
   * хуку ещё раз, не меняется. Иначе повтор команды агентом (или второй
   * такой же хук) давал бы `myc run -- myc run -- …`.
   */
  test("хук над выводом хука ничего не меняет", () => {
    const corpus = [
      "bun test",
      "cd a && bun test 2>&1 | tail -5",
      "CI=1 make -j8",
      "bun run build && bun run typecheck && go test ./...",
      "if pytest; then cargo build; fi",
    ];
    for (const command of corpus) {
      const once = wrap(command);
      expect(once).not.toBe(command);
      expect(wrap(once)).toBe(once);
    }
  });

  test("фон (&) не трогается: слот держал бы то, чего никто не ждёт", () => {
    expect(wrap("bun test &")).toBe("bun test &");
    expect(wrap("bun test 2>&1 & echo started")).toBe("bun test 2>&1 & echo started");
  });

  test(`${HELD_ENV} в самой команде — вложенный запуск, не трогается`, () => {
    expect(wrap(`${HELD_ENV}=${DEFAULT_LANE} bun test`)).toBe(`${HELD_ENV}=${DEFAULT_LANE} bun test`);
  });

  test(`${HELD_ENV} в окружении хука: полоса занята предком`, () => {
    expect(Q.held({ [HELD_ENV]: DEFAULT_LANE })).toBe(true);
    expect(Q.held({ [HELD_ENV]: `other, ${DEFAULT_LANE}` })).toBe(true);
    expect(Q.held({ [HELD_ENV]: "other" })).toBe(false);
    expect(Q.held({})).toBe(false);
  });
});

describe(`шаблоны: встроенные и ${QUEUE_ENV}`, () => {
  test("без переменной — встроенный список", () => {
    expect(Q.patterns({}).length).toBe(HEAVY_PATTERNS.length);
  });

  test("переменная заменяет список", () => {
    const env = { [QUEUE_ENV]: "just test; mvn verify" };
    expect(wrap("just test", env)).toBe("myc run -- just test");
    expect(wrap("mvn -q verify", env)).toBe("myc run -- mvn -q verify");
    expect(wrap("bun test", env)).toBe("bun test");
  });

  test("ведущий + добавляет к встроенным", () => {
    const env = { [QUEUE_ENV]: "+just test" };
    expect(wrap("just test", env)).toBe("myc run -- just test");
    expect(wrap("bun test", env)).toBe("myc run -- bun test");
  });

  test("off, пустая строка — хук не оборачивает ничего", () => {
    for (const v of ["off", "", "none", "0"]) expect(wrap("bun test", { [QUEUE_ENV]: v })).toBe("bun test");
  });

  test("$ в своём шаблоне — тоже «без позиционных аргументов», путь со слешем — как написан", () => {
    const env = { [QUEUE_ENV]: "vitest run $;./gradlew build" };
    expect(wrap("vitest run", env)).toBe("myc run -- vitest run");
    expect(wrap("vitest run src/a.test.ts", env)).toBe("vitest run src/a.test.ts");
    expect(wrap("./gradlew build", env)).toBe("myc run -- ./gradlew build");
  });
});

/**
 * Предфильтр на shell хоста пропускает дальше только команду со словом из
 * PREFILTER_WORDS. Значит каждый встроенный шаблон обязан такое слово
 * содержать — иначе фильтр отсёк бы тяжёлую команду раньше, чем её увидит
 * разбор. Новый шаблон без такого слова роняет этот тест, а не очередь.
 */
describe("предфильтр — надмножество тяжёлого", () => {
  test("каждый встроенный шаблон содержит слово предфильтра", () => {
    for (const p of HEAVY_PATTERNS) {
      expect([p, PREFILTER_WORDS.some((w) => p.includes(w))]).toEqual([p, true]);
    }
  });

  test("команда хука перечисляет ровно эти слова и уступает переопределению", () => {
    const cmd = queueHookCommand("myc");
    expect(cmd).toContain(PREFILTER_WORDS.map((w) => `*${w}*`).join("|"));
    expect(cmd).toContain(`\${${QUEUE_ENV}+x}`);
  });
});

describe("решение хука целиком", () => {
  const payload = (tool_input: Record<string, unknown>, tool_name = "Bash"): unknown => ({
    session_id: "s",
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
  });

  test("тяжёлое: updatedInput — весь ввод с новой командой, решения о правах нет", () => {
    const out = Q.hook(payload({ command: "bun test", timeout: 600000, description: "Run tests" }), { PATH: "/bin" }, "/p", "myc");
    const parsed = JSON.parse(out) as { hookSpecificOutput: Record<string, unknown> };
    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      updatedInput: { command: "myc run -- bun test", timeout: 600000, description: "Run tests" },
    });
    expect(parsed.hookSpecificOutput["permissionDecision"]).toBeUndefined();
  });

  test("путь от корня проекта становится абсолютным: агент мог уйти cd в другой каталог", () => {
    const out = Q.hook(payload({ command: "make" }), {}, "/proj dir", "dist/myc");
    expect((JSON.parse(out) as { hookSpecificOutput: { updatedInput: { command: string } } }).hookSpecificOutput.updatedInput.command).toBe(
      "'/proj dir/dist/myc' run -- make",
    );
  });

  test("не Bash, фон, занятая полоса, лёгкая команда — пустой вывод", () => {
    expect(Q.hook(payload({ command: "bun test" }, "Write"), {}, "/p", "myc")).toBe("");
    expect(Q.hook(payload({ command: "bun test", run_in_background: true }), {}, "/p", "myc")).toBe("");
    expect(Q.hook(payload({ command: "bun test" }), { [HELD_ENV]: DEFAULT_LANE, PATH: "/bin" }, "/p", "myc")).toBe("");
    expect(Q.hook(payload({ command: "ls" }), { PATH: "/bin" }, "/p", "myc")).toBe("");
    expect(Q.hook(null, {}, "/p", "myc")).toBe("");
  });

  test("выбранного myc больше нет — команда как есть, но вслух (systemMessage), а не молча", () => {
    const gone = classifier(() => false);
    const out = gone.hook(payload({ command: "bun test" }), { PATH: "/bin" }, "/p", "dist/myc");
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(parsed["hookSpecificOutput"]).toBeUndefined();
    expect(String(parsed["systemMessage"])).toContain("dist/myc is not found");
  });
});

/**
 * ПРАВА (доработка memory-sj2h9k235rxs). `myc run -- X` исполняет что угодно,
 * поэтому решение хука — по ИСХОДНОЙ команде и правилам пользователя: без
 * вопроса проходит только то, что прошло бы и без myc. Семантика правил и
 * решения хука — из бинаря Claude Code 2.1.267 (см. шапку queue-hook.ts):
 * `X:*` — `X` или `X …`; решение `ask` задаёт вопрос всегда, `allow`
 * проходит без вопроса, если нет deny/ask-правила на НОВЫЙ ввод; без решения
 * — обычная проверка нового ввода, а правила wire `myc run` не разрешают.
 *
 * Мутация, на которой этот блок обязан краснеть (проверена на приёмке):
 *   «хук отвечает allow без проверки исходной команды» — `allow` на любую
 *   переписанную: падают «без правила — без решения», «широкое правило —
 *   вопрос» и «агентский myc run -- rm -rf».
 */
describe("права: решение по исходной команде", () => {
  const HOME = "/home/u";
  const USER = `${HOME}/.claude/settings.json`;
  const PROJECT = "/p/.claude/settings.json";
  const env = { HOME, PATH: "/bin" };
  const settings = (perms: Record<string, string[]>): string => JSON.stringify({ permissions: perms });

  function decide(command: string, files: Files, mode = "default"): Record<string, any> | null {
    const out = classifier(() => true, files).hook(
      { tool_name: "Bash", permission_mode: mode, tool_input: { command, description: "d" } },
      env,
      "/p",
      "myc",
    );
    return out === "" ? null : (JSON.parse(out) as Record<string, any>);
  }
  const spec = (r: Record<string, any> | null): Record<string, any> | undefined => r?.["hookSpecificOutput"];

  test("переписанный bun test при правиле пользователя Bash(bun test:*) — allow, вопроса не будет", () => {
    const r = spec(decide("bun test", { [PROJECT]: settings({ allow: ["Bash(bun test:*)"] }) }));
    expect(r?.["permissionDecision"]).toBe("allow");
    expect(r?.["permissionDecisionReason"]).toContain("Bash(bun test:*)");
    expect(r?.["updatedInput"]?.["command"]).toBe("myc run -- bun test");
  });

  test("правило в пользовательском слое работает так же, как в проектном", () => {
    const r = spec(decide("bun test --timeout 20000", { [USER]: settings({ allow: ["Bash(bun test:*)"] }) }));
    expect(r?.["permissionDecision"]).toBe("allow");
  });

  test("без правила — переписано без решения: Claude Code спросит, и в вопросе вся команда", () => {
    const r = spec(decide("bun test", {}));
    expect(r?.["permissionDecision"]).toBeUndefined();
    expect(r?.["updatedInput"]?.["command"]).toBe("myc run -- bun test");
  });

  test("агентский myc run -- rm -rf — не одобряется: без правил нет решения, с широким Bash(myc:*) — вопрос", () => {
    expect(decide("myc run -- rm -rf /tmp/x", {})).toBeNull();
    const r = spec(decide("myc run -- rm -rf /tmp/x", { [USER]: settings({ allow: ["Bash(myc:*)"] }) }));
    expect(r?.["permissionDecision"]).toBe("ask");
    expect(r?.["permissionDecisionReason"]).toContain("'rm -rf /tmp/x'");
    expect(r?.["permissionDecisionReason"]).toContain("Bash(myc:*)");
  });

  test("агентский myc run -- bun test при Bash(bun test:*) — allow, без переписывания", () => {
    const r = spec(decide("myc run --max-wait 10m -- bun test", { [PROJECT]: settings({ allow: ["Bash(bun test:*)"] }) }));
    expect(r?.["permissionDecision"]).toBe("allow");
    expect(r?.["updatedInput"]).toBeUndefined();
  });

  test("тяжёлая без своего правила при широком Bash(myc:*) — вопрос, а не проход по чужому правилу", () => {
    const r = spec(decide("bun test", { [USER]: settings({ allow: ["Bash(myc:*)"] }) }));
    expect(r?.["permissionDecision"]).toBe("ask");
    expect(r?.["updatedInput"]?.["command"]).toBe("myc run -- bun test");
  });

  test("deny на исходную: тяжёлую не переписываем (откажет Claude Code), агентский myc run — deny", () => {
    const files = { [PROJECT]: settings({ allow: ["Bash(myc:*)"], deny: ["Bash(bun test:*)", "Bash(rm:*)"] }) };
    expect(decide("bun test", files)).toBeNull();
    expect(decide("bun test", files, "bypassPermissions")).toBeNull();
    const r = spec(decide("myc run -- rm -rf /tmp/x", files));
    expect(r?.["permissionDecision"]).toBe("deny");
    expect(r?.["permissionDecisionReason"]).toContain("Bash(rm:*)");
  });

  test("ask-правило на исходную сохраняется: вопрос, даже если есть allow и даже в bypassPermissions", () => {
    const files = { [PROJECT]: settings({ allow: ["Bash(bun test:*)"], ask: ["Bash(bun test:*)"] }) };
    for (const mode of ["default", "bypassPermissions", "auto"]) {
      expect([mode, spec(decide("bun test", files, mode))?.["permissionDecision"]]).toEqual([mode, "ask"]);
    }
  });

  test("не одна простая команда: за цепочку не ручаемся; разрешённую как написано — не трогаем", () => {
    const files = { [PROJECT]: settings({ allow: ["Bash(bun test:*)"] }) };
    expect(decide("bun test 2>&1 | tail -30", files)).toBeNull();
    expect(decide("bun test > log.txt", files)).toBeNull();
    // Без правила цепочка всё равно спросила бы — переписываем без решения.
    expect(spec(decide("cd x && bun test", {}))?.["updatedInput"]?.["command"]).toBe("cd x && myc run -- bun test");
    // N>&M — не запись в файл: одна простая команда.
    expect(spec(decide("bun test 2>&1", files))?.["permissionDecision"]).toBe("allow");
  });

  test("dontAsk: спросить некого — тяжёлая как есть, агентский myc run при широком правиле — deny", () => {
    const files = { [USER]: settings({ allow: ["Bash(myc:*)"] }) };
    expect(decide("bun test", files, "dontAsk")).toBeNull();
    expect(spec(decide("myc run -- make", files, "dontAsk"))?.["permissionDecision"]).toBe("deny");
  });

  test("bypassPermissions и Bash целиком в allow — переписываем без решения", () => {
    expect(spec(decide("bun test", {}, "bypassPermissions"))?.["permissionDecision"]).toBeUndefined();
    const all = spec(decide("bun test", { [USER]: settings({ allow: ["Bash"] }) }));
    expect([all?.["permissionDecision"], all?.["updatedInput"]?.["command"]]).toEqual([undefined, "myc run -- bun test"]);
  });

  test("битый файл настроек — ручаться нечем: allow не выносится", () => {
    const r = spec(decide("bun test", { [PROJECT]: settings({ allow: ["Bash(bun test:*)"] }), [USER]: "{not json" }));
    expect(r?.["permissionDecision"]).not.toBe("allow");
  });

  test("сравнение правил — как у Claude Code: X:* это X или «X …», * — шаблон, иначе точное", () => {
    const Qr = classifier();
    const m = (rule: string, text: string): boolean => Qr.matchRule(Qr.ruleOf(rule), text) as boolean;
    expect(m("bun test:*", "bun test")).toBe(true);
    expect(m("bun test:*", "bun  test  path/a.test.ts")).toBe(true);
    expect(m("bun test:*", "bun testing")).toBe(false);
    expect(m("myc:*", "myc run -- rm -rf /")).toBe(true);
    expect(m("myc prime:*", "myc run -- rm -rf /")).toBe(false);
    expect(m("git *", "git")).toBe(true);
    expect(m("git *", "git status")).toBe(true);
    expect(m("npm run build", "npm run build")).toBe(true);
    expect(m("npm run build", "npm run build -- --prod")).toBe(false);
  });
});

describe("helper", () => {
  test("текст helper'а не зависит от проекта и от выбранного myc", () => {
    expect(queueHelper()).toBe(queueHelper());
    expect(queueHelper()).toContain(QUEUE_CLASSIFIER_JS);
    expect(queueHelper()).not.toContain("dist/myc");
  });
});
