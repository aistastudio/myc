import { describe, expect, test } from "bun:test";
import { compareSemver, isNewerVersion, parseSemver } from "./semver.ts";

describe("semver: сравнение числами, а не строками", () => {
  test("0.10.0 СТАРШЕ 0.9.0 — ловушка лексикографики", () => {
    // Строкой "0.10.0" < "0.9.0", и на этом проверка обновлений врала бы.
    expect("0.10.0" < "0.9.0").toBe(true);
    expect(compareSemver("0.10.0", "0.9.0")).toBe(1);
    expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
    expect(isNewerVersion("0.9.0", "0.10.0")).toBe(false);
  });

  test("та же ловушка на каждом разряде", () => {
    const pairs: [string, string][] = [
      ["0.9.10", "0.9.9"],
      ["1.10.0", "1.9.9"],
      ["10.0.0", "9.9.9"],
      ["0.1.10", "0.1.9"],
      ["2.0.0", "10.0.0"],
    ];
    for (const [a, b] of pairs) {
      const cmp = compareSemver(a, b);
      expect([a, b, cmp]).toEqual([a, b, a === "2.0.0" ? -1 : 1]);
    }
  });

  test("равные версии — 0, и это не «новее»", () => {
    expect(compareSemver("0.1.1", "0.1.1")).toBe(0);
    expect(isNewerVersion("0.1.1", "0.1.1")).toBe(false);
  });

  test("собранная новее опубликованной — обновляться некуда", () => {
    // Ровно текущее состояние проекта: в реестре 0.1.0, собрана 0.1.1.
    expect(compareSemver("0.1.0", "0.1.1")).toBe(-1);
    expect(isNewerVersion("0.1.0", "0.1.1")).toBe(false);
  });

  test("предрелиз младше релиза, и между собой по правилам спецификации", () => {
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareSemver("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
    // Числовой идентификатор младше алфавитного.
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    // Более длинный набор при равном префиксе — старше.
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    // Предрелиз следующей версии всё равно новее текущего релиза.
    expect(isNewerVersion("0.2.0-rc.1", "0.1.1")).toBe(true);
  });

  test("билд-метка в сравнении не участвует", () => {
    expect(compareSemver("1.0.0+aaa", "1.0.0+bbb")).toBe(0);
    expect(parseSemver("1.2.3+sha.1")?.build).toBe("sha.1");
  });

  test("ведущая v снимается: теги пишут её как придётся", () => {
    expect(compareSemver("v0.10.0", "0.9.0")).toBe(1);
  });

  test("неразобранная версия — ТРЕТИЙ исход, а не «равны»", () => {
    // null вместо 0: иначе битый ответ реестра стал бы «обновлений нет».
    expect(compareSemver("latest", "0.1.1")).toBeNull();
    expect(compareSemver("0.1", "0.1.1")).toBeNull();
    expect(compareSemver("", "0.1.1")).toBeNull();
    expect(compareSemver("1.2.3.4", "0.1.1")).toBeNull();
    expect(compareSemver("01.2.3", "0.1.1")).toBeNull();
    expect(compareSemver("1.0.0-", "0.1.1")).toBeNull();
    // …и это никогда не «есть обновление».
    expect(isNewerVersion("не версия", "0.1.1")).toBe(false);
    expect(isNewerVersion("0.1.1", "мусор")).toBe(false);
  });

  test("разбор возвращает разряды числами", () => {
    expect(parseSemver("0.10.3-rc.2")).toEqual({
      major: 0,
      minor: 10,
      patch: 3,
      prerelease: ["rc", 2],
      build: undefined,
    });
  });
});
