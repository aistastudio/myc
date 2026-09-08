/**
 * `myc init` — создать воркспейс одной командой (§3.1, §11).
 *
 * Ноль вопросов по умолчанию и ноль обращений в сеть: онбординг ломается на
 * первом же вопросе и на первом же таймауте. Автодетект (git-корень, slug,
 * graft) только показывает найденное — ничего не спрашивает и не качает.
 * Модель эмбеддингов — отдельная команда `myc models fetch` (§11.1: "модель
 * докачается при следующем запуске"); её отсутствие не мешает работать с
 * задачами, но это деградация ретривала и обязана быть громкой (warn),
 * не молчаливой.
 *
 * Повторный `init` на готовом воркспейсе — не ошибка (§11.3): печатает
 * состояние и выходит 0, ничего не трогая.
 *
 * ЛИЧНОСТЬ ВОРКСПЕЙСА НЕСЁТ КОНФИГ, А НЕ БАЗА (memory-hnh8r8304s27). `slug`
 * из `.myc/workspace.toml` попадает в id каждого узла и в `scope` каждого
 * запроса, а сам файл коммитится — это общая личность, одна на всех
 * участников. База `myc.db` в `.gitignore` и у каждого своя. Клон приезжает
 * с конфигом, но без базы, и «воркспейс существует?» по базе давало ответ
 * «нет»: `init` переписывал общий конфиг слагом из ИМЕНИ КАТАЛОГА, узлы
 * приезжали со старым scope и становились невидимыми ниоткуда — молча.
 * Поэтому существование определяется по ЛЮБОМУ из двух признаков, а `init`
 * создаёт только НЕДОСТАЮЩЕЕ: есть конфиг без базы — поднимаем базу под
 * приехавший слаг («усыновление», `adopted`), есть база без конфига —
 * восстанавливаем конфиг из `meta.slug`.
 *
 * Смена слага — отдельное явное действие (`--slug`), и оно громкое: старые
 * узлы остаются со старым scope, то есть перестают быть видимыми, и
 * пользователь обязан узнать об этом до, а не после.
 *
 * `--force` пересоздаёт ЛОКАЛЬНОЕ состояние (база, кеш проекций, кеши
 * детекта), но не трогает то, что лежит в git — `workspace.toml` и оплог
 * `.myc/graph/`. Стирать их значило бы теми же руками обнулить знание у
 * всех участников: у второго это одна команда, у остальных — его `git push`.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { migrate, migrations, Q } from "@myc/store-sqlite";
import {
  DEFAULT_CODE_INTEL_MODE,
  probeGraftPresence,
  readCodeIntelConfig,
  realSelectEnv,
  selectCodeIntel,
  type CodeIntelSelection,
} from "@myc/code-intel";
import { ExitCode } from "../exit.ts";
import { CLI_VERSION } from "../index.ts";
import { plural } from "../render.ts";
import type { Command, CommandContext, CommandFailure, CommandResult } from "../registry.ts";
import {
  createPersonalWorkspace,
  flagBool,
  PERSONAL_SLUG,
  personalHome,
  personalWipePlan,
  personalWorkspaceStatus,
  wipePersonalWorkspace,
  type PersonalWipePlan,
} from "./store.ts";
// Из wsfind.ts напрямую: init и так тянет store.ts, но связь worktree →
// основное дерево живёт там же, где её читает поиск воркспейса, и второй
// реализации у неё быть не должно.
import { findWorktreeLink, type WorktreeLink } from "./wsfind.ts";

// bun:sqlite Database напрямую, без vec0-рантайма CliDriver (store.ts) и без
// GraphStore: init только создаёт файл, накатывает миграции и пишет пару
// строк метаданных — доставать полный движок ради этого незачем.
const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
] as const;

function slugify(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (s.length === 0 || !/^[a-z]/.test(s)) s = `w${s}`;
  s = s.slice(0, 8);
  while (s.length < 2) s += "0";
  return s;
}

function detectGitRoot(dir: string): string | undefined {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (!proc.success) return undefined;
    const root = proc.stdout.toString().trim();
    return root.length > 0 ? root : undefined;
  } catch {
    return undefined; // git не установлен — не блокирует init
  }
}

/**
 * S42/myc-qie.11: `.myc/.gitignore` — только оплог, meta.json, .gitattributes
 * и workspace.toml идут в git; база sqlite (и её -wal/-shm/-journal, S42
 * дискуссия про мержи бинарников) и кеш проекций (уже само-игнорируется, но
 * дублируем здесь — работает и до первого `myc export`) остаются локальными.
 * Список — не markdown-блок с маркерами, а плоские строки: писать в конец
 * недостающие построчно достаточно для идемпотентности и не тянет за собой
 * парсер разметки.
 */
const MYC_GITIGNORE_LINES = [
  "myc.db",
  "myc.db-wal",
  "myc.db-shm",
  "myc.db-journal",
  "projections/",
  // Кеш детекта код-интеллекта (S52): он про эту машину — какой PATH, где
  // лежит graft. Закоммитить его значит навязать чужому клону свой PATH.
  "state.json",
] as const;

function mycGitignoreContent(): string {
  return [
    "# myc (S42): локальные файлы — не идут в git",
    "# оплог, meta.json, .gitattributes и workspace.toml коммитятся как есть",
    ...MYC_GITIGNORE_LINES,
    "",
  ].join("\n");
}

/**
 * Пишет `.myc/.gitignore`, если его ещё нет; иначе дописывает только те
 * строки из MYC_GITIGNORE_LINES, которых не хватает — не трогая остальное
 * содержимое (в т.ч. добавленное пользователем) и не дублируя уже
 * присутствующие строки при повторном `init`.
 */
function ensureMycGitignore(mycDir: string): void {
  const path = join(mycDir, ".gitignore");
  if (!existsSync(path)) {
    writeFileSync(path, mycGitignoreContent(), "utf8");
    return;
  }
  const existing = readFileSync(path, "utf8");
  const present = new Set(existing.split("\n").map((line) => line.trim()));
  const missing = MYC_GITIGNORE_LINES.filter((line) => !present.has(line));
  if (missing.length === 0) return;
  const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  writeFileSync(
    path,
    `${existing}${sep}# myc: добавлено автоматически при init\n${missing.join("\n")}\n`,
    "utf8",
  );
}

/**
 * «graft рядом есть» для строки отчёта. С S52 это обёртка над единым
 * детектом из `@myc/code-intel`: раньше здесь и в бутстрапе жили две почти
 * одинаковые функции, расходившиеся признаком индекса (`graft/` против
 * `graft/INDEX.md`). Признак сохранён дословно — каталога достаточно, —
 * потому что вопрос тут другой: «есть ли что показать пользователю», а не
 * «какой реализацией myc считает символы». На второй отвечает
 * `selectCodeIntel`, и по умолчанию ответ — builtin, даже если graft найден.
 */
function detectGraft(dir: string): boolean {
  const probe = probeGraftPresence(dir, realSelectEnv);
  return probe.indexDir || probe.bin !== null;
}

/** Выбранная реализация код-интеллекта — то, что `init` обязан напечатать. */
function codeIntelOf(dir: string): CodeIntelSelection {
  return selectCodeIntel(dir, realSelectEnv, readCodeIntelConfig(dir));
}

function ciData(s: CodeIntelSelection): InitData["code_intel"] {
  return { mode: s.mode, id: s.id, state: s.state, reason: s.reason, degraded: s.degraded };
}

/**
 * Каждый код деградации выбора уходит в `meta.degraded[]` отдельной строкой
 * (И2, §6.3). Особый случай — `code_intel=graft` без graft: это ошибка
 * конфигурации, и молчаливого отката к builtin здесь нет ни в `select`, ни
 * в выводе; пользователь просил конкретную реализацию и обязан узнать, что
 * её нет, а не получить другую под тем же именем.
 */
function warnCodeIntel(ctx: CommandContext, s: CodeIntelSelection): void {
  for (const code of s.degraded) ctx.warn(code, s.reason);
}

interface ExistingWorkspace {
  schemaVersion: number | undefined;
  nodeCount: number | undefined;
  slug: string | undefined;
}

function readExistingWorkspace(dir: string): ExistingWorkspace {
  const dbPath = join(dir, ".myc", "myc.db");
  let schemaVersion: number | undefined;
  let nodeCount: number | undefined;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      schemaVersion =
        (db.query("SELECT max(version) AS v FROM schema_migrations").get() as
          | { v: number | null }
          | null
        )?.v ?? undefined;
      nodeCount =
        (db.query("SELECT count(*) AS n FROM nodes").get() as { n: number } | null)?.n ??
        undefined;
    } finally {
      db.close();
    }
  } catch {
    // битая база — просто не даём цифр, не роняем идемпотентный путь
  }
  let slug: string | undefined;
  try {
    const tomlPath = join(dir, ".myc", "workspace.toml");
    if (existsSync(tomlPath)) {
      const m = /^slug\s*=\s*"([a-z][a-z0-9]{1,7})"/m.exec(readFileSync(tomlPath, "utf8"));
      slug = m?.[1];
    }
  } catch {
    // как выше — не критично для идемпотентного ответа
  }
  return { schemaVersion, nodeCount, slug };
}

/** Слаг из коммитнутого `.myc/workspace.toml` — общая личность воркспейса. */
function readConfigSlug(mycDir: string): string | undefined {
  const path = join(mycDir, "workspace.toml");
  if (!existsSync(path)) return undefined;
  try {
    return /^slug\s*=\s*"([a-z][a-z0-9]{1,7})"/m.exec(readFileSync(path, "utf8"))?.[1];
  } catch {
    return undefined;
  }
}

/**
 * Запасной источник слага: `myc_meta.slug` в базе. Нужен ровно в одном
 * случае — конфиг потеряли, а база жива: восстановить общий файл из имени
 * каталога значило бы повторить ту же подмену личности, только с другой
 * стороны.
 */
function readDbSlug(dbPath: string): string | undefined {
  if (!existsSync(dbPath)) return undefined;
  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      const row = db.query("SELECT value FROM myc_meta WHERE key = 'slug'").get() as
        | { value: string }
        | null;
      const v = row?.value;
      return typeof v === "string" && /^[a-z][a-z0-9]{1,7}$/.test(v) ? v : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function workspaceTomlContent(slug: string): string {
  // `code_intel` пишется явно и коммитится (S52 §12.1): умолчание builtin
  // существует ради воспроизводимости, а невидимое умолчание её не даёт —
  // в конфиге должно быть написано, что тут выбрано, чтобы у соседа
  // работало так же.
  return (
    `# myc workspace config — commit this file (per-machine settings go in local.toml)\n` +
    `slug = "${slug}"\n` +
    `# код-интеллект: builtin (умолчание) | auto | graft | off\n` +
    `code_intel = "${DEFAULT_CODE_INTEL_MODE}"\n`
  );
}

/**
 * Смена слага правит ОДНУ строку, а не переписывает файл: рядом со `slug`
 * в конфиге живут веса ready (S21), бюджет бутстрапа и `code_intel` — общие
 * настройки, которых пользователь не просил трогать.
 */
function writeSlugInToml(mycDir: string, slug: string): void {
  const path = join(mycDir, "workspace.toml");
  if (!existsSync(path)) {
    writeFileSync(path, workspaceTomlContent(slug), "utf8");
    return;
  }
  const existing = readFileSync(path, "utf8");
  const line = `slug = "${slug}"`;
  const next = /^slug\s*=\s*"[^"]*"/m.test(existing)
    ? existing.replace(/^slug\s*=\s*"[^"]*"/m, line)
    : `${existing}${existing.endsWith("\n") ? "" : "\n"}${line}\n`;
  if (next !== existing) writeFileSync(path, next, "utf8");
}

/**
 * Что `--force` имеет право стереть: только локальное состояние машины.
 * `workspace.toml` и `.myc/graph/` лежат в git и принадлежат не этой машине,
 * а всем участникам сразу; стереть их здесь — тот же обвал знания, что и
 * молчаливая перезапись слага, только через `git push` соседа.
 * `.gitignore` и `config.json` тоже коммитятся и переживают `--force`.
 */
const FORCE_KEEP = new Set(["graph", "workspace.toml", "config.json", ".gitignore"]);

function wipeLocalState(mycDir: string): void {
  for (const entry of readdirSync(mycDir)) {
    if (FORCE_KEEP.has(entry)) continue;
    rmSync(join(mycDir, entry), { recursive: true, force: true });
  }
}

/**
 * Создать файл базы под данный слаг: миграции, `site_id`, `slug`. `site_id`
 * у каждой машины свой, даже когда слаг общий: он делит оплог на файлы по
 * сайтам, и совпадение означало бы запись двух участников в один файл.
 */
async function createWorkspaceDb(
  dbPath: string,
  slug: string,
): Promise<{ siteId: string; schemaVersion: number }> {
  const db = new Database(dbPath, { create: true });
  try {
    for (const pragma of PRAGMAS) db.exec(pragma);
    await migrate(db, { migrations, writable: true });
    const schemaVersion = migrations.reduce((m, mig) => Math.max(m, mig.version), 0);
    const siteId = `local-${slug}-${crypto.getRandomValues(new Uint32Array(1))[0]!.toString(36)}`;
    db.prepare(Q.meta_set.sql).run("site_id", siteId);
    db.prepare(Q.meta_set.sql).run("slug", slug);
    return { siteId, schemaVersion };
  } finally {
    db.close();
  }
}

/**
 * Поднять базу под УЖЕ СУЩЕСТВУЮЩУЮ личность воркспейса — то, чего не хватает
 * клону: `.myc/workspace.toml` приехал из git, `myc.db` в `.gitignore` и его
 * нет. Ничего, кроме базы и недостающих строк `.gitignore`, не создаётся:
 * слаг берётся из конфига, а не выдумывается, и конфиг не переписывается.
 *
 * Возвращает `undefined`, когда усыновлять нечего или некого: база уже есть
 * (звать повторно безопасно) либо конфига нет — тогда личность пришлось бы
 * выдумать, а это ровно та подмена, из-за которой знание становилось
 * невидимым. В этом случае решение остаётся за человеком: `myc init`.
 */
export async function adoptWorkspaceDb(
  mycDir: string,
): Promise<{ dbPath: string; slug: string; siteId: string; schemaVersion: number } | undefined> {
  const dbPath = join(mycDir, "myc.db");
  if (existsSync(dbPath)) return undefined;
  const slug = readConfigSlug(mycDir);
  if (slug === undefined) return undefined;

  ensureMycGitignore(mycDir);
  try {
    const { siteId, schemaVersion } = await createWorkspaceDb(dbPath, slug);
    return { dbPath, slug, siteId, schemaVersion };
  } catch (error) {
    // Недосозданная база хуже отсутствующей: следующий запуск примет её за
    // готовый воркспейс и молча промахнётся мимо миграций.
    rmSync(dbPath, { force: true });
    throw error;
  }
}

/**
 * S41: `myc init` (проектный) НЕ создаёт ~/.myc молча — он только сообщает
 * его состояние (dешёвый stat + опциональное readonly-чтение счётчиков, та
 * же цена, что и у readExistingWorkspace для проектной базы). Создать личный
 * ярус можно только явно — `myc init --global`.
 */
interface PersonalSummary {
  dir: string;
  exists: boolean;
  schemaVersion?: number;
  nodeCount?: number;
}

function readPersonalSummary(): PersonalSummary {
  const status = personalWorkspaceStatus();
  if (!status.exists) return { dir: status.dir, exists: false };
  let schemaVersion: number | undefined;
  let nodeCount: number | undefined;
  try {
    const db = new Database(status.dbPath, { readonly: true });
    try {
      schemaVersion =
        (db.query("SELECT max(version) AS v FROM schema_migrations").get() as
          | { v: number | null }
          | null
        )?.v ?? undefined;
      nodeCount =
        (db.query("SELECT count(*) AS n FROM nodes").get() as { n: number } | null)?.n ??
        undefined;
    } finally {
      db.close();
    }
  } catch {
    // как у readExistingWorkspace — не критично для идемпотентного ответа
  }
  return { dir: status.dir, exists: true, schemaVersion, nodeCount };
}

function personalLine(p: PersonalSummary): string {
  if (!p.exists) {
    return `  · личный ~/.myc        не создан — создать: myc init --global`;
  }
  const n = p.nodeCount !== undefined ? `${p.nodeCount} узлов` : "узлов ?";
  return `  ✓ личный ~/.myc        schema v${p.schemaVersion ?? "?"}, ${n}`;
}

interface InitData {
  dir: string;
  slug: string;
  git: { root: string | undefined; isGit: boolean };
  graft: boolean;
  /** Какой реализацией myc считает символы и почему (S52 §6.2). */
  code_intel: {
    mode: string;
    id: string | null;
    state: string;
    reason: string;
    degraded: readonly string[];
  };
  idempotent: boolean;
  /**
   * Конфиг приехал из git, базы не было — `init` поднял только её. Не
   * `idempotent` (что-то создали) и не «создан с нуля» (личность не наша).
   */
  adopted: boolean;
  /** Слаг сменили явным `--slug`: старые узлы уходят из видимости. */
  slug_changed?: { from: string; to: string; nodes: number | undefined };
  db: { path: string; schemaVersion: number | undefined; nodeCount?: number };
  personal: PersonalSummary;
  siteId?: string;
  /** Звали из git worktree: цель — основное дерево, а не текущий каталог. */
  worktree?: { dir: string; main: string };
  next: string;
  took_ms: number;
}

/**
 * Одна строка про код-интеллект. Печатается всегда, в том числе на
 * идемпотентном повторе: «какая реализация выбрана» — первое, что перестают
 * понимать, когда реализаций две, а умолчание не то, что стоит в PATH.
 */
function codeIntelLine(c: InitData["code_intel"]): string {
  // `!` вместо `·` — единственный маркер, который в этом выводе значит «тут
  // не всё в порядке» (так же помечена строка «не git-репозиторий»).
  const mark = c.state === "ok" ? "·" : "!";
  return `  ${mark} код-интеллект        ${c.reason}`;
}

/**
 * Блок про worktree в выводе — печатается ВСЕГДА, когда звали оттуда. Это не
 * украшение: init создал (или нашёл) воркспейс не в том каталоге, где стоит
 * человек, и умолчать об этом значило бы оставить его гадать, почему `.myc`
 * не появился под ногами.
 */
function worktreeData(link: WorktreeLink | undefined): { worktree?: { dir: string; main: string } } {
  return link === undefined ? {} : { worktree: { dir: link.worktreeDir, main: link.mainRoot } };
}

function worktreeLine(w: NonNullable<InitData["worktree"]>, idempotent: boolean): string {
  const what = idempotent ? "воркспейс уже есть" : "воркспейс создан";
  return (
    `  ! git worktree         ${w.dir} — ветка, а не проект: ${what} в основном дереве ` +
    `${w.main}. Воркспейс один на репозиторий: второй расколол бы очередь и память, ` +
    `и claim перестал бы что-либо значить`
  );
}

function renderInitHuman(raw: unknown): string {
  const d = raw as InitData;
  const lines: string[] = [];
  const version = CLI_VERSION;

  if (d.idempotent) {
    const n = d.db.nodeCount !== undefined ? `${d.db.nodeCount} узлов` : "узлов ?";
    lines.push(
      `myc ${version} · .myc уже существует (slug=${d.slug}, schema v${d.db.schemaVersion ?? "?"}, ${n})`,
    );
    lines.push("ничего не изменено. пересоздать: myc init --force (удалит локальную базу)");
    if (d.worktree !== undefined) lines.push(worktreeLine(d.worktree, true));
    lines.push(codeIntelLine(d.code_intel));
    lines.push(personalLine(d.personal));
    lines.push(`дальше: ${d.next}`);
    return `${lines.join("\n")}\n`;
  }

  if (d.adopted) {
    lines.push(
      `myc ${version} · клон ${d.dir} · slug=${d.slug} из .myc/workspace.toml (не тронут)`,
    );
    lines.push("");
    if (d.worktree !== undefined) lines.push(worktreeLine(d.worktree, false));
    lines.push(`  ✓ .myc/myc.db          создана, sqlite, schema v${d.db.schemaVersion ?? "?"}, wal`);
    lines.push(`  · .myc/workspace.toml  приехал из git — общая личность воркспейса`);
    lines.push(`  · graft                ${d.graft ? "найден" : "не найден"}`);
    lines.push(codeIntelLine(d.code_intel));
    lines.push(personalLine(d.personal));
    lines.push("");
    lines.push("дальше:");
    lines.push(`  ${d.next}`);
    lines.push("");
    lines.push(`готово за ${d.took_ms} мс · сеть не использовалась`);
    return `${lines.join("\n")}\n`;
  }

  const gitLabel = d.git.isGit ? "git" : "НЕ git-репозиторий";
  lines.push(`myc ${version} · repo ${d.dir} (${gitLabel}) · slug=${d.slug}`);
  lines.push("");
  lines.push(`  ✓ .myc/myc.db          sqlite, schema v${d.db.schemaVersion ?? "?"}, wal`);
  lines.push(`  ✓ .myc/workspace.toml  slug=${d.slug}`);
  if (d.worktree !== undefined) lines.push(worktreeLine(d.worktree, false));
  if (d.slug_changed !== undefined) {
    const n = d.slug_changed.nodes;
    lines.push(
      `  ! слаг сменён          ${d.slug_changed.from} → ${d.slug_changed.to}: ` +
        `${n !== undefined ? `${n} узлов` : "существующие узлы"} остаются со scope=${d.slug_changed.from} ` +
        `и больше не видны; вернуть: myc init --slug ${d.slug_changed.from}`,
    );
  }
  lines.push(`  · graft                ${d.graft ? "найден" : "не найден"}`);
  lines.push(codeIntelLine(d.code_intel));
  lines.push(
    "  · эмбеддинги           не скачаны — модель отдельной командой `myc models fetch`; " +
      "задачи работают и без неё (BM25)",
  );
  lines.push(personalLine(d.personal));
  if (!d.git.isGit) {
    lines.push("  ! не git-репозиторий   якоря к коду будут без blob_hash");
  }
  lines.push("");
  lines.push("дальше:");
  lines.push(`  ${d.next}`);
  lines.push("");
  lines.push(`готово за ${d.took_ms} мс · сеть не использовалась`);
  return `${lines.join("\n")}\n`;
}

interface GlobalInitData {
  dir: string;
  slug: string;
  idempotent: boolean;
  db: { path: string; schemaVersion: number | undefined; nodeCount?: number };
  siteId?: string;
  /** Что `--force` действительно удалил — факт, а не намерение. */
  wiped?: {
    entries: string[];
    /** Была ли среди удалённого сама память (только по явному --wipe-memory). */
    memory: boolean;
    /** Записи с памятью, ОСТАВЛЕННЫЕ на месте: обратная сторона того же факта. */
    memoryKept: string[];
    nodes: number | undefined;
    ops: number | undefined;
  };
  /** Чужие записи под ~/.myc, которых `--force` не касается (например, `bin/`). */
  kept?: string[];
  next: string;
  took_ms: number;
}

function countNodes(n: number): string {
  return `${n} ${plural(n, "узел", "узла", "узлов")}`;
}

function countOps(n: number): string {
  return `${n} ${plural(n, "операция", "операции", "операций")}`;
}

/**
 * Отказ стереть личную память. Три вещи, без которых отказ — тупик:
 * ЧТО стоит на пути (путь и цифры), ПОЧЕМУ этого не вернуть (нет git) и
 * КАКИМ ОБРАЗОМ пользователь всё-таки сделает то, что хотел. Согласие —
 * флаг, а не вопрос в stdin: агент запускает команды без терминала, и
 * вопрос, которого некому увидеть, превращается в вечное ожидание.
 */
function refusePersonalWipe(plan: PersonalWipePlan): CommandFailure {
  const what =
    plan.ops === undefined || plan.nodes === undefined
      ? "база не читается — что в ней, неизвестно"
      : `${countNodes(plan.nodes)}, ${countOps(plan.ops)} оплога`;
  return {
    ok: false,
    code: "precond.personal_memory",
    msg:
      `${plan.dir}: ${what}. Личный ярус не коммитится в git — восстановить его будет ` +
      `неоткуда, поэтому --force стирает здесь только восстановимое и на память ` +
      `не распространяется`,
    exit: ExitCode.PRECOND,
    hint:
      `сначала копия: cp -R ${plan.dir} ${plan.dir}.bak · ` +
      `стереть насовсем: myc init --global --force --wipe-memory`,
  };
}

function renderGlobalInitHuman(raw: unknown): string {
  const d = raw as GlobalInitData;
  const lines: string[] = [];
  if (d.idempotent) {
    const n = d.db.nodeCount !== undefined ? countNodes(d.db.nodeCount) : "узлов ?";
    lines.push(`личный воркспейс уже существует: ${d.dir} (schema v${d.db.schemaVersion ?? "?"}, ${n})`);
    // Строка, из которой человек узнаёт про --wipe-memory раньше, чем
    // упрётся в отказ: «удалит данные» тут больше не правда — --force их
    // не трогает.
    lines.push(
      "ничего не изменено. пересоздать: myc init --global --force " +
        "(память переживёт; стереть и её — добавить --wipe-memory)",
    );
  } else {
    // База пережила `--force` — значит воркспейс не создан заново, а оставлен
    // на месте с вычищенными кешами. Сказать «создан» здесь значило бы
    // отчитаться о том, чего команда как раз НЕ сделала.
    const keptMemory = d.wiped !== undefined && !d.wiped.memory && d.wiped.memoryKept.length > 0;
    lines.push(
      keptMemory
        ? `личный воркспейс на месте, стёрто только восстановимое: ${d.dir}`
        : `личный воркспейс создан: ${d.dir}`,
    );
    if (d.wiped !== undefined && d.wiped.memory) {
      const n = d.wiped.nodes !== undefined ? countNodes(d.wiped.nodes) : "узлы";
      const ops = d.wiped.ops !== undefined ? `, ${countOps(d.wiped.ops)} оплога` : "";
      lines.push(`  ! память стёрта  ${n}${ops} — восстановить неоткуда, копии не осталось`);
    }
    if (keptMemory && d.wiped !== undefined) {
      const n = d.wiped.nodes !== undefined ? countNodes(d.wiped.nodes) : "узлы";
      const ops = d.wiped.ops !== undefined ? `, ${countOps(d.wiped.ops)} оплога` : "";
      lines.push(`  · память не тронута  ${n}${ops} · ${d.wiped.memoryKept.join(", ")}`);
      if (d.wiped.entries.length > 0) lines.push(`  ✓ стёрто восстановимое  ${d.wiped.entries.join(", ")}`);
    }
    lines.push(`  ✓ myc.db  sqlite, schema v${d.db.schemaVersion ?? "?"}, wal`);
    if (d.kept !== undefined && d.kept.length > 0) {
      lines.push(`  · не тронуто  ${d.kept.join(", ")} — это не myc создавал`);
    }
    lines.push(
      "  · память сюда попадает только явным --global у recall/remember; " +
        "по умолчанию запись идёт в проектный .myc/ (S41)",
    );
  }
  lines.push(`дальше: ${d.next}`);
  lines.push(`готово за ${d.took_ms} мс`);
  return `${lines.join("\n")}\n`;
}

export function createInitCommand(): Command {
  return {
    name: "init",
    summary: "create a workspace: .myc/ with sqlite db, migrations, site_id, slug",
    flags: [
      { name: "slug", value: "string", description: "workspace slug (default: from directory name)" },
      { name: "force", description: "wipe an existing .myc/ and recreate it" },
      {
        name: "global",
        description:
          "create/report the personal workspace ~/.myc instead of the project one (S41: memory " +
          "written explicitly with --global, never silently)",
      },
      {
        name: "wipe-memory",
        description:
          "with --global --force: also erase the personal memory itself (db + oplog). " +
          "Nothing restores it — this is the explicit consent, not a convenience flag",
      },
    ],
    help:
      "Zero questions, zero network calls. Autodetects the git root and slug from the " +
      "directory name; both are shown, never confirmed. Re-running on an existing " +
      "workspace is a no-op (exit 0) unless --force is given. The embeddings model is " +
      "not downloaded here — that's `myc models fetch`, and its absence never blocks task work. " +
      "`--global` targets the personal workspace ~/.myc (S41) instead: it is never created " +
      "silently by a plain `myc init`, only reported. There `--force` erases only what can be " +
      "rebuilt (caches); the memory itself is not in git and nothing restores it, so erasing it " +
      "takes a second, explicit `--wipe-memory` — a flag, not a question, because agents run " +
      "without a terminal.",
    handler: async (ctx: CommandContext): Promise<CommandResult> => {
      const t0 = performance.now();

      if (flagBool(ctx, "global")) {
        const home = personalHome();
        const force = flagBool(ctx, "force");
        const wipeMemory = flagBool(ctx, "wipe-memory");
        const status = personalWorkspaceStatus(home);

        // Разрешение без действия — почти наверняка опечатка в разрушительной
        // команде, и трактовать его как «пользователь имел в виду --force»
        // значит додумать за него ровно тот шаг, ради которого всё это.
        if (wipeMemory && !force) {
          return {
            ok: false,
            code: "usage.wipe_memory_without_force",
            msg:
              "--wipe-memory — это разрешение на разрушительный шаг, а не сам шаг: " +
              "оно действует только вместе с --force",
            exit: ExitCode.USAGE,
            hint: "myc init --global --force --wipe-memory",
          };
        }

        if (status.exists && !force) {
          const summary = readPersonalSummary();
          const data: GlobalInitData = {
            dir: status.dir,
            slug: PERSONAL_SLUG,
            idempotent: true,
            db: { path: status.dbPath, schemaVersion: summary.schemaVersion, nodeCount: summary.nodeCount },
            next: "myc recall <запрос>",
            took_ms: Math.max(1, Math.round(performance.now() - t0)),
          };
          return { ok: true, data, meta: { took_ms: data.took_ms, idempotent: true } };
        }

        // Решение принимается ДО первой записи на диск: отказ обязан оставить
        // каталог ровно таким, каким его застал, включая кеши. Полумера
        // «кеши стёр, базу не тронул, вышел с ошибкой» оставила бы человека
        // гадать, что именно с ним произошло.
        const plan = personalWipePlan(home);
        if (force && plan.hasMemory && !wipeMemory) return refusePersonalWipe(plan);

        // Разрешение доезжает до исполнителя параметром: без `--wipe-memory`
        // стирается ровно восстановимое, база с оплогом остаётся на месте —
        // и на ярусе с памятью (сюда мы просто не дойдём), и на пустом.
        const wipedEntries = force ? wipePersonalWorkspace(plan, { memory: wipeMemory }) : [];

        const created = await createPersonalWorkspace(home);
        const data: GlobalInitData = {
          dir: created.dir,
          slug: PERSONAL_SLUG,
          idempotent: false,
          db: { path: created.dbPath, schemaVersion: created.schemaVersion },
          siteId: created.siteId,
          ...(force
            ? {
                wiped: {
                  entries: [...wipedEntries],
                  memory: wipeMemory,
                  memoryKept: wipeMemory ? [] : [...plan.memory],
                  nodes: plan.nodes,
                  ops: plan.ops,
                },
                kept: [...plan.kept],
              }
            : {}),
          next: "myc recall <запрос>",
          took_ms: Math.max(1, Math.round(performance.now() - t0)),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms, idempotent: false } };
      }

      const base = resolve(ctx.globals.directory ?? process.cwd());
      const target = ctx.args[0] !== undefined ? resolve(base, ctx.args[0]) : base;

      const gitRoot = detectGitRoot(target);

      // ВОРКСПЕЙС ПРИНАДЛЕЖИТ РЕПОЗИТОРИЮ, А НЕ ВЕТКЕ (memory-6amwnpb7tbat).
      // `git rev-parse --show-toplevel` в worktree отдаёт корень САМОГО
      // worktree, и init на нём завёл бы второй воркспейс: очередь и память
      // раскололись бы надвое, а claim перестал бы что-либо значить — два
      // агента на двух ветках друг друга не увидели бы. Поэтому цель —
      // основное дерево. Не отказ: отказ отправил бы человека делать то же
      // самое руками, а промолчать и создать рядом нельзя. Куда именно
      // создали, печатается отдельной строкой — это и есть объяснение.
      // Подъём по каталогам, а не `gitRoot`: у СЛОМАННОГО worktree (основное
      // дерево унесли) `git rev-parse` падает и отдаёт undefined — то есть
      // именно там, где отказ обязателен, git молчит.
      const link = findWorktreeLink(target);
      if (link !== undefined && !existsSync(link.mainRoot)) {
        // Единственный случай, когда остаётся только отказать: создавать
        // нечего и негде. Молча завести воркспейс в worktree — ровно тот
        // раскол, ради которого всё это.
        return {
          ok: false,
          code: "precond.worktree_main_missing",
          msg:
            `${link.worktreeDir} — git worktree, воркспейс принадлежит основному дереву, ` +
            `но каталога ${link.mainRoot} нет: перенесли или удалили ` +
            `(файл .git ведёт в ${link.gitDir})`,
          exit: ExitCode.PRECOND,
          hint: "git worktree repair <путь к основному дереву>",
        };
      }
      const workspaceDir = link?.mainRoot ?? gitRoot ?? target;
      const force = flagBool(ctx, "force");

      const mycDir = join(workspaceDir, ".myc");
      const dbPath = join(mycDir, "myc.db");

      // Личность воркспейса — в конфиге; база только его исполняет. Порядок
      // источников тот же и для клона (конфиг есть, базы нет), и для потери
      // конфига (база есть, конфига нет); имя каталога — последний источник,
      // и только когда ни одного признака воркспейса ещё нет.
      const rawSlug = ctx.flags["slug"];
      const requestedSlug =
        typeof rawSlug === "string" && /^[a-z][a-z0-9]{1,7}$/.test(rawSlug) ? rawSlug : undefined;
      const priorSlug = readConfigSlug(mycDir) ?? readDbSlug(dbPath);
      const slug = requestedSlug ?? priorSlug ?? slugify(basename(workspaceDir));
      const slugChanged = priorSlug !== undefined && slug !== priorSlug;

      const hadDb = existsSync(dbPath);

      // Ничего создавать не надо и личность не меняется — печатаем состояние
      // и выходим, как и раньше. Единственное, что здесь всё-таки создаётся, —
      // недостающие служебные файлы (.gitignore, потерянный workspace.toml):
      // «создать недостающее» — это и есть идемпотентность, а не «не трогать
      // ничего вообще».
      if (hadDb && !force && !slugChanged) {
        ensureMycGitignore(mycDir);
        if (!existsSync(join(mycDir, "workspace.toml"))) writeSlugInToml(mycDir, slug);
        const existing = readExistingWorkspace(workspaceDir);
        const ci = codeIntelOf(workspaceDir);
        warnCodeIntel(ctx, ci);
        const data: InitData = {
          dir: workspaceDir,
          slug,
          git: { root: gitRoot, isGit: gitRoot !== undefined },
          graft: detectGraft(workspaceDir),
          code_intel: ciData(ci),
          idempotent: true,
          adopted: false,
          db: { path: dbPath, schemaVersion: existing.schemaVersion, nodeCount: existing.nodeCount },
          personal: readPersonalSummary(),
          ...worktreeData(link),
          next: "myc ready",
          took_ms: Math.max(1, Math.round(performance.now() - t0)),
        };
        return { ok: true, data, meta: { took_ms: data.took_ms, idempotent: true } };
      }

      // Число узлов, которые смена слага уводит из видимости, считаем ДО
      // любых разрушительных действий: после --force его уже не узнать.
      const nodesBefore = hadDb ? readExistingWorkspace(workspaceDir).nodeCount : undefined;

      if (force && existsSync(mycDir)) wipeLocalState(mycDir);

      mkdirSync(mycDir, { recursive: true });
      ensureMycGitignore(mycDir);

      // Клон: конфиг приехал из git, базы нет. Личность не наша — берём её
      // как есть и создаём только недостающее.
      const adopted = !hadDb && priorSlug !== undefined && !slugChanged;

      let schemaVersion: number | undefined;
      let siteId: string | undefined;
      if (!existsSync(dbPath)) {
        const created = await createWorkspaceDb(dbPath, slug);
        siteId = created.siteId;
        schemaVersion = created.schemaVersion;
      } else {
        // Живая база под новым слагом (явный --slug): миграции на месте,
        // меняется только запись о личности.
        const db = new Database(dbPath);
        try {
          db.prepare(Q.meta_set.sql).run("slug", slug);
          schemaVersion =
            (db.query("SELECT max(version) AS v FROM schema_migrations").get() as
              | { v: number | null }
              | null
            )?.v ?? undefined;
        } finally {
          db.close();
        }
      }

      // Конфиг переписываем ТОЛЬКО когда его нет или когда слаг действительно
      // сменили: он коммитится, и лишний git-статус на общем файле — это шаг
      // к тому, чтобы кто-то закоммитил чужую личность.
      if (!existsSync(join(mycDir, "workspace.toml")) || slugChanged) {
        writeSlugInToml(mycDir, slug);
      }

      if (slugChanged) {
        ctx.warn(
          "slug.changed",
          `слаг воркспейса ${priorSlug} → ${slug}: ` +
            `${nodesBefore !== undefined ? `${nodesBefore} существующих узлов` : "существующие узлы"} ` +
            `остаются со scope=${priorSlug} и перестают быть видимыми; ` +
            `вернуть: myc init --slug ${priorSlug}`,
        );
      }

      const graft = detectGraft(workspaceDir);
      const ci = codeIntelOf(workspaceDir);
      if (!graft) {
        ctx.warn(
          "degraded.graft",
          "graft не найден — код-интеллект на builtin (текст), callers/search/map недоступны",
        );
      }
      warnCodeIntel(ctx, ci);
      ctx.warn(
        "degraded.embeddings",
        "модель эмбеддингов не скачана — поиск работает на BM25 до `myc models fetch`",
      );
      if (gitRoot === undefined) {
        ctx.warn("degraded.git", "не git-репозиторий — якоря к коду будут без blob_hash");
      }

      const data: InitData = {
        dir: workspaceDir,
        slug,
        git: { root: gitRoot, isGit: gitRoot !== undefined },
        graft,
        code_intel: ciData(ci),
        idempotent: false,
        adopted,
        ...(slugChanged ? { slug_changed: { from: priorSlug!, to: slug, nodes: nodesBefore } } : {}),
        db: { path: dbPath, schemaVersion },
        ...worktreeData(link),
        personal: readPersonalSummary(),
        ...(siteId !== undefined ? { siteId } : {}),
        next: adopted ? "myc import" : 'myc task "<первая задача>" -p P1',
        took_ms: Math.max(1, Math.round(performance.now() - t0)),
      };
      return { ok: true, data, meta: { took_ms: data.took_ms, idempotent: false } };
    },
    renderHuman: (raw, _ctx) =>
      typeof raw === "object" && raw !== null && "git" in (raw as object)
        ? renderInitHuman(raw)
        : renderGlobalInitHuman(raw),
  };
}
