/**
 * Воркер конкурентного прогона claim (claim.test.ts, «настоящая конкурентность»).
 *
 * Запускается отдельным ПРОЦЕССОМ (Bun.spawn), рвётся за задачами одной базы
 * вместе с соседями и печатает на stdout одну JSON-строку:
 *   { holder, won: number, ids: string[], latencies: number[] }
 *
 * Режимы: --claim cas — боевой путь GraphStore.claimNode;
 *         --claim twostep — мутант (SELECT → UPDATE без предиката) для
 *         мутационной проверки: детектор должен поймать двойные захваты.
 */

import { openSqlite } from "./index.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations/index.ts";
import { GraphStore, Q } from "./queries.ts";
import { twoStepClaim } from "./claim.ts";

interface Args {
  db: string;
  site: string;
  scope: string;
  holder: string;
  kind: string;
  claim: "cas" | "twostep";
  batchSize: number;
  maxAttempts: number;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const db = get("db");
  if (db === undefined) throw new Error("--db PATH is required");
  return {
    db,
    site: get("site") ?? "siteA",
    scope: get("scope") ?? "s",
    holder: get("holder") ?? "worker",
    kind: get("kind") ?? "task",
    claim: (get("claim") ?? "cas") as "cas" | "twostep",
    batchSize: Number(get("batch-size") ?? 16),
    maxAttempts: Number(get("max-attempts") ?? Number.POSITIVE_INFINITY),
  };
}

const args = parseArgs(Bun.argv.slice(2));
const driver = openSqlite(args.db);
await migrate(driver.database, { migrations, writable: true });
const store = new GraphStore(driver, {
  siteId: args.site,
  actor: args.holder,
  newId: () => {
    throw new Error("the worker does not create nodes");
  },
});

// Барьер старта: все процессы выходят на беговую дорожку до первого захвата,
// иначе горка запуска перекашивает конкуренцию и латентность.
const startDeadline = Date.now() + 60_000;
while (driver.one(Q.meta_get, ["race_start"]) === undefined) {
  if (Date.now() > startDeadline) {
    console.error("start barrier race_start not set within 60 s");
    process.exit(1);
  }
  await Bun.sleep(5);
}

const won: string[] = [];
const latencies: number[] = [];
let attempts = 0;
let exhausted = false;

while (!exhausted) {
  const now = Date.now();
  const candidates = driver.all<{ id: string }>(Q.claim_candidates, [
    args.scope,
    args.kind,
    now,
    args.batchSize,
  ]);
  if (candidates.length === 0) {
    const rest = driver.one<{ n: number }>(Q.claim_remaining, [
      args.scope,
      args.kind,
      now,
    ]);
    if (rest === undefined || rest.n === 0) break;
    continue;
  }
  for (const { id } of candidates) {
    if (attempts >= args.maxAttempts) {
      exhausted = true;
      break;
    }
    attempts += 1;
    const t0 = performance.now();
    const got =
      args.claim === "cas"
        ? store.claimNode(id, args.holder)
        : twoStepClaim(store, id, args.holder);
    // Мутант «побеждает» на каждой попытке — в этом и состоит поломка:
    // он верит устаревшему списку ready, а не ответу CAS.
    if (got !== undefined) {
      won.push(id);
      latencies.push(performance.now() - t0);
    }
  }
}

driver.close();
console.log(
  JSON.stringify({ holder: args.holder, won: won.length, ids: won, latencies }),
);
