/**
 * Воркер пула разбора для code_index (см. ./code_index.ts).
 *
 * Пул заводится только на большом батче (≥ PARSE_POOL_MIN_FILES работ):
 * полный индекс репозитория — это сотни миллисекунд чистого listDefs, и они
 * честно делятся по ядрам. Пул живёт внутри одного drainCodeIndex и гаснет
 * вместе с ним — это НЕ демон (решение S8), постоянного процесса нет.
 */

import { listDefs, loadLang, type Def, type LangId } from "./symbols.ts";

interface ParseRequest {
  readonly id: number;
  readonly source: string;
  readonly lang: LangId;
}

interface ParseReply {
  readonly id: number;
  readonly defs?: Def[];
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
 * `listDefs` синхронна, а `.wasm` грузится промисом — стык лёг сюда. Первый
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
      ctx.postMessage({ id, defs: listDefs(source, lang) });
    } catch (err) {
      ctx.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
    }
  })();
};
