/**
 * Файлы, которые индекс не берёт НИКОГДА, — по ИМЕНИ, поверх любого перечня
 * (memory-wpr1x91jp8fm).
 *
 * Перечень файлов — `git ls-files --cached --others --exclude-standard`, и он
 * честно отдаёт неотслеживаемый, но не игнорируемый файл. Так на cherry в
 * реестр и корпус попал `grow-your-meme/.env`: корневой .gitignore там `.env`
 * не упоминает, и git в своём праве. Надеяться на чужой .gitignore нельзя —
 * `code grep` читает всё, что есть в реестре, и отдал бы секрет агенту.
 * Поэтому здесь запрет, который действует на ЛЮБОМ перечне: на git-перечне
 * (отслеживаемый `.env` — тоже секрет) и на обходе без git.
 *
 * Правило намеренно УЗКОЕ: точные имена и точные расширения. `env.ts`,
 * `environment.ts`, `keys.ts`, `keychain.rs` — код, и он индексу нужен.
 * Шаблоны окружения (`.env.example`, `.env.stage.sample`) — документация без
 * значений: их индексировать можно, и grep по ним полезен.
 *
 * Сравнение — по последнему сегменту пути и без учёта регистра: на macOS
 * `.ENV` — тот же файл, что `.env`.
 */

/** Секретные имена целиком: окружение, учётные данные, приватные ключи SSH. */
const SECRET_NAMES: ReadonlySet<string> = new Set([
  ".env",
  ".envrc",
  ".netrc",
  ".pgpass",
  ".git-credentials",
  ".pypirc",
  ".npmrc",
  // Только приватные: `id_rsa.pub` — публичный ключ, его индексировать можно.
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

/** Секретные расширения: ключи, хранилища ключей, состояние и переменные terraform. */
const SECRET_EXTS: ReadonlySet<string> = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".tfstate",
  ".tfvars",
]);

/** Суффиксы, превращающие `.env.*` в шаблон без значений. */
const ENV_TEMPLATE_EXTS: ReadonlySet<string> = new Set([".example", ".sample", ".template", ".dist"]);

/** Правило одной строкой — для отказов и подсказок, одно на весь продукт. */
export const SECRET_NAMES_LABEL =
  ".env and .env.* (not .example/.sample/.template/.dist), *.pem, *.key, *.p12, *.pfx, *.jks, " +
  "*.keystore, *.tfstate, *.tfvars, private SSH keys (id_rsa, id_ed25519, …), .npmrc, .netrc, " +
  ".pgpass, .pypirc, .git-credentials, .envrc";

/** Секретное ли ИМЯ файла (последний сегмент пути, без каталогов). */
export function isSecretName(name: string): boolean {
  const base = name.toLowerCase();
  if (SECRET_NAMES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = base.slice(dot);
  if (base.startsWith(".env.")) return !ENV_TEMPLATE_EXTS.has(ext);
  if (SECRET_EXTS.has(ext)) return true;
  return ext === ".backup" && base.endsWith(".tfstate.backup");
}

/** Секретный ли файл по POSIX-пути от корня: решает только его имя. */
export function isSecretPath(path: string): boolean {
  return isSecretName(path.slice(path.lastIndexOf("/") + 1));
}
