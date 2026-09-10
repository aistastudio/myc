/**
 * Воркер для проверки консистентности при аварийном завершении (checkpoint.test.ts).
 *
 * Запускается отдельным ПРОЦЕССОМ (Bun.spawn) и пишет узлы в цикл без пауз,
 * пока его не убьют SIGKILL. После каждого удачного коммита дописывает строку
 * `<n> <id>` в файл прогресса — через appendFileSync, то есть настоящим
 * write(2) без буфера: то, что успело попасть в файл, точно закоммичено в базу.
 *
 * Потолок WAL занижен намеренно, чтобы предохранитель срабатывал часто и
 * убийство с заметной вероятностью пришлось прямо на checkpoint.
 */

import { appendFileSync } from "node:fs";
import { generateId } from "@myc/core";
import { openSqlite } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore } from "./queries.ts";

const argv = process.argv;
const get = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const dbPath = get("db");
const progressPath = get("progress");
if (dbPath === undefined || progressPath === undefined) {
  throw new Error("--db PATH and --progress PATH are required");
}
const hard = Number(get("hard") ?? 512 * 1024);
const site = get("site") ?? "killer";

const driver = openSqlite({
  path: dbPath,
  wal: { hardLimitBytes: hard, softLimitBytes: Math.floor(hard / 2) },
});
await migrate(driver.database, { migrations, writable: true });
const store = new GraphStore(driver, {
  siteId: site,
  actor: "crash-test",
  newId: () => generateId(),
  now: () => Date.now(),
});

let n = 0;
process.stdout.write("ready\n");
for (;;) {
  const node = store.createNode({
    kind: "note",
    scope: "crash",
    title: `node ${site} ${n}`,
    body: `body ${n} — enough text for the write to touch FTS and the derived columns`,
    attrs: { topic: `t${n % 16}` },
  });
  n++;
  appendFileSync(progressPath, `${n} ${node.id}\n`);
}
