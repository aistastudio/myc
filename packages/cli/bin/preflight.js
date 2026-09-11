#!/usr/bin/env node
/**
 * postinstall-проверка. Запускается тем рантаймом, который ставил пакет —
 * обычно это node, поэтому здесь снова голый JS без `bun:`.
 *
 * Зачем: shebang у bin/myc.js — `#!/usr/bin/env -S bun --no-env-file
 * --config=/dev/null` (зачем флаги — в шапке самого bin/myc.js), и если Bun в
 * системе нет вовсе, первая же попытка запустить `myc` даст `env: bun: No such
 * file or directory` (код 127) — сообщение, по которому нельзя понять ни
 * причину, ни что делать. Наша заглушка до этого не доживает: её просто некому
 * выполнить. Значит сказать надо здесь, на установке.
 *
 * Установку НЕ роняем: пакет разложен правильно, не хватает только рантайма,
 * и это чинится `curl … | bash` без переустановки.
 *
 * WINDOWS — та же беда другим путём: там этот shebang не исполним вовсе, даже
 * при установленном Bun. Шим `bun add -g` берёт `-S` за программу
 * (`interpreter executable "-S" not found`), cmd-shim npm передаёт
 * `--config=/dev/null`, а Bun на Windows такого файла не находит (`ENOENT …
 * while reading config`). Оба отказа — до первой строки myc, и сказать
 * человеку, что делать, можно только здесь. Установку тоже не роняем.
 * Предел: `bun add -g` postinstall недоверенного пакета не запускает
 * («Blocked 1 postinstall»), и эту рамку увидит только ставящий через npm —
 * остальным о WSL говорит README.
 */

import { spawnSync } from "node:child_process";

if (process.platform === "win32") {
  process.stderr.write(
    frame("@aistastudio/myc: Windows is not supported", [
      "myc runs on macOS and Linux; on Windows use WSL.",
      "The `myc` launcher will not start in cmd or PowerShell.",
      "",
      "  wsl --install",
      "",
      "Then, inside WSL: install Bun and @aistastudio/myc there.",
    ]),
  );
} else if (typeof process.versions.bun !== "string" && !bunOnPath()) {
  // По-английски, как весь вывод CLI (эпик memory-rc2s0m1e9kpz).
  process.stderr.write(
    frame("@aistastudio/myc is installed, but it will not start yet", [
      "myc runs only on Bun (its storage is bun:sqlite).",
      "Bun was not found on this system.",
      "",
      "  curl -fsSL https://bun.sh/install | bash",
      "",
      "Then: myc --version",
    ]),
  );
}

/**
 * Рамка собирается по ширине самой длинной строки, а не подгоняется руками:
 * после переименования пакета `@myc/cli` -> `@aistastudio/myc` верхняя граница
 * разъехалась, и это первое, что видит человек без Bun.
 */
function frame(title, body) {
  const w = Math.max(title.length + 3, ...body.map((l) => l.length)) + 1;
  const top = `  ┌─ ${title} ${"─".repeat(Math.max(0, w - title.length - 2))}┐`;
  const mid = body.map((l) => `  │ ${l.padEnd(w)}│`);
  const bot = `  └${"─".repeat(w + 1)}┘`;
  return ["", top, ...mid, bot, ""].join("\n");
}

function bunOnPath() {
  try {
    return spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}
