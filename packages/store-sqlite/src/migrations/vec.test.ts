import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { VecSelfCheckReport } from "./vec-selfcheck.ts";

// vec0 требует внешней libsqlite3 и Database.setCustomSQLite, а тот допустим
// один раз и только до открытия первого соединения. `bun test` гоняет все файлы
// в одном процессе, поэтому проверка живёт в дочернем (см. ./vec-selfcheck.ts).
const proc = Bun.spawnSync(["bun", "run", join(import.meta.dir, "vec-selfcheck.ts")], {
  stdout: "pipe",
  stderr: "pipe",
});

const stdout = proc.stdout.toString().trim();
const report: VecSelfCheckReport = proc.success
  ? (JSON.parse(stdout) as VecSelfCheckReport)
  : { available: false, reason: `дочерний процесс упал: ${proc.stderr.toString().trim()}` };

if (!report.available) {
  console.warn(
    `[vec] проверка векторного набора ПРОПУЩЕНА: ${report.reason}. ` +
      "Без vec0 базовая схема полноценна (S26) — это покрыто schema.test.ts. " +
      "Чтобы прогнать: MYC_SQLITE_LIB=<libsqlite3 с расширениями> MYC_SQLITE_VEC=<путь к vec0 без расширения файла>",
  );
}

describe.skipIf(!report.available)("векторный набор при загруженном vec0", () => {
  test("миграция создаёт nodes_vec и записывает свой учёт", () => {
    expect(report.appliedVersions).toEqual([1, 2, 3, 4]);
    expect(report.skipped).toBe(false);
    expect(report.objects).toContain("nodes_vec");
    // shadow-таблицы vec0 — доказательство, что оператор не был молча пропущен
    expect(report.objects).toContain("nodes_vec_chunks");
    expect(report.bookkeeping).toEqual([
      { version: 1, name: "vec_init" },
      { version: 2, name: "vec_rerank_f32" },
      { version: 3, name: "vec_rerank_f32_lru_index" },
      { version: 4, name: "vec_embed_meta" },
    ]);
    // Учёт векторных миграций отдельный, базовый не тронут (S26).
    expect(report.objects).toContain("schema_migrations_vec");
    expect(report.objects).toContain("schema_migrations");
  });

  test("vec_nodes_f32 (переранжирование) заведена той же миграцией, без ручного создания", () => {
    expect(report.objects).toContain("vec_nodes_f32");
    expect(report.objects).toContain("ix_vec_f32_accessed");
    expect(report.f32RoundTrip).toEqual([{ node_id: "node-f32-1", matches: true }]);
  });

  test("вставка через vec_int8() и KNN с фильтром по (scope, layer) работают", () => {
    const knn = report.filteredKnn ?? [];
    expect(knn.length).toBe(3);
    // Ближайший — вектор с наименьшим числом инвертированных координат.
    expect(knn[0]!.node_rowid).toBe(1);
    const distances = knn.map((r) => r.distance);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
    // Строка из чужой партиции (scope='s2', layer=3) в выдачу не попала.
    expect(knn.map((r) => r.node_rowid)).not.toContain(99);
  });

  test("сырой BLOB отвергается: vec0 читает его как float32", () => {
    expect(report.rawBlobRejected).toBe(true);
    expect(report.rawBlobError).toContain("expected to be of type int8");
    expect(report.rawBlobError).toContain("float32 vector was provided");
  });
});
