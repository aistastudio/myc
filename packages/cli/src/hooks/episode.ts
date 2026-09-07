/**
 * Сырой эпизод L0 (§6.2, шаг 3) — первое, что делает pre-compact, и то, ради
 * чего он вообще существует.
 *
 * ПОРЯДОК ЗАПИСИ КРИТИЧЕН. Сырой эпизод пишется ПЕРВЫМ и быстро (бюджет 6 мс),
 * всё остальное — после. Причина не в эстетике: если процесс убьют посреди
 * хука, из сырого эпизода восстанавливается всё прочее (кандидаты, спасательный
 * пакет, дистилляция), а из спасательного пакета — ничего.
 *
 * ЦЕЛОСТНОСТЬ ПРИ УБИЙСТВЕ ПРОЦЕССА. Файл пишется во временное имя и въезжает
 * на место одним `rename` (атомарен в пределах ФС), и только ПОСЛЕ этого
 * появляется строка узла. Порядок именно такой, потому что строка без файла —
 * узел, который ВРЁТ, что эпизод сохранён, а файл без строки — целые данные,
 * которым не хватает индекса. Второе чинится, первое нет: {@link
 * reconcileEpisodes} на следующем запуске читает шапку осиротевшего файла и
 * восстанавливает строку. Тест `kill-safety` бьёт SIGKILL'ом именно в это
 * окно — оно достижимо, и потому оно самозалечивается, а не «маловероятно».
 * `fsync` сознательно не зовём: он защищает от потери питания, стоит
 * миллисекунды и не нужен против `kill`.
 *
 * ACL. Эпизод — `private` и L0 по умолчанию (D22): транскрипт содержит чужой
 * код, чужие пароли и чужие мысли, и делиться им по умолчанию — инцидент.
 * Секреты к этому моменту уже замаскированы вызывающей стороной (D23).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { generateId, type JsonValue } from "@myc/core";
import type { StoreHandle } from "../commands/store.ts";

export const EPISODES_DIR = "episodes";
/** Уровень 1: на горячем пути важна скорость, а не последние 3% степени сжатия. */
const ZSTD_LEVEL = 1;

/**
 * Шапка эпизода. Здесь только то, что известно БЕСПЛАТНО к моменту записи:
 * разбор транскрипта (ходы, формат, модель) стоит миллисекунды и происходит
 * ПОСЛЕ, иначе сырой эпизод перестаёт быть первым.
 */
export interface EpisodeHeader {
  readonly v: 1;
  readonly id: string;
  readonly reason: string;
  readonly agent: string;
  readonly created_at: number;
  readonly raw_bytes: number;
  readonly secrets_masked: number;
  readonly cwd?: string;
  readonly session_id?: string;
}

export interface EpisodeWriteInput {
  /** Каталог воркспейса (`.myc`), внутри которого лежит `episodes/`. */
  readonly mycDir: string;
  readonly handle: StoreHandle;
  readonly header: Omit<EpisodeHeader, "v" | "id">;
  /** Транскрипт ПОСЛЕ маскирования секретов. */
  readonly redacted: string;
  readonly attrs: Readonly<Record<string, JsonValue>>;
}

export interface EpisodeWriteResult {
  readonly id: string;
  readonly path: string;
  readonly storedBytes: number;
  readonly compression: "zstd" | "none";
  /** Время шага целиком: файл + строка узла. Бюджет — 6 мс. */
  readonly tookMs: number;
}

function compress(text: string): { data: Uint8Array | string; ext: string; how: "zstd" | "none" } {
  try {
    return { data: Bun.zstdCompressSync(Buffer.from(text, "utf8"), { level: ZSTD_LEVEL }), ext: ".jsonl.zst", how: "zstd" };
  } catch {
    // Нет zstd в рантайме — пишем как есть. Эпизод важнее сжатия, и молчать
    // об этом нельзя: `compression` уходит в attrs узла и в вывод команды.
    return { data: text, ext: ".jsonl", how: "none" };
  }
}

/**
 * Пишет эпизод: файл, затем строку узла. Возвращает id и фактическое время
 * шага. Бросает только если не записалось НИЧЕГО — частичного состояния после
 * этой функции не бывает.
 */
export function writeEpisode(input: EpisodeWriteInput): EpisodeWriteResult {
  const t0 = performance.now();
  const dir = join(input.mycDir, EPISODES_DIR);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    // Эпизоды приватны (D22) и лежат рядом с git. Правило игнора ставит тот,
    // кто создаёт каталог: без него первый же `git add .` унесёт в историю
    // сырые транскрипты — то самое, ради чего эпизод и помечен private.
    writeFileSync(join(dir, ".gitignore"), "# сырые эпизоды L0 приватны (D22) и в git не идут\n*\n");
  }

  const id = generateId(input.handle.slug);
  const header: EpisodeHeader = { v: 1, id, ...input.header };
  const body = `${JSON.stringify(header)}\n${input.redacted}`;
  const { data, ext, how } = compress(body);

  const finalPath = join(dir, `${id}${ext}`);
  const tmpPath = join(dir, `.${id}${ext}.tmp`);
  writeFileSync(tmpPath, data);
  renameSync(tmpPath, finalPath); // ← до этой точки на месте эпизода нет ничего

  const storedBytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;

  // id в заголовке не украшение: content_hash считается по (kind, title, body),
  // а тело эпизода лежит в файле, поэтому два сжатия подряд с одинаковым
  // reason дали бы одинаковый хеш и второй эпизод не записался бы вовсе.
  input.handle.store.createNode({
    id,
    kind: "session",
    layer: 0,
    acl: "private",
    scope: input.handle.scope,
    title: `эпизод ${id} · ${input.header.reason} · ${input.header.agent}`,
    actor: input.handle.actor,
    attrs: {
      ...input.attrs,
      episode_path: `${EPISODES_DIR}/${id}${ext}`,
      episode_bytes: storedBytes,
      compression: how,
    },
  });

  return { id, path: finalPath, storedBytes, compression: how, tookMs: performance.now() - t0 };
}

/**
 * Подметает `.tmp`-файлы, оставшиеся от убитых процессов. Вызывается в самом
 * конце хука и только при наличии бюджета: уборка мусора не имеет права
 * конкурировать с записью эпизода.
 */
export function sweepPartialEpisodes(mycDir: string, olderThanMs = 3_600_000, now = Date.now()): number {
  const dir = join(mycDir, EPISODES_DIR);
  if (!existsSync(dir)) return 0;
  let removed = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
      const path = join(dir, name);
      try {
        if (now - statSync(path).mtimeMs < olderThanMs) continue;
        rmSync(path, { force: true });
        removed++;
      } catch {
        // чужой файл или гонка с другим процессом — уборка не обязана удаться
      }
    }
  } catch {
    return removed;
  }
  return removed;
}

/** Максимум файлов, которые проверяем на сиротство: они всегда свежие. */
const RECONCILE_SCAN = 50;

export interface ReconcileResult {
  /** Осиротевшие файлы, которым восстановлена строка узла. */
  readonly adopted: readonly string[];
  /** Файлы, которые прочитать не удалось: оставлены на месте, не удалены. */
  readonly unreadable: number;
}

function readHeader(path: string): EpisodeHeader | null {
  try {
    const raw = readFileSync(path);
    const text = path.endsWith(".zst")
      ? new TextDecoder().decode(Bun.zstdDecompressSync(raw))
      : raw.toString("utf8");
    const first = text.slice(0, text.indexOf("\n"));
    const parsed = JSON.parse(first) as EpisodeHeader;
    return parsed.v === 1 && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Возвращает каталог эпизодов в согласованное состояние после убийства
 * процесса: файл, у которого нет строки узла, получает её обратно из
 * собственной шапки. Данные при этом не восстанавливаются «примерно» — шапка
 * записана той же транзакцией записи файла и содержит всё, что было известно
 * на момент записи.
 *
 * Нечитаемый файл НЕ удаляется: непонятный файл в каталоге данных — повод
 * посмотреть на него человеку, а не повод стереть.
 */
export function reconcileEpisodes(mycDir: string, handle: StoreHandle): ReconcileResult {
  const dir = join(mycDir, EPISODES_DIR);
  if (!existsSync(dir)) return { adopted: [], unreadable: 0 };
  const adopted: string[] = [];
  let unreadable = 0;
  let files: { name: string; mtime: number }[];
  try {
    files = readdirSync(dir)
      .filter((n) => !n.startsWith("."))
      .map((name) => {
        try {
          return { name, mtime: statSync(join(dir, name)).mtimeMs };
        } catch {
          return { name, mtime: 0 };
        }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, RECONCILE_SCAN);
  } catch {
    return { adopted: [], unreadable: 0 };
  }

  for (const { name } of files) {
    const id = name.split(".")[0];
    if (id === undefined || id.length === 0) continue;
    try {
      if (handle.store.getNode(id, true) !== undefined) continue;
    } catch {
      continue;
    }
    const path = join(dir, name);
    const header = readHeader(path);
    if (header === null || header.id !== id) {
      unreadable++;
      continue;
    }
    try {
      handle.store.createNode({
        id,
        kind: "session",
        layer: 0,
        acl: "private",
        scope: handle.scope,
        title: `эпизод ${id} · ${header.reason} · ${header.agent}`,
        actor: handle.actor,
        attrs: {
          reason: header.reason,
          agent: header.agent,
          raw_bytes: header.raw_bytes,
          secrets_masked: header.secrets_masked,
          episode_path: `${EPISODES_DIR}/${name}`,
          episode_bytes: statSync(path).size,
          compression: name.endsWith(".zst") ? "zstd" : "none",
          // Строка восстановлена после обрыва, а не записана хуком. Это видно
          // запросом — молчаливого «как будто так и было» здесь не будет (И2).
          adopted: true,
        },
      });
      adopted.push(id);
    } catch {
      unreadable++;
    }
  }
  return { adopted, unreadable };
}
