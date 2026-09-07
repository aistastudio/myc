/**
 * Экран «роутинг»: модель × класс задачи, цена, доля успеха (W12).
 *
 * Приёмка одной строкой: панель обязана показывать достаточную статистику,
 * чтобы координатор выбрал модель, НЕ СПРАШИВАЯ НИКОГО. Данные не считаются
 * здесь заново — читаются готовые из `compareModels` (@myc/swarm/compare.ts),
 * той же функции, что печатает `myc report models`. Разойтись с CLI в ответе
 * «какая модель дешевле» значило бы вести панель, которой нельзя доверять
 * решение.
 *
 * ЧЕСТНОСТЬ, А НЕ КРАСОТА: `answer` каждого класса (single_arm,
 * insufficient_attempts, no_cost_data, ok) переносится в `degraded` того же
 * payload, что и экран здоровья — молчаливого «среднее по одной попытке
 * выглядит как вывод» здесь не бывает (И2). costUsdMean остаётся `null`,
 * когда стоимость не посчитана НИ У ОДНОЙ попытки руки, и числом (включая 0),
 * когда посчитана, — это разные состояния, и подменять одно другим нельзя.
 */

import { compareModels, type ClassAnswer } from "@myc/swarm";
import type { ReadOnlyDb } from "./db.ts";
import type {
  Degradation,
  RoutingArm,
  RoutingClass,
  RoutingCoverage,
  RoutingPayload,
} from "./types.ts";

export interface RoutingOptions {
  readonly taskClass?: string;
  readonly since?: number;
  readonly minAttempts?: number;
}

function toArm(a: ClassAnswer["arms"][number], cls: ClassAnswer): RoutingArm {
  return {
    arm: a.arm,
    modelId: a.modelId,
    effort: a.effort,
    harness: a.harness,
    attempts: a.attempts,
    qualityMean: a.qualityMean,
    quality: a.quality,
    costUsdMean: a.costUsdMean,
    costedAttempts: a.costedAttempts,
    costCoverage: a.costCoverage,
    cleanRate: a.cleanRate,
    enoughData: a.enoughData,
    isCheapest: cls.cheapest === a.arm,
    isEqualGroup: cls.equalGroup.includes(a.arm),
  };
}

function emptyPayload(minAttempts: number, degraded: Degradation[], t0: number): RoutingPayload {
  return {
    available: false,
    classes: [],
    coverage: {
      attempts: 0,
      finished: 0,
      withCost: 0,
      arms: 0,
      classes: 0,
      tasksClosed: 0,
      tasksAttributed: 0,
    },
    outcomeVersion: 0,
    minAttempts,
    credibleMass: 0.9,
    degraded,
    took_ms: Math.round(performance.now() - t0),
  };
}

export function buildRouting(db: ReadOnlyDb, opts: RoutingOptions = {}): RoutingPayload {
  const t0 = performance.now();
  const minAttempts = opts.minAttempts ?? 3;

  if (!db.has("swarm_attempt")) {
    return emptyPayload(minAttempts, [
      {
        code: "swarm.missing",
        msg: "таблицы swarm_attempt нет — атрибуция ещё не заводилась ни для одной попытки",
      },
    ], t0);
  }

  const report = compareModels(db.raw(), {
    taskClass: opts.taskClass,
    since: opts.since,
    minAttempts: opts.minAttempts,
  });

  const degraded: Degradation[] = [];
  if (report.classes.length === 0) {
    degraded.push({
      code: "swarm.no_attribution",
      msg: "атрибуции нет: ни одной закрытой попытки",
    });
  }
  for (const cls of report.classes) {
    if (cls.answer === "single_arm") {
      degraded.push({
        code: `routing.single_arm.${cls.taskClass}`,
        msg: `${cls.taskClass}: сравнивать не с чем — ${cls.why}`,
      });
    } else if (cls.answer === "insufficient_attempts") {
      degraded.push({
        code: `routing.insufficient_attempts.${cls.taskClass}`,
        msg: `${cls.taskClass}: наблюдений не хватает — ${cls.why}`,
      });
    } else if (cls.answer === "no_cost_data") {
      degraded.push({
        code: `routing.no_cost_data.${cls.taskClass}`,
        msg: `${cls.taskClass}: ${cls.why}`,
      });
    } else if (cls.separationPending) {
      degraded.push({
        code: `routing.separation_pending.${cls.taskClass}`,
        msg: `${cls.taskClass}: разница не подтверждена — ${cls.why}`,
      });
    }
  }

  const classes: RoutingClass[] = report.classes.map((cls) => ({
    taskClass: cls.taskClass,
    arms: cls.arms.map((a) => toArm(a, cls)),
    qualityLeader: cls.qualityLeader,
    cheapest: cls.cheapest,
    separationPending: cls.separationPending,
    answer: cls.answer,
    why: cls.why,
  }));

  const closed = db.has("nodes")
    ? db.one<{ n: number }>(
        "SELECT count(*) AS n FROM nodes WHERE kind = 'task' AND status = 'closed' AND deleted_at IS NULL",
      )
    : undefined;
  const attributed = db.one<{ n: number }>(
    "SELECT count(DISTINCT task_id) AS n FROM swarm_attempt WHERE finished_at IS NOT NULL",
  );

  const coverage: RoutingCoverage = {
    attempts: report.coverage.attempts,
    finished: report.coverage.finished,
    withCost: report.coverage.withCost,
    arms: report.coverage.arms,
    classes: report.coverage.classes,
    tasksClosed: closed?.n ?? 0,
    tasksAttributed: attributed?.n ?? 0,
  };

  return {
    available: true,
    classes,
    coverage,
    outcomeVersion: report.outcomeVersion,
    minAttempts: report.minAttempts,
    credibleMass: report.credibleMass,
    degraded,
    took_ms: Math.round(performance.now() - t0),
  };
}
