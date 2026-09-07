/**
 * Claim задач: CAS-захват, lease с TTL и epoch (§9.4, решение S35).
 *
 * Движок — методы GraphStore.claimNode/renewLease/releaseLease/closeClaimed
 * (queries.ts): один UPDATE с предикатом в WHERE внутри BEGIN IMMEDIATE,
 * окно между чтением и записью не существует. Здесь — эргономика поверх
 * движка: тикет держателя с автопродлением heartbeat'ом каждые LEASE_RENEW_MS,
 * батч-захват из ready и эталон поломки для мутационных тестов.
 *
 * Источники: docs/design/01-core-data-model.md §9.4;
 * docs/design/ARCHITECTURE.md §10 (S35).
 */

import { LEASE_RENEW_MS, LEASE_TTL_MS, Q, GraphStore } from "./queries.ts";
import type { ClaimReceipt, NodeLease } from "./queries.ts";

export { LEASE_RENEW_MS, LEASE_TTL_MS };
export type { ClaimReceipt, NodeLease };

export interface ClaimsOptions {
  /** Имя держателя по умолчанию; иначе GraphStore.actor. */
  readonly holder?: string;
  /** TTL аренды по умолчанию; иначе LEASE_TTL_MS. */
  readonly ttlMs?: number;
}

/**
 * Тикет владения задачей. Эпоха фиксируется на момент захвата: после того как
 * задачу перезахватил другой агент, любой вызов тикета — renew, release, close —
 * безвозвратно получает отказ (CAS по holder+epoch).
 */
export class ClaimTicket {
  private constructor(
    private readonly store: GraphStore,
    readonly id: string,
    readonly holder: string,
    readonly epoch: number,
    private readonly ttlMs: number,
    public expiresAt: number,
  ) {}

  static capture(store: GraphStore, r: ClaimReceipt, ttlMs: number): ClaimTicket {
    return new ClaimTicket(store, r.id, r.holder, r.epoch, ttlMs, r.expiresAt);
  }

  /** Продлить аренду; false — владение потеряно. По умолчанию — своим TTL. */
  renew(ttlMs: number = this.ttlMs): boolean {
    const expiresAt = this.store.renewLease(this.id, this.holder, this.epoch, ttlMs);
    if (expiresAt === undefined) return false;
    this.expiresAt = expiresAt;
    return true;
  }

  /** Вернуть задачу в open; false — владение потеряно. */
  release(): boolean {
    return this.store.releaseLease(this.id, this.holder, this.epoch);
  }

  /** Закрыть взятую задачу (status='closed'); false — владение потеряно. */
  close(): boolean {
    return this.store.closeClaimed(this.id, this.holder, this.epoch);
  }

  /** Тикет всё ещё у держателя и lease не истёк. */
  alive(nowMs: number = Date.now()): boolean {
    const lease = this.store.leaseOf(this.id);
    return (
      lease !== undefined &&
      lease.holder === this.holder &&
      lease.epoch === this.epoch &&
      (lease.expires === 0 || lease.expires > nowMs)
    );
  }

  /**
   * Heartbeat: продлевать lease каждые `intervalMs` (по умолчанию 300 с —
   * втрое чаще TTL 900 с). Возвращает функцию остановки.
   */
  keepAlive(intervalMs: number = LEASE_RENEW_MS): () => void {
    const timer = setInterval(() => {
      this.renew();
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}

/** Фасад claim-операций одного держателя поверх GraphStore. */
export class Claims {
  constructor(
    private readonly store: GraphStore,
    private readonly opts: ClaimsOptions = {},
  ) {}

  get holder(): string {
    return this.opts.holder ?? this.store.actor;
  }

  get ttlMs(): number {
    return this.opts.ttlMs ?? LEASE_TTL_MS;
  }

  /** Захватить конкретную задачу; undefined — она уже не открыта для нас. */
  claim(id: string, ttlMs: number = this.ttlMs): ClaimTicket | undefined {
    const receipt = this.store.claimNode(id, this.holder, ttlMs);
    return receipt === undefined
      ? undefined
      : ClaimTicket.capture(this.store, receipt, ttlMs);
  }

  /**
   * Батч-захват из ready (`myc ready --claim N`, §9.4): один проход по
   * кандидатам, по CAS на каждого. Кандидаты читаются списком, но решение
   * за каждый отвечает отдельный CAS — прочитанный список не обязывает:
   * проигравший просто идёт к следующему. Останавливается, набрав `limit`
   * или исчерпав список.
   */
  claimReady(scope: string, limit = 1, kind = "task"): ClaimTicket[] {
    const now = Date.now();
    const candidates = this.store.driver.all<{ id: string }>(Q.claim_candidates, [
      scope,
      kind,
      now,
      limit,
    ]);
    const won: ClaimTicket[] = [];
    for (const { id } of candidates) {
      if (won.length >= limit) break;
      const ticket = this.claim(id);
      if (ticket !== undefined) won.push(ticket);
    }
    return won;
  }

  leaseOf(id: string): NodeLease | undefined {
    return this.store.leaseOf(id);
  }
}

/**
 * АНТИ-ПАТТЕРН §9.4 — живой эталон поломки для мутационных тестов.
 * Решение принимается по списку ready (шаг 1, чтение — в вызывающем коде),
 * запись — безусловным UPDATE (шаг 2, без предиката). Между шагами другой
 * процесс успевает перезахватить задачу, и «победитель» затирает его lease.
 * CAS в GraphStore.claimNode в той же ситуации возвращает undefined.
 * Никогда не использовать вне мутационных проверок.
 */
export function twoStepClaim(
  store: GraphStore,
  id: string,
  holder: string,
): ClaimReceipt {
  store.driver.tx("immediate", (tx) => {
    tx.run(Q.claim_twostep_node, [id, holder]); // шаг 2: запись без предиката
  });
  const lease = store.leaseOf(id);
  return { id, holder, epoch: lease?.epoch ?? 0, expiresAt: 0 };
}
