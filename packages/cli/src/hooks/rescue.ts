/**
 * Спасательный пакет (§6.2) — то, что переживёт сжатие контекста.
 *
 * Пакет собирается ВТОРЫМ, после того как сырой эпизод уже лежит на диске.
 * Он не источник истины, а выжимка: всё, что сюда не влезло, остаётся в
 * эпизоде и в кандидатах. Поэтому урезание секций честное — «…ещё N», а не
 * молчаливое отбрасывание хвоста (И2).
 *
 * Порядок наполнения и порядок печати намеренно разные. Печатаем в порядке
 * §6.2 (АКТИВНО, ФАЙЛЫ, РЕШЕНО, ОТКРЫТО, ДАЛЬШЕ), а бюджет раздаём в порядке
 * невосполнимости: решения первыми. Задачу и список файлов агент восстановит
 * одной командой `myc ready`, а «k=60 оставляем, Qdrant не тянем» после
 * компакта не восстановит ничем.
 */

import { defineQueries } from "@myc/core";
import type { StoreHandle } from "../commands/store.ts";
import type { FileTouch } from "./transcript.ts";

const QR = defineQueries({
  rescue_active: {
    name: "rescue_active",
    sql: `SELECT id, title, status, priority, assignee
          FROM nodes
          WHERE kind = 'task' AND deleted_at IS NULL
            AND status IN ('in_progress', 'blocked', 'open')
          ORDER BY CASE status WHEN 'in_progress' THEN 0 WHEN 'blocked' THEN 1 ELSE 2 END,
                   priority ASC, updated_at DESC
          LIMIT ?1`,
    params: ["limit"],
  },
});

export interface ActiveTask {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly priority: number;
  readonly assignee: string;
}

export function activeTasks(handle: StoreHandle, limit = 8): ActiveTask[] {
  try {
    return handle.driver.all<ActiveTask>(QR.rescue_active, [limit]);
  } catch {
    return []; // пакет без очереди задач лучше, чем отсутствие пакета
  }
}

export interface RescueInput {
  readonly episodeId: string;
  readonly rawBytes: number;
  readonly secretsMasked: number;
  readonly decisions: readonly string[];
  readonly open: readonly string[];
  readonly files: readonly FileTouch[];
  readonly tasks: readonly ActiveTask[];
  readonly mycCalls: readonly string[];
  /** Потолок пакета: 1200 симв для auto, 2000 для manual (§6.2). */
  readonly budget: number;
  /** Строки деградации — печатаются всегда, урезанию не подлежат (И2). */
  readonly degraded?: readonly string[];
}

function kb(bytes: number): string {
  return bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

function fmtPriority(priority: number): string {
  return `P${priority}`;
}

function taskLine(t: ActiveTask): string {
  const who = t.assignee.length > 0 ? ` @${t.assignee}` : "";
  const status = t.status === "in_progress" ? "" : ` [${t.status}]`;
  return `${t.id} ${fmtPriority(t.priority)} ${t.title}${who}${status}`;
}

function fileLine(f: FileTouch): string {
  return f.count > 1 ? `${f.path} (${f.count}×)` : f.path;
}

interface Section {
  readonly label: string;
  readonly items: readonly string[];
  /** Разделитель внутри секции: решения читаются столбиком, файлы — строкой. */
  readonly join: "\n" | " · ";
}

const LABEL_WIDTH = 9;

/** Рендер секции с уже урезанным списком; пустая секция не печатается. */
function renderSection(section: Section, kept: readonly string[], dropped: number): string {
  if (kept.length === 0) return "";
  const tail = dropped > 0 ? [`…${dropped} more`] : [];
  const all = [...kept, ...tail];
  const pad = " ".repeat(LABEL_WIDTH);
  const body =
    section.join === "\n"
      ? all.map((line, i) => (i === 0 ? line : `${pad}${line}`)).join("\n")
      : all.join(" · ");
  return `${section.label.padEnd(LABEL_WIDTH)}${body}`;
}

export interface RescuePacket {
  readonly text: string;
  readonly chars: number;
  /** Сколько строк каждой секции не влезло — видно и в JSON, и в тексте. */
  readonly dropped: Readonly<Record<string, number>>;
}

export function buildRescuePacket(input: RescueInput, tookMs?: number): RescuePacket {
  const secrets =
    input.secretsMasked > 0
      ? `, ${input.secretsMasked} secret${input.secretsMasked === 1 ? "" : "s"} masked`
      : "";
  const head = [
    "# myc: context is being compacted — here is what must not be lost",
    `episode ${input.episodeId} saved (${kb(input.rawBytes)}${secrets})`,
    ...(input.degraded ?? []).map((d) => `WARN ${d}`),
    "",
  ].join("\n");

  const next = [
    `myc show ${input.episodeId}`,
    ...(input.tasks[0] ? [`myc show ${input.tasks[0].id}`] : []),
    "myc ready --claim",
  ];

  // Порядок печати — §6.2; порядок раздачи бюджета — по невосполнимости.
  const sections: readonly Section[] = [
    { label: "ACTIVE", items: input.tasks.map(taskLine), join: "\n" },
    { label: "FILES", items: input.files.map(fileLine), join: " · " },
    { label: "DECIDED", items: [...input.mycCalls, ...input.decisions], join: "\n" },
    { label: "OPEN", items: input.open, join: "\n" },
    { label: "NEXT", items: next, join: " · " },
  ];
  const fillOrder = ["DECIDED", "ACTIVE", "OPEN", "NEXT", "FILES"];

  const kept = new Map<string, string[]>(sections.map((s) => [s.label, []]));
  const dropped: Record<string, number> = {};
  // Хвост «N симв · M мс» и переводы строк между секциями — тоже бюджет.
  let left = input.budget - head.length - 24;

  for (const label of fillOrder) {
    const section = sections.find((s) => s.label === label);
    if (!section) continue;
    const list = kept.get(label)!;
    let skipped = 0;
    for (const item of section.items) {
      const cost = item.length + LABEL_WIDTH + 1;
      if (cost <= left) {
        list.push(item);
        left -= cost;
      } else {
        skipped++;
      }
    }
    if (skipped > 0) dropped[label] = skipped;
  }

  const blocks = sections
    .map((s) => renderSection(s, kept.get(s.label)!, dropped[s.label] ?? 0))
    .filter((s) => s.length > 0);

  const bodyText = `${head}${blocks.join("\n")}`;
  const chars = bodyText.length;
  const footer = tookMs === undefined ? "" : `\n${chars} chars · ${Math.round(tookMs)} ms`;
  return { text: `${bodyText}${footer}\n`, chars, dropped };
}
