/**
 * Стенд ранжирования `myc code search` (memory-5nvk1hwcene2).
 *
 * ЗАЧЕМ ОН НУЖЕН ОТДЕЛЬНО ОТ ТЕСТОВ. Тест отвечает «работает ли»; здесь
 * вопрос другой — «насколько хорошо», и ответ на него — число, которое можно
 * сравнить с прошлым и с graft. Правки ранжирования без этого числа
 * неотличимы от вкусовщины: у любой эвристики находится вопрос, на котором
 * она помогает.
 *
 * СРАВНЕНИЕ РЕЖИМОВ — ЧАСТЬ СТЕНДА, А НЕ УПРАЖНЕНИЕ. `--modes` гоняет тот же
 * набор через три способа объединить ступени лестницы:
 *   `first`    — первая ступень, что-то нашедшая (как делает `runHybrid`);
 *   `flat`     — RRF по ступеням БЕЗ свёртки в файлы;
 *   `files`    — то, что стоит в продукте: RRF по ступеням + свёртка в файлы.
 * Именно эта таблица оправдывает решение в `search.ts`; без неё «мы выбрали
 * свёртку» — заявление, а не вывод.
 *
 *   bun run packages/code-intel/src/bench-code-search.ts --db .myc/myc.db
 */

import { Database } from "bun:sqlite";
import { analyzeFtsQuery } from "@myc/retrieval/fts";
import { searchCode } from "./search.ts";

interface Case {
  q: string;
  expect: string;
  why: string;
  hard?: boolean;
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : fallback;
}

const SQL_STAGE = `SELECT u.id AS id, u.path AS path, u.unit AS unit
  FROM code_fts f JOIN code_units u ON u.id = f.rowid
 WHERE code_fts MATCH ?1 AND u.repo_id = ?2
 ORDER BY bm25(code_fts, 4.0, 1.0, 1.0, 0.5) LIMIT 80`;

/** Пути в порядке выдачи для режима, которого нет в продукте (для сравнения). */
function baseline(db: Database, repoId: string, query: string, mode: "first" | "flat"): string[] {
  const p = analyzeFtsQuery(query.replace(/[-.]+/g, " "));
  if (p === null) return [];
  const stages = [p.and, p.prefixAnd, p.prefixRelaxed, p.prefixRelaxed2, p.prefixOr];
  const q = db.query(SQL_STAGE);
  const acc = new Map<number, { path: string; score: number }>();
  const seen = new Set<string>();
  for (const match of stages) {
    if (match === "" || seen.has(match)) continue;
    seen.add(match);
    let rows: Array<{ id: number; path: string }>;
    try {
      rows = q.all(match, repoId) as Array<{ id: number; path: string }>;
    } catch {
      continue;
    }
    if (rows.length === 0) continue;
    rows.forEach((r, i) => {
      const cur = acc.get(r.id) ?? { path: r.path, score: 0 };
      cur.score += 1 / (10 + i + 1);
      acc.set(r.id, cur);
    });
    if (mode === "first") break;
  }
  const out: string[] = [];
  for (const v of [...acc.values()].sort((a, b) => b.score - a.score)) {
    if (!out.includes(v.path)) out.push(v.path);
  }
  return out;
}

async function main(): Promise<void> {
  const dbPath = arg("db", ".myc/myc.db");
  const repoId = arg("repo", "");
  const spec = (await Bun.file(arg("queries", "bench/code-search-queries.json")).json()) as {
    cases: Case[];
  };
  const db = new Database(dbPath, { readonly: true });
  const units = (db.query("SELECT COUNT(*) AS n FROM code_units WHERE repo_id = ?1").get(repoId) as {
    n: number;
  }).n;
  if (units === 0) {
    console.error(`корпуса нет: code_units пуст для repo '${repoId}'. Сначала: myc code index`);
    process.exit(1);
  }

  const modes = arg("modes", "first,flat,files").split(",");
  const rows: string[] = [];
  for (const mode of modes) {
    let mrr = 0;
    let top1 = 0;
    let top3 = 0;
    let found = 0;
    let ms = 0;
    const detail: string[] = [];
    for (const c of spec.cases) {
      const re = new RegExp(c.expect);
      const t0 = performance.now();
      const paths =
        mode === "files"
          ? searchCode(db, repoId, c.q).hits.map((h) => h.path)
          : baseline(db, repoId, c.q, mode === "first" ? "first" : "flat");
      ms += performance.now() - t0;
      const i = paths.slice(0, 10).findIndex((p) => re.test(p));
      if (i === 0) top1++;
      if (i >= 0 && i < 3) top3++;
      if (i >= 0) {
        found++;
        mrr += 1 / (i + 1);
      }
      detail.push(`  ${(i >= 0 ? `#${i + 1}` : "—").padStart(4)}  ${c.q}${c.hard === true ? "  (hard)" : ""}`);
    }
    const n = spec.cases.length;
    if (mode === "files") for (const line of detail) console.log(line);
    rows.push(
      `${mode.padEnd(6)} MRR ${(mrr / n).toFixed(3)}  top1 ${top1}/${n}  top3 ${top3}/${n}  ` +
        `top10 ${found}/${n}  ${(ms / n).toFixed(1)} мс/запрос`,
    );
  }
  console.log("");
  console.log(`корпус: ${units} единиц, ${spec.cases.length} размеченных вопросов`);
  for (const r of rows) console.log(r);
}

await main();
