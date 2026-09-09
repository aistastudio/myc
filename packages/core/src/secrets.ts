/**
 * Редакция секретов на записи (D23, docs/design/03-interfaces-and-integration.md §9).
 *
 * Обязательный этап перед тем, как текст (транскрипт сессии, absorb, import)
 * попадёт в оплог: PreCompact пишет сырые транскрипты, `.myc/` лежит рядом с
 * git, и без детектора это утечка чужих ключей по расписанию.
 *
 * Два слоя обнаружения:
 *  1. Паттерны — таблица данных (имя, regex, уверенность), а не код: новый
 *     провайдер добавляется строкой в {@link SECRET_PATTERNS}, без изменения
 *     логики.
 *  2. Энтропия Шеннона — ловит то, что паттерны не знают (произвольные
 *     API-ключи), но только в контексте, похожем на присваивание секрета
 *     (`KEY = "..."`), и с исключениями для hex-хешей, UUID и base64-картинок
 *     — иначе она забивает шумом git-хеши и минифицированный код.
 *
 * Секрет не удаляется, а маскируется устойчивым плейсхолдером
 * `<redacted:kind:sha1_8>`: одинаковый секрет → одинаковый плейсхолдер (по
 * первым 8 hex-символам sha1 значения), текст вокруг сохраняется.
 */

import { createHash } from "node:crypto";

export type SecretConfidence = "high" | "medium" | "low";

export interface SecretFinding {
  readonly kind: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: SecretConfidence;
  readonly placeholder: string;
}

export interface RedactResult {
  readonly text: string;
  readonly findings: readonly SecretFinding[];
}

interface SecretPattern {
  readonly kind: string;
  readonly confidence: SecretConfidence;
  readonly regex: RegExp;
  /**
   * Номер захватывающей группы, содержащей собственно секрет. Если не
   * задан — маскируется всё совпадение целиком (сам секрет самодостаточен:
   * ключ, JWT, PEM-блок). Если задан — маскируется только значение, а
   * префикс вида `Authorization: Bearer ` или `DB_PASSWORD=` остаётся на
   * месте ради читаемости.
   */
  readonly valueGroup?: number;
}

// ---------------------------------------------------------------------------
// 1. Паттерны — данные, не код.
// ---------------------------------------------------------------------------

/**
 * Каждый regex собран с флагом `g` в {@link compilePattern}, здесь можно
 * писать их без учёта этого — компиляция общая для всех.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: "aws_access_key_id", confidence: "high", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    kind: "aws_secret_access_key",
    confidence: "medium",
    regex: /\baws_secret_access_key\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/i,
    valueGroup: 1,
  },
  { kind: "gcp_api_key", confidence: "high", regex: /\bAIza[0-9A-Za-z\-_]{35}\b/ },
  { kind: "google_oauth_client_secret", confidence: "high", regex: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "openai_project_key", confidence: "high", regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "openai_key", confidence: "high", regex: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { kind: "anthropic_key", confidence: "high", regex: /\bsk-ant-[A-Za-z0-9-]{20,}\b/ },
  { kind: "slack_token", confidence: "high", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    kind: "slack_webhook",
    confidence: "high",
    regex: /\bhooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]+\b/,
  },
  { kind: "github_token", confidence: "high", regex: /\bgh[pousr]_[A-Za-z0-9]{36}\b/ },
  { kind: "github_fine_grained_pat", confidence: "high", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { kind: "stripe_key", confidence: "high", regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { kind: "npm_token", confidence: "high", regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { kind: "sendgrid_key", confidence: "high", regex: /\bSG\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  { kind: "mailgun_key", confidence: "medium", regex: /\bkey-[a-f0-9]{32}\b/ },
  { kind: "digitalocean_token", confidence: "high", regex: /\bdop_v1_[a-f0-9]{64}\b/ },
  {
    kind: "azure_storage_connection_string",
    confidence: "high",
    regex: /\bDefaultEndpointsProtocol=https?;[^;\n]*AccountKey=([A-Za-z0-9+/=]{20,})/,
    valueGroup: 1,
  },
  {
    kind: "private_key_pem",
    confidence: "high",
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/,
  },
  { kind: "jwt", confidence: "high", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    kind: "db_connection_string",
    confidence: "high",
    regex: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:[^@\s]+@[^\s'"`]+/i,
  },
  {
    kind: "basic_auth_url",
    confidence: "medium",
    regex: /\bhttps?:\/\/[^:\s/@]+:[^@\s]+@[^\s'"`]+/i,
  },
  {
    kind: "authorization_header",
    confidence: "high",
    regex: /\bAuthorization\s*:\s*(?:Bearer|Basic)\s+([A-Za-z0-9\-._~+/]+=*)/i,
    valueGroup: 1,
  },
  { kind: "twilio_api_key_sid", confidence: "medium", regex: /\bSK[a-f0-9]{32}\b/ },
  {
    /**
     * Присваивание чему-то, что названо ключом, токеном или паролем.
     *
     * Правило пришлось переписать после отчёта с живого проекта: прежняя
     * форма требовала ВЕРХНЕГО регистра и подчёркивания перед словом, и потому
     * ловила `DB_PASSWORD=…`, но пропускала `db_password=…`, `password=…`,
     * `api_key=…` и `PGPASSWORD=…` — то есть ровно те написания, которые
     * встречаются в коде и в выводе чаще всего. Секрет уходил в эпизод сжатия
     * открытым текстом.
     *
     * Теперь: регистр не важен (`i`), разделитель перед словом необязателен
     * (`PGPASSWORD` — одно слово), а имя может и целиком быть ключевым словом
     * (`password=`, `passwords=`). Правая граница значения осталась прежней.
     *
     * Порог длины 8 сознательно НЕ снижен: короткие значения дают ложные
     * срабатывания на прозе («ключ: да»), а маскировать нечего — секретом на
     * семь символов всё равно нельзя пользоваться. Но это допущение, и оно
     * названо: `hunter2` этим правилом не скрывается.
     */
    kind: "generic_key_assignment",
    confidence: "medium",
    regex:
      /\b((?:[A-Za-z][A-Za-z0-9]*(?:[_.-][A-Za-z0-9]+)*[_.-])?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)S?)\s*[:=]\s*["']?([A-Za-z0-9\-_/+.=]{8,})["']?/i,
    valueGroup: 2,
  },
  {
    /**
     * Слитное имя без разделителя: `PGPASSWORD`, `MYSQLPWD`, `APITOKEN`.
     *
     * Отдельным правилом, а не ветвью предыдущего, ради ГРАНИЦЫ. Разрешив
     * слитный префикс при любом регистре, мы начинаем маскировать `monkey=`,
     * `donkey:` и `turkeys=` — «key» сидит внутри обычных слов, и проза
     * превращается в решето наоборот. Здесь имя целиком в верхнем регистре:
     * так пишут переменные окружения и не пишут английские существительные.
     */
    kind: "screaming_key_assignment",
    confidence: "medium",
    regex:
      /\b([A-Z][A-Z0-9]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL)S?)\s*[:=]\s*["']?([A-Za-z0-9\-_/+.=]{8,})["']?/,
    valueGroup: 2,
  },
] as const;

interface CompiledPattern extends SecretPattern {
  readonly compiled: RegExp;
}

function compilePattern(pattern: SecretPattern): CompiledPattern {
  const flags = pattern.regex.flags.includes("g") ? pattern.regex.flags : `${pattern.regex.flags}g`;
  return { ...pattern, compiled: new RegExp(pattern.regex.source, flags) };
}

const COMPILED_PATTERNS: readonly CompiledPattern[] = SECRET_PATTERNS.map(compilePattern);

// ---------------------------------------------------------------------------
// 2. Энтропийная проверка.
// ---------------------------------------------------------------------------

/**
 * Порог 4.0 бит/символ (значение из D23). Случайный ключ на алфавите
 * base62/base64 несёт ~5.5-6 бит/симв.; естественный текст и обычные
 * идентификаторы — 3-4. Hex-хеши (git, md5/sha1/sha256) несут ~3.9-4.0
 * бит/симв на алфавите из 16 символов и **исключаются отдельно** по длине
 * (32/40/64) и алфавиту, а не порогом энтропии — иначе порог, достаточно
 * низкий, чтобы ловить настоящие ключи, обязательно ловит и хеши.
 */
const ENTROPY_THRESHOLD_BITS = 4.0;
const ENTROPY_MIN_LEN = 32;
const ENTROPY_MAX_LEN = 256;

/**
 * Контекст, похожий на присваивание секрета: `имя [:=] "значение"`.
 *
 * Имя взято в АТОМАРНУЮ группу — приём `(?=(X))\2` вместо простого `X`. Это
 * не украшение: без него движок на каждой букве 37-мегабайтной стенограммы
 * съедал до 40 символов имени и потом откатывался по одному, проверяя
 * `\s*[:=]` в каждой точке отката. Замер на стенограмме этого проекта —
 * 901 мс из 1375 мс всего маскирования; с атомарной группой 614 мс.
 *
 * Эквивалентность здесь не вопрос вкуса, а следствие алфавитов: `[\w.$-]` не
 * содержит ни пробельных, ни `:`, ни `=`. Значит жадный проход имени всегда
 * останавливается ровно там, где начинается `\s*[:=]` (или там, где совпадения
 * нет вовсе), и ни один откат не способен дать совпадение, которого не даёт
 * атомарный вариант. Проверено и эмпирически: на шести настоящих стенограммах
 * (55 МБ, 1131 совпадение) оба варианта дают побайтово одинаковый список.
 */
const ASSIGNMENT_CONTEXT =
  /([A-Za-z](?=([\w.$-]{1,40}))\2)\s*[:=]\s*["']?([A-Za-z0-9+/_=\-]{32,256})["']?/g;
/** Номер группы со значением: атомарная группа сдвинула нумерацию на единицу. */
const ASSIGNMENT_VALUE_GROUP = 3;

const HEX_HASH_LENGTHS = new Set([32, 40, 64]);
const HEX_RE = /^[0-9a-f]+$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ключи контекста, за которыми почти никогда не стоит секрет. */
const BENIGN_KEY_RE = /^(?:id|uuid|hash|sha|sha1|sha256|md5|commit|rev|revision|version|src|href|url|path|class|style|guid|digest|checksum|etag|blob|oid)$/i;

function shannonEntropyBitsPerChar(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const len = value.length;
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksLikeHexHash(value: string): boolean {
  return HEX_HASH_LENGTHS.has(value.length) && HEX_RE.test(value);
}

/** `data:image/png;base64,....` встроенное в JSON/markdown — не секрет. */
function isDataUrlContext(line: string): boolean {
  return /data:[a-z0-9./+-]+;base64,/i.test(line);
}

interface RawMatch {
  readonly kind: string;
  readonly confidence: SecretConfidence;
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

function findEntropyMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  ASSIGNMENT_CONTEXT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ASSIGNMENT_CONTEXT.exec(text)) !== null) {
    const key = m[1] as string;
    const value = m[ASSIGNMENT_VALUE_GROUP] as string;
    if (value.length < ENTROPY_MIN_LEN || value.length > ENTROPY_MAX_LEN) continue;
    if (BENIGN_KEY_RE.test(key)) continue;
    if (looksLikeHexHash(value)) continue;
    if (UUID_RE.test(value)) continue;

    const lineStart = text.lastIndexOf("\n", m.index) + 1;
    const lineEnd = text.indexOf("\n", m.index);
    const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd);
    if (isDataUrlContext(line)) continue;

    if (shannonEntropyBitsPerChar(value) < ENTROPY_THRESHOLD_BITS) continue;

    const valueStart = m.index + m[0].lastIndexOf(value);
    matches.push({
      kind: "high_entropy_assignment",
      confidence: "medium",
      start: valueStart,
      end: valueStart + value.length,
      value,
    });
  }
  return matches;
}

function findPatternMatches(text: string): RawMatch[] {
  const matches: RawMatch[] = [];
  for (const pattern of COMPILED_PATTERNS) {
    pattern.compiled.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.compiled.exec(text)) !== null) {
      const full = m[0];
      if (full.length === 0) {
        pattern.compiled.lastIndex += 1;
        continue;
      }
      const groupIdx = pattern.valueGroup;
      const value = groupIdx !== undefined ? m[groupIdx] : undefined;
      if (groupIdx !== undefined && value === undefined) continue;
      const target = value ?? full;
      const start = groupIdx !== undefined ? m.index + full.lastIndexOf(target) : m.index;
      matches.push({
        kind: pattern.kind,
        confidence: pattern.confidence,
        start,
        end: start + target.length,
        value: target,
      });
    }
  }
  return matches;
}

/** Убирает перекрытия: паттерны приоритетнее энтропии, длиннее — приоритетнее короче. */
function dedupeOverlaps(matches: RawMatch[]): RawMatch[] {
  const sorted = [...matches].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    return b.end - b.start - (a.end - a.start);
  });
  const result: RawMatch[] = [];
  let lastEnd = -1;
  for (const match of sorted) {
    if (match.start < lastEnd) continue;
    result.push(match);
    lastEnd = match.end;
  }
  return result;
}

function placeholderFor(kind: string, value: string): string {
  const hash = createHash("sha1").update(value).digest("hex").slice(0, 8);
  return `<redacted:${kind}:${hash}>`;
}

/**
 * Находит и маскирует секреты в тексте. Бюджет пути записи — 5 мс
 * (docs/design/03-interfaces-and-integration.md §9); при превышении
 * вызывающая сторона обязана честно отразить это в `meta.degraded`, а не
 * промолчать.
 */
export function redactSecrets(input: string): RedactResult {
  const patternMatches = findPatternMatches(input);
  const patternSpans = patternMatches.map((m) => [m.start, m.end] as const);
  const entropyMatches = findEntropyMatches(input).filter(
    (e) => !patternSpans.some(([s, en]) => e.start < en && e.end > s),
  );

  const matches = dedupeOverlaps([...patternMatches, ...entropyMatches]);
  if (matches.length === 0) {
    return { text: input, findings: [] };
  }

  let out = "";
  let cursor = 0;
  const findings: SecretFinding[] = [];
  for (const match of matches) {
    out += input.slice(cursor, match.start);
    const placeholder = placeholderFor(match.kind, match.value);
    out += placeholder;
    findings.push({
      kind: match.kind,
      start: match.start,
      end: match.end,
      confidence: match.confidence,
      placeholder,
    });
    cursor = match.end;
  }
  out += input.slice(cursor);

  return { text: out, findings };
}
