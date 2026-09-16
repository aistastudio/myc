#!/usr/bin/env node
// .kimi-code/myc-hooks.mjs — сгенерирован `myc wire`; правки будут перезаписаны.
//
// Правило то же, что у Claude Code и Codex: myc НИКОГДА не валит сессию
// агента. Любая ошибка, таймаут, отсутствие бинаря — выход 0 и пустой
// stdout. Кодом 2 Kimi блокирует ход, поэтому им мы не выходим никогда.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EV = process.argv[2];

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {}

// Kimi запускает хук из каталога сессии и кладёт его же в payload.cwd.
const DIR = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

// СТЕНОГРАММА У KIMI: её нет во входе хука, но она есть на диске.
// Прочитано в бинаре (сборка 2026-09-04): PreCompact зовётся как
// `trigger("PreCompact", {inputData: withSessionFacts({trigger, tokenCount})})`,
// а `withSessionFacts` добавляет ровно `sessionTitle`; строка
// `transcript_path` не встречается в бинаре НИ РАЗУ. Значит `--transcript -`
// читал пустоту: stdin к этому моменту уже вычерпан разбором payload выше.
// Зато сессия лежит файлом: `~/.kimi-code/session_index.jsonl` сопоставляет
// `sessionId` → `sessionDir`, а внутри `agents/main/wire.jsonl` — тот самый
// JSONL, где `{"type":"context.append_message","message":{role,content}}`
// читается parseTranscript как ход без единой поправки.
function transcriptPath(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const home = process.env.KIMI_CODE_HOME || join(process.env.HOME ?? "", ".kimi-code");
  const index = join(home, "session_index.jsonl");
  if (!existsSync(index)) return null;
  try {
    for (const line of readFileSync(index, "utf8").split("\n")) {
      if (!line.includes(sessionId)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec?.sessionId !== sessionId || typeof rec?.sessionDir !== "string") continue;
      const wire = join(rec.sessionDir, "agents", "main", "wire.jsonl");
      return existsSync(wire) ? wire : null;
    }
  } catch {}
  return null;
}

const LIMIT = {
  "session-start": 2500,
  "pre-compact": 7500,
}[EV] ?? 2000;

function bin() {
  const env = process.env.MYC_BIN;
  if (env && existsSync(env)) return env;
  for (const p of ["node_modules/.bin/myc", "dist/myc", ".myc/bin/myc"]) {
    const abs = join(DIR, p);
    if (existsSync(abs)) return abs;
  }
  const home = join(process.env.HOME ?? "", ".myc/bin/myc");
  if (existsSync(home)) return home;
  return "myc"; // PATH; если и там нет — spawnSync вернёт ошибку, и мы выйдем 0
}

const ARGS = {
  "session-start": ["prime", "--budget", "2000", "--format", "agent", "--session", payload.session_id ?? ""],
  "pre-compact": ["absorb-session", "--reason", payload.trigger ?? "auto", "--transcript", transcriptPath(payload.session_id) ?? "-", "--budget", payload.trigger === "manual" ? "2000" : "1200", "--agent", "kimi", "--session", payload.session_id ?? "", "--hook-output", "text"],
}[EV];

if (!ARGS) process.exit(0);

try {
  const r = spawnSync(bin(), ARGS, {
    cwd: DIR,
    timeout: LIMIT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, MYC_HOOK: EV, MYC_HOOK_AGENT: "kimi" },
  });
  // В контекст Kimi попадает только JSON с полем message — обычный stdout
  // он разбирает и молча выбрасывает.
  if (r.status === 0 && r.stdout && r.stdout.trim()) {
    process.stdout.write(JSON.stringify({ message: r.stdout }) + "\n");
  }
} catch {}

process.exit(0);
