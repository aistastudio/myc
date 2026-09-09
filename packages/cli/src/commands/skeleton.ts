/**
 * `myc skeleton <файл>` — API файла вместо файла (memory-wrntvzwx8dh0).
 *
 * ЗАЧЕМ. Агент, которому нужно понять, ЧТО файл предлагает наружу, читает его
 * целиком — и платит контекстом за тела функций, комментарии и импорты,
 * которых не спрашивал. `read.ts` весит 15 КБ; его API — 16 объявлений,
 * которые помещаются в килобайт. Разница здесь не в удобстве, а в бюджете
 * окна: один файл — это единицы процентов контекста, десять файлов — уже
 * половина.
 *
 * ЭКОНОМИЯ ПЕЧАТАЕТСЯ, А НЕ ОБЕЩАЕТСЯ. Команда, чей смысл — «дешевле», обязана
 * называть, во сколько раз именно на ЭТОМ файле: «в 12 раз» и «в 1.2 раза» —
 * это разные решения читателя, и подменять их словом «дёшево» нельзя. Поэтому
 * в выдаче стоят байты файла, байты скелета и их отношение, а в `--json` —
 * оба числа сырыми.
 *
 * СИГНАТУРЫ ИЗ ИСХОДНИКА, СПАНЫ ИЗ ИНДЕКСА, И ИХ РАСХОЖДЕНИЕ НАЗЫВАЕТСЯ.
 * `code_defs` знает имя, вид и границы; текста сигнатуры там нет и не будет —
 * хранить его значило бы держать вторую копию исходника, устаревающую молча.
 * Поэтому файл читается (одно чтение), а его хеш сверяется с тем, что записал
 * индекс: разошлись — в ответе стоит WARN, а не молчаливо съехавшие строки.
 *
 * ВЛОЖЕННОСТЬ ПОКАЗАНА СДВИГОМ. Плоский список из 40 имён не отличает метод
 * класса от функции модуля; `graft skeleton` именно так и печатает. Спаны
 * вложены — значит вложенность известна бесплатно, и класс в выдаче выглядит
 * классом.
 */

import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandFailure } from "../registry.ts";
import { flagStr, realStoreDeps, type StoreDeps } from "./store.ts";
import { codeRepo } from "./code.ts";

function failure(code: string, msg: string, exit: ExitCode, hint?: string): CommandFailure {
  return { ok: false, code, msg, exit, hint };
}

const FLAGS: readonly FlagSpec[] = [
  { name: "repo", value: "string", description: "repo id (default: derived from cwd)" },
  { name: "kind", value: "string", description: "keep only these kinds, comma-separated" },
  { name: "exported", description: "only exported declarations — the API as others see it" },
];

interface SkeletonData {
  repo: string;
  path: string;
  lang: string;
  entries: {
    name: string;
    kind: string;
    span_start: number;
    span_end: number;
    exported: boolean;
    nesting: number;
    signature: string;
  }[];
  /** Отфильтровано флагами из общего числа объявлений файла. */
  hidden: number;
  file_bytes: number;
  file_lines: number;
  skeleton_bytes: number;
  /** Во сколько раз скелет дешевле файла по байтам; 0 — файла на диске нет. */
  cheaper: number;
  on_disk: boolean;
  stale: boolean;
  took_ms: number;
}

export function createSkeletonCommand(deps: StoreDeps = realStoreDeps): Command {
  return {
    name: "skeleton",
    summary: "the API of one file: every declaration, its signature and span, in a fraction of the bytes",
    help:
      "Reads code_defs built by `myc code index` and the file itself, and prints one line per " +
      "declaration: nesting, kind, span and the signature cut at the start of the body. Answers " +
      "'what does this file offer' without spending the context of reading it, and says by how " +
      "much: file bytes, skeleton bytes and their ratio are in the output. Spans come from the " +
      "index, signatures from disk — if the two disagree (the file changed after indexing) that " +
      "is reported, not smoothed over. Only L1 languages (ts/tsx/js/jsx/py) have declarations; a " +
      "file registered at L0 has a row in the index and no symbols, and says so. The body of an " +
      "interface or object type alias is NOT printed — a skeleton is signatures, and the span is " +
      "right there for whoever needs the fields.",
    flags: FLAGS,
    handler: async (ctx) => {
      const t0 = performance.now();
      const raw = ctx.args[0];
      if (raw === undefined || raw.trim().length === 0) {
        return failure("usage.invalid", "нужно: myc skeleton <path>", ExitCode.USAGE);
      }
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const { repoId, repoRoot } = await codeRepo(h, flagStr(ctx, "repo"));
        const { fileSkeleton, indexScope } = await import("@myc/code-intel/read");
        const db = h.driver.database;
        const scope = indexScope(db, repoId);
        if (scope.files === 0) {
          return failure(
            "precond.no_index",
            `код-индекс этого репозитория (${repoId.length > 0 ? repoId : "корень воркспейса"}) не построен: ` +
              "в code_files ноль строк — скелет брать неоткуда",
            ExitCode.PRECOND,
            "myc code index",
          );
        }

        // Путь принимается и как относительный от корня репозитория, и как
        // тот, что человек скопировал из вывода другой команды. Нормализация
        // одна: срезать ведущий "./" и разделители Windows.
        const path = raw.trim().replace(/^\.\//, "").replaceAll("\\", "/");
        const known = db
          .query("SELECT lang FROM code_files WHERE repo_id = ?1 AND path = ?2")
          .get(repoId, path) as { lang: string } | null;
        if (known === null) {
          return failure(
            "notfound.file",
            `файла ${path} нет в индексе этого репозитория: просмотрено ${scope.files} файлов`,
            ExitCode.NOTFOUND,
            "путь относительный от корня репозитория; индекс мог отстать: myc code index",
          );
        }

        const sk = fileSkeleton(db, repoId, path, repoRoot);
        const kindsRaw = flagStr(ctx, "kind");
        const want =
          kindsRaw === undefined || kindsRaw.trim().length === 0
            ? null
            : new Set(
                kindsRaw
                  .split(",")
                  .map((s) => s.trim().toLowerCase())
                  .filter((s) => s.length > 0),
              );
        const onlyExported = ctx.flags["exported"] === true;
        const kept = sk.entries.filter(
          (e) => (want === null || want.has(e.kind)) && (!onlyExported || e.exported),
        );

        const data: SkeletonData = {
          repo: repoId,
          path: sk.path,
          lang: sk.lang,
          entries: kept.map((e) => ({
            name: e.name,
            kind: e.kind,
            span_start: e.spanStart,
            span_end: e.spanEnd,
            exported: e.exported,
            nesting: e.nesting,
            signature: e.signature,
          })),
          hidden: sk.entries.length - kept.length,
          file_bytes: sk.fileBytes,
          file_lines: sk.fileLines,
          skeleton_bytes: sk.skeletonBytes,
          cheaper:
            sk.skeletonBytes > 0 ? Math.round((sk.fileBytes / sk.skeletonBytes) * 10) / 10 : 0,
          on_disk: sk.onDisk,
          stale: sk.stale,
          took_ms: 0,
        };
        data.took_ms = Math.round(performance.now() - t0);

        if (!sk.onDisk) {
          ctx.warn(
            "skeleton.gone",
            `файл ${path} есть в индексе, но не на диске — сигнатур не будет, спаны из индекса`,
          );
        } else if (sk.stale) {
          ctx.warn(
            "skeleton.stale",
            `содержимое ${path} разошлось с индексом: спаны и сигнатуры могут указывать не туда`,
          );
        }
        if (sk.entries.length === 0) {
          ctx.warn(
            "skeleton.no_defs",
            `в ${path} (${sk.lang}) объявлений не найдено: ` +
              "либо язык уровня L0 (в индексе только путь и хеш), либо файл действительно пуст",
          );
        }
        return { ok: true, data, meta: { took_ms: data.took_ms, count: data.entries.length } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as SkeletonData;
      const out: string[] = [`${d.path}  ${d.lang}  ${d.file_lines} строк, ${d.file_bytes} Б`];
      for (const e of d.entries) {
        const pad = "  ".repeat(e.nesting);
        const span = `${e.span_start}-${e.span_end}`.padEnd(11);
        out.push(
          `${span} ${pad}${e.exported ? "+" : " "} ${e.signature.length > 0 ? e.signature : `${e.kind} ${e.name}`}`,
        );
      }
      if (d.entries.length === 0) out.push("объявлений нет");
      if (d.hidden > 0) out.push(`скрыто фильтром: ${d.hidden}`);
      if (d.stale) out.push("ВНИМАНИЕ: файл изменился после индексации — спаны могут не совпадать");
      out.push(
        `скелет ${d.skeleton_bytes} Б против ${d.file_bytes} Б файла` +
          `${d.cheaper > 0 ? ` — дешевле в ${d.cheaper}×` : ""}  ${d.took_ms} мс`,
      );
      return `${out.join("\n")}\n`;
    },
  };
}
