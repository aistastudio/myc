/**
 * Общая оснастка тестов пакета: временный воркспейс с настоящей схемой и
 * генератор графа нужного размера. Схема берётся из @myc/store-sqlite, а не
 * пишется здесь копией: тест обязан ломаться, когда меняется DDL.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";

export interface Workspace {
  readonly dir: string;
  readonly dbPath: string;
  readonly db: Database;
  cleanup(): void;
}

export async function makeWorkspace(toml?: string): Promise<Workspace> {
  const dir = mkdtempSync(join(tmpdir(), "myc-viz-"));
  mkdirSync(join(dir, ".myc"));
  const dbPath = join(dir, ".myc", "myc.db");
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  await migrate(db, { migrations, writable: true });
  if (toml !== undefined) writeFileSync(join(dir, ".myc", "workspace.toml"), toml);
  return {
    dir,
    dbPath,
    db,
    cleanup(): void {
      try {
        db.close();
      } catch {
        // уже закрыта — не мешает уборке
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

let seq = 0;

export interface SeedOptions {
  readonly nodes: number;
  /** Префикс id — второй засев в ту же базу не должен биться о PK. */
  readonly prefix?: string;
  /** Рёбер на узел; связи ставятся детерминированно, чтобы граф был связным. */
  readonly edgesPerNode?: number;
  readonly kinds?: readonly string[];
  readonly now?: number;
}

/**
 * Наполнение прямым INSERT, а не через GraphStore: тест меряет просмотрщик,
 * а не движок записи, и 10k узлов через оплог заняли бы минуты.
 */
export function seedGraph(db: Database, opts: SeedOptions): void {
  const n = opts.nodes;
  const kinds = opts.kinds ?? ["task", "note", "doc", "fragment", "session", "entity"];
  const now = opts.now ?? Date.now();
  const perNode = opts.edgesPerNode ?? 2;
  const p = opts.prefix ?? "n";

  const insNode = db.prepare(
    `INSERT INTO nodes (id, kind, layer, scope, title, status, priority, open_blockers,
                        content_hash, created_at, updated_at, actor, attrs)
     VALUES (?1, ?2, ?3, '', ?4, ?5, ?6, 0, ?7, ?8, ?9, 'seed', ?10)`,
  );
  const insEdge = db.prepare(
    `INSERT OR IGNORE INTO edges (src, type, dst, add_tag, actor, created_at)
     VALUES (?1, ?2, ?3, ?4, 'seed', ?5)`,
  );
  const edgeTypes = ["blocks", "relates", "parent", "mentions", "touches"] as const;

  db.exec("BEGIN");
  for (let i = 0; i < n; i++) {
    const kind = kinds[i % kinds.length]!;
    const status = kind === "task" ? (i % 7 === 0 ? "in_progress" : "open") : "active";
    insNode.run(
      `${p}-${i}`,
      kind,
      i % 4,
      `узел ${i}`,
      status,
      i % 4,
      `h${seq++}-${i}`,
      now - i * 1000,
      now - i * 500,
      kind === "task" ? JSON.stringify({ type: i % 3 === 0 ? "bug" : "task" }) : "{}",
    );
  }
  for (let i = 0; i < n; i++) {
    for (let k = 1; k <= perNode; k++) {
      const dst = (i + k * 7 + 1) % n;
      if (dst === i) continue;
      // blocks исключён из наполнения: его триггеры двигают open_blockers и
      // выкинули бы половину задач из ready, а очередь тут тоже проверяется.
      const type = edgeTypes[(i + k) % edgeTypes.length]!;
      insEdge.run(`${p}-${i}`, type === "blocks" ? "relates" : type, `${p}-${dst}`, `${p}t${i}-${k}`, now);
    }
  }
  db.exec("COMMIT");
}

export function seedOplog(db: Database, count: number, now = Date.now()): void {
  const ins = db.prepare(
    `INSERT INTO oplog (op_id, site_id, hlc, ts_ms, actor, op, entity, entity_id, field, value, scope, origin)
     VALUES (?1, 'site-a', ?2, ?3, ?4, ?5, 'node', ?6, ?7, ?8, '', 1)`,
  );
  const ops = ["set", "inc", "edge_add", "edge_del", "claim"] as const;
  db.exec("BEGIN");
  for (let i = 0; i < count; i++) {
    ins.run(
      `site-a:${i}`,
      i,
      now - (count - i) * 60_000,
      i % 2 === 0 ? "claude-1" : "human",
      ops[i % ops.length]!,
      `n-${i % 50}`,
      "status",
      JSON.stringify("open"),
    );
  }
  db.exec("COMMIT");
}
