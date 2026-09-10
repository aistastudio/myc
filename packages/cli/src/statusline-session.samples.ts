/**
 * Образцы поведения классификатора строки статуса и отпечаток по ним.
 *
 * Состояние сессии в кеше хранит счётчики, посчитанные ОДНОЙ логикой; сменилась
 * логика — счёт обязан начаться заново, а для этого должна смениться
 * CLASSIFIER_VERSION. Этот файл делает её подъём неизбежным: классификация
 * фиксированного набора образцов сворачивается в хэш, и тест держит историю
 * «версия → отпечаток» (statusline-session.test.ts). Поменял, как считается
 * хоть один образец, и не поднял версию — тест красный и говорит, что делать.
 *
 * Не тест и не рантайм: импортирует его только тест (и разовые замеры), в
 * сборку CLI он не попадает. Образцы — реальные формы из транскриптов:
 * heredoc со спекой, многострочные команды, обёртки, кавычки, комментарии,
 * проза в командной позиции; исходы MCP и Bash — ошибка, отказ, пусто, польза.
 */

import { createHash } from "node:crypto";

export interface ClassifierApi {
  findMycInvocation(command: string): { readonly cmd: string } | null;
  classifyMcp(cmd: string, block: { is_error?: unknown; content?: unknown }, entry: { mcpMeta?: unknown }): string;
  classifyCli(cmd: string, block: { is_error?: unknown; content?: unknown }, entry: { toolUseResult?: unknown }): string;
}

export const BASH_SAMPLES: readonly string[] = [
  "myc show x",
  "./dist/myc ready 2>&1 | head -5",
  "cd /r && MYC_DRAIN=0 ./dist/myc code search foo --json",
  "for i in 1 2; do ./dist/myc recall q; done",
  '"${CLAUDE_PROJECT_DIR:-.}/dist/myc" -C /x --db a.db callers f',
  "bun packages/cli/src/main.ts remember 'факт'",
  "nohup env A=1 myc prime",
  'git commit -m "fix; myc show x"',
  "grep -n myc file.ts",
  "cat > spec.md <<'EOF'\n# Спека\nmyc show memory-x покажет задачу\n./dist/myc ready\nEOF\n",
  "cat <<EOF | ./dist/myc import -\n{}\nEOF",
  "cd /Users/x/memory\n./dist/myc show x",
  "cat notes.txt\nmyc стоит в горячем пути агента",
  "# myc show x — комментарий; myc show y\nls -la",
  "cat <<-\tEND\n\tmyc show y\n\tEND\n./dist/myc list",
  "myc --version",
  "python3 - <<PY\nimport os\nos.system('myc show z')\nPY",
  "echo $(( 1 << 2 ))\n./dist/myc recall q",
  "./dist/myc \\\n  --json callers f",
];

type Block = { is_error?: unknown; content?: unknown };

export const MCP_SAMPLES: readonly (readonly [string, Block, { mcpMeta?: unknown }])[] = [
  ["recall", { content: "{}" }, { mcpMeta: { structuredContent: { rows: [{ id: "a" }], shown: 1 } } }],
  ["recall", { content: "{}" }, { mcpMeta: { structuredContent: { rows: [], shown: 0 } } }],
  ["recall", { content: '{"rows":[],"shown":0}' }, {}],
  ["show", { content: "myc: notfound.node: узел x не найден", is_error: true }, {}],
  ["update", { content: "myc: conflict.claimed: задача занята", is_error: true }, {}],
  ["show", { content: "myc: internal.unexpected: boom", is_error: true }, {}],
  ["callers", { content: "{}" }, { mcpMeta: { structuredContent: { edges: [], total_edges: 0 } } }],
  ["callers", { content: "{}" }, { mcpMeta: { structuredContent: { edges: [{}], total_edges: 1 } } }],
  ["ready", { content: "{}" }, { mcpMeta: { structuredContent: { claimed: { id: "t" } } } }],
  ["ready", { content: "{}" }, { mcpMeta: { structuredContent: { items: [] } } }],
  ["code search", { content: "{}" }, { mcpMeta: { structuredContent: { hits: [] } } }],
  ["remember", { content: "записано memory-x" }, { mcpMeta: { structuredContent: { id: "m" } } }],
];

/** Исход Bash так, как его пишет Claude Code 2.1.267: объект при коде 0, строка «Error: Exit code N» иначе. */
function bash(stdout: string, code = 0, stderr = "", interrupted = false): [Block, { toolUseResult: unknown }] {
  if (code !== 0) {
    return [{ is_error: true, content: `Exit code ${code}\n${stdout}${stderr}` }, { toolUseResult: `Error: Exit code ${code}\n${stdout}${stderr}` }];
  }
  return [{ content: stdout }, { toolUseResult: { stdout, stderr, interrupted, isImage: false, noOutputExpected: false } }];
}

export const CLI_SAMPLES: readonly (readonly [string, Block, { toolUseResult?: unknown }])[] = [
  ["show", ...bash("", 3, "myc: notfound.node: узел x не найден\n")],
  ["ready", ...bash("something\n", 1)],
  ["update", ...bash("myc: usage.invalid: unknown flag --claim\n")],
  ["recall", ...bash('{"ok":true,"cmd":"recall","data":{"rows":[],"shown":0,"total":0}}\n')],
  ["recall", ...bash('{"ok":true,"cmd":"recall","data":{"rows":[{"id":"a"}],"shown":1}}\n')],
  ["claim", ...bash('{"ok":false,"cmd":"claim","data":null,"error":{"code":"conflict.claimed","msg":"x","exit":4}}\n')],
  ["recall", ...bash("0 из 0 · пусто · project: ни один из 481 видимых узлов не совпал\n")],
  ["list", ...bash("3 из 3 · 6 мс\n")],
  ["ready", ...bash("0 ready · 31 blocked · 2 in_progress · 6 мс\n")],
  ["code grep", ...bash('"zz" — 0 вхождений в 0 символах, файлов 0 (просмотрено 602)\n')],
  ["code search", ...bash("0 файлов · ступени — · 2 мс\nWARN code_search.empty: ни одна ступень не нашла ничего\n")],
  ["callers", ...bash("символов 1, групп 2, вхождений 11  [call 10, import 1]\n")],
  ["show", ...bash("x  task  P1  open\n")],
  ["recall", ...bash("", 0, "", true)],
  // Английские подвалы (v3): те же шесть команд, ноль и не ноль у каждой.
  // Код поиска — без WARN-строки: иначе пустоту решает она, а не счётчик.
  ["recall", ...bash("0 of 0 · 4 ms\n")],
  ["recall", ...bash("2 of 5 · 4 ms\n")],
  ["search", ...bash("0 of 0 · 3 ms\n")],
  ["search", ...bash("1 of 1 · 3 ms\n")],
  ["list", ...bash("0 of 0 · 6 ms\n")],
  ["list", ...bash("3 of 3 · 6 ms\n")],
  ["code grep", ...bash('"zz" — 0 occurrences in 0 symbols, files 0 (scanned 602)\n')],
  ["code grep", ...bash('"fooBar" — 2 occurrences in 1 symbol, files 1 (scanned 3)\n')],
  ["code search", ...bash("0 files · stages — · 2 ms\n")],
  ["code search", ...bash("1 file · stages bm25 · 2 ms\n")],
  ["callers", ...bash("symbols 1, groups 0, occurrences 0\n")],
  ["callers", ...bash("symbols 1, groups 2, occurrences 11  [call 10, import 1]\n")],
];

/** Отпечаток поведения: как классификатор отвечает на все образцы. */
export function behaviorFingerprint(api: ClassifierApi): string {
  const answers = [
    ...BASH_SAMPLES.map((c) => api.findMycInvocation(c)?.cmd ?? null),
    ...MCP_SAMPLES.map(([cmd, block, entry]) => api.classifyMcp(cmd, block, entry)),
    ...CLI_SAMPLES.map(([cmd, block, entry]) => api.classifyCli(cmd, block, entry)),
  ];
  return createHash("sha256").update(JSON.stringify(answers)).digest("hex").slice(0, 16);
}
