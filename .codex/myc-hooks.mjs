#!/usr/bin/env node
// .codex/myc-hooks.mjs — сгенерирован `myc wire`; правки будут перезаписаны.
//
// Правило то же, что у Claude Code, opencode и Kimi: myc НИКОГДА не валит
// сессию агента. Любая ошибка, любой таймаут, отсутствие бинаря — выход 0 и
// пустой stdout. Кодом 2 Codex блокирует ход, поэтому им мы не выходим никогда.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const EV = process.argv[2];

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8") || "{}");
} catch {}

// Codex зовёт хук из каталога проекта и кладёт его же в payload.cwd.
const DIR = typeof payload.cwd === "string" && payload.cwd ? payload.cwd : process.cwd();

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
  "pre-compact": ["absorb-session", "--reason", payload.trigger ?? "auto", "--transcript", payload.transcript_path ?? "-", "--budget", payload.trigger === "manual" ? "2000" : "1200", "--agent", "codex", "--session", payload.session_id ?? "", "--hook-output", "text"],
}[EV];

if (!ARGS) process.exit(0);

try {
  const r = spawnSync(bin(), ARGS, {
    cwd: DIR,
    timeout: LIMIT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, MYC_HOOK: EV, MYC_HOOK_AGENT: "codex" },
  });
  // additionalContext есть ТОЛЬКО у SessionStart: в схеме
  // pre-compact.command.output его нет вовсе (continue, stopReason,
  // suppressOutput, systemMessage — и всё). Печатать туда пакет значило бы
  // отдавать его в /dev/null; за сжатием codex сам зовёт SessionStart с
  // source:"compact", и пакет приходит оттуда.
  if (EV === "session-start" && r.status === 0 && r.stdout && r.stdout.trim()) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: r.stdout },
      }) + "\n",
    );
  }
} catch {}

process.exit(0);
