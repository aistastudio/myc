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

import { readFileSync, writeFileSync } from "node:fs";
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
 * Коммит, на котором стоит дерево. Им датируется снимок прогона тестов —
 * единственная величина, которую сборка не может сверить с артефактом:
 * полный прогон стоит три минуты, гонять его на каждой сборке сайта нельзя.
 * Значит снимок обязан устаревать ГРОМКО, а не тихо.
 */
function headCommit(): string {
  const p = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" });
  return new TextDecoder().decode(p.stdout).trim();
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

// ── Числа без артефакта: обязаны нести команду ────────────────────────────────
{
  const needCommand = ["cache", "import", "package", "roadmap", "latency", "boost", "graph", "tests"];
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
  // Значит она обязана нести КОММИТ, на котором снята, и устаревать громко.
  // Поймано на живом: снимок обещал 2131 pass и одно падение, а на HEAD было
  // 2139 и ноль — сайт сообщал бы о несуществующей поломке.
  if (m.tests.commit === undefined) {
    problems.push({ where: "tests/commit", expected: "коммит, на котором снят прогон", actual: "нет" });
  } else if (m.tests.commit !== headCommit()) {
    problems.push({
      where: "tests/commit",
      expected: `снимок на HEAD (${headCommit().slice(0, 8)})`,
      actual: `снят на ${String(m.tests.commit).slice(0, 8)} — перегоните \`bun test\` и обновите tests в measurements.json`,
    });
  }
  if (m.tests.fail === 0 || m.tests.failing_test) {
    checks.push(`tests: ${m.tests.pass} pass / ${m.tests.fail} fail / ${m.tests.skip} skip${m.tests.fail ? ` — падение названо: «${m.tests.failing_test}»` : ""}`);
  }

  // README — тоже поверхность с числами, и приёмка вехи M2 требует, чтобы их
  // защищала сборка. Иначе цепочка обрывается на последнем звене: артефакты
  // сверены с measurements.json, а README живёт своей жизнью и тихо
  // устаревает. Проверяем ровно таблицу бюджетов: она и есть те «три числа
  // из бенчмарка», ради которых веха заводилась.
  const readme = readFileSync(join(repoRoot, "README.md"), "utf8");
  for (const row of m.latency.rows) {
    // Имя операции в README пишется человеку («cold start»), в замере — кодом
    // («cold_start»). Сверяем смысл, а не написание.
    const name = String(row.op).replace(/_/g, "[ _]");
    const re = new RegExp(`\\|\\s*\`?${name}\`?[^|]*\\|\\s*([0-9.]+)\\s*ms\\s*\\|\\s*([0-9.]+)\\s*ms`, "i");
    const hit = re.exec(readme);
    if (hit === null) {
      problems.push({ where: `README/${row.op}`, expected: "строка таблицы бюджетов", actual: "не найдена" });
      continue;
    }
    if (Number(hit[1]) !== row.p99) {
      problems.push({ where: `README/${row.op} p99`, expected: String(row.p99), actual: hit[1]! });
    }
    if (Number(hit[2]) !== row.budget) {
      problems.push({ where: `README/${row.op} бюджет`, expected: String(row.budget), actual: hit[2]! });
    }
  }
  checks.push(`README: таблица бюджетов сверена, ${m.latency.rows.length} строк`);

  const notDone = m.roadmap.rows.filter((r: any) => r.done === 0);
  checks.push(`roadmap: ${m.roadmap.rows.length} вех, из них ${notDone.length} не начаты (${notDone.map((r: any) => r.key).join(", ")})`);
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

const out = `// СГЕНЕРИРОВАНО site/build.ts — не править руками.\n// Источник: site/measurements.json, сверено с артефактами репозитория.\nwindow.MYC_DATA = ${JSON.stringify(m, null, 2)};\nwindow.MYC_DATA.verified = { at: ${JSON.stringify(new Date().toISOString())}, assertions: ${checks.length} };\n`;
writeFileSync(join(siteDir, "data.js"), out, "utf8");
console.log(`\nsite/data.js выпущен: ${checks.length} сверенных утверждений.`);
