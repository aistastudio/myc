/**
 * Секретные по имени файлы не попадают в индекс кода (memory-wpr1x91jp8fm).
 *
 * На cherry `myc code index` занёс в реестр `grow-your-meme/.env`: перечень —
 * `git ls-files --others --exclude-standard`, а корневой .gitignore там `.env`
 * не упоминает. Здесь воспроизведено ровно это — git настоящий, .gitignore о
 * секретах молчит, глобальные настройки git отрезаны (у пользователя в
 * `~/.config/git/ignore` `.env` почти наверняка есть, и тогда тест зеленел бы
 * без всякого запрета).
 *
 * МУТАЦИЯ приёмки — `isSecretName` всегда false — обязана ронять
 * интеграционные тесты этого файла: секреты возвращаются в `code_files`, и
 * `grepCode` находит их уникальные строки.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobs, migrate, migrations } from "@myc/store-sqlite";
import { CODE_INDEX_JOB_KIND, drainCodeIndex, runCodeIndex } from "./code_index.ts";
import { grepCode, resolveGrepScope } from "./grep.ts";
import { listFiles } from "./langs.ts";
import { buildSearchUnits } from "./search.ts";
import { isSecretName, isSecretPath } from "./secret-paths.ts";

// ---------------------------------------------------------------------------
// Предикат
// ---------------------------------------------------------------------------

describe("isSecretName — точные имена и расширения, без регистра", () => {
  const SECRET = [
    ".env",
    ".ENV",
    ".Env",
    ".env.local",
    ".env.production",
    ".env.stage.local",
    ".env.example.bak",
    ".env.",
    ".envrc",
    ".netrc",
    ".pgpass",
    ".git-credentials",
    ".pypirc",
    ".npmrc",
    ".NPMRC",
    "server.pem",
    "SERVER.PEM",
    "tls.key",
    "cert.p12",
    "cert.pfx",
    "release.jks",
    "debug.keystore",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "prod.tfvars",
    "prod.auto.tfvars",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "ID_RSA",
  ];
  const PLAIN = [
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.dist",
    ".env.stage.example",
    ".env.local.sample",
    ".ENV.EXAMPLE",
    "env",
    "env.ts",
    "environment.ts",
    ".environment",
    "env.example",
    "keys.ts",
    "keyboard.ts",
    "keychain.rs",
    "monkey",
    "key",
    "pem.ts",
    "id_rsa.pub",
    "id_ed25519.pub",
    "id_rsa_test.ts",
    "npmrc.md",
    ".npmrc.example",
    "tfstate.md",
    "backup.tfstate.md",
    "README.md",
    ".gitignore",
  ];

  test.each(SECRET)("%s — секрет", (name) => {
    expect(isSecretName(name)).toBe(true);
  });

  test.each(PLAIN)("%s — не секрет", (name) => {
    expect(isSecretName(name)).toBe(false);
  });

  test("путь решается по последнему сегменту, каталоги не в счёт", () => {
    expect(isSecretPath("grow-your-meme/.env")).toBe(true);
    expect(isSecretPath("deploy/certs/server.pem")).toBe(true);
    expect(isSecretPath("home/.ssh/id_rsa")).toBe(true);
    expect(isSecretPath("home/.ssh/id_rsa.pub")).toBe(false);
    // Каталог с секретным именем (virtualenv `.env/`) — не секрет его файлам.
    expect(isSecretPath(".env/lib/site.py")).toBe(false);
    expect(isSecretPath("keys.pem/readme.md")).toBe(false);
    expect(isSecretPath("config/.env.example")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Настоящий git, настоящий индекс
// ---------------------------------------------------------------------------

const HERMETIC = ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "XDG_CONFIG_HOME"] as const;
const saved: Record<string, string | undefined> = {};
let xdg: string;

beforeAll(() => {
  xdg = mkdtempSync(join(tmpdir(), "myc-secret-xdg-"));
  for (const k of HERMETIC) saved[k] = process.env[k];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.XDG_CONFIG_HOME = xdg;
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(xdg, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(
    [
      "git",
      "-c", "user.name=t",
      "-c", "user.email=t@t",
      "-c", "commit.gpgsign=false",
      "-c", "init.defaultBranch=main",
      ...args,
    ],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function put(base: string, rel: string, content: string): void {
  const abs = join(base, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

/** Уникальные строки секретов: найтись grep'ом им не дано ни в каком режиме. */
const LEAKS = {
  env: "ENVSECRET-4d1a",
  pem: "PEMSECRET-8b2c",
  npmrc: "NPMTOKEN-7f3e",
  local: "LOCALSECRET-19ad",
} as const;
const TEMPLATE = "EXAMPLE-PLACEHOLDER-91c2";

let work: string;
let repo: string;
let db: Database;

async function openDb(): Promise<Database> {
  const d = new Database(join(work, "myc.db"), { create: true });
  await migrate(d, { migrations, writable: true });
  return d;
}

function paths(repoId: string): string[] {
  return (db.query("SELECT path FROM code_files WHERE repo_id = ?1 ORDER BY path").all(repoId) as Array<{
    path: string;
  }>).map((r) => r.path);
}

/**
 * Репозиторий, чей .gitignore о секретах молчит. Отслеживаемые: код, шаблон
 * окружения и `config/.npmrc` (отслеживаемый секрет — тоже секрет).
 * Неотслеживаемые, но не игнорируемые: `.env`, `certs/server.pem`,
 * `app/.env.local` рядом с `app/main.ts`.
 */
function buildRepo(): void {
  repo = join(work, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  put(repo, ".gitignore", "node_modules/\n");
  put(repo, "src/app.ts", "export function app(): number {\n  return 1;\n}\n");
  put(repo, ".env.example", `API_KEY=${TEMPLATE}\n`);
  put(repo, ".env.stage.example", `API_KEY=${TEMPLATE}\n`);
  put(repo, "config/.npmrc", `//registry.npmjs.org/:_authToken=${LEAKS.npmrc}\n`);
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  put(repo, ".env", `API_KEY=${LEAKS.env}\n`);
  put(repo, "certs/server.pem", `-----BEGIN PRIVATE KEY-----\n${LEAKS.pem}\n-----END PRIVATE KEY-----\n`);
  put(repo, "app/main.ts", "export const main = 'app';\n");
  put(repo, "app/.env.local", `TOKEN=${LEAKS.local}\n`);
}

beforeEach(async () => {
  work = mkdtempSync(join(tmpdir(), "myc-secret-"));
  db = await openDb();
});

afterEach(() => {
  db.close();
  rmSync(work, { recursive: true, force: true });
});

describe("git-перечень: .gitignore о секретах молчит", () => {
  beforeEach(buildRepo);

  test("git сам отдаёт .env — без запрета он лёг бы в реестр", () => {
    // Предпосылка теста: иначе он проверял бы .gitignore, а не запрет.
    const others = git(repo, "ls-files", "--others", "--exclude-standard").split("\n");
    expect(others).toContain(".env");
    expect(others).toContain("certs/server.pem");
    expect(git(repo, "ls-files").split("\n")).toContain("config/.npmrc");
  });

  test("секреты не в code_files, шаблоны и код — в нём; счёт назван", async () => {
    const { scan } = await runCodeIndex(db, { repoId: "g", root: repo });
    const listed = paths("g");
    for (const p of [".env", "certs/server.pem", "config/.npmrc", "app/.env.local"]) {
      expect(listed).not.toContain(p);
    }
    for (const p of [".env.example", ".env.stage.example", "src/app.ts", "app/main.ts", ".gitignore"]) {
      expect(listed).toContain(p);
    }
    expect(scan.secretSkipped).toBe(4);
    expect(scan.files).toBe(listed.length);
    // Производных у секретов нет тоже: ни определений, ни ссылок, ни корпуса.
    buildSearchUnits(db, "g", repo);
    for (const table of ["code_defs", "code_ref_sites", "code_units"]) {
      const n = db
        .query(`SELECT count(*) AS n FROM ${table} WHERE repo_id = 'g' AND path IN ('.env','certs/server.pem','config/.npmrc','app/.env.local')`)
        .get() as { n: number };
      expect(n.n).toBe(0);
    }
  });

  test("code grep не находит ни одной строки секрета ни в каком режиме", async () => {
    await runCodeIndex(db, { repoId: "g", root: repo });
    const scopesOf = (inputs: string[]) => {
      const r = resolveGrepScope(db, "g", repo, inputs);
      if (!r.ok) throw new Error(`${inputs.join(",")}: ${r.code}`);
      return r.scopes;
    };
    for (const leak of Object.values(LEAKS)) {
      const modes = [
        grepCode(db, "g", repo, leak),
        grepCode(db, "g", repo, leak.toLowerCase(), { ignoreCase: true }),
        grepCode(db, "g", repo, leak, { scopes: scopesOf(["."]) }),
        // Каталог, где секрет лежит рядом с обычным файлом.
        grepCode(db, "g", repo, leak, { scopes: scopesOf(["app"]) }),
        grepCode(db, "g", repo, leak, { scopes: scopesOf(["certs/..", "app/"]) }),
        grepCode(db, "g", repo, leak, { langs: ["local", "pem", ""] }),
      ];
      for (const r of modes) expect({ leak, hits: r.hits, files: r.files }).toEqual({ leak, hits: 0, files: 0 });
    }
    // Шаблон окружения при этом ищется — запрет узкий, а не «всё с .env».
    const tpl = grepCode(db, "g", repo, TEMPLATE);
    expect(tpl.groups.map((g) => g.path).sort()).toEqual([".env.example", ".env.stage.example"]);
  });

  test("явный --in на секретный файл — отказ denied.secret, а не чтение", async () => {
    await runCodeIndex(db, { repoId: "g", root: repo });
    for (const input of [".env", "config/.npmrc", "certs/server.pem", "app/.env.local", "./app/../.env"]) {
      const r = resolveGrepScope(db, "g", repo, [input]);
      expect({ input, code: r.ok ? "ok" : r.code }).toEqual({ input, code: "denied.secret" });
    }
    // Каталог, под которым в реестре одни секреты: реестру там искать нечего.
    const certs = resolveGrepScope(db, "g", repo, ["certs"]);
    expect(certs.ok ? "ok" : certs.code).toBe("notfound.scope");
    // Шаблон — обычная область.
    expect(resolveGrepScope(db, "g", repo, [".env.example"]).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Реестр, собранный до запрета
// ---------------------------------------------------------------------------

describe("строки секрета, записанные до запрета", () => {
  beforeEach(buildRepo);

  /** Всё, что старая сборка могла записать о `.env`, — во всех таблицах. */
  function plantStale(): void {
    const st = statSync(join(repo, ".env"));
    db.query(
      "INSERT INTO code_files (repo_id, path, lang, mtime_ms, size_bytes, file_hash, indexed_at) VALUES ('g', '.env', '', ?1, ?2, 'wy:stale', 1)",
    ).run(Math.round(st.mtimeMs), st.size);
    db.query(
      "INSERT INTO code_defs (repo_id, path, name, kind, span_start, span_end) VALUES ('g', '.env', 'API_KEY', 'variable', 1, 1)",
    ).run();
    db.query(
      "INSERT INTO code_ref_sites (repo_id, path, line, name, kind, from_name, from_start) VALUES ('g', '.env', 1, 'API_KEY', 'read', '', 0)",
    ).run();
    const unit = db
      .query(
        "INSERT INTO code_units (repo_id, path, unit, name, kind, span_start, span_end, file_hash) VALUES ('g', '.env', 'def', 'API_KEY', 'variable', 1, 1, 'wy:stale') RETURNING id",
      )
      .get() as { id: number };
    db.query("INSERT INTO code_fts (rowid, name, sig, doc, path) VALUES (?1, 'API_KEY', ?2, '', '.env')").run(
      unit.id,
      `API_KEY=${LEAKS.env}`,
    );
    db.query("INSERT INTO code_refs (repo_id, name, n_files, n_hits, computed_at) VALUES ('g', 'API_KEY', 1, 1, 1)").run();
  }

  function countFor(table: string): number {
    return (db.query(`SELECT count(*) AS n FROM ${table} WHERE repo_id = 'g' AND path = '.env'`).get() as { n: number }).n;
  }

  test("следующий code index удаляет их из реестра и всех производных, removed ≥ 1", async () => {
    await runCodeIndex(db, { repoId: "g", root: repo });
    buildSearchUnits(db, "g", repo);
    plantStale();
    expect(countFor("code_files")).toBe(1);

    // Пока индекс не прогнан, grep уже не читает секрет — ни обходом реестра,
    // ни явным путём.
    expect(grepCode(db, "g", repo, LEAKS.env).hits).toBe(0);
    const explicit = resolveGrepScope(db, "g", repo, [".env"]);
    expect(explicit.ok ? "ok" : explicit.code).toBe("denied.secret");

    const { scan } = await runCodeIndex(db, { repoId: "g", root: repo });
    expect(scan.removed).toBeGreaterThanOrEqual(1);
    const search = buildSearchUnits(db, "g", repo);
    expect(search.removed).toBeGreaterThanOrEqual(1);

    for (const table of ["code_files", "code_defs", "code_ref_sites", "code_units"]) {
      expect({ table, n: countFor(table) }).toEqual({ table, n: 0 });
    }
    const fts = db.query("SELECT count(*) AS n FROM code_fts WHERE code_fts MATCH ?1").get(`"${LEAKS.env}"`) as {
      n: number;
    };
    expect(fts.n).toBe(0);
    // Кеш fan_in — по репозиторию: удаление файла его сбрасывает.
    expect((db.query("SELECT count(*) AS n FROM code_refs WHERE repo_id = 'g'").get() as { n: number }).n).toBe(0);
  });

  test("работа на секретный файл, вставшая в очередь до запрета, не пишет его обратно", async () => {
    // L1-имя под запретом: такой файл уже разбирался бы и попал в корпус поиска.
    put(repo, ".env.ts", `export const TOKEN = "${LEAKS.env}";\n`);
    await runCodeIndex(db, { repoId: "g", root: repo });
    expect(paths("g")).not.toContain(".env.ts");
    jobs.enqueue(db, CODE_INDEX_JOB_KIND, { entityId: ".env.ts", scope: "g", priority: 8, now: Date.now() });
    const drain = await drainCodeIndex(db, { repoId: "g", root: repo }, { poolMinFiles: 0 });
    expect(drain.claimed).toBe(1);
    expect(drain.parsed).toBe(0);
    expect(drain.cleaned).toBe(1);
    expect(paths("g")).not.toContain(".env.ts");
    expect((db.query("SELECT count(*) AS n FROM code_defs WHERE path = '.env.ts'").get() as { n: number }).n).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Запасной обход без git
// ---------------------------------------------------------------------------

describe("не-git дерево: обход без .gitignore, запрет действует и там", () => {
  test("перечень без секретов, счёт назван, grep их не находит", async () => {
    const tree = join(work, "plain");
    put(tree, "a.ts", "export const a = 1;\n");
    put(tree, ".env", `API_KEY=${LEAKS.env}\n`);
    put(tree, ".env.sample", `API_KEY=${TEMPLATE}\n`);
    put(tree, "ssh/id_rsa", `${LEAKS.pem}\n`);
    put(tree, "ssh/id_rsa.pub", "ssh-rsa AAAA public\n");
    put(tree, "deploy/tls.key", `${LEAKS.local}\n`);

    const l = await listFiles(tree);
    expect(l.unignored).toEqual([{ dir: ".", reason: "not a git repository" }]);
    expect([...l.files]).toEqual([".env.sample", "a.ts", "ssh/id_rsa.pub"]);
    expect(l.secretSkipped).toBe(3);

    const { scan } = await runCodeIndex(db, { repoId: "p", root: tree });
    expect(scan.secretSkipped).toBe(3);
    expect(paths("p")).toEqual([".env.sample", "a.ts", "ssh/id_rsa.pub"]);
    for (const leak of [LEAKS.env, LEAKS.pem, LEAKS.local]) {
      expect(grepCode(db, "p", tree, leak).hits).toBe(0);
    }
    const deny = resolveGrepScope(db, "p", tree, ["ssh/id_rsa"]);
    expect(deny.ok ? "ok" : deny.code).toBe("denied.secret");
    expect(resolveGrepScope(db, "p", tree, ["ssh/id_rsa.pub"]).ok).toBe(true);
  });
});
