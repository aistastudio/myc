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

import { L1_LANGS_LABEL } from "@myc/code-intel/langs";
import { ExitCode } from "../exit.ts";
import type { FlagSpec } from "../flags.ts";
import type { Command, CommandFailure } from "../registry.ts";
import { flagStr, realStoreDeps, type StoreDeps } from "./store.ts";
import { codeTarget, count, noIndexFailure, type SourceData, sourceData, sourceLines, warnWorktree } from "./code.ts";

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
  source?: SourceData;
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
      `is reported, not smoothed over. Only L1 languages (${L1_LANGS_LABEL}) have declarations; a ` +
      "file registered at L0 has a row in the index and no symbols, and says so. The body of an " +
      "interface or object type alias is NOT printed — a skeleton is signatures, and the span is " +
      "right there for whoever needs the fields.",
    flags: FLAGS,
    handler: async (ctx) => {
      const t0 = performance.now();
      const raw = ctx.args[0];
      if (raw === undefined || raw.trim().length === 0) {
        return failure("usage.invalid", "usage: myc skeleton <path>", ExitCode.USAGE);
      }
      const opened = await deps.openStore(ctx);
      if (!opened.ok) return opened.failure;
      const h = opened.handle;
      try {
        const t = await codeTarget(h, flagStr(ctx, "repo"), ctx.globals.directory ?? process.cwd());
        const { repoId, view } = t;
        const { fileSkeleton, indexScope } = await import("@myc/code-intel/read");
        const db = h.driver.database;
        const scope = indexScope(db, view);
        if (t.missing || scope.files === 0) {
          return await noIndexFailure(
            h,
            t,
            "nowhere to take a skeleton from",
            "the code index of this repo (workspace root) is not built: code_files has zero rows — nowhere to take a skeleton from",
          );
        }
        warnWorktree(ctx, t, "signatures are read from the copy whose content the index saw");

        // Путь принимается и как относительный от корня репозитория, и как
        // тот, что человек скопировал из вывода другой команды. Нормализация
        // одна: срезать ведущий "./" и разделители Windows.
        const path = raw.trim().replace(/^\.\//, "").replaceAll("\\", "/");
        const known = db
          .query("SELECT lang FROM code_files WHERE repo_id = ?1 AND path = ?2")
          .get(view.repoId, view.prefix + path) as { lang: string } | null;
        if (known === null) {
          return failure(
            "notfound.file",
            `file ${path} is not in this repo's index: scanned ${count(scope.files, "file")}`,
            ExitCode.NOTFOUND,
            "the path is relative to the repo root; the index may be behind: myc code index",
          );
        }

        // Сигнатуры — из файла, спаны — из индекса, и сверка их хешей — то,
        // что держит скелет честным. Из git worktree сначала читается его
        // копия (то, что правит агент); разошлась она с индексом, а основная
        // копия с ним совпадает — показывается ОСНОВНАЯ, и это называется:
        // сигнатуры, нарезанные по чужим спанам из файла ветки, — мусор,
        // а скелет основной копии — правда, пусть и про другую ветку.
        let sk = fileSkeleton(db, view, path, t.fileRoot, t.fallbackRoot);
        let readFrom = t.fileRoot;
        if (sk.stale && t.fallbackRoot !== undefined) {
          const main = fileSkeleton(db, view, path, t.fallbackRoot);
          if (main.onDisk && !main.stale) {
            sk = main;
            readFrom = t.fallbackRoot;
            ctx.warn(
              "skeleton.main_copy",
              `your worktree copy of ${path} differs from what the index saw — shown: the declarations and ` +
                `signatures of the MAIN copy ${t.fallbackRoot}, not of your file`,
            );
          }
        }
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
        const origin = sourceData(t, readFrom);
        if (origin !== undefined) data.source = origin;

        if (!sk.onDisk) {
          ctx.warn(
            "skeleton.gone",
            `file ${path} is in the index but not on disk — no signatures, spans come from the index`,
          );
        } else if (sk.stale) {
          ctx.warn(
            "skeleton.stale",
            `the content of ${path} differs from the index: spans and signatures may point to the wrong place`,
          );
        }
        if (sk.entries.length === 0) {
          ctx.warn(
            "skeleton.no_defs",
            `no declarations found in ${path} (${sk.lang}): ` +
              "either an L0 language (the index holds only path and hash) or the file really is empty",
          );
        }
        return { ok: true, data, meta: { took_ms: data.took_ms, count: data.entries.length } };
      } finally {
        h.close();
      }
    },
    renderHuman: (data) => {
      const d = data as SkeletonData;
      const out: string[] = [`${d.path}  ${d.lang}  ${count(d.file_lines, "line")}, ${d.file_bytes} B`];
      for (const e of d.entries) {
        const pad = "  ".repeat(e.nesting);
        const span = `${e.span_start}-${e.span_end}`.padEnd(11);
        out.push(
          `${span} ${pad}${e.exported ? "+" : " "} ${e.signature.length > 0 ? e.signature : `${e.kind} ${e.name}`}`,
        );
      }
      if (d.entries.length === 0) out.push("no declarations");
      if (d.hidden > 0) out.push(`hidden by filter: ${d.hidden}`);
      if (d.stale) out.push("WARNING: the file changed after indexing — spans may not match");
      out.push(
        `skeleton ${d.skeleton_bytes} B vs file ${d.file_bytes} B` +
          `${d.cheaper > 0 ? ` — ${d.cheaper}× cheaper` : ""}  ${d.took_ms} ms`,
      );
      out.push(...sourceLines(d.source));
      return `${out.join("\n")}\n`;
    },
  };
}
