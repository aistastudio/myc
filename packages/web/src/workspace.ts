/**
 * Конфигурация воркспейса, нужная просмотрщику: slug и веса сортировки ready.
 *
 * Разбор здесь свой, а не импорт из CLI, по двум причинам: `@myc/web` не
 * должен зависеть от поверхности `@myc/cli` (иначе поверхности зацепляются
 * друг за друга), и просмотрщик обязан подниматься на воркспейсе, где
 * workspace.toml битый или отсутствует. Значения — ратифицированные S21.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { ReadyWeights, WorkspaceTier } from "./types.ts";

/** Веса сортировки ready (решение S21). Переопределяются секцией [ready]. */
export const DEFAULT_READY_WEIGHTS: ReadyWeights = {
  priority: 0.4,
  unblocks: 0.27,
  freshness: 0.14,
  anchors: 0.1,
  type: 0.09,
};

export interface WorkspaceConfig {
  readonly slug: string;
  readonly weights: ReadyWeights;
  /** scope в базе: у воркспейса по умолчанию он пустой, у остальных = slug. */
  readonly scope: string;
}

const WEIGHT_KEYS: readonly (keyof ReadyWeights)[] = [
  "priority",
  "unblocks",
  "freshness",
  "anchors",
  "type",
];

/** Тот же крошечный подмножество TOML, что и в CLI: [секции] и key = value. */
export function parseWorkspaceToml(text: string): { slug: string; weights: ReadyWeights } {
  let slug = "myc";
  const weights: Record<string, number> = { ...DEFAULT_READY_WEIGHTS };
  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sec = /^\[([a-z_]+)\]$/i.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    const kv = /^([a-z_]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1]!;
    const raw = kv[2]!.trim();
    if (section === "ready" && WEIGHT_KEYS.includes(key as keyof ReadyWeights)) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) weights[key] = n;
    } else if (section === "" && key === "slug") {
      const s = /^"([a-z][a-z0-9]{1,7})"$/.exec(raw);
      if (s) slug = s[1]!;
    }
  }
  return { slug, weights: weights as unknown as ReadyWeights };
}

export function loadWorkspace(dir: string): WorkspaceConfig {
  let slug = "myc";
  let weights = DEFAULT_READY_WEIGHTS;
  const tomlPath = join(dir, ".myc", "workspace.toml");
  if (existsSync(tomlPath)) {
    try {
      const parsed = parseWorkspaceToml(readFileSync(tomlPath, "utf8"));
      slug = parsed.slug;
      weights = parsed.weights;
    } catch {
      // битый конфиг не должен ронять просмотрщик — остаются дефолты S21
    }
  }
  return { slug, weights, scope: slug === "myc" ? "" : slug };
}

/** Размер файла в байтах или 0, если его нет (WAL после чекпойнта исчезает). */
export function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Ярус открытой базы (S41): личный `~/.myc` против проектного `.myc/` внутри
 * репозитория. Различает их только путь базы — физически это разные хранилища,
 * и просмотрщик всегда открыт ровно на одном из них, поэтому ось показывается
 * один раз в шапке, а не примешивается к строкам списка (у тех свои оси
 * охвата S58/S59 из attrs). Пустой HOME — проектный без догадок.
 */
export function tierOf(dbPath: string, home: string | undefined): WorkspaceTier {
  if (home === undefined || home.trim().length === 0) return "project";
  const personalDir = resolve(home, ".myc");
  const resolved = resolve(dbPath);
  return resolved === personalDir || resolved.startsWith(personalDir + sep)
    ? "personal"
    : "project";
}
