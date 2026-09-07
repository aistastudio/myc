/**
 * Сервер, поднятый НЕ бинарём `myc`: `defaultRegistry` в таком процессе пуст,
 * а веб пишет через `run()` в нём же. Живёт отдельным файлом, потому что
 * внутри тестового процесса реестр уже наполнен соседними тестами и случай не
 * воспроизводится.
 */
import { startVizServer } from "../server.ts";

const [dbPath, dir, id] = process.argv.slice(2);
const server = startVizServer({ dbPath: dbPath!, dir: dir!, port: 0 });
const res = await fetch(`http://localhost:${server.port}/api/nodes/${id}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "переименовано без бинаря" }),
});
const body = (await res.json()) as { ok?: boolean; error?: { code?: string } };
process.stdout.write(JSON.stringify({ ok: body.ok === true, code: body.error?.code ?? null }));
server.stop();
