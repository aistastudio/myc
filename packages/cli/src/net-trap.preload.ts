/**
 * Заглушка сети для тестов, которые ПЕРЕКРЫВАЮТ её настоящему процессу myc.
 *
 * Подключается через `bun --preload`, то есть до загрузки любого модуля CLI:
 * заменяет `globalThis.fetch` (и `Bun.connect`, если рантайм даёт его
 * переписать) на ловушку, которая пишет строку в `MYC_NET_TRAP_LOG` и бросает.
 *
 * Зачем процессом, а не подменой внутри теста. Утверждение «горячий путь не
 * ходит в сеть» живёт МЕЖДУ процессами: команду запускает хук, агент, оболочка,
 * и однопоточная подмена в том же процессе проверяет не то, что выполняется в
 * бою. Ровно поэтому файл — отдельный модуль, а не замыкание в тесте.
 */

import { appendFileSync } from "node:fs";

const LOG = process.env.MYC_NET_TRAP_LOG;

function record(kind: string, target: string): never {
  if (LOG !== undefined && LOG.length > 0) {
    appendFileSync(LOG, `${JSON.stringify({ kind, target, argv: process.argv.slice(2) })}\n`);
  }
  throw new Error(`network blocked by the test (${kind} → ${target})`);
}

const trapped = (input: unknown): never =>
  record("fetch", String((input as { url?: string })?.url ?? input));
// `preconnect` живёт на настоящем fetch отдельным полем — переносим, иначе
// подмена не пройдёт по типу и упадёт не там, где смотрят.
(trapped as unknown as { preconnect: unknown }).preconnect = (): void => {};
globalThis.fetch = trapped as unknown as typeof fetch;

try {
  const bun = (globalThis as { Bun?: Record<string, unknown> }).Bun;
  if (bun !== undefined && typeof bun["connect"] === "function") {
    bun["connect"] = (opts: unknown): never => record("Bun.connect", JSON.stringify(opts));
  }
} catch {
  // Рантайм не даёт переписать — ловушки на fetch достаточно для утверждения,
  // а импорты node:net закрывает статическая половина того же теста.
}
