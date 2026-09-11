/**
 * Хук очереди для Claude Code: тяжёлую команду агента исполняет `myc run`
 * (эпик memory-14qyv1gmacef, задача memory-sj2h9k235rxs).
 *
 * ЗАЧЕМ. Очередь есть (`myc run -- <cmd>`, commands/run.ts), но агенты о ней
 * не знают и зовут `bun test` напрямую — несколько агентов на машине снова
 * дерутся за ядра. Хук PreToolUse на Bash сам переписывает тяжёлую команду в
 * `myc run -- <та же команда>`; всё остальное проходит нетронутым.
 *
 * ЧТО УМЕЕТ PreToolUse — ПРОЧИТАНО В БИНАРЕ Claude Code 2.1.267
 * (~/.local/share/claude/versions/2.1.267), а не по памяти:
 *   - вывод хука: `hookSpecificOutput = {hookEventName: "PreToolUse",
 *     permissionDecision?: allow|deny|ask|defer, permissionDecisionReason?,
 *     updatedInput?: object, additionalContext?}`;
 *   - `updatedInput` БЕЗ решения — отдельная ветка исполнителя: хук отдаёт
 *     событие `hookUpdatedInput`, им заменяется ввод инструмента
 *     (`case"hookUpdatedInput":xe=In.updatedInput`), и дальше идёт ОБЫЧНАЯ
 *     проверка разрешений — уже по новому вводу;
 *   - решение хука против правил (функция с `but deny rule overrides`):
 *     `deny` — отказ; `allow`/`ask` сверяются с правилами НОВОГО ввода
 *     (`Ik`: deny-правила, ask на весь инструмент, отказ самого Bash,
 *     ask-правила, проверки безопасности): deny-правило бьёт хук, ask-правило
 *     или проверка безопасности ведут в полный путь с вопросом, иначе `allow`
 *     проходит БЕЗ вопроса, а `ask` задаёт вопрос ВСЕГДА — canUseTool с
 *     навязанным решением (`kd=async(e,n,r,o,d,p)=>{if(p)return p;…}`)
 *     allow-правила уже не смотрит. Правила ИСХОДНОЙ команды Claude Code не
 *     видит вовсе: после переписывания её нет;
 *   - поэтому права хук решает сам, по исходной команде и правилам
 *     пользователя (см. «ПРАВА» ниже), а не отдаёт это на откуп правилу,
 *     которое совпало бы с `myc run -- …`;
 *   - `updatedInput` заменяет ввод ЦЕЛИКОМ и проверяется схемой инструмента
 *     (лишние ключи прощаются, ошибка схемы — отказ): отдаём весь
 *     `tool_input` с новой командой, `timeout`/`description`/… сохраняются;
 *   - ввод Bash — `{command, timeout?, description?, run_in_background?,
 *     dangerouslyDisableSandbox?}`, и хук получает его целиком: флаг фона
 *     ВИДЕН, фоновый запуск не трогаем (слот держал бы наблюдатель `--watch`
 *     или сервер, пока его не убьют);
 *   - stdin хука — одна строка JSON и `\n`, затем EOF
 *     (`un.stdin.write(o+"\n"), un.stdin.end()`);
 *   - `timeout` записи хука — СЕКУНДЫ (`e.timeout?e.timeout*1000:…`).
 * Выбор: переписываем ввод, а не запрещаем с просьбой повторить — запрет
 * стоил бы агенту лишнего хода на каждую тяжёлую команду, а переписанную
 * команду он всё равно видит в выводе (строки ожидания `myc run` в stderr).
 *
 * ЦЕНА. Хук зовётся на КАЖДЫЙ Bash-вызов агента. Один запуск node здесь стоит
 * 23 мс p50 и до 38 мс p99 — больше бюджета prime-хука (30 мс p99) ещё до
 * первой строки кода. Поэтому команда хука в settings.json — фильтр на shell
 * самого хоста (`read` и `case`, ни одного fork): дальше проходит только
 * команда, в тексте которой есть одно из PREFILTER_WORDS, остальные выходят за
 * единицы миллисекунд. Точный разбор — helper под bun, если он есть (запуск
 * ~12 мс), иначе под node. Базы не касается ни одна из двух половин.
 *
 * ПРАВА. `myc run -- X` исполняет ПРОИЗВОЛЬНУЮ команду X, значит myc не имеет
 * права быть обходом системы разрешений. Инвариант: `myc run -- X` проходит
 * без вопроса ТОЛЬКО если X сам по себе прошёл бы по правилам пользователя;
 * иначе человек видит вопрос, и в нём видна настоящая X. Правила хук читает
 * из тех же файлов, что Claude Code (пользовательский, проектный, локальный,
 * managed), и сравнивает так же (`X:*` — `X` или `X …`, `*` — шаблон, иначе
 * точное совпадение). Решение — по исходной команде:
 *   - deny-правило совпало с исходной (или с X после `myc run --`) — тяжёлую
 *     не переписываем, Claude Code откажет ей сам; агентский `myc run -- X`
 *     получает `deny`;
 *   - команда одна и простая (без `; && || | &`, подстановок и перенаправлений,
 *     кроме `N>&M`), allow-правило совпало с ней, ask — нет: `allow`;
 *   - с исходной совпало ask-правило — `ask` (в dontAsk — не переписываем,
 *     агентский `myc run` — `deny`): Claude Code спросил бы и про исходную;
 *   - bypassPermissions или `Bash` целиком в allow — переписываем без решения:
 *     не спрашивают ни о чём, кроме deny/ask-правил, а их хук уже учёл (Claude
 *     Code сверяет их ДО режима, значит и хук обязан — иначе переписанная
 *     команда ушла бы от deny-правила исходной);
 *   - allow-правила пропустили исходную тяжёлую (каждую в цепочке), а
 *     поручиться за всю цепочку нельзя — не переписываем вовсе: вопрос на
 *     каждый прогон там, где его не было, хуже прогона вне очереди;
 *   - какое-то allow-правило пропустило бы саму `myc run …` (широкое
 *     `Bash(myc:*)` в чужом слое) — `ask` с настоящей командой в причине;
 *   - иначе переписываем БЕЗ решения: Claude Code спросит про `myc run -- X`
 *     так же, как спросил бы про X (правила wire `myc run` не разрешают).
 *
 * ГДЕ ЖИВЁТ РАЗБОР. Helper — генерируемый .mjs, а собранный бинарь myc
 * минифицирован, значит `fn.toString()` дал бы разный текст helper'а из
 * исходников и из dist. Поэтому разбор — исходник JS строкой (QUEUE_CLASSIFIER_JS):
 * тот же текст вклеивается в helper и исполняется тестами через `new Function`,
 * то есть проверяется ровно то, что ставится. В строке нет обратных кавычек и
 * `${` — только так String.raw оставляет её обычным JS.
 */

import { DEFAULT_LANE, HELD_ENV } from "../run-queue.ts";

/** Helper хука: целиком наш файл, пишется только с `--queue-hook`. */
export const QUEUE_HELPER_REL = ".claude/helpers/myc-queue.mjs";

/** По этому имени wire/unwire узнают свою запись PreToolUse среди чужих. */
export const QUEUE_HELPER_MARK = "myc-queue.mjs";

/** Переопределение списка тяжёлого: `;`-список шаблонов, `+` в начале — добавить к встроенным. */
export const QUEUE_ENV = "MYC_QUEUE_HEAVY";

/** Таймаут записи хука для хоста — секунды (см. шапку). Работа хука — десятки миллисекунд. */
export const QUEUE_HOOK_TIMEOUT_S = 5;

/**
 * Что считать тяжёлым: полный прогон тестов и сборка. Шаблон — слова,
 * которыми начинается команда (первое сравнивается по базовому имени, флаги
 * между словами пропускаются); `$` в конце — «и ни одного позиционного
 * аргумента»: `bun test` тяжёлый, `bun test path/file.test.ts` — точечный.
 * Любой `--watch…` снимает тяжесть: наблюдатель держал бы слот вечно.
 */
export const HEAVY_PATTERNS: readonly string[] = [
  "bun test $",
  "bun run test",
  "bun run build",
  "bun run typecheck",
  "npm test",
  "npm run test",
  "npm run build",
  "pnpm test",
  "pnpm run test",
  "pnpm build",
  "pnpm run build",
  "yarn test",
  "yarn build",
  "cargo test",
  "cargo build",
  "go test ./...",
  "go build ./...",
  "pytest $",
  "python -m pytest $",
  "python3 -m pytest $",
  "make",
];

/**
 * Флаги со значением у `bun test` и `pytest`: слово после них — значение, а
 * не путь. Без этого `bun test --timeout 20000` сошёл бы за точечный прогон
 * «файла 20000» и мимо очереди ушёл бы полный.
 */
export const VALUE_FLAGS: readonly string[] = [
  "--timeout", "-t", "--test-name-pattern", "--preload", "--rerun-each", "--seed",
  "--max-concurrency", "--reporter", "--reporter-outfile", "--coverage-reporter",
  "--coverage-dir", "--env-file", "--cwd", "--tsconfig-override",
  "-k", "-m", "-p", "-c", "-o", "-n", "-W", "--maxfail", "--rootdir", "--basetemp",
  "--junitxml", "--junit-xml", "--durations", "--tb", "--ignore", "--ignore-glob",
  "--deselect", "--log-level", "--capture", "--import-mode", "--dist", "--confcutdir",
];

/**
 * Слова предфильтра на shell хоста. Каждый встроенный шаблон содержит одно из
 * них (стережёт тест), поэтому фильтр пропускает НАДМНОЖЕСТВО тяжёлого: он
 * может зря позвать helper, но не может пропустить тяжёлую команду мимо него.
 * С заданным MYC_QUEUE_HEAVY фильтр отключается — чужих шаблонов он не знает.
 */
export const PREFILTER_WORDS: readonly string[] = ["test", "build", "typecheck", "make"];

/**
 * И вторая половина предфильтра — `myc … run`: агентский `myc run -- X` хук
 * тоже обязан увидеть, чтобы права решались по X, а не по слову `myc`.
 */
export const PREFILTER_QUEUED = "*myc*run*";

/**
 * Где лежат managed-настройки Claude Code (прочитано в бинаре 2.1.267:
 * `/Library/Application Support/ClaudeCode`, `/etc/claude-code`): их deny и
 * ask хук обязан видеть так же, как проектные.
 */
export const MANAGED_SETTINGS: readonly string[] = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
];

/**
 * Разбор команды и решение хука. Фабрика: `o` — списки и имена, `host` —
 * файловая система (в helper'е — node:fs/node:path, в тестах — подделка).
 *
 * Разбор понимает подмножество shell, в котором агенты пишут команды:
 * кавычки, экранирование, `$(…)`/`${…}`/обратные кавычки, `;`/`&&`/`||`/`|`/
 * `&`/перевод строки, скобки, перенаправления (`2>&1`, `&>`, `<<<`),
 * here-doc с телом и комментарии. Всё, что за пределами понятого (незакрытая
 * кавычка, перенаправление без цели), — команда проходит как есть: хук
 * имеет право ошибиться только в сторону «не встал в очередь».
 */
export const QUEUE_CLASSIFIER_JS = String.raw`function makeQueueClassifier(o, host) {
  var BQ = String.fromCharCode(96);
  var META = " \t\n;&|()<>";
  var SKIP = { "!": 1, "{": 1, "}": 1, "if": 1, "then": 1, "else": 1, "elif": 1, "fi": 1,
    "do": 1, "done": 1, "while": 1, "until": 1, "time": 1, "esac": 1 };
  var COMPOUND = { "for": 1, "case": 1, "select": 1, "function": 1, "coproc": 1 };
  var PASS = { "exec": 1, "command": 1, "env": 1 };
  var REDIR = ["<<<", "<<-", "&>>", "<<", ">>", "<>", "<&", ">&", ">|", "&>", "<", ">"];
  var PARAM = /[A-Za-z0-9_@*#?$!-]/;
  var NAME = /[A-Za-z0-9_]/;
  var valueFlags = new Set(o.valueFlags);

  function skipBacktick(src, i) {
    for (var k = i + 1; k < src.length; k++) {
      if (src[k] === "\\") { k++; continue; }
      if (src[k] === BQ) return k;
    }
    return -1;
  }

  // Closing index of the "(" or "{" at i, honouring quotes; -1 when unbalanced.
  function skipGroup(src, i, open, close) {
    var depth = 0;
    for (var k = i; k < src.length; k++) {
      var c = src[k];
      if (c === "\\") { k++; continue; }
      if (c === "'") { k = src.indexOf("'", k + 1); if (k < 0) return -1; continue; }
      if (c === '"') { var d = readDouble(src, k); if (d === null) return -1; k = d.end - 1; continue; }
      if (c === BQ) { k = skipBacktick(src, k); if (k < 0) return -1; continue; }
      if (c === open) depth++;
      else if (c === close && --depth === 0) return k;
    }
    return -1;
  }

  // "$" at i: the end of the expansion (exclusive), or -1; null when it is a literal "$".
  function skipDollar(src, i) {
    var nx = src[i + 1];
    if (nx === "(") { var e = skipGroup(src, i + 1, "(", ")"); return e < 0 ? -1 : e + 1; }
    if (nx === "{") { var b = skipGroup(src, i + 1, "{", "}"); return b < 0 ? -1 : b + 1; }
    if (nx !== undefined && PARAM.test(nx)) {
      var k = i + 2;
      if (NAME.test(nx)) while (k < src.length && NAME.test(src[k])) k++;
      return k;
    }
    return null;
  }

  function readDouble(src, i) {
    var value = "", dynamic = false;
    for (var k = i + 1; k < src.length; ) {
      var c = src[k];
      if (c === '"') return { end: k + 1, value: value, dynamic: dynamic };
      if (c === "\\") {
        var nx = src[k + 1];
        if (nx === "\n") { k += 2; continue; }
        if (nx === '"' || nx === "\\" || nx === "$" || nx === BQ) { value += nx; k += 2; continue; }
        value += c; k++; continue;
      }
      if (c === "$") {
        var e = skipDollar(src, k);
        if (e === -1) return null;
        if (e !== null) { dynamic = true; k = e; continue; }
      }
      if (c === BQ) { var t = skipBacktick(src, k); if (t < 0) return null; dynamic = true; k = t + 1; continue; }
      value += c; k++;
    }
    return null;
  }

  function readWord(src, i) {
    var start = i, value = "", dynamic = false, quoted = false;
    while (i < src.length) {
      var c = src[i];
      if (META.indexOf(c) !== -1) break;
      if (c === "\\") {
        if (src[i + 1] === "\n") { i += 2; continue; }
        if (i + 1 < src.length) { value += src[i + 1]; quoted = true; i += 2; continue; }
        value += c; i++; continue;
      }
      if (c === "'") {
        var j = src.indexOf("'", i + 1);
        if (j < 0) return null;
        value += src.slice(i + 1, j); quoted = true; i = j + 1; continue;
      }
      if (c === '"') {
        var d = readDouble(src, i);
        if (d === null) return null;
        value += d.value; quoted = true; dynamic = dynamic || d.dynamic; i = d.end; continue;
      }
      if (c === "$" && src[i + 1] === "'") {
        var k = i + 2;
        while (k < src.length && src[k] !== "'") k += src[k] === "\\" ? 2 : 1;
        if (k >= src.length) return null;
        value += src.slice(i + 2, k); quoted = true; i = k + 1; continue;
      }
      if (c === "$") {
        var e = skipDollar(src, i);
        if (e === -1) return null;
        if (e !== null) { dynamic = true; i = e; continue; }
      }
      if (c === BQ) { var t = skipBacktick(src, i); if (t < 0) return null; dynamic = true; i = t + 1; continue; }
      value += c; i++;
    }
    return { start: start, end: i, value: value, raw: src.slice(start, i), dynamic: dynamic, quoted: quoted };
  }

  function skipBodies(src, i, docs) {
    for (var h of docs) {
      while (i < src.length) {
        var eol = src.indexOf("\n", i);
        if (eol < 0) eol = src.length;
        var line = src.slice(i, eol);
        if (h.strip) line = line.replace(/^\t+/, "");
        i = eol + 1;
        if (line === h.delim) break;
      }
    }
    return Math.min(i, src.length);
  }

  // Simple commands of the text: [{words, bg, redirs, complex}], or null
  // outside the understood subset. complex: a here-doc or a process substitution.
  function scan(src) {
    var segs = [], cur = fresh(), target = null, docs = [], i = 0;
    function fresh() { return { words: [], bg: false, redirs: [], complex: false }; }
    function end(bg) {
      if (cur.words.length > 0 || cur.redirs.length > 0) { cur.bg = bg; segs.push(cur); }
      cur = fresh();
    }
    while (i < src.length) {
      var c = src[i];
      if (c === " " || c === "\t") { i++; continue; }
      if (c === "\\" && src[i + 1] === "\n") { i += 2; continue; }
      if (c === "\n") {
        if (target !== null) return null;
        end(false);
        i = docs.length > 0 ? skipBodies(src, i + 1, docs) : i + 1;
        docs = [];
        continue;
      }
      if (c === "#") { while (i < src.length && src[i] !== "\n") i++; continue; }
      if ((c === "<" || c === ">") && src[i + 1] === "(") {
        var p = skipGroup(src, i + 1, "(", ")");
        if (p < 0) return null;
        cur.complex = true;
        if (target !== null) { cur.redirs.push({ op: target, target: src.slice(i, p + 1) }); target = null; }
        else cur.words.push({ start: i, end: p + 1, value: "", raw: src.slice(i, p + 1), dynamic: true, quoted: false });
        i = p + 1;
        continue;
      }
      if (c === "<" || c === ">" || (c === "&" && src[i + 1] === ">")) {
        if (target !== null) return null;
        var op = null;
        for (var r of REDIR) if (src.startsWith(r, i)) { op = r; break; }
        i += op.length;
        target = op;
        continue;
      }
      if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
        if (target !== null) return null;
        var bg = false;
        if (c === ";") i += src[i + 1] === ";" ? (src[i + 2] === "&" ? 3 : 2) : src[i + 1] === "&" ? 2 : 1;
        else if (c === "&") { if (src[i + 1] === "&") i += 2; else { i += 1; bg = true; } }
        else if (c === "|") i += src[i + 1] === "|" || src[i + 1] === "&" ? 2 : 1;
        else i += 1;
        end(bg);
        continue;
      }
      var w = readWord(src, i);
      if (w === null || w.end === i) return null;
      i = w.end;
      if (/^[0-9]+$/.test(w.raw) && (src[i] === "<" || src[i] === ">")) continue;
      if (target !== null) {
        if (target === "<<" || target === "<<-") {
          docs.push({ delim: w.value, strip: target === "<<-" });
          cur.complex = true;
        }
        cur.redirs.push({ op: target, target: w.raw });
        target = null;
        continue;
      }
      cur.words.push(w);
    }
    if (target !== null || docs.length > 0) return null;
    end(false);
    return segs;
  }

  function isFlag(w) { return !w.dynamic && w.value.length > 1 && w.value[0] === "-"; }
  function base(v) { return v.slice(v.lastIndexOf("/") + 1); }

  // The command word of a simple command: reserved words, VAR=value and
  // exec/command/env before it are skipped. null — not a simple command.
  function commandOf(ws) {
    var k = 0, held = false;
    while (k < ws.length) {
      var w = ws[k], plain = !w.quoted && !w.dynamic;
      if (plain && SKIP[w.value] === 1) { k++; continue; }
      if (plain && COMPOUND[w.value] === 1) return null;
      var a = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(w.raw);
      if (a !== null) { if (a[1] === o.heldEnv) held = true; k++; continue; }
      if (plain && PASS[w.value] === 1 && k + 1 < ws.length && !isFlag(ws[k + 1])) { k++; continue; }
      break;
    }
    return k < ws.length ? { at: ws[k].start, words: ws.slice(k), held: held } : null;
  }

  function matches(ws, p) {
    var first = ws[0];
    if (first.dynamic) return false;
    if ((p.words[0].indexOf("/") >= 0 ? first.value : base(first.value)) !== p.words[0]) return false;
    var k = 1;
    for (var j = 1; j < p.words.length; j++) {
      var want = p.words[j];
      if (want[0] !== "-") while (k < ws.length && isFlag(ws[k])) k++;
      var w = ws[k];
      if (w === undefined || w.dynamic || w.value !== want) return false;
      k++;
    }
    if (!p.bare) return true;
    for (; k < ws.length; k++) {
      var x = ws[k];
      if (!isFlag(x)) return false;
      if (x.value.indexOf("=") < 0 && valueFlags.has(x.value)) k++;
    }
    return true;
  }

  // myc run ... is already in the queue, whatever the patterns say ("+myc" may
  // list heavy myc commands such as myc reindex, never myc run itself).
  function queued(ws) {
    if (ws[0].dynamic || base(ws[0].value) !== "myc") return false;
    for (var k = 1; k < ws.length && ws[k].value !== "--"; k++) if (!ws[k].dynamic && ws[k].value === "run") return true;
    return false;
  }

  function isHeavy(ws, pats) {
    if (queued(ws)) return false;
    for (var w of ws) if (!w.dynamic && w.value.slice(0, 7) === "--watch") return false;
    for (var p of pats) if (matches(ws, p)) return true;
    return false;
  }

  function parsePattern(text) {
    var words = String(text).trim().split(/\s+/).filter(Boolean);
    var bare = words[words.length - 1] === "$";
    if (bare) words.pop();
    return words.length > 0 ? { words: words, bare: bare } : null;
  }

  function patterns(env) {
    var builtin = o.builtin.map(parsePattern);
    var raw = env[o.envName];
    if (raw === undefined) return builtin;
    var t = String(raw).trim();
    if (t === "" || t === "off" || t === "none" || t === "0") return [];
    var add = t[0] === "+";
    var own = (add ? t.slice(1) : t).split(/[;\n]/).map(parsePattern).filter(Boolean);
    return add ? builtin.concat(own) : own;
  }

  function held(env) {
    return String(env[o.heldEnv] || "").split(",").some(function (s) { return s.trim() === o.lane; });
  }

  // Words as Claude Code compares them with a rule: raw text, single spaces,
  // redirections left out.
  function textOf(ws) { return ws.map(function (w) { return w.raw; }).join(" "); }

  // The command myc run is given: the words after its "--". null when absent.
  function innerOf(ws) {
    for (var k = 1; k < ws.length; k++) {
      if (ws[k].value !== "--" || ws[k].quoted) continue;
      var rest = ws.slice(k + 1);
      return rest.length > 0 ? { text: textOf(rest), dynamic: rest.some(function (w) { return w.dynamic; }) } : null;
    }
    return null;
  }

  // The segments of the command: heavy ones to rewrite, and myc run ones
  // (typed by the agent) whose inner command decides the permission.
  function analyze(command, pats, rewrite) {
    var segs = scan(command);
    if (segs === null) return null;
    var heavy = [], runs = [];
    for (var s of segs) {
      var c = commandOf(s.words);
      if (c === null) continue;
      if (queued(c.words)) runs.push({ seg: s, c: c, inner: innerOf(c.words) });
      else if (rewrite && !s.bg && !c.held && isHeavy(c.words, pats)) heavy.push({ seg: s, c: c });
    }
    return { segs: segs, heavy: heavy, runs: runs };
  }

  // Offsets of the command words that go through the queue, in text order.
  function plan(command, pats) {
    if (pats.length === 0) return [];
    var a = analyze(command, pats, true);
    return a === null ? [] : a.heavy.map(function (h) { return h.c.at; });
  }

  // One plain command and nothing else: no ; && || | & or newline, no
  // expansion, no prefix before the command word, no redirection but N>&M.
  function simple(a) {
    if (a.segs.length !== 1) return false;
    var s = a.segs[0], c = commandOf(s.words);
    if (s.bg || s.complex || c === null || c.at !== s.words[0].start) return false;
    for (var w of s.words) if (w.dynamic) return false;
    for (var r of s.redirs) if (!((r.op === ">&" || r.op === "<&") && /^([0-9]+|-)$/.test(r.target))) return false;
    return true;
  }

  // --- the user's permission rules, read and matched as Claude Code 2.1.267 does ---

  function norm(s) { return String(s).replace(/[ \t]+/g, " ").trim(); }

  function hasStar(s) {
    for (var i = 0; i < s.length; i++) {
      if (s[i] !== "*") continue;
      var b = 0;
      for (var j = i - 1; j >= 0 && s[j] === "\\"; j--) b++;
      if (b % 2 === 0) return true;
    }
    return false;
  }

  // "X:*" — X or "X ...", a pattern with "*" — a wildcard (a trailing " *"
  // with the only star also matches X alone), anything else — the exact command.
  function ruleOf(content) {
    var m = /^([\s\S]+):\*$/.exec(content);
    if (m !== null) return { type: "prefix", prefix: norm(m[1]) };
    if (hasStar(content)) return { type: "wildcard", pattern: content.trim() };
    return { type: "exact", command: content };
  }

  function wildcard(pattern, text) {
    var src = "", stars = 0;
    for (var i = 0; i < pattern.length; i++) {
      var c = pattern[i];
      if (c === "\\" && (pattern[i + 1] === "*" || pattern[i + 1] === "\\")) { src += "\\" + pattern[i + 1]; i++; continue; }
      if (c === "*") { src += ".*"; stars++; continue; }
      src += c.replace(/[.+?^$|()[\]{}\\'"]/g, "\\$&");
    }
    if (stars === 1 && src.slice(-3) === " .*") src = src.slice(0, -3) + "( .*)?";
    return new RegExp("^" + src + "$", "s").test(text);
  }

  function matchRule(r, text) {
    var t = norm(text);
    if (r.type === "prefix") return t === r.prefix || t.slice(0, r.prefix.length + 1) === r.prefix + " ";
    if (r.type === "wildcard") return wildcard(r.pattern, t);
    return r.command === t || r.command === String(text).trim();
  }

  // Bash rules from the settings Claude Code reads: user, project, local, managed.
  function loadRules(dir, env) {
    var R = { allow: [], deny: [], ask: [], allowAll: false, denyAll: false, askAll: false, unsure: false };
    var home = env.CLAUDE_CONFIG_DIR || host.join(env.HOME || "", ".claude");
    var files = [host.join(home, "settings.json"), host.join(dir, ".claude/settings.json"),
      host.join(dir, ".claude/settings.local.json")].concat(o.managed);
    for (var f of files) {
      var text = host.read(f);
      if (text === null) continue;
      var doc = null;
      try { doc = JSON.parse(text); } catch (e) { R.unsure = true; continue; }
      var perms = doc !== null && typeof doc === "object" ? doc.permissions : null;
      if (perms === null || typeof perms !== "object") continue;
      for (var kind of ["allow", "deny", "ask"]) {
        for (var rule of Array.isArray(perms[kind]) ? perms[kind] : []) {
          if (typeof rule !== "string") continue;
          var s = rule.trim();
          if (s === "Bash") { R[kind + "All"] = true; continue; }
          var m = /^Bash\(([\s\S]*)\)$/.exec(s);
          if (m !== null && m[1].trim() !== "") R[kind].push({ text: s, rule: ruleOf(m[1]) });
        }
      }
    }
    return R;
  }

  function firstMatch(list, texts) {
    for (var r of list) for (var t of texts) if (matchRule(r.rule, t)) return r.text;
    return null;
  }

  function insert(command, at, word) {
    var out = command;
    for (var k = at.length - 1; k >= 0; k--) out = out.slice(0, at[k]) + word + " run -- " + out.slice(at[k]);
    return out;
  }

  function quote(s) {
    return /^[A-Za-z0-9_\/.,:@%+=-]+$/.test(s) ? s : "'" + s.split("'").join("'\\''") + "'";
  }

  // The myc chosen by wire: a bare name is looked up in PATH, a path is taken
  // relative to the project. null — it is gone.
  function mycWord(cmd, env, dir) {
    if (typeof cmd !== "string" || cmd === "") return null;
    if (cmd.indexOf("/") < 0) {
      var dirs = String(env.PATH || "").split(host.delimiter);
      for (var d of dirs) if (d && host.exists(host.join(d, cmd))) return quote(cmd);
      return null;
    }
    var abs = host.resolve(dir, cmd);
    return host.exists(abs) ? quote(abs) : null;
  }

  // The hook itself: stdout for the host, "" when the command passes as it is.
  // A rewrite goes out as updatedInput; the permission decision is taken on the
  // ORIGINAL command, because after the rewrite Claude Code no longer sees it.
  function hook(payload, env, dir, cmd) {
    if (payload === null || typeof payload !== "object" || payload.tool_name !== "Bash") return "";
    var input = payload.tool_input;
    if (input === null || typeof input !== "object" || typeof input.command !== "string") return "";
    var command = input.command, pats = patterns(env);
    var a = analyze(command, pats, input.run_in_background !== true && !held(env) && pats.length > 0);
    if (a === null || (a.heavy.length === 0 && a.runs.length === 0)) return "";

    var next = null, word = null;
    if (a.heavy.length > 0) {
      word = mycWord(cmd, env, dir);
      if (word === null && a.runs.length === 0) {
        return JSON.stringify({
          systemMessage: "myc queue hook: " + String(cmd) + " is not found, so this heavy command runs outside " +
            "the machine-wide queue; run: myc wire --queue-hook",
        }) + "\n";
      }
      if (word === null) a.heavy = [];
      else next = insert(command, a.heavy.map(function (h) { return h.c.at; }), word);
    }
    function out(decision, reason) {
      if (decision === null && next === null) return "";
      var h = { hookEventName: "PreToolUse" };
      if (decision !== null) { h.permissionDecision = decision; h.permissionDecisionReason = reason; }
      if (next !== null && decision !== "deny") h.updatedInput = Object.assign({}, input, { command: next });
      return JSON.stringify({ hookSpecificOutput: h }) + "\n";
    }

    // Deny and ask rules bind in every mode, bypassPermissions included (Claude
    // Code checks them before the mode), so they are read first, always.
    var mode = typeof payload.permission_mode === "string" ? payload.permission_mode : "default";
    var R = loadRules(dir, env);
    if (R.denyAll) return "";

    // Deny and ask are matched against more than Claude Code would look at:
    // the whole text, every segment with and without its prefixes, and the
    // command inside each myc run. Over-matching them only costs the queue.
    var texts = [norm(command)];
    for (var s of a.segs) {
      texts.push(textOf(s.words));
      var sc = commandOf(s.words);
      if (sc !== null) texts.push(textOf(sc.words));
    }
    var inner = a.runs.length === 1 && a.runs[0].inner !== null ? a.runs[0].inner.text : null;
    for (var q of a.runs) if (q.inner !== null) texts.push(q.inner.text);
    var denied = firstMatch(R.deny, texts);
    if (denied !== null) {
      if (a.runs.length === 0) return "";
      next = null;
      return out("deny", "myc: this command is denied by your rule " + denied + ", and myc run does not get around it");
    }
    var asked = R.askAll ? "Bash" : firstMatch(R.ask, texts);

    // Vouch only for one plain command that a rule of the user's allows as it is.
    var orig = a.heavy.length === 1 && a.runs.length === 0 ? textOf(a.heavy[0].c.words)
      : a.runs.length === 1 && a.heavy.length === 0 && a.runs[0].inner !== null && !a.runs[0].inner.dynamic ? inner : null;
    if (asked === null && !R.unsure && orig !== null && simple(a)) {
      var by = firstMatch(R.allow, [orig]);
      if (by !== null) {
        return out("allow", "myc: '" + orig + "' is allowed by your rule " + by +
          (next !== null ? "; it waits for its turn in the machine-wide queue" : ""));
      }
    }

    // A question that names the real command. In dontAsk there is no one to
    // ask: a heavy command stays as it was, a myc run is refused.
    var what = inner !== null ? inner : a.heavy.map(function (h) { return textOf(h.c.words); }).join("; ");
    function question(because) {
      var why = "myc: '" + what + "' runs through myc run; approve it only if you would approve '" + what + "' itself (" +
        because + ")";
      if (mode === "dontAsk") {
        next = null;
        return a.runs.length > 0 ? out("deny", why) : "";
      }
      return out("ask", why);
    }
    if (asked !== null) return question("your rule " + asked + " asks for it");
    if (mode === "bypassPermissions" || R.allowAll) return out(null, "");
    if (a.runs.length === 0 && a.heavy.length > 0 &&
      a.heavy.every(function (h) { return firstMatch(R.allow, [textOf(h.c.words)]) !== null; })) {
      return ""; // allowed as it was written: better unqueued than a question on every run
    }
    // A rule that would pass myc run itself would pass any command through it.
    var queuedTexts = a.runs.map(function (q) { return textOf(q.c.words); })
      .concat(a.heavy.map(function (h) { return word + " run -- " + textOf(h.c.words); }));
    var broad = firstMatch(R.allow, queuedTexts);
    if (broad !== null) return question("your rule " + broad + " would let any command through myc run");
    return out(null, "");
  }

  return { scan: scan, plan: plan, insert: insert, patterns: patterns, held: held, parsePattern: parsePattern,
    mycWord: mycWord, loadRules: loadRules, matchRule: matchRule, ruleOf: ruleOf, hook: hook };
}`;

/** Настройки фабрики — одни для helper'а и для тестов. */
export function queueClassifierConfig(): Record<string, unknown> {
  return {
    builtin: HEAVY_PATTERNS,
    valueFlags: VALUE_FLAGS,
    lane: DEFAULT_LANE,
    heldEnv: HELD_ENV,
    envName: QUEUE_ENV,
    managed: MANAGED_SETTINGS,
  };
}

/** `.claude/helpers/myc-queue.mjs` — текст не зависит ни от проекта, ни от выбранного myc. */
export function queueHelper(): string {
  return `#!/usr/bin/env node
// ${QUEUE_HELPER_REL} — generated by \`myc wire --queue-hook\`; edits will be overwritten.
//
// Claude Code PreToolUse hook on Bash. A heavy command (a full test run, a
// build) is rewritten to wait for its turn in the machine-wide queue:
// \`myc run -- <the same command>\`. Anything else passes untouched, and so
// does a command run in the background, one already under myc run, or one
// inside a command that holds the queue slot (${HELD_ENV}).
//
// myc run runs whatever it is given, so it must not be a way around the
// permission rules: the queued command is approved without a question only
// when the user's own rules approve the original command; otherwise Claude
// Code asks, and the whole command is in the question. A myc run typed by the
// agent is judged by the command after its "--" the same way.
//
// argv[2] is the myc that \`myc wire --queue-hook\` checked. The patterns are
// built in; ${QUEUE_ENV}="a b $;c d" replaces them, a leading "+" adds to
// them, "off" disables the hook. The rule of every myc hook holds: it never
// breaks the agent's session — on any error it prints nothing and exits 0,
// and the command runs exactly as the agent wrote it.
import { existsSync, readFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";

${QUEUE_CLASSIFIER_JS}

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};
const Q = makeQueueClassifier(${JSON.stringify(queueClassifierConfig())}, { exists: existsSync, read, join, resolve, delimiter });

let out = "";
try {
  const payload = JSON.parse(readFileSync(0, "utf8"));
  out = Q.hook(payload, process.env, process.env.CLAUDE_PROJECT_DIR || process.cwd(), process.argv[2]);
} catch {}
if (out) process.stdout.write(out);
process.exit(0);
`;
}

/** Слово shell для команды хука: имя или путь, в одинарных кавычках, если нужно. */
function shellWord(s: string): string {
  return /^[A-Za-z0-9_/.,:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Команда записи хука в `.claude/settings.json`. Исполняется shell'ом хоста
 * (`$SHELL`: bash, zsh или sh), поэтому только POSIX:
 *
 *   1. `read` берёт строку JSON без fork; из неё — хвост после `"command":"`
 *      до ближайшего `","` (внутри строки JSON такой тройки не бывает: каждая
 *      её кавычка экранирована), то есть текст команды, а не описание;
 *   2. `case` по PREFILTER_WORDS и PREFILTER_QUEUED: не совпало — выход 0 за
 *      единицы мс;
 *   3. иначе — helper под bun (если есть), иначе под node, с тем же JSON на
 *      stdin и выбранным при wire myc в argv.
 *
 * Helper'а нет (удалён руками) — выход 0: хук, валящий Bash, хуже отсутствия.
 */
export function queueHookCommand(mycCommand: string): string {
  const words = [...PREFILTER_WORDS.map((w) => `*${w}*`), PREFILTER_QUEUED].join("|");
  return [
    `f="\${CLAUDE_PROJECT_DIR:-.}/${QUEUE_HELPER_REL}"`,
    "IFS= read -r p",
    `c=\${p#*'"command":"'}`,
    `case \${c%%'","'*} in ${words}) ;; *) [ -n "\${${QUEUE_ENV}+x}" ] || exit 0;; esac`,
    `[ -f "$f" ] || exit 0`,
    "r=node",
    "command -v bun >/dev/null 2>&1 && r=bun",
    `printf '%s\\n' "$p" | "$r" "$f" ${shellWord(mycCommand)}`,
  ].join("; ");
}

/** Запись хука для `hooks.PreToolUse` в `.claude/settings.json`. */
export function queueHookEntry(mycCommand: string): Record<string, unknown> {
  return {
    matcher: "Bash",
    hooks: [{ type: "command", command: queueHookCommand(mycCommand), timeout: QUEUE_HOOK_TIMEOUT_S }],
  };
}
