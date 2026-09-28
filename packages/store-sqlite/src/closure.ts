/**
 * МОСТ К ЗАМЫКАНИЮ РОДИТЕЛЕЙ, КОТОРОЕ ЖИВЁТ В ЯДРЕ.
 *
 * Сама материализация (`packages/core/src/closure.ts`) написана генераторами:
 * дерево правит не только CLI, но и сервер (`POST /v1/ws/:ws/edges`), а
 * правило, доступное одному писателю и недоступное другому, — это не правило.
 *
 * Здесь остаётся ровно то, что принадлежит ХРАНИЛИЩУ: синхронный прогон
 * генератора и открытие своей транзакции для одиночных вызовов (тесты,
 * `doctor --recount`). Сигнатуры прежние — переезд алгоритма не повод
 * переписывать вызывающих.
 */

import { runSync, type DbDriver } from "@myc/core";
import * as C from "@myc/core";

export { ClosureError, MAX_PARENT_DEPTH, type ClosureErrorCode, type ClosureRow } from "@myc/core";

export function checkParentInsert(db: DbDriver, child: string, parent: string): void {
  runSync(C.checkParentInsert(child, parent), db);
}

export function applyParentInsert(tx: DbDriver, child: string, parent: string): void {
  runSync(C.applyParentInsert(child, parent), tx);
}

export function applyParentRemove(tx: DbDriver, child: string, parent: string): void {
  runSync(C.applyParentRemove(child, parent), tx);
}

export function applyParentMove(tx: DbDriver, child: string, newParent: string): void {
  runSync(C.applyParentMove(child, newParent), tx);
}

export function applyNodeDeleted(tx: DbDriver, nodeId: string): void {
  runSync(C.applyNodeDeleted(nodeId), tx);
}

export function applyRebuild(tx: DbDriver): void {
  runSync(C.applyRebuild(), tx);
}

// --- входы, открывающие свою транзакцию --------------------------------------
//
// Транзакция — дело хранилища: у SQLite это `BEGIN IMMEDIATE`, у Postgres её
// открывает `withTenant`. Поэтому они и не уехали в ядро вместе с правилами.

export function insertParentEdge(db: DbDriver, child: string, parent: string): void {
  db.tx("immediate", (tx) => applyParentInsert(tx, child, parent));
}

export function removeParentEdge(db: DbDriver, child: string, parent: string): void {
  db.tx("immediate", (tx) => applyParentRemove(tx, child, parent));
}

export function moveParentEdge(db: DbDriver, child: string, newParent: string): void {
  db.tx("immediate", (tx) => applyParentMove(tx, child, newParent));
}

export function deleteNodeClosure(db: DbDriver, nodeId: string): void {
  db.tx("immediate", (tx) => applyNodeDeleted(tx, nodeId));
}

export function rebuildParentClosure(db: DbDriver): { rows: number } {
  return db.tx("immediate", (tx) => {
    applyRebuild(tx);
    return { rows: runSync(C.closureCount(), tx) };
  });
}

// --- чтения ------------------------------------------------------------------

export function dumpParentClosure(db: DbDriver): C.ClosureRow[] {
  return runSync(C.dumpParentClosure(), db);
}

/** Потомки `ancestor`, сам узел не включён. */
export function descendantsOf(
  db: DbDriver,
  ancestor: string,
): Array<{ descendant: string; depth: number }> {
  return runSync(C.descendantsOf(ancestor), db);
}

/** Предки `descendant`, сам узел не включён. */
export function ancestorsOf(
  db: DbDriver,
  descendant: string,
): Array<{ ancestor: string; depth: number }> {
  return runSync(C.ancestorsOf(descendant), db);
}
