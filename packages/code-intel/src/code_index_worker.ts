/**
 * Воркер пула разбора для code_index (см. ./code_index.ts).
 *
 * Пул заводится только на большом батче (≥ PARSE_POOL_MIN_FILES работ):
 * полный индекс репозитория — это сотни миллисекунд чистого разбора, и они
 * честно делятся по ядрам. Пул живёт внутри одного drainCodeIndex и гаснет
 * вместе с ним — это НЕ демон (решение S8), постоянного процесса нет.
 */

import { loadLang, type Def, type LangId } from "./symbols.ts";
import { listDefsAndRefs, type Ref } from "./refs.ts";

/**
 * КАТАЛОГИ WASM ВОРКЕР НЕ ИЩЕТ — их выставляет главный поток (`ParsePool`).
 *
 * Не осторожность, а единственное, что здесь работает. `Bun.resolveSync` за
 * границей потока опирается на путь модуля, а модуль этого воркера в собранном
 * бинаре лежит в bunfs: node_modules рядом нет и быть не может. На сборочной
 * машине резолвер иногда всё-таки попадает в чужой node_modules по путям,
 * впечённым в бандл, — и именно это делало поломку невидимой в тестах: у себя
 * работает, у скачавшего бинарь нет.
 *
 * Поэтому отсутствие переменных — отказ СРАЗУ и с именем причины, а не тихий
 * поиск, который на одной машине найдёт, а на другой развалится стеком
 * резолвера. Бросок на загрузке модуля доходит до `onerror` пула, а тот
 * превращает его в отказ команды.
 */
const runtimeDir = process.env.MYC_TREE_SITTER_DIR;
const grammarDir = process.env.MYC_TREE_SITTER_GRAMMAR_DIR;
if (
  runtimeDir === undefined ||
  runtimeDir === "" ||
  grammarDir === undefined ||
  grammarDir === ""
) {
  throw new Error(
    "parse worker started without tree-sitter directories: MYC_TREE_SITTER_DIR and " +
      "MYC_TREE_SITTER_GRAMMAR_DIR are set by the main thread (ParsePool). There is nothing " +
      "to look them up with here — node_modules does not exist across the thread boundary",
  );
}

interface ParseRequest {
  readonly id: number;
  readonly source: string;
  readonly lang: LangId;
}

/**
 * Ответ воркера. Определения и ссылки едут ВМЕСТЕ и разбираются за один
 * проход дерева: посылать файл дважды ради второго ответа значило бы
 * построить дерево дважды, а построение дерева и есть вся цена разбора.
 */
interface ParseReply {
  readonly id: number;
  readonly defs?: Def[];
  readonly refs?: Ref[];
  readonly error?: string;
}

// bun-types в этой конфигурации не объявляет self; в воркере Bun это тот же
// globalThis с onmessage/postMessage.
const ctx = globalThis as unknown as {
  onmessage: ((e: MessageEvent<ParseRequest>) => void) | null;
  postMessage: (msg: ParseReply) => void;
};

/**
 * ГРАММАТИКА ГРУЗИТСЯ ОДИН РАЗ НА ВОРКЕР И ЖИВЁТ В ПАМЯТИ.
 *
 * Разбор синхронен, а `.wasm` грузится промисом — стык лёг сюда. Первый
 * файл каждого языка ждёт загрузку (Parser.init ~7 мс + грамматика ~4 мс);
 * `loadLang` идемпотентна и отдаёт один промис на все параллельные вызовы,
 * поэтому остальные файлы того же языка встают за тем же ожиданием, а не
 * заводят второе. Пул живёт весь большой прогон (сотни файлов), так что эти
 * 11 мс платятся один раз на воркер, а не на файл.
 *
 * Обработчик асинхронный намеренно: `postMessage` не обязан случиться в том
 * же такте, а порядок ответов пулу не важен — он сводит их по `id`.
 */
ctx.onmessage = (e: MessageEvent<ParseRequest>) => {
  const { id, source, lang } = e.data;
  void (async () => {
    try {
      await loadLang(lang);
      const { defs, refs } = listDefsAndRefs(source, lang);
      ctx.postMessage({ id, defs, refs });
    } catch (err) {
      ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};
