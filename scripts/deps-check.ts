#!/usr/bin/env bun
import { readdir } from "node:fs/promises";

const PACKAGES_DIR = "packages";

const SURFACES = new Set(["cli", "mcp", "server", "web"]);

type Rule = (pkg: string, deps: Set<string>) => string | null;

const RULES: Rule[] = [
  (pkg, deps) => {
    if (pkg === "core" && deps.size > 0) {
      return `core must not depend on any @myc/* package, found: ${[...deps].join(", ")}`;
    }
    return null;
  },
  (pkg, deps) => {
    if (pkg === "retrieval" && deps.has("distiller")) {
      return "retrieval must not depend on @myc/distiller";
    }
    return null;
  },
  (pkg, deps) => {
    if (pkg === "swarm") {
      const extra = [...deps].filter((d) => d !== "core");
      if (extra.length > 0) {
        return `swarm may only depend on @myc/core, found extra: ${extra.join(", ")}`;
      }
    }
    return null;
  },
  (pkg, deps) => {
    if (pkg.startsWith("store-")) {
      const extra = [...deps].filter((d) => d !== "core");
      if (extra.length > 0) {
        return `${pkg} may only depend on @myc/core, found extra: ${extra.join(", ")}`;
      }
    }
    return null;
  },
];

async function listPackages(): Promise<string[]> {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function shortName(fullName: string): string {
  return fullName.replace(/^@myc\//, "");
}

/**
 * СЛОИСТОСТЬ СТОРОЖАТ РАДИ РАНТАЙМА, а `devDependencies` в рантайм не
 * попадают (memory-p1v756t1jc1z).
 *
 * Прежде сюда шли все три секции разом, и правило «store-* зависит только от
 * core» запрещало пакету ТЕСТОВУЮ оснастку. Следствие было не
 * теоретическим: `cycle.latency.test.ts` не мог перейти на методику
 * @myc/bench (медиана по независимым трейлам, сторож дрожания) и под
 * нагрузкой падал, сообщая о загрузке машины, а не о коде. Так же были
 * заперты core и swarm — три пакета из четырнадцати.
 */
async function collectDeclaredDeps(pkgDir: string): Promise<Set<string>> {
  const pkgJsonPath = `${PACKAGES_DIR}/${pkgDir}/package.json`;
  const pkgJson = await Bun.file(pkgJsonPath).json();
  const deps = new Set<string>();
  for (const field of ["dependencies", "peerDependencies"]) {
    const section = pkgJson[field] as Record<string, string> | undefined;
    if (!section) continue;
    for (const dep of Object.keys(section)) {
      if (dep.startsWith("@myc/")) deps.add(shortName(dep));
    }
  }
  return deps;
}

/** Тестовый файл: его импорты в бинарь не попадают. */
function isTestFile(file: string): boolean {
  return /(?:^|[./])(?:test|spec)\.[tj]sx?$/.test(file) || /\.(?:test|spec)\./.test(file);
}

async function collectImportedDeps(pkgDir: string): Promise<Set<string>> {
  const deps = new Set<string>();
  const srcDir = `${PACKAGES_DIR}/${pkgDir}/src`;
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  for await (const file of glob.scan(srcDir)) {
    // ТЕСТЫ НЕ СЧИТАЮТСЯ ЗАВИСИМОСТЬЮ ПАКЕТА. Правило слоистости защищает
    // рантайм: что импортирует тест, в поставку не уходит. Считая их,
    // сторож запрещал пакету пользоваться собственной тестовой оснасткой —
    // и именно поэтому бюджетные тесты трёх пакетов остались без методики
    // @myc/bench (memory-p1v756t1jc1z).
    if (isTestFile(file)) continue;
    const text = await Bun.file(`${srcDir}/${file}`).text();
    // Ищем ИМПОРТЫ, а не любое вхождение имени: комментарий, объясняющий
    // связь с соседним пакетом («тот же выключатель, что у @myc/bench»),
    // засчитывался как зависимость, и правило запрещало объяснять само себя.
    // Здесь важна форма: `from "@myc/x"`, `import("@myc/x")`, `require`.
    const matches = text.matchAll(
      /(?:from|import|require)\s*\(?\s*["'`]@myc\/([a-z0-9-]+)["'`]/g,
    );
    for (const m of matches) {
      const dep = m[1]!;
      if (dep !== pkgDir) deps.add(dep);
    }
  }
  return deps;
}

async function main() {
  const packages = await listPackages();
  const violations: string[] = [];

  for (const pkg of packages) {
    if (SURFACES.has(pkg)) continue;

    const declared = await collectDeclaredDeps(pkg);
    const imported = await collectImportedDeps(pkg);
    const deps = new Set([...declared, ...imported]);

    for (const rule of RULES) {
      const violation = rule(pkg, deps);
      if (violation) violations.push(`[@myc/${pkg}] ${violation}`);
    }
  }

  if (violations.length > 0) {
    console.error("deps-check failed:");
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }

  console.log(`deps-check passed for ${packages.length} packages`);
}

await main();
