import { defaultRegistry } from "./registry.ts";
import { registerAll } from "./register.ts";
import { finish, guardStdio, run } from "./index.ts";

registerAll(defaultRegistry);

// Счётчики записей — до первой из них: MCP-сервер и viz пишут в stdout сами,
// мимо RunResult, и их хвост тоже обязан уйти в fd до выхода. Почему выход
// только после слива — см. `finish` в index.ts (memory-vzst83nfmp3q).
guardStdio();

function main(): void {
  run(process.argv.slice(2), {
    tty: process.stdout.isTTY === true,
    env: process.env as Record<string, string | undefined>,
  }).then(finish);
}

main();
