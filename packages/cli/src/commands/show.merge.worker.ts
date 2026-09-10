/**
 * Воркер для многопроцессной проверки цепочки версий (см. show.test.ts).
 *
 * Отдельный ПРОЦЕСС, потому что инвариант живёт между процессами: две машины
 * надстраивают свою версию над общим предком, ничего не зная друг о друге, а
 * потом их оплоги сливаются. Однопоточный тест такое уже дважды пропускал
 * (S38, S40) — там молчаливо терялись записи на гонках.
 *
 *   --db <path> --site <id> --mode version --ancestor <id> --title <t>
 *       записать новую версию поверх предка: узел, ребро supersedes и
 *       переезд head_id всей цепочке предка (§6.3);
 *   --db <path> --site <id> --mode import --from <dir>
 *       применить чужой оплог из каталога графа.
 *
 * Печатает одну строку JSON.
 */

import {
  collectVersions,
  generateId,
  supersessionPlan,
  versionSourceOf,
} from "@myc/core";
import { GraphStore, importGraph, migrate, migrations, openSqlite } from "@myc/store-sqlite";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function need(name: string): string {
  const v = arg(name);
  if (v === undefined) throw new Error(`--${name} required`);
  return v;
}

const dbPath = need("db");
const mode = need("mode");

const driver = openSqlite(dbPath);
try {
  await migrate(driver.database, { migrations, writable: true });

  const store = new GraphStore(driver, {
    newId: () => generateId(),
    siteId: need("site"),
    actor: `worker-${need("site")}`,
  });

  if (mode === "import") {
    const r = importGraph(store, need("from"), { rebuildCache: false });
    process.stdout.write(`${JSON.stringify({ mode, applied: r.applied, fresh: r.fresh })}\n`);
  } else if (mode === "version") {
    const ancestor = need("ancestor");
    const node = store.createNode({
      kind: "note",
      scope: "test",
      title: need("title"),
      body: arg("body") ?? need("title"),
    });
    store.addEdge(node.id, "supersedes", ancestor, { weight: 0.97 });
    // Голова переезжает предку И всей его цепочке — иначе прадед остался бы
    // указывать на промежуточную версию. Обход и план — общие с show и
    // absorb (@myc/core): здесь стояла третья копия того же запроса.
    const old = store.getNode(ancestor, true)!;
    const { graph } = collectVersions(versionSourceOf(driver, store), {
      id: old.id,
      head_id: old.head_id,
      hlc: old.hlc,
      site_id: old.site_id,
    });
    const plan = supersessionPlan(graph, ancestor, node.id);
    for (const id of plan.rehead) {
      store.updateNode(id, { head_id: plan.head, status: "superseded" });
    }
    process.stdout.write(`${JSON.stringify({ mode, id: node.id, ancestor })}\n`);
  } else {
    throw new Error(`unknown --mode ${mode}`);
  }
} finally {
  driver.close();
}
