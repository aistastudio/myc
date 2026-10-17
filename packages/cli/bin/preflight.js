#!/usr/bin/env node
/**
 * postinstall-проверка (голый JS: её выполняет тот рантайм, который ставил
 * пакет — обычно node).
 *
 * НАЧЁМ С ЧЕГО МЕНЯЛОСЬ. Прежний лаунчик требовал Bun, и её текст объяснял,
 * почему на Windows shebang `env -S` не исполним. Теперь запускатель —
 * `bin/myc.js` на голом node, а сам myc — нативный бинарь из платформенного
 * пакета (@aistastudio/myc-<os>-<arch>, optionalDependencies). Это меняет
 * и предмет проверки: нативный бинарь может НЕ приехать — npm умеет
 * пропускать optional-зависимости (`--omit=optional`, обрезанная
 * конфигурация, зеркало без пакета), и первая же попытка запуска тогда
 * упадёт. Сказать об этом на установке дешевле, чем при первом вызове.
 *
 * Установку НЕ роняем: пакет разложен правильно, не хватает только бинаря,
 * и `npm install -g @aistastudio/myc --force` чинит без переустановки вручную.
 *
 * WINDOWS. Нативная сборка экспериментальна до подтверждения на живой
 * машине; если бинарь не приехал, единственный рабочий путь — WSL, и эта
 * рамка говорит об этом прямо здесь.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require_ = createRequire(import.meta.url);

const PLATFORM_PKG = {
  "win32/x64": "@aistastudio/myc-win-x64",
  "darwin/arm64": "@aistastudio/myc-darwin-arm64",
  "darwin/x64": "@aistastudio/myc-darwin-x64",
  "linux/x64": "@aistastudio/myc-linux-x64",
  "linux/arm64": "@aistastudio/myc-linux-aarch64",
}[`${process.platform}/${process.arch}`];

function nativeBinaryInstalled() {
  if (PLATFORM_PKG === undefined) return false;
  try {
    const root = dirname(require_.resolve(`${PLATFORM_PKG}/package.json`));
    return existsSync(join(root, "bin", process.platform === "win32" ? "myc.exe" : "myc"));
  } catch {
    return false;
  }
}

if (nativeBinaryInstalled()) process.exit(0); // тишина — штатная установка

const hasBundle = existsSync(join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "myc.js"));
const lines = [""];
if (process.platform === "win32") {
  lines.push(
    "  myc: the native Windows binary did not install (optional dependency skipped?).",
    "  Native path:",
    "      npm install -g @aistastudio/myc --force",
    "  Without it the launcher falls back to the JS bundle, which needs Bun —",
    "  on Windows the supported way is WSL:",
    "      wsl --install",
    "  then, inside WSL: install Bun and @aistastudio/myc there.",
    "",
  );
} else if (hasBundle) {
  lines.push(
    `  myc: no native binary for ${process.platform}/${process.arch} (optional dependency skipped?).`,
    "  The launcher will fall back to the JS bundle, which needs Bun (>= 1.3.0).",
    "  To get the native binary: npm install -g @aistastudio/myc --force",
    "",
  );
} else {
  lines.push(
    "  myc: neither the native binary nor the bundle is present — reinstall:",
    "      npm install -g @aistastudio/myc --force",
    "",
  );
}
process.stderr.write(`${lines.join("\n")}\n`);
