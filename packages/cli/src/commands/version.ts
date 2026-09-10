/**
 * `myc version` — версия сборки и, ЕДИНСТВЕННОЙ во всём CLI командой, живая
 * проверка обновлений по флагу `--check`.
 *
 * Почему отдельная команда, а не строка в существующих. Проверка обновлений
 * касается человека, а не агента: агент читает `prime`, `ready`, `recall`, и
 * там сеть запрещена инвариантом И1 (бюджеты prime p99 0.70 мс при потолке
 * 30 — один запрос к реестру превращает их в сотни). Отдельная команда
 * делает границу видимой: сеть уходит ровно оттуда, где её попросили, и
 * замыкание импортов горячего пути этот модуль не содержит — это утверждает
 * update-check.hot-path.test.ts.
 *
 * `myc version` БЕЗ флагов сеть не трогает вовсе: печатает версию и то, что
 * лежит в кеше от прошлой проверки, честно называя её возраст. Ровно поэтому
 * его безопасно звать откуда угодно.
 */

import { CLI_VERSION } from "../index.ts";
import { SCHEMA_VERSION } from "@myc/core";
import type { Command, CommandContext, CommandResult } from "../registry.ts";
import {
  cachedVerdict,
  checkForUpdate,
  PACKAGE_NAME,
  registryUrl,
  updateCheckMode,
  updateNotice,
  UPGRADE_COMMAND,
  type UpdateVerdict,
} from "../update-check.ts";

export interface VersionData {
  readonly version: string;
  readonly schema: number;
  readonly package: string;
  readonly update: UpdateVerdict;
  /** Режим проверки: off | manual | auto — чтобы «почему не проверилось» не гадали. */
  readonly mode: string;
  /** Куда бы пошёл запрос. Печатается всегда — в закрытом контуре это первое, что спросят. */
  readonly registry: string;
}

function flagBool(ctx: CommandContext, name: string): boolean {
  return ctx.flags[name] === true;
}

export function createVersionCommand(): Command {
  return {
    name: "version",
    summary: "print the build version; --check asks the registry for a newer one",
    flags: [
      {
        name: "check",
        description: "ask the npm registry for the latest version (the only network call myc makes)",
      },
      {
        name: "offline",
        description: "forbid the network for this call; --check then reports 'disabled', not 'up to date'",
      },
    ],
    help:
      "Without --check there is no network at all: the verdict comes from the cache written by " +
      "the last check, and its age is printed. With --check the npm registry is asked directly " +
      "(explicit, human-typed, bounded by MYC_UPDATE_CHECK_TIMEOUT_MS, default 3000).\n\n" +
      "An unreachable registry is reported as 'could not check' with the reason and a WARN " +
      "line — never as 'no updates'. Versions are compared numerically, so 0.10.0 is newer than " +
      "0.9.0.\n\n" +
      "Off switches, both directions: MYC_UPDATE_CHECK=0 forbids the network even for --check; " +
      "--offline does the same for one call; MYC_UPDATE_CHECK=1 additionally enables a detached " +
      "background check (at most once a day) from `myc init` and `myc wire`. The default is " +
      "manual: myc never reaches the network on its own.\n\n" +
      "Updating itself is deliberately NOT automated: swapping the binary under a running agent " +
      "changes behaviour mid-session — the task lease is taken by one version and released by " +
      "another. The upgrade command is printed instead.",
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const env = process.env;
      const offline = flagBool(ctx, "offline");
      const check = flagBool(ctx, "check");
      const verdict: UpdateVerdict = check
        ? await checkForUpdate({ current: CLI_VERSION, env, offline })
        : cachedVerdict({ current: CLI_VERSION, env, offline });

      // И2: «не смогли проверить» — деградация, и она обязана быть слышна
      // отдельно от данных (WARN в человеческом выводе, warn[] в конверте,
      // код 6 при --strict). Молча вернуть статус в поле — значит позволить
      // прочитать вывод как «всё в порядке».
      if (verdict.status === "unreachable") {
        ctx.warn("update.unreachable", `the registry did not answer — updates NOT checked: ${verdict.reason}`);
      }
      // Запрошенную проверку запретила политика — тоже деградация: человек
      // просил проверить, и не узнать об отказе он не должен.
      if (check && verdict.status === "disabled") {
        ctx.warn("update.disabled", `update check forbidden: ${verdict.reason}`);
      }

      const data: VersionData = {
        version: CLI_VERSION,
        schema: SCHEMA_VERSION,
        package: PACKAGE_NAME,
        update: verdict,
        mode: updateCheckMode(env),
        registry: registryUrl(env),
      };
      return { ok: true, data, meta: { checked: check } };
    },
    renderHuman: (raw) => {
      const d = raw as VersionData;
      const v = d.update;
      const lines = [`myc ${d.version} (schema ${d.schema})`];
      switch (v.status) {
        case "update_available":
          lines.push(`update: ${v.current} → ${v.latest}`, `  ${UPGRADE_COMMAND}`);
          break;
        case "up_to_date":
          lines.push(`latest in the registry: ${v.latest} — nothing to update to`);
          break;
        case "ahead":
          lines.push(`the registry has ${v.latest} — this build is newer than the published one`);
          break;
        case "unreachable":
          // Слово «не» здесь несёт весь смысл строки: без него вывод
          // читается как «проверено, всё хорошо».
          lines.push(`updates NOT checked: ${v.reason}`);
          break;
        case "disabled":
          lines.push(`update check is off: ${v.reason}`);
          break;
        case "never_checked":
          lines.push("updates never checked — `myc version --check`");
          break;
      }
      if (v.source === "cache" && v.age_ms !== undefined) {
        const notice = updateNotice(v);
        if (notice !== null || v.status === "up_to_date" || v.status === "ahead") {
          lines.push(`  from cache, checked ${Math.max(1, Math.round(v.age_ms / 60_000))} min ago`);
        }
      }
      lines.push(`registry: ${d.registry} · mode: ${d.mode} (MYC_UPDATE_CHECK)`);
      return `${lines.join("\n")}\n`;
    },
  };
}
