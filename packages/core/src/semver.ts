/**
 * Сравнение версий по semver — ЧИСЛАМИ, не строками.
 *
 * Строковое сравнение здесь не «менее точное», а прямо неверное: `"0.10.0" <
 * "0.9.0"` истинно в лексикографике, и проверка обновлений с ним молча
 * сообщала бы «у вас свежая версия» ровно в тот момент, когда вышла десятая
 * минорная. Это не гипотеза: 0.9 → 0.10 переживает каждый пакет, доживший до
 * десятого релиза, а ложное «обновлений нет» неотличимо от правды и потому
 * не находится никогда.
 *
 * Реализация — подмножество semver 2.0.0, которого достаточно реестру npm:
 * `major.minor.patch` обязательны и числовые; предрелиз (`-rc.1`) сравнивается
 * по правилам спецификации (числовые идентификаторы — числами, смешанные —
 * строками, предрелиз МЛАДШЕ одноимённого релиза); билд-метка (`+sha`) в
 * сравнении не участвует вовсе (§10 спецификации).
 *
 * Модуль без зависимостей и без ввода-вывода: его зовут и CLI, и тесты, и он
 * не имеет права тянуть за собой ничего, что стоит времени старта.
 */

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** Идентификаторы предрелиза: число — числовой, строка — алфавитный. */
  readonly prerelease: readonly (number | string)[];
  /** Билд-метка после `+`. Хранится, но в сравнении НЕ участвует. */
  readonly build: string | undefined;
}

const CORE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PRERELEASE_ID = /^[0-9A-Za-z-]+$/;
/** Числовой идентификатор предрелиза: без ведущих нулей (§9 спецификации). */
const NUMERIC_ID = /^(0|[1-9]\d*)$/;

/**
 * Разобрать версию. `null` — не разобралась; вызывающий ОБЯЗАН отличать это
 * от «версии равны»: неразобранная версия не даёт права ни на один вывод.
 * Ведущая `v` снимается — реестры и теги пишут её как придётся.
 */
export function parseSemver(raw: string): Semver | null {
  const text = raw.trim().replace(/^v/, "");
  if (text.length === 0) return null;

  let rest = text;
  let build: string | undefined;
  const plus = rest.indexOf("+");
  if (plus >= 0) {
    build = rest.slice(plus + 1);
    rest = rest.slice(0, plus);
    if (build.length === 0) return null;
  }

  let prereleaseRaw = "";
  const dash = rest.indexOf("-");
  if (dash >= 0) {
    prereleaseRaw = rest.slice(dash + 1);
    rest = rest.slice(0, dash);
    if (prereleaseRaw.length === 0) return null;
  }

  const m = CORE.exec(rest);
  if (m === null) return null;

  const prerelease: (number | string)[] = [];
  if (prereleaseRaw.length > 0) {
    for (const id of prereleaseRaw.split(".")) {
      if (!PRERELEASE_ID.test(id)) return null;
      prerelease.push(NUMERIC_ID.test(id) ? Number(id) : id);
    }
  }

  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease,
    build,
  };
}

/** Сравнение разобранных версий: -1 / 0 / 1. */
export function compareParsedSemver(a: Semver, b: Semver): -1 | 0 | 1 {
  const cmp = (x: number, y: number): -1 | 0 | 1 => (x < y ? -1 : x > y ? 1 : 0);
  const core = cmp(a.major, b.major) || cmp(a.minor, b.minor) || cmp(a.patch, b.patch);
  if (core !== 0) return core;

  // Предрелиз МЛАДШЕ релиза: 1.0.0-rc.1 < 1.0.0. Пустой список — релиз.
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const n = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    // Более длинный набор идентификаторов СТАРШЕ при равном префиксе.
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = typeof x === "number";
    const yNum = typeof y === "number";
    if (xNum && yNum) {
      const c = cmp(x, y);
      if (c !== 0) return c;
      continue;
    }
    // Числовой идентификатор ВСЕГДА младше алфавитного (§11.4.3).
    if (xNum) return -1;
    if (yNum) return 1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Сравнить две версии-строки. `null` — хотя бы одна не разобралась, и это
 * ТРЕТИЙ исход, а не «равны»: вызывающий обязан сказать «не смогли сравнить».
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) return null;
  return compareParsedSemver(pa, pb);
}

/**
 * Строго новее ли `candidate`, чем `current`. `false` при неразобранной
 * версии — предлагать обновление на то, чего не смогли прочитать, нельзя.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  return compareSemver(candidate, current) === 1;
}
