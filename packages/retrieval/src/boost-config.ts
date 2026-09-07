// Коэффициенты бустов ранжирования из workspace.toml (§2.2).
//
// Числа §2.2 живут в DEFAULT_HYBRID_CONFIG, но «вынести в конфиг» означает и
// то, что их можно переопределить, не пересобирая бинарь: у разных корпусов
// разная цена свежести и разная польза от слоя, а перекалибровка коэффициента
// — это замер (bench/boost-eval.ts), который делают на своём воркспейсе.
//
// Разбор нарочно крошечный и в том же духе, что absorbThresholdsFromToml в
// @myc/core: «ключ = число» и «ключ = [a, b, c, d]», всё прочее игнорируется.
// Неверное значение НЕ роняет поиск — остаётся умолчание: ранжирование не то
// место, где опечатка в конфиге должна лишать пользователя выдачи.

import {
  DEFAULT_GRAPH_DECAY_BY_HOP,
  DEFAULT_GRAPH_TYPE_WEIGHTS,
  DEFAULT_HYBRID_CONFIG,
  DEFAULT_LAYER_WEIGHTS,
  type HybridConfig,
  type HybridProfile,
} from "./hybrid.ts";

/** Ровно те поля HybridConfig, которые задают boost(d). */
export type BoostSettings = Pick<
  HybridConfig,
  | "priorityBoostP0"
  | "priorityBoostP1"
  | "priorityPenaltyP3"
  | "freshnessAmplitude"
  | "freshnessTauDays"
  | "layerWeights"
>;

export const DEFAULT_BOOST_SETTINGS: BoostSettings = Object.freeze({
  priorityBoostP0: DEFAULT_HYBRID_CONFIG.priorityBoostP0,
  priorityBoostP1: DEFAULT_HYBRID_CONFIG.priorityBoostP1,
  priorityPenaltyP3: DEFAULT_HYBRID_CONFIG.priorityPenaltyP3,
  freshnessAmplitude: DEFAULT_HYBRID_CONFIG.freshnessAmplitude,
  freshnessTauDays: DEFAULT_HYBRID_CONFIG.freshnessTauDays,
  layerWeights: DEFAULT_LAYER_WEIGHTS,
});

/** Скалярные ключи секции [retrieval] -> поле конфига. */
const SCALAR_KEYS: Readonly<Record<string, keyof BoostSettings>> = {
  priority_boost_p0: "priorityBoostP0",
  priority_boost_p1: "priorityBoostP1",
  priority_penalty_p3: "priorityPenaltyP3",
  freshness_amplitude: "freshnessAmplitude",
  freshness_tau_days: "freshnessTauDays",
};

/** Ключи весов слоёв: по одному массиву [L0, L1, L2, L3] на профиль. */
const LAYER_KEYS: Readonly<Record<string, HybridProfile>> = {
  layer_weights_prime: "prime",
  layer_weights_deep: "deep",
  layer_weights_balanced: "balanced",
};

function parseWeights(raw: string): readonly [number, number, number, number] | null {
  const m = /^\[([^\]]*)\]/.exec(raw.trim());
  if (!m) return null;
  const parts = m[1]!
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  // Отрицательный вес слоя перевернул бы порядок выдачи знаком, а не величиной,
  // и это почти наверняка опечатка, а не намерение.
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

/**
 * Секция [retrieval] из workspace.toml. Возвращает базу с применёнными
 * переопределениями; строки, которые не разобрались, молча пропускаются —
 * ровно как в absorbThresholdsFromToml.
 */
export function boostSettingsFromToml(
  text: string,
  base: BoostSettings = DEFAULT_BOOST_SETTINGS,
): BoostSettings {
  const scalars: Record<string, number> = {
    priorityBoostP0: base.priorityBoostP0,
    priorityBoostP1: base.priorityBoostP1,
    priorityPenaltyP3: base.priorityPenaltyP3,
    freshnessAmplitude: base.freshnessAmplitude,
    freshnessTauDays: base.freshnessTauDays,
  };
  const layers: Record<HybridProfile, readonly [number, number, number, number]> = {
    prime: base.layerWeights.prime,
    deep: base.layerWeights.deep,
    balanced: base.layerWeights.balanced,
  };

  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sec = /^\[([a-z_.]+)\]$/i.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    if (section !== "retrieval") continue;
    const kv = /^([a-z0-9_]+)\s*=\s*(.+)$/i.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const raw = kv[2]!;

    const layerProfile = LAYER_KEYS[key];
    if (layerProfile !== undefined) {
      const w = parseWeights(raw);
      if (w !== null) layers[layerProfile] = w;
      continue;
    }

    const field = SCALAR_KEYS[key];
    if (field === undefined) continue;
    const n = Number(raw.split("#")[0]!.trim());
    if (!Number.isFinite(n) || n < 0) continue;
    // τ в днях — величина другого порядка, чем прибавка к бусту; общего
    // потолка у них нет, поэтому единственная проверка — неотрицательность,
    // а τ = 0 запрещено отдельно: на нём exp(−age/0) не определён.
    if (field === "freshnessTauDays" && n <= 0) continue;
    scalars[field] = n;
  }

  return Object.freeze({
    priorityBoostP0: scalars.priorityBoostP0!,
    priorityBoostP1: scalars.priorityBoostP1!,
    priorityPenaltyP3: scalars.priorityPenaltyP3!,
    freshnessAmplitude: scalars.freshnessAmplitude!,
    freshnessTauDays: scalars.freshnessTauDays!,
    layerWeights: Object.freeze(layers),
  });
}

// ===========================================================================
// Расширение по графу: те же правила, тот же файл (memory-1md1zhs0w8r0)
// ===========================================================================
//
// Затухание по глубине и веса типов рёбер живут ЗДЕСЬ, рядом с бустами, по той
// же причине: без конфигурации точку «расширение выключено» нельзя получить,
// не правя исходник, — то есть нельзя ИЗМЕРИТЬ, что обход вообще что-то
// делает. Замер: bench/graph-eval.ts, результат bench/graph-eval.json.

/** Ровно те поля HybridConfig, которые задают обход графа. */
export type GraphSettings = Pick<
  HybridConfig,
  | "graphMaxHops"
  | "graphDecayByHop"
  | "graphSeeds"
  | "graphMinEdgeWeight"
  | "graphHopFanout"
  | "graphHop2Seeds"
  | "graphTypeWeights"
  | "graphTypeWeightDefault"
>;

export const DEFAULT_GRAPH_SETTINGS: GraphSettings = Object.freeze({
  graphMaxHops: DEFAULT_HYBRID_CONFIG.graphMaxHops,
  graphDecayByHop: DEFAULT_GRAPH_DECAY_BY_HOP,
  graphSeeds: DEFAULT_HYBRID_CONFIG.graphSeeds,
  graphMinEdgeWeight: DEFAULT_HYBRID_CONFIG.graphMinEdgeWeight,
  graphHopFanout: DEFAULT_HYBRID_CONFIG.graphHopFanout,
  graphHop2Seeds: DEFAULT_HYBRID_CONFIG.graphHop2Seeds,
  graphTypeWeights: DEFAULT_GRAPH_TYPE_WEIGHTS,
  graphTypeWeightDefault: DEFAULT_HYBRID_CONFIG.graphTypeWeightDefault,
});

/** Скалярные ключи секции [retrieval] -> поле конфига обхода. */
const GRAPH_SCALAR_KEYS: Readonly<Record<string, keyof GraphSettings>> = {
  graph_max_hops: "graphMaxHops",
  graph_seeds: "graphSeeds",
  graph_min_edge_weight: "graphMinEdgeWeight",
  graph_hop_fanout: "graphHopFanout",
  graph_hop2_seeds: "graphHop2Seeds",
  graph_type_weight_default: "graphTypeWeightDefault",
};

/** Целые ключи: доли узлов и хопов дробными не бывают. */
const GRAPH_INT_KEYS = new Set<keyof GraphSettings>([
  "graphMaxHops",
  "graphSeeds",
  "graphHopFanout",
  "graphHop2Seeds",
]);

/**
 * Затухание: `graph_decay_by_hop = [0.5, 0.5]`. Длина списка — это и есть
 * максимальная глубина, до которой затухание вообще описано: хоп глубже
 * последнего элемента не выполняется, даже если graph_max_hops больше.
 * Значение вне (0, 1] отвергается: затухание, равное нулю, обнуляет всю ветку
 * молча, а большее единицы — уже не затухание, а усиление с глубиной.
 */
function parseDecay(raw: string): readonly number[] | null {
  const m = /^\[([^\]]*)\]/.exec(raw.trim());
  if (!m) return null;
  const parts = m[1]!
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  if (parts.length === 0 || parts.length > 2) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n <= 0 || n > 1)) return null;
  return Object.freeze(nums);
}

/**
 * Веса типов: `graph_type_weights = { mentions = 0.5, touches = 0.5 }`.
 * Разбор такой же крошечный, как у остальных ключей: пары «имя = число»
 * внутри фигурных скобок, всё прочее пропускается. Отрицательный вес
 * запрещён — он переворачивал бы порядок знаком, а не величиной.
 */
function parseTypeWeights(raw: string): Readonly<Record<string, number>> | null {
  const m = /^\{([^}]*)\}/.exec(raw.trim());
  if (!m) return null;
  const out: Record<string, number> = {};
  for (const pair of m[1]!.split(",")) {
    const kv = /^\s*([a-z_]+)\s*=\s*([0-9.]+)\s*$/i.exec(pair);
    if (!kv) continue;
    const n = Number(kv[2]);
    if (!Number.isFinite(n) || n < 0) continue;
    out[kv[1]!.toLowerCase()] = n;
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
}

/**
 * Секция [retrieval] из workspace.toml — параметры обхода. Как и у бустов,
 * строка, которая не разобралась, молча пропускается: опечатка в конфиге не
 * то место, где пользователь должен лишаться выдачи.
 */
export function graphSettingsFromToml(
  text: string,
  base: GraphSettings = DEFAULT_GRAPH_SETTINGS,
): GraphSettings {
  const out: Record<string, unknown> = { ...base };

  let section = "";
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sec = /^\[([a-z_.]+)\]$/i.exec(line);
    if (sec) {
      section = sec[1]!.toLowerCase();
      continue;
    }
    if (section !== "retrieval") continue;
    const kv = /^([a-z0-9_]+)\s*=\s*(.+)$/i.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const raw = kv[2]!;

    if (key === "graph_decay_by_hop") {
      const d = parseDecay(raw);
      if (d !== null) out.graphDecayByHop = d;
      continue;
    }
    if (key === "graph_type_weights") {
      const w = parseTypeWeights(raw);
      if (w !== null) out.graphTypeWeights = w;
      continue;
    }
    const field = GRAPH_SCALAR_KEYS[key];
    if (field === undefined) continue;
    const n = Number(raw.split("#")[0]!.trim());
    if (!Number.isFinite(n) || n < 0) continue;
    if (GRAPH_INT_KEYS.has(field) && !Number.isInteger(n)) continue;
    out[field] = n;
  }

  return Object.freeze(out as unknown as GraphSettings);
}
