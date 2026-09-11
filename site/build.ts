#!/usr/bin/env bun
/**
 * Сборка сайта: сверить числа site/measurements.json с артефактами репозитория
 * и выпустить site/data.js.
 *
 * Проверка — не украшение. Числа на сайте живут в measurements.json, а рядом в
 * репозитории лежат файлы, которые пишут сами замеры (bench/*.json). Если число
 * в measurements.json разошлось с тем, что записал замер, сборка ПАДАЕТ: сайт с
 * числом, которого замер больше не даёт, хуже сайта без числа.
 *
 *   bun run site/build.ts          сверить и собрать
 *   bun run site/build.ts --check  только сверить, ничего не писать
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(siteDir, "..");
const checkOnly = process.argv.includes("--check");

type Problem = { where: string; expected: unknown; actual: unknown; note?: string };
const problems: Problem[] = [];
const checks: string[] = [];

const readJson = (rel: string): any => JSON.parse(readFileSync(join(repoRoot, rel), "utf8"));
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

/**
 * Отпечаток КОДА, к которому относится снимок прогона тестов — единственная
 * величина, которую сборка не может сверить с артефактом: полный прогон стоит
 * три минуты, гонять его на каждой сборке сайта нельзя. Значит снимок обязан
 * устаревать громко, а не тихо.
 *
 * Раньше здесь стоял HEAD, и сторож был неисполним по построению: прогон
 * делается ДО коммита, записанный HEAD — это предыдущий коммит, а после
 * `git commit` он перестаёт совпадать. Сборка Pages падала на каждом пуше,
 * сообщая «перегоните bun test» тому, кто только что его перегнал.
 *
 * Отпечаток берётся от содержимого файлов, которые влияют на результат
 * прогона: правка кода делает снимок устаревшим (и это ловится), а правка
 * README, сайта или самого measurements.json — нет.
 */
function sourceFingerprint(): string {
  const p = Bun.spawnSync(
    ["git", "ls-files", "-s", "packages", "db", "scripts", "bunfig.toml", "package.json"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const listing = new TextDecoder().decode(p.stdout);
  // Индекс git даёт хеш содержимого каждого файла; нам нужна их сумма, а не
  // порядок — но `ls-files` уже сортирован, так что хеш строки устойчив.
  return Bun.SHA256.hash(listing, "hex").slice(0, 16);
}

function same(where: string, expected: number, actual: number, digits = 3): void {
  if (round(expected, digits) === round(actual, digits)) {
    checks.push(`${where}: ${round(actual, digits)}`);
    return;
  }
  problems.push({ where, expected, actual });
}

const m = readJson("site/measurements.json");

// ── Бюджеты латентности ───────────────────────────────────────────────────────
// Абсолютное значение p99 меряется на конкретной машине и не сверяется с файлом:
// сверяем два утверждения, которые от машины не зависят по смыслу — что p99
// уложился в бюджет, и что p95 не ушёл от линии CI дальше допуска.
{
  const baseline = readJson(m.latency.check.file)[m.latency.check.section];
  if (!baseline) {
    problems.push({ where: "latency/baseline", expected: m.latency.check.section, actual: "нет секции" });
  } else {
    for (const row of m.latency.rows) {
      if (row.p99 >= row.budget) {
        problems.push({ where: `latency/${row.op}/budget`, expected: `p99 < ${row.budget}`, actual: row.p99 });
      } else {
        checks.push(`latency/${row.op}: p99 ${row.p99} мс < бюджет ${row.budget} мс`);
      }
      const line = baseline[row.op];
      if (!line) {
        problems.push({ where: `latency/${row.op}/baseline`, expected: "линия в baseline.json", actual: "нет" });
        continue;
      }
      // Правило регрессии здесь ТО ЖЕ, что в scripts/bench-latency.ts:
      // порог 15% по p95 применяется только когда абсолютный прирост не меньше
      // 5% бюджета операции. Иначе на операции с линией в микросекунды любой
      // шум планировщика даёт двузначный процент при ничтожной разнице.
      // Своё, более строгое правило было бы не проверкой сайта, а вторым
      // определением регрессии — и сайт расходился бы с CI на ровном месте.
      const drift = (row.p95 - line.p95) / line.p95;
      const absDelta = row.p95 - line.p95;
      const absFloor = row.budget * 0.05;
      const regressed = drift > m.latency.check.tolerance && absDelta >= absFloor;
      if (regressed) {
        problems.push({
          where: `latency/${row.op}/drift`,
          expected: `p95 ≤ линия +${(m.latency.check.tolerance * 100).toFixed(0)}% либо прирост < ${round(absFloor, 4)} мс`,
          actual: `${(drift * 100).toFixed(1)}% (+${round(absDelta, 4)} мс)`,
          note: `baseline p95 ${round(line.p95, 4)} мс`,
        });
      } else {
        const why = drift > m.latency.check.tolerance ? `, прирост ${round(absDelta, 4)} мс ниже пола ${round(absFloor, 4)} мс` : "";
        checks.push(`latency/${row.op}: p95 ${row.p95} мс, дрейф ${(drift * 100).toFixed(1)}% от линии CI${why}`);
      }
    }
  }
}

// ── Бусты ранжирования ────────────────────────────────────────────────────────
{
  const j = readJson(m.boost.check.file);
  const byVariant = Object.fromEntries(j.variants.map((v: any) => [v.variant, v]));
  same("boost/off/mrr", m.boost.overall.off.mrr, byVariant.off.mrr);
  same("boost/on/mrr", m.boost.overall.on.mrr, byVariant.on.mrr);
  same("boost/off/p1", m.boost.overall.off.p1, byVariant.off.p1);
  same("boost/on/p1", m.boost.overall.on.p1, byVariant.on.p1);
  same("boost/corpus/nodes", m.boost.corpus.nodes, j.corpus.nodes, 0);
  same("boost/corpus/queries", m.boost.corpus.queries, j.corpus.queries, 0);
  for (const g of m.boost.groups) {
    same(`boost/${g.key}/off`, g.off, byVariant.off.byGroup[g.key].mrr);
    same(`boost/${g.key}/on`, g.on, byVariant.on.byGroup[g.key].mrr);
  }
  const control = m.boost.groups.find((g: any) => g.control);
  if (!control || control.on >= control.off) {
    problems.push({
      where: "boost/control",
      expected: "контрольная группа ухудшается",
      actual: control ? `${control.off} → ${control.on}` : "нет контрольной группы",
    });
  } else {
    checks.push(`boost/control: ${control.off} → ${control.on} — контроль ухудшается, как и должен`);
  }
}

// ── Обход графа ───────────────────────────────────────────────────────────────
{
  const j = readJson(m.graph.check.file);
  const byVariant = Object.fromEntries(j.variants.map((v: any) => [v.variant, v]));
  for (const variant of ["off", "hop1", "hop2"] as const) {
    same(`graph/${variant}/mrr`, m.graph.overall[variant].mrr, byVariant[variant].mrr);
    same(`graph/${variant}/found`, m.graph.overall[variant].found, byVariant[variant].found, 0);
  }
  same("graph/corpus/nodes", m.graph.corpus.nodes, j.corpus.nodes, 0);
  same("graph/corpus/edges", m.graph.corpus.edges, j.corpus.edges, 0);
  for (const g of m.graph.groups) {
    for (const variant of ["off", "hop1", "hop2"] as const) {
      same(`graph/${g.key}/${variant}`, g[variant], byVariant[variant].byGroup[g.key].mrr);
    }
  }
  same("graph/cache/mismatches", m.graph.cache.rank_mismatches, j.cache.rankMismatches, 0);
  same("graph/cache/hits", m.graph.cache.hits, j.cache.hits, 0);
  const control = m.graph.groups.find((g: any) => g.control);
  if (!control || control.hop2 >= control.off) {
    problems.push({
      where: "graph/control",
      expected: "контрольная группа ухудшается",
      actual: control ? `${control.off} → ${control.hop2}` : "нет контрольной группы",
    });
  } else {
    checks.push(`graph/control: ${control.off} → ${control.hop2} — контроль ухудшается, как и должен`);
  }
}

// ── Версия релиза: из packages/cli/package.json, а не из замеров ──────────────
// Шапка сайта показывала env.myc — версию, на которой 2026-09-07 сняли замеры
// задержек (0.1.1), и полтора десятка релизов подряд выдавала её за текущую.
// Текущий релиз — факт репозитория; package.version в measurements.json обязан
// с ним совпадать, иначе размеры пакета на странице — от другой версии.
const release: string = readJson("packages/cli/package.json").version;
if (m.package?.version !== release) {
  problems.push({
    where: "package/version",
    expected: release,
    actual: `${m.package?.version} — пересоберите пакет (bun run pack:npm) и обновите package в measurements.json`,
  });
} else {
  checks.push(`package: версия ${release} = packages/cli/package.json`);
}

// ── Числа без артефакта: обязаны нести команду ────────────────────────────────
{
  const needCommand = ["cache", "import", "package", "roadmap", "latency", "boost", "graph", "tests", "features", "planned"];
  for (const key of needCommand) {
    if (typeof m[key]?.command !== "string" || m[key].command.length === 0) {
      problems.push({ where: `${key}/command`, expected: "команда воспроизведения", actual: "нет" });
    } else {
      checks.push(`${key}: команда «${m[key].command}»`);
    }
  }
  // Отношение печатает сам тест по НЕокруглённым временам, а в measurements.json
  // времена лежат в той точности, в какой тест их напечатал. Поэтому сверяется не
  // равенство, а совместимость: отношение обязано лежать внутри интервала,
  // который допускает напечатанная точность обоих времён. Требовать точного
  // совпадения значило бы требовать чисел, которых в выводе теста нет.
  const decimals = (x: number) => (String(x).split(".")[1] ?? "").length;
  const band = (x: number) => {
    const half = 0.5 * 10 ** -decimals(x);
    return [x - half, x + half] as const;
  };
  for (const r of m.cache.rows) {
    const [missLo, missHi] = band(r.miss_ms);
    const [hitLo, hitHi] = band(r.hit_ms);
    const lo = missLo / hitHi;
    const hi = missHi / hitLo;
    if (r.ratio < lo || r.ratio > hi) {
      problems.push({
        where: `cache/${r.key}/ratio`,
        expected: `×${r.ratio}`,
        actual: `допустимо ×${Math.round(lo)}…×${Math.round(hi)} при напечатанной точности ${r.miss_ms} / ${r.hit_ms} мс`,
      });
    } else {
      checks.push(`cache/${r.key}: ${r.miss_ms} → ${r.hit_ms} мс, ×${r.ratio} внутри ×${Math.round(lo)}…×${Math.round(hi)}`);
    }
  }
  const gap = m.import.ready_gap;
  if (gap.myc - gap.bd !== gap.diff) {
    problems.push({ where: "import/ready_gap", expected: gap.diff, actual: gap.myc - gap.bd });
  } else {
    checks.push(`import/ready_gap: myc ${gap.myc} − bd ${gap.bd} = ${gap.diff}`);
  }
  for (const r of m.roadmap.rows) {
    if (r.done > r.total || r.done < 0) {
      problems.push({ where: `roadmap/${r.key}`, expected: `0 ≤ done ≤ total`, actual: `${r.done}/${r.total}` });
    }
  }
  // Падение теста обязано быть НАЗВАНО, а не подразумеваться нулём.
  if (m.tests.fail > 0 && !m.tests.failing_test) {
    problems.push({ where: "tests/failing_test", expected: "имя падающего теста", actual: "нет" });
  }
  // `tests` — единственная величина, которую нельзя сверить с артефактом:
  // прогон стоит три минуты, и гонять его на каждой сборке сайта нельзя.
  // Значит она обязана нести отпечаток КОДА, на котором снята, и устаревать
  // громко. Поймано на живом: снимок обещал 2131 pass и одно падение, а в
  // дереве было 2139 и ноль — сайт сообщал бы о несуществующей поломке.
  if (m.tests.sources === undefined) {
    problems.push({
      where: "tests/sources",
      expected: "отпечаток кода, на котором снят прогон",
      actual: `нет — добавьте "sources": "${sourceFingerprint()}" в tests`,
    });
  } else if (m.tests.sources !== sourceFingerprint()) {
    problems.push({
      where: "tests/sources",
      expected: `отпечаток кода ${sourceFingerprint()}`,
      actual: `снимок снят на ${String(m.tests.sources)} — код с тех пор менялся: перегоните \`bun test\` и обновите tests в measurements.json`,
    });
  }
  if (m.tests.fail === 0 || m.tests.failing_test) {
    checks.push(`tests: ${m.tests.pass} pass / ${m.tests.fail} fail / ${m.tests.skip} skip${m.tests.fail ? ` — падение названо: «${m.tests.failing_test}»` : ""}`);
  }

  const notDone = m.roadmap.rows.filter((r: any) => r.done === 0);
  checks.push(`roadmap: ${m.roadmap.rows.length} вех, из них ${notDone.length} не начаты (${notDone.map((r: any) => r.key).join(", ")})`);
}

// ── Даты замеров: у ранжирования — дата самого артефакта ──────────────────────
// Подвал говорит, когда снято каждое число. Для ранжирования дату пишет сам
// замер (generated_at в bench/*.json), и сайт не имеет права назвать другую:
// иначе «перемерено тогда-то» снова стало бы словами.
for (const key of ["boost", "graph"] as const) {
  const stamped = String(readJson(m[key].check.file).generated_at ?? "").slice(0, 10);
  if (m[key].date !== stamped) {
    problems.push({ where: `${key}/date`, expected: m[key].date, actual: stamped || "нет generated_at" });
  } else {
    checks.push(`${key}: дата ${stamped} = generated_at в ${m[key].check.file}`);
  }
}
if (m.tests.myc !== undefined && m.tests.myc !== release) {
  problems.push({ where: "tests/myc", expected: release, actual: `${m.tests.myc} — прогон снят на другой версии` });
}

// ── Вехи: снимок site/roadmap.ts, внутренне согласованный ────────────
// Сами done/total сборка пересчитать не может: базы myc в CI нет, их снимает
// site/roadmap.ts перед релизом (как bench). Здесь проверяется, что
// снимок сделан этим скриптом и согласован сам с собой — иначе число снова
// можно вписать рукой, как было до скрипта, и его сторожило бы только
// `0 ≤ done ≤ total`.
{
  const R = m.roadmap;
  if (R.command !== "bun run site/roadmap.ts") {
    problems.push({ where: "roadmap/command", expected: "bun run site/roadmap.ts", actual: R.command });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(R.as_of))) {
    problems.push({ where: "roadmap/as_of", expected: "дата снимка YYYY-MM-DD", actual: R.as_of });
  }
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const r of R.rows) {
    const where = `roadmap/${r.key}`;
    if (ids.has(r.id) || keys.has(r.key)) problems.push({ where, expected: "уникальные id и ключ", actual: `${r.id} ${r.key}` });
    ids.add(r.id);
    keys.add(r.key);
    if (!Array.isArray(r.open)) {
      problems.push({ where: `${where}/open`, expected: "список незакрытых детей из site/roadmap.ts", actual: "нет" });
      continue;
    }
    const ints = [r.done, r.total, r.cancelled, r.in_progress].every((x) => Number.isInteger(x) && x >= 0);
    if (!ints || r.total - r.done - r.cancelled !== r.open.length) {
      problems.push({ where: `${where}/counts`, expected: `total − done − cancelled = незакрытых детей (${r.open.length})`, actual: `${r.total} − ${r.done} − ${r.cancelled}` });
    }
    const taken = r.open.filter((c: any) => c.status === "in_progress").length;
    if (taken !== r.in_progress) problems.push({ where: `${where}/in_progress`, expected: taken, actual: r.in_progress });
  }
  for (const r of R.rows) {
    if (r.parent !== undefined && !ids.has(r.parent)) {
      problems.push({ where: `roadmap/${r.key}/parent`, expected: "родитель — веха из того же снимка", actual: r.parent });
    }
  }
  checks.push(`roadmap: снимок ${R.as_of} (${R.source}), ${R.rows.length} вех, total − done − cancelled = незакрытых у каждой`);
}

// ── Возможности: релиз не из будущего ─────────────────────────────────────────
{
  const cmp = (a: string, b: string): number => {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
    return 0;
  };
  const groupKeys = new Set<string>();
  let n = 0;
  for (const g of m.features.groups) {
    if (groupKeys.has(g.key) || !g.title_en || !g.title_ru || !(g.items?.length > 0)) {
      problems.push({ where: `features/${g.key}`, expected: "уникальный ключ, заголовки en/ru и пункты", actual: JSON.stringify(g).slice(0, 80) });
    }
    groupKeys.add(g.key);
    for (const it of g.items ?? []) {
      n++;
      const where = `features/${g.key}#${n}`;
      if (!it.en || !it.ru || !it.cmd) problems.push({ where, expected: "en, ru и cmd", actual: JSON.stringify(it).slice(0, 80) });
      if (!/^\d+\.\d+\.\d+$/.test(String(it.since)) || cmp(it.since, release) > 0) {
        problems.push({ where: `${where}/since`, expected: `релиз x.y.z не новее ${release}`, actual: it.since });
      }
    }
  }
  checks.push(`features: ${n} возможностей в ${m.features.groups.length} группах, релиз каждой ≤ ${release}`);
}

// ── Запланированное: только то, что в снимке вех действительно открыто ────────
// Описание задачи, которую уже закрыли, — это обещание уже сделанного под
// видом будущего, и наоборот, прятать открытую нечестно. Второе закрыто
// отрисовкой: задача без описания показывается заголовком из myc. Первое
// ловится здесь.
{
  const rows = new Map<string, any>(m.roadmap.rows.map((r: any) => [r.id, r]));
  const seen = new Set<string>();
  let described = 0;
  for (const e of m.planned.epics) {
    const row = rows.get(e.id);
    if (row === undefined) {
      problems.push({ where: `planned/${e.id}`, expected: "эпик из снимка вех", actual: "нет в roadmap" });
      continue;
    }
    const open = new Set<string>(row.open.map((c: any) => c.id));
    for (const it of e.items) {
      const where = `planned/${row.key}/${it.id}`;
      if (seen.has(it.id)) problems.push({ where, expected: "одно описание на задачу", actual: "повтор" });
      seen.add(it.id);
      if (!it.en || !it.ru) problems.push({ where, expected: "en и ru", actual: "нет" });
      if (!open.has(it.id)) {
        problems.push({ where, expected: `задача, открытая в снимке вех ${m.roadmap.as_of}`, actual: "не открыта — закрыта, отменена или ушла из эпика: уберите описание" });
      } else {
        described++;
      }
    }
  }
  const openTotal = m.roadmap.rows.reduce((s: number, r: any) => s + r.open.length, 0);
  checks.push(`planned: ${described} из ${openTotal} открытых задач описаны, остальные показаны заголовком из myc`);
}

// ── Команды на странице — команды ЭТОЙ сборки ────────────────────────────────
// Страница советует команды: у каждой возможности своя, в установке, в
// примерах. Совет с командой или флагом, которых нет, — тот же сломанный
// обещанный путь, что ловит advised-commands.test.ts в самом CLI. Поэтому
// каждая `myc …` со страницы спрашивается у CLI из исходников: `<команда>
// [подкоманда] --help` обязан ответить 0, а каждый флаг — стоять в его справке
// или среди глобальных. Команда из будущего (`myc serve`) помечается в
// разметке data-future; раздел «запланировано» не проверяется вовсе — он по
// определению про то, чего ещё нет. Для `bun run|test <файл>` проверяется, что
// файл есть.
{
  const mainTs = join(repoRoot, "packages", "cli", "src", "main.ts");
  const cliEnv = { ...process.env, NO_COLOR: "1", MYC_UPDATE_CHECK: "0" };
  const helpOf = (out: string, section: string): string[] => {
    const at = out.indexOf(`\n${section}:\n`);
    if (at < 0) return [];
    const body = out.slice(at + section.length + 3);
    const end = body.search(/\n\s*\n/);
    return (end < 0 ? body : body.slice(0, end)).split("\n");
  };
  const flagsIn = (lines: string[]): string[] =>
    lines.flatMap((l) => {
      const f = /^\s+(?:(-[A-Za-z]),\s+)?(--[a-z][a-z-]*)/.exec(l);
      return f === null ? [] : [f[2]!, ...(f[1] !== undefined ? [f[1]] : [])];
    });

  const top = Bun.spawnSync([process.execPath, mainTs, "--help"], { cwd: repoRoot, env: cliEnv, stdout: "pipe", stderr: "pipe" });
  const topOut = new TextDecoder().decode(top.stdout);
  const paths = new Set<string>(
    helpOf(topOut, "Commands").flatMap((l) => {
      const c = /^  ([a-z][a-z-]*(?: [a-z][a-z-]*)?)\s{2,}\S/.exec(l);
      return c === null ? [] : [c[1]!];
    }),
  );
  const globals = new Set(flagsIn(helpOf(topOut, "Globals")));
  if (top.exitCode !== 0 || paths.size === 0 || globals.size === 0) {
    problems.push({ where: "commands/cli", expected: "myc --help из исходников: команды и глобальные флаги", actual: `код ${top.exitCode}, команд ${paths.size}` });
  }

  const tokenize = (line: string): string[] => {
    const out: string[] = [];
    let cur = "";
    let quote: string | null = null;
    let open = false;
    for (const ch of line) {
      if (quote !== null) { if (ch === quote) quote = null; else cur += ch; continue; }
      if (ch === '"' || ch === "'") { quote = ch; open = true; continue; }
      if (/\s/.test(ch)) { if (open) out.push(cur); cur = ""; open = false; continue; }
      cur += ch;
      open = true;
    }
    if (open) out.push(cur);
    return out;
  };

  type Use = { where: string; text: string; path: string | null; flags: string[] };
  const uses: Use[] = [];
  const fileRefs: { where: string; file: string }[] = [];
  /** strict: строка из поля команды — «myc» с не-командой после него это ошибка, а не пропуск. */
  const addLine = (raw: string, where: string, strict: boolean): void => {
    for (const segment of raw.split(/\s*(?:&&|;|\|)\s*/)) {
      const line = segment.trim().replace(/^\$\s+/, "");
      const t = tokenize(line);
      while (t.length > 0 && /^[A-Z_][A-Z0-9_]*=/.test(t[0]!)) t.shift();
      if (t[0] === "bun" && (t[1] === "run" || t[1] === "test")) {
        for (const a of t.slice(2)) if (a.includes("/") || /\.(ts|js)$/.test(a)) fileRefs.push({ where, file: a });
        continue;
      }
      if (t[0] !== "myc") continue;
      const rest = t.slice(1);
      if (rest.length > 0 && !rest[0]!.startsWith("-") && !/^[a-z][a-z-]*$/.test(rest[0]!)) {
        if (strict) uses.push({ where, text: line, path: rest[0]!, flags: [] });
        continue; // «myc │ ctx 42% …» — образец строки статуса, а не команда
      }
      let i = 0;
      const flags: string[] = [];
      while (i < rest.length && rest[i]!.startsWith("-")) {
        flags.push(rest[i]!.split("=")[0]!);
        if (["--db", "-C", "--directory"].includes(rest[i]!)) i++;
        i++;
      }
      let path: string | null = null;
      if (i < rest.length) {
        path = rest[i++]!;
        if (i < rest.length && paths.has(`${path} ${rest[i]}`)) path = `${path} ${rest[i++]}`;
      }
      for (; i < rest.length && rest[i] !== "--"; i++) {
        if (/^--?[A-Za-z]/.test(rest[i]!)) flags.push(rest[i]!.split("=")[0]!);
      }
      uses.push({ where, text: line, path, flags });
    }
  };

  // Поля команд в measurements.json — кроме planned.
  const walk = (v: any, where: string): void => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${where}[${i}]`));
    if (v === null || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (where === "" && k === "planned") continue;
      const here = where === "" ? k : `${where}.${k}`;
      if (typeof x === "string" && (k === "command" || k === "cmd" || k.endsWith("_command"))) addLine(x, here, true);
      else walk(x, here);
    }
  };
  walk(m, "");
  // <code>myc …</code> в текстах возможностей.
  m.features.groups.forEach((g: any) =>
    g.items.forEach((it: any, i: number) => {
      for (const txt of [it.en, it.ru]) {
        for (const c of String(txt).matchAll(/<code>([\s\S]*?)<\/code>/g)) addLine(c[1]!, `features.${g.key}[${i}]`, false);
      }
    }),
  );
  // <code> и <pre><code> в разметке страницы; пояснения (# …) отрезаются.
  const html = readFileSync(join(siteDir, "index.html"), "utf8");
  const decode = (s: string) =>
    s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  for (const c of html.matchAll(/<code(\s[^>]*)?>([\s\S]*?)<\/code>/g)) {
    if ((c[1] ?? "").includes("data-future")) continue;
    const inner = decode(c[2]!.replace(/<span class="c">[\s\S]*?<\/span>/g, "").replace(/<[^>]+>/g, ""));
    for (const line of inner.split("\n")) addLine(line.replace(/\s+#.*$/, ""), "index.html", false);
  }
  // Оба README советуют те же команды, что страница, и ещё свои (import-beads,
  // run, doctor --hooks): блоки ```…``` построчно и `…` в тексте — перенос
  // строки внутри `…` склеивается пробелом. Раздел дорожной карты не
  // проверяется, как и «запланировано» на странице: он про то, чего ещё нет
  // (`myc serve`).
  for (const file of ["README.md", "docs/README.ru.md"]) {
    const md = readFileSync(join(repoRoot, file), "utf8").replace(/^## (?:Roadmap|Дорожная карта)\n[\s\S]*?(?=^## )/m, "");
    for (const b of md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      for (const line of b[1]!.split("\n")) addLine(line.replace(/\s+#.*$/, ""), file, false);
    }
    for (const c of md.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`]+)`/g)) addLine(c[1]!.replace(/\s+/g, " "), file, false);
  }

  const distinct = [...new Set(uses.map((u) => u.path).filter((p): p is string => p !== null))];
  const helps = new Map<string, { code: number; flags: Set<string> }>();
  await Promise.all(
    distinct.map(async (p) => {
      const proc = Bun.spawn([process.execPath, mainTs, ...p.split(" "), "--help"], { cwd: repoRoot, env: cliEnv, stdout: "pipe", stderr: "pipe" });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      helps.set(p, { code, flags: new Set(flagsIn(helpOf(out, "Flags"))) });
    }),
  );
  let flagCount = 0;
  for (const u of uses) {
    const h = u.path === null ? { code: 0, flags: new Set<string>() } : helps.get(u.path)!;
    if (h.code !== 0 || (u.path !== null && !paths.has(u.path) && !paths.has(u.path.split(" ")[0]!))) {
      problems.push({ where: `commands/${u.where}`, expected: "команда этой сборки", actual: `${u.text} — «myc ${u.path} --help» ответил ${h.code}` });
      continue;
    }
    for (const f of u.flags) {
      flagCount++;
      if (!h.flags.has(f) && !globals.has(f)) {
        problems.push({ where: `commands/${u.where}`, expected: `флаг из «myc ${u.path ?? ""} --help»`, actual: `${f} в «${u.text}»` });
      }
    }
  }
  for (const r of fileRefs) {
    if (!existsSync(join(repoRoot, r.file))) problems.push({ where: `commands/${r.where}`, expected: "файл в репозитории", actual: r.file });
  }
  checks.push(`commands: ${uses.length} вызовов myc (${distinct.length} разных команд) и ${flagCount} флагов есть в справке этой сборки; ${fileRefs.length} файлов из bun run/test на месте`);
}

// ── README: числа двух README — те же, что на сайте ──────────────────────────
// README — тоже поверхность с числами, и приёмка вехи M2 требует, чтобы их
// защищала сборка. Иначе цепочка обрывается на последнем звене: артефакты
// сверены с measurements.json, а README живёт своей жизнью и тихо устаревает.
// Так и вышло: до 0.3.6 оба README писали «3.20 MB, 10 files», когда пакет
// весил 3.39 МБ в 13 файлах, — сверялась одна таблица бюджетов.
//
// Сверяется КАЖДОЕ число README, у которого есть запись в measurements.json:
// размеры пакета, строка `myc --version` (с выводом CLI этой сборки), модель,
// снимок тестов, таблица бюджетов с датой и машиной замера, MRR, кеш, импорт
// из beads. Образец обязан найтись хотя бы раз, и каждое его вхождение обязано
// совпасть: переписали фразу — поправьте образец здесь же, осознанно, а не
// потеряйте сверку молча. Абзацы сравниваются со схлопнутыми пробелами: перенос
// строки внутри фразы — не повод для расхождения.
{
  const mainTs = join(repoRoot, "packages", "cli", "src", "main.ts");
  const ver = Bun.spawnSync([process.execPath, mainTs, "--version"], {
    cwd: repoRoot,
    env: { ...process.env, NO_COLOR: "1", MYC_UPDATE_CHECK: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const cliVersion = new TextDecoder().decode(ver.stdout).trim();
  if (ver.exitCode !== 0 || !cliVersion.startsWith(`myc ${release} `)) {
    problems.push({ where: "README/cli", expected: `myc --version из исходников: myc ${release} …`, actual: `код ${ver.exitCode}: ${cliVersion}` });
  }

  /** Число из README: пробелы разрядов («27 000», «100 000») и запятые не в счёт. */
  const num = (s: string): number => Number(s.replace(/[\s  ,]/g, ""));
  const hop2 = m.graph.groups.find((g: any) => g.key === "hop2");
  const search = m.cache.rows.find((r: any) => r.key === "search");
  const embed = m.cache.rows.find((r: any) => r.key === "embed");
  const imp = Object.fromEntries(m.import.rows.map((r: any) => [r.key, r.n]));

  type Claim = { what: string; re: RegExp; want: readonly (string | number)[]; raw?: true };
  const claims = (lang: "en" | "ru"): Claim[] => {
    const en = lang === "en";
    return [
      {
        what: "пакет: сжатый МБ, распакованный МБ, файлов",
        re: en
          ? /@aistastudio\/myc\s+#\s*([\d.]+) MB compressed, ([\d.]+) MB unpacked, (\d+) files/g
          : /@aistastudio\/myc\s+#\s*([\d.]+) МБ сжатый, ([\d.]+) МБ распакованный, (\d+) файл/g,
        want: [m.package.compressed_mb, m.package.unpacked_mb, m.package.files],
      },
      { what: "строка `myc --version`", re: /^myc --version\s+#\s*(.+?)\s*$/gm, want: [cliVersion], raw: true },
      {
        what: "модель: МБ, секунд",
        re: en ? /`myc models fetch` \((\d+) MB, ~(\d+) s\)/g : /`myc models fetch` \((\d+) МБ, ~(\d+) с\)/g,
        want: [Math.round(m.package.model.mb), Math.round(m.package.model.seconds)],
      },
      {
        what: "тесты: pass / fail / skip",
        re: /(\d[\d   ,]*) pass \/ (\d+) fail \/ (\d+) skip/g,
        want: [m.tests.pass, m.tests.fail, m.tests.skip],
      },
      {
        what: "замер задержек: дата, машина, версия",
        re: en
          ? /on (\d{4}-\d{2}-\d{2}), ([a-z0-9-]+), myc (\d+\.\d+\.\d+), not re-measured since/g
          : /(\d{4}-\d{2}-\d{2}), ([a-z0-9-]+), myc (\d+\.\d+\.\d+), с тех пор не переснимался/g,
        want: [m.env.date, m.latency.check.section, m.env.myc],
      },
      {
        what: "бусты: MRR@10 до → после",
        re: /MRR@10 \*\*([\d.]+) → ([\d.]+)\*\* \(`bench\/boost-eval\.ts`\)/g,
        want: [m.boost.overall.off.mrr, m.boost.overall.on.mrr],
      },
      {
        what: "граф: MRR@10 до → 2 хопа",
        re: /MRR@10 \*\*([\d.]+) → ([\d.]+)\*\* \(`bench\/graph-eval\.ts`\)/g,
        want: [m.graph.overall.off.mrr, m.graph.overall.hop2.mrr],
      },
      {
        what: "граф: группа «ответ в двух хопах»",
        re: en ? /unreachable in one hop goes ([\d.]+) → ([\d.]+)/g : /недостижимая за один хоп, идёт ([\d.]+) → ([\d.]+)/g,
        want: [hop2.off, hop2.hop2],
      },
      {
        what: "ранжирование: дата замера",
        re: en ? /both re-measured (\d{4}-\d{2}-\d{2})/g : /оба перемерены (\d{4}-\d{2}-\d{2})/g,
        want: [m.boost.date === m.graph.date ? m.boost.date : `${m.boost.date} / ${m.graph.date}`],
      },
      {
        what: "кеш: ×поиск, дата, ≈×эмбеддинги (до тысяч)",
        re: en
          ? /(\d[\d   ]*)× in the run of (\d{4}-\d{2}-\d{2}), ≈(\d[\d   ]*)× for embeddings/g
          : /(\d[\d   ]*)× в прогоне (\d{4}-\d{2}-\d{2}), ≈(\d[\d   ]*)× для эмбеддингов/g,
        want: [search.ratio, m.env.date, Math.round(embed.ratio / 1000) * 1000],
      },
      {
        what: "импорт из beads: мс, задачи, зависимости, заметки, память",
        re: en
          ? /(\d+) ms: (\d+) tasks, (\d+) dependencies, (\d+) notes, (\d+) memories/g
          : /(\d+) мс: (\d+) задач, (\d+) зависимост\S*, (\d+) замет\S*, (\d+) памят/g,
        want: [m.import.ms, imp.tasks, imp.edges, imp.notes, imp.memories],
      },
      {
        what: "импорт из beads: обе очереди ready",
        re: en ? /both ready queues now return the same (\d+) tasks/g : /обе очереди готовых задач теперь дают одни и те же (\d+) задач/g,
        want: [m.import.ready_gap.diff === 0 ? m.import.ready_gap.myc : `myc ${m.import.ready_gap.myc} ≠ bd ${m.import.ready_gap.bd}`],
      },
    ];
  };

  for (const [file, lang, unit] of [["README.md", "en", "ms"], ["docs/README.ru.md", "ru", "мс"]] as const) {
    const text = readFileSync(join(repoRoot, file), "utf8");
    const flat = text.replace(/\s+/g, " ");
    let matched = 0;
    for (const c of claims(lang)) {
      const hits = [...(c.raw ? text : flat).matchAll(c.re)];
      if (hits.length === 0) {
        problems.push({ where: `${file}: ${c.what}`, expected: `фраза по образцу ${c.re.source}`, actual: "не найдена" });
        continue;
      }
      for (const h of hits) {
        const got = h.slice(1).map((g, i) => (typeof c.want[i] === "number" ? num(g!) : g));
        if (got.some((g, i) => g !== c.want[i])) {
          problems.push({ where: `${file}: ${c.what}`, expected: c.want.join(" / "), actual: `${got.join(" / ")} («${h[0]}»)` });
        } else {
          matched++;
        }
      }
    }

    // Таблица бюджетов. Имя операции в README пишется человеку («cold start»),
    // в замере — кодом («cold_start»); русская таблица ведёт код операции первым
    // словом. Сверяем смысл, а не написание.
    for (const row of m.latency.rows) {
      const name = String(row.op).replace(/_/g, "[ _]");
      const re = new RegExp(`\\|\\s*\`?${name}\`?[^|]*\\|\\s*([0-9.]+)\\s*${unit}\\s*\\|\\s*([0-9.]+)\\s*${unit}`, "i");
      const hit = re.exec(text);
      if (hit === null) {
        problems.push({ where: `${file}: бюджет ${row.op}`, expected: "строка таблицы бюджетов", actual: "не найдена" });
        continue;
      }
      if (Number(hit[1]) !== row.p99) problems.push({ where: `${file}: ${row.op} p99`, expected: String(row.p99), actual: hit[1]! });
      if (Number(hit[2]) !== row.budget) problems.push({ where: `${file}: ${row.op} бюджет`, expected: String(row.budget), actual: hit[2]! });
    }
    const pkg = `${m.package.compressed_mb}/${m.package.unpacked_mb} МБ, ${m.package.files} файлов`;
    checks.push(
      `${file}: ${matched} вхождений ${claims(lang).length} образцов = measurements.json (пакет ${pkg}; «${cliVersion}»; ` +
        `тесты ${m.tests.pass}/${m.tests.fail}/${m.tests.skip}); таблица бюджетов, ${m.latency.rows.length} строк`,
    );
  }
}

// ── Итог ──────────────────────────────────────────────────────────────────────
console.log(`сверено утверждений: ${checks.length}`);
for (const c of checks) console.log(`  [OK] ${c}`);

if (problems.length > 0) {
  console.error(`\nРАСХОЖДЕНИЙ: ${problems.length}`);
  for (const p of problems) {
    console.error(`  [РАСХОЖДЕНИЕ] ${p.where}: в measurements.json ${JSON.stringify(p.expected)}, в артефакте ${JSON.stringify(p.actual)}${p.note ? ` (${p.note})` : ""}`);
  }
  console.error("\nСайт не собран. Прогоните команду замера заново и перенесите её вывод в site/measurements.json.");
  process.exit(1);
}

if (checkOnly) {
  console.log("\nтолько сверка — файлы не тронуты.");
  process.exit(0);
}

const out = `// СГЕНЕРИРОВАНО site/build.ts — не править руками.\n// Источник: site/measurements.json, сверено с артефактами репозитория.\nwindow.MYC_DATA = ${JSON.stringify(m, null, 2)};\nwindow.MYC_DATA.verified = { at: ${JSON.stringify(new Date().toISOString())}, assertions: ${checks.length} };\nwindow.MYC_DATA.release = ${JSON.stringify(release)};\n`;
writeFileSync(join(siteDir, "data.js"), out, "utf8");
console.log(`\nsite/data.js выпущен: ${checks.length} сверенных утверждений.`);
