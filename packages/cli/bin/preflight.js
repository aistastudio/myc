#!/usr/bin/env node
/**
 * postinstall-проверка. Запускается тем рантаймом, который ставил пакет —
 * обычно это node, поэтому здесь снова голый JS без `bun:`.
 *
 * Зачем: shebang у bin/myc.js — `#!/usr/bin/env bun`, и если Bun в системе
 * нет вовсе, первая же попытка запустить `myc` даст `env: bun: No such file
 * or directory` (код 127) — сообщение, по которому нельзя понять ни причину,
 * ни что делать. Наша заглушка до этого не доживает: её просто некому
 * выполнить. Значит сказать надо здесь, на установке.
 *
 * Установку НЕ роняем: пакет разложен правильно, не хватает только рантайма,
 * и это чинится `curl … | bash` без переустановки.
 */

import { spawnSync } from "node:child_process";

if (typeof process.versions.bun !== "string" && !bunOnPath()) {
  process.stderr.write(
    // Рамка собирается по ширине самой длинной строки, а не подгоняется
    // руками: после переименования пакета `@myc/cli` -> `@aistastudio/myc`
    // верхняя граница разъехалась, и это первое, что видит человек без Bun.
    (() => {
      const title = "@aistastudio/myc установлен, но запускаться пока не будет";
      const body = [
        "myc работает только на Bun (хранилище на bun:sqlite).",
        "Bun в системе не найден.",
        "",
        "  curl -fsSL https://bun.sh/install | bash",
        "",
        "После этого: myc --version",
      ];
      const w = Math.max(title.length + 3, ...body.map((l) => l.length)) + 1;
      const top = `  ┌─ ${title} ${"─".repeat(Math.max(0, w - title.length - 2))}┐`;
      const mid = body.map((l) => `  │ ${l.padEnd(w)}│`);
      const bot = `  └${"─".repeat(w + 1)}┘`;
      return ["", top, ...mid, bot, ""].join("\n");
    })(),

  );
}

function bunOnPath() {
  try {
    return spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
