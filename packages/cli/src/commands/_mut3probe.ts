#!/usr/bin/env bun
// Временный замер: цена открытия источников при recall в экосистеме из 16
// воркспейсов. Запускается дважды — с мутацией «без ленивости» и без неё.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations } from "@myc/store-sqlite";
import { run } from "../index.ts";
import { Registry } from "./../registry.ts";
import { createRecallCommand } from "./recall.ts";
import { createRememberCommand, realRememberDeps } from "./remember.ts";
import { realRetrieveExtras, type RetrieveDeps } from "./retrieve.ts";
import { realStoreDeps } from "./store.ts";

const box = mkdtempSync(join(tmpdir(), "myc-mut3-"));
const root = join(box, "cherry");
const home = join(box, "home");
mkdirSync(root, { recursive: true });
mkdirSync(home, { recursive: true });

const deps: RetrieveDeps = {
  openStore: realStoreDeps.openStore,
  ...realRetrieveExtras,
  resolveEmbedder: async () => ({ ok: false, reason: "выключен" }),
};
const registry = new Registry();
registry.register(createRememberCommand({ ...realRememberDeps, chatLlm: () => false }));
registry.register(createRecallCommand(deps));

async function ws(dir: string): Promise<void> {
  mkdirSync(join(dir, ".myc"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  const raw = new Database(join(dir, ".myc", "myc.db"), { create: true });
  await migrate(raw, { migrations, writable: true });
  raw.close();
}
const at = (dir: string, ...args: string[]) =>
  run(["-C", dir, ...args], { registry, env: { MYC_ACTOR: "t", MYC_HOME: home } });

await ws(root);
await at(root, "remember", "в корне инвалидация кеша идёт по oplog.seq");
for (let i = 0; i < 15; i++) {
  const name = `repo${String(i).padStart(2, "0")}`;
  await ws(join(root, name));
  for (let k = 0; k < 40; k++) {
    await at(join(root, name), "remember", `в ${name} заметка ${k} про инвалидацию кеша и очередь`);
  }
}

const samples: number[] = [];
for (let i = 0; i < 25; i++) {
  const t0 = performance.now();
  await at(root, "recall", "инвалидация кеша", "--repo", "all");
  samples.push(performance.now() - t0);
}
samples.sort((a, b) => a - b);
const p = (q: number) => samples[Math.max(0, Math.ceil((q / 100) * samples.length) - 1)]!;
console.log(`recall в экосистеме из 16 воркспейсов: p50=${p(50).toFixed(2)} p95=${p(95).toFixed(2)} p99=${p(99).toFixed(2)} мс`);
rmSync(box, { recursive: true, force: true });
