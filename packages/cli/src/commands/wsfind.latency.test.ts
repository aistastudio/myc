/**
 * Цена поиска воркспейса. Поиск делается на КАЖДЫЙ запуск любой команды, и
 * весь холодный старт стоит 24 мс при потолке 60 (И1) — поэтому у этой правки
 * есть не только «работает», но и «сколько стоит».
 *
 * Три утверждения, как требует методика (@myc/bench):
 *
 * 1. СТРУКТУРНОЕ — распознавание worktree живёт ТОЛЬКО в ветке отказа.
 *    Проверяется не замером, а поведением: в каталоге со своим `.myc` лежит
 *    файл `.git`, ведущий в worktree чужого дерева, где воркспейс тоже есть.
 *    Если бы ссылку читали раньше подъёма (или вместо него), ответ был бы
 *    чужим. Отсюда и равенство цены в пункте 2 — читать нечего.
 *
 * 2. ОТНОСИТЕЛЬНОЕ, успешный путь: против ДОСЛОВНОЙ реализации до правки.
 *    Замерено ×1.00 (p50 3.3 мкс против 3.3 мкс): на пути, которым идут все
 *    запуски в обычном репозитории, не прибавилось ни одного системного
 *    вызова.
 *
 * 3. ОТНОСИТЕЛЬНОЕ, путь worktree: против `git rev-parse --git-common-dir` —
 *    того же ответа, полученного подпроцессом. Замерено ×139.89 (p50 69.4 мкс
 *    против 9.705 мс). Подпроцесс стоил бы полтора десятка процентов всего
 *    холодного старта ради двух коротких read().
 *
 * И абсолютный бюджет 1 мс — самое слабое из трёх, но оно ловит случай, когда
 * поиск однажды начнут делать чем-то принципиально более дорогим.
 */

import { afterAll, beforeAll, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  expectAheadOfRival,
  expectCostAtMost,
  expectWithinBudget,
  measure,
  report,
} from "@myc/bench";
import { findWorkspaceDb, personalHome } from "./wsfind.ts";

/**
 * Реализация ДО правки, дословно. Она и есть «цена до»: соперник меряется
 * чередуясь с новым кодом, на тех же данных, в том же процессе — загрузка
 * машины растягивает обе половины и из отношения уходит.
 */
function findBeforeThisChange(
  startDir: string,
): { dbPath: string; wsDir: string } | { searched: string[] } {
  const boundary = resolve(personalHome());
  const searched: string[] = [];
  let dir = resolve(startDir);
  let climbed = false;
  for (;;) {
    if (climbed && dir === boundary) break;
    const dbPath = join(dir, ".myc", "myc.db");
    searched.push(dbPath);
    if (existsSync(dbPath)) return { dbPath, wsDir: dir };
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    climbed = true;
  }
  return { searched };
}

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  if (!p.success) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
}

const ITERS = 1500;
const WARMUP = 200;

/** Бюджет поиска: 1 мс. Замеры на этом стенде — в шапке файла. */
const LOOKUP_BUDGET_MS = 1;

/**
 * Во сколько раз успешный путь может подорожать против реализации до правки.
 * Измерено ×1.00. Порог 1.5 — он не различает 1.0 и 1.2, но поймает
 * появление в подъёме лишнего чтения файла или, тем более, вызова git.
 */
const HOT_PATH_MAX_RATIO = 1.5;

/**
 * Во сколько раз чтение файлов обязано опережать `git rev-parse`.
 *
 * Измерено на двух разных машинах, и разброс оказался в семь раз:
 *   macOS arm64, 14 ядер, APFS        ×139.89
 *   ubuntu-latest, 4 ядра, GitHub CI  ×19.86
 * Порог 20 был выведен из первого числа и на втором краснел, сообщая о
 * «потере преимущества» там, где чтение файлов всё ещё в двадцать раз
 * быстрее запуска процесса.
 *
 * Что здесь на самом деле стережётся — появление вызова git в горячем пути
 * подъёма воркспейса. Такая регрессия делает две стороны ОДНИМ И ТЕМ ЖЕ
 * действием, то есть роняет отношение к ~×1 (ровно это показала мутация
 * «ix_nodes_ready_repo снят» в соседнем замере: ×0.86). Порог 5 лежит вчетверо
 * ниже худшего наблюдённого здорового значения и впятеро выше больного.
 */
const MIN_AHEAD_OF_GIT = 5;

let sandbox: string;
let savedHome: string | undefined;
let deep: string; // обычный репозиторий, глубина 3
let missing: string; // ни .myc, ни git по всему пути
let wtDeep: string; // глубина 3 внутри worktree

beforeAll(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), "myc-wscost-")));
  savedHome = process.env.MYC_HOME;
  process.env.MYC_HOME = sandbox; // граница подъёма — сам стенд

  const main = join(sandbox, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  writeFileSync(join(main, "f"), "x\n");
  git(main, "add", "f");
  git(main, "commit", "-qm", "c");
  mkdirSync(join(main, ".myc"), { recursive: true });
  writeFileSync(join(main, ".myc", "myc.db"), ""); // ищется существование, не схема

  deep = join(main, "packages", "cli", "src");
  mkdirSync(deep, { recursive: true });

  missing = join(sandbox, "nothing", "a", "b");
  mkdirSync(missing, { recursive: true });

  const wt = join(sandbox, "wt-feature");
  git(main, "worktree", "add", "-q", wt, "-b", "feature");
  wtDeep = join(wt, "packages", "cli", "src");
  mkdirSync(wtDeep, { recursive: true });
});

afterAll(() => {
  if (savedHome === undefined) delete process.env.MYC_HOME;
  else process.env.MYC_HOME = savedHome;
  rmSync(sandbox, { recursive: true, force: true });
});

test("успешный подъём не подорожал: ×1.00 против реализации до правки", () => {
  const m = measure(
    "поиск воркспейса: обычный репозиторий, глубина 3",
    () => {
      findWorkspaceDb(deep);
    },
    {
      warmup: WARMUP,
      iters: ITERS,
      budgetMs: LOOKUP_BUDGET_MS,
      rival: () => {
        findBeforeThisChange(deep);
      },
      rivalLabel: "реализация ДО правки",
    },
  );
  report(m);
  expectCostAtMost(m, HOT_PATH_MAX_RATIO);
  expectWithinBudget(m);
});

// Соперник тут — НАСТОЯЩИЙ запуск процесса по 9 мс, поэтому итераций на два
// порядка меньше, чем в остальных замерах: 60×3 прогона это уже ~2 секунды
// чистого git. Отношение p50 от числа итераций не зависит, а абсолютный
// бюджет здесь с семикратным запасом (0.13 мс против 1) и шума не боится.
/**
 * 100, а не 60: у замера бюджет по p99, а p99 по nearest-rank при n < 100 —
 * максимум прогона, то есть один сосед по процессору решал за весь прогон.
 * Цена — соперник-подпроцесс git (~12 мс): ~4 с на три прогона.
 */
const GIT_ITERS = 100;

test(
  "worktree: чтение файлов против подпроцесса git",
  () => {
  const m = measure(
    "поиск воркспейса: worktree, глубина 3",
    () => {
      findWorkspaceDb(wtDeep);
    },
    {
      warmup: 10,
      iters: GIT_ITERS,
      budgetMs: LOOKUP_BUDGET_MS,
      rival: () => {
        Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], {
          cwd: wtDeep,
          stdout: "pipe",
          stderr: "pipe",
        });
      },
      rivalLabel: "git rev-parse --git-common-dir (подпроцесс)",
    },
  );
  report(m);
  expectAheadOfRival(m, MIN_AHEAD_OF_GIT);
  expectWithinBudget(m);
  },
  60_000,
);

test("отказ (ни .myc, ни git) остаётся в бюджете", () => {
  const m = measure(
    "поиск воркспейса: не найден нигде",
    () => {
      findWorkspaceDb(missing);
    },
    {
      warmup: WARMUP,
      iters: ITERS,
      budgetMs: LOOKUP_BUDGET_MS,
      rival: () => {
        findBeforeThisChange(missing);
      },
      rivalLabel: "реализация ДО правки",
    },
  );
  // Здесь новый код ДОРОЖЕ старого (замерено ×2.33: 6.4 мкс против 2.7) — на
  // каждом уровне добавилась проверка «а не worktree ли это». Это ветка
  // отказа, её проходят один раз перед тем, как команда всё равно упадёт;
  // относительного утверждения тут нет намеренно, есть абсолютное.
  report(m);
  expectWithinBudget(m);
});
