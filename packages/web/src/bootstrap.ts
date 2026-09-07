/**
 * Экран «бутстрап» (W9, memory-hxatd6ce2ymn): редактор обязательного
 * контекста, который агент читает ДО начала работы.
 *
 * ПРЕДПРОСМОТР — БУКВАЛЬНЫЙ ВЫВОД `myc bootstrap`, не пересборка на этом
 * сервере. `loadBootstrapPreview` прогоняет ту же команду CLI (`runCli` из
 * mutate.ts, `run()` из @myc/cli) и возвращает как есть поле `data.text` её
 * JSON-конверта — то, что реально печатает бюджетируемый рендер
 * (packages/cli/src/commands/bootstrap.ts, `renderBootstrap`), обрезку
 * включая. Пересчитать блоки здесь заново значило бы завести вторую
 * реализацию бюджета рядом с первой — ровно та ошибка, из-за которой
 * mutate.ts запрещает второй путь записи (S38/S40); для рендера бюджета
 * действует тот же довод.
 *
 * ЗАПИСЬ — ТЕМ ЖЕ ДВИЖКОМ, ЧТО И ОСТАЛЬНЫЕ МУТАЦИИ ВЕБА: `planBootstrapSet`
 * и `planBootstrapRm` собирают argv для `myc bootstrap set|rm` и уходят в
 * `runWrite` (mutate.ts) — тот же `run()` из @myc/cli, тот же конверт, тот же
 * перевод кодов выхода в HTTP. Здесь нет ни одного прямого INSERT/UPDATE.
 */

import type { ReadOnlyDb } from "./db.ts";
import { runWrite, type RunCli, type WriteOutcome, type WritePlan } from "./mutate.ts";
import type { BootstrapHistoryRow, BootstrapPreview } from "./types.ts";

// ---------------------------------------------------------------------------
// чтение: тот же процесс `myc bootstrap`, не пересборка
// ---------------------------------------------------------------------------

/**
 * `myc bootstrap --json`. Возвращает WriteOutcome (не WritePlan) — здесь нет
 * argv для собственного построения, только прогон и разбор конверта; имя
 * `runWrite` унаследовано от mutate.ts осознанно: конверт CLI один и тот же
 * независимо от того, была правка или нет.
 */
export async function loadBootstrapPreview(runCli: RunCli, budget?: number): Promise<WriteOutcome> {
  const argv = ["bootstrap"];
  if (budget !== undefined) argv.push("--budget", String(budget));
  return runWrite(runCli, argv);
}

/** `myc bootstrap list --json` — те же строки (ключ/ярус/размер), что в терминале. */
export async function loadBootstrapBlocks(runCli: RunCli): Promise<WriteOutcome> {
  return runWrite(runCli, ["bootstrap", "list"]);
}

/** Приводит конверт к `BootstrapPreview` без потери полей `renderBootstrap`. */
export function toPreview(data: Record<string, unknown>): BootstrapPreview {
  return data as unknown as BootstrapPreview;
}

// ---------------------------------------------------------------------------
// версии блока: хвост оплога по узлу (kind=note, поле body)
// ---------------------------------------------------------------------------

const HISTORY_SQL = `
  SELECT seq, ts_ms, actor, value
    FROM oplog
   WHERE entity_id = ?1 AND field = 'body'
   ORDER BY hlc DESC
   LIMIT ?2`;

/**
 * История правок текста блока. Читается по id узла, а не по ключу: id
 * приходит клиенту из `myc bootstrap list`, и для личного яруса (S41) его
 * там нет (`ListRow.id === "-"`) — значит истории для личных блоков тоже
 * нет, и это ограничение существующего CLI, а не этого экрана. Отдельной
 * проверки на `nodeId === "-"` не нужно: такого узла не существует, и запрос
 * по несуществующему id честно возвращает пустой список сам по себе.
 *
 * `value` в оплоге — `JSON.stringify` исходного значения (store-sqlite);
 * для поля `body` это JSON-строка, и её разбирают здесь же — так же, как
 * прочитал бы человек текст, а не его JSON-эскейп.
 */
export function loadBootstrapHistory(
  db: ReadOnlyDb,
  nodeId: string,
  limit = 20,
): readonly BootstrapHistoryRow[] {
  if (!db.has("oplog")) return [];
  const capped = Math.min(Math.max(Math.floor(limit), 1), 200);
  const rows = db.all<{ seq: number; ts_ms: number; actor: string; value: string | null }>(
    HISTORY_SQL,
    [nodeId, capped],
  );
  return rows.map((r) => ({
    seq: r.seq,
    ts_ms: r.ts_ms,
    actor: r.actor,
    text: parseBodyValue(r.value),
  }));
}

function parseBodyValue(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "string" ? v : raw;
  } catch {
    return raw;
  }
}

// ---------------------------------------------------------------------------
// запись: план для общего write() из server.ts
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

function bad(msg: string, hint?: string): WriteOutcome {
  return { ok: false, status: 400, code: "usage.invalid", msg, hint, degraded: [], warn: [] };
}

/**
 * POST /api/bootstrap/<key> {text, global?} — `myc bootstrap set`.
 *
 * Ключ доезжает до CLI как есть: формат (`^[a-z][a-z0-9_-]{0,31}$`) проверяет
 * он сам (`isBootstrapKey`), и дублировать здесь ту же регулярку значило бы
 * завести второй источник истины, который однажды разойдётся с первым.
 */
export function planBootstrapSet(key: string, body: Body): WritePlan | WriteOutcome {
  const text = body["text"];
  if (typeof text !== "string" || text.length === 0) {
    return bad("нужен 'text'", "POST /api/bootstrap/<key> {text: string, global?: boolean}");
  }
  if (text === "-") {
    // У CLI '-' означает «читать stdin»; в HTTP это подвесило бы запись на
    // stdin процесса вместо правки — тот же отказ, что у mutate.ts.
    return bad("текст '-' у CLI означает чтение stdin и в HTTP не имеет смысла");
  }
  const global = body["global"];
  if (global !== undefined && typeof global !== "boolean") {
    return bad("'global' — boolean");
  }
  const argv = ["bootstrap", "set"];
  if (global === true) argv.push("--global");
  argv.push(key, text);
  return { argv, clockFields: [] };
}

/** POST /api/bootstrap/<key>/op {op: "rm", global?} — `myc bootstrap rm`. */
export function planBootstrapRm(key: string, body: Body): WritePlan | WriteOutcome {
  const op = body["op"];
  if (op !== "rm") {
    return bad(op === undefined ? "нужен 'op'" : `неизвестная операция '${String(op)}'`, "допустима rm");
  }
  const global = body["global"];
  if (global !== undefined && typeof global !== "boolean") {
    return bad("'global' — boolean");
  }
  const argv = ["bootstrap", "rm"];
  if (global === true) argv.push("--global");
  argv.push(key);
  return { argv, clockFields: [] };
}
