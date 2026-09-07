/**
 * Харнесс конкурентных прогонов claim: поднимает 8 отдельных процессов
 * (Bun.spawn) воркера claim.worker.ts против одной базы и собирает отчёты.
 * Используется тестами claim.test.ts — и боевым прогоном (cas), и
 * мутационным (twostep).
 */

import { join } from "node:path";

export interface WorkerReport {
  readonly holder: string;
  readonly won: number;
  readonly ids: string[];
  readonly latencies: number[];
}

export interface RaceOptions {
  readonly processes: number;
  readonly claim: "cas" | "twostep";
  readonly batchSize: number;
  readonly scope: string;
  readonly kind: string;
  readonly site: string;
  readonly maxAttempts: number;
}

export async function runClaimWorkers(
  dbPath: string,
  opts: Partial<RaceOptions> & { go?: () => void } = {},
): Promise<WorkerReport[]> {
  const options: RaceOptions = {
    processes: opts.processes ?? 8,
    claim: opts.claim ?? "cas",
    batchSize: opts.batchSize ?? 16,
    scope: opts.scope ?? "s",
    kind: opts.kind ?? "task",
    site: opts.site ?? "siteA",
    // Мутант (twostep) не даёт предикату ready «выгореть» — его прогон
    // ограничен числом попыток, боевой (cas) завершается по исчерпанию.
    maxAttempts: opts.maxAttempts ?? (opts.claim === "twostep" ? 200 : Number.POSITIVE_INFINITY),
  };
  const workerPath = join(import.meta.dir, "claim.worker.ts");
  const procs = Array.from({ length: options.processes }, (_, i) =>
    Bun.spawn({
      cmd: [
        process.execPath,
        workerPath,
        "--db",
        dbPath,
        // Каждый процесс роя — свой сайт (§9.5): op_id = site:seq, поэтому
        // независимые процессы одного сайта сталкивались бы оплог-коллизиями.
        // Ровно для межсайтовых конфликтов claim и существует merge_claim.
        "--site",
        `${options.site}:w${i}`,
        "--scope",
        options.scope,
        "--kind",
        options.kind,
        "--holder",
        `w${i}`,
        "--claim",
        options.claim,
        "--batch-size",
        String(options.batchSize),
        "--max-attempts",
        String(options.maxAttempts),
      ],
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  // Все процессы заспавнены и ждут барьер race_start — можно открывать старт.
  opts.go?.();
  return Promise.all(
    procs.map(async (proc, i) => {
      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const code = await proc.exited;
      if (code !== 0) {
        throw new Error(`воркер w${i} завершился с кодом ${code}: ${err}`);
      }
      return JSON.parse(out) as WorkerReport;
    }),
  );
}
