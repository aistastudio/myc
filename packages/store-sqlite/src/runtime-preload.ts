// Preload для `bun test` (bunfig.toml → [test] preload).
//
// В многофайловом прогоне bun test сам открывает внутреннюю сборку SQLite до
// запуска любых тестов, после чего Database.setCustomSQLite уже невозможен
// ("SQLite already loaded"). Поэтому инициализация рантайма обязана случиться
// здесь — до того, как раннер и тесты откроют хоть одно соединение.
// ensureSqliteRuntime идемпотентен: все последующие вызовы получают закешированное
// состояние. Не найденная библиотека или vec0 не роняет прогон — состояние
// деградации видно через getSqliteRuntimeState() (инвариант И2). Явно заданная,
// но нерабочая MYC_SQLITE / MYC_SQLITE_VEC роняет прогон громко и сразу.
import { ensureSqliteRuntime } from "./runtime.ts";

ensureSqliteRuntime();
