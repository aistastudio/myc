/**
 * `trackWrites` в одном процессе, на поддельном потоке (memory-vzst83nfmp3q).
 *
 * Многопроцессный guard (`stdout-drain.multiprocess.test.ts`) проверяет то,
 * что делает Bun 1.3.14: колбэк приходит на КАЖДУЮ запись, в том числе после
 * EPIPE, а события `error` у stdout он не шлёт вовсе. Две страховки
 * `trackWrites` — «колбэк с ошибкой ломает поток» и слушатель `error` — на
 * таком рантайме не видны: мутации, снимающие их, guard проходят. Здесь они
 * проверяются там, где их можно вызвать: поток, который после EPIPE колбэков
 * больше не зовёт, и поток, который шлёт `error` (так делает Node).
 *
 * МУТАЦИИ: убрать `if (err) broken = true` — краснеет «после EPIPE не ждём
 * колбэков»; убрать слушатель `error` — краснеет «событие error».
 */

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { trackWrites } from "./index.ts";

type Cb = (err?: Error | null) => void;

/** Поток, колбэки которого отпускает тест. */
class FakeStream extends EventEmitter {
  readonly calls: Array<{ chunk: unknown; encoding: unknown; cb: Cb | undefined }> = [];
  write(chunk: unknown, encoding?: unknown, cb?: Cb): boolean {
    this.calls.push({ chunk, encoding, cb });
    return false;
  }
}

function tracked(): { fake: FakeStream; stream: NodeJS.WriteStream; settled: () => Promise<void> } {
  const fake = new FakeStream();
  const stream = fake as unknown as NodeJS.WriteStream;
  return { fake, stream, settled: trackWrites(stream) };
}

/** Резолвится ли промис за один оборот цикла. */
async function resolvesNow(p: Promise<void>): Promise<boolean> {
  return Promise.race([p.then(() => true), Bun.sleep(20).then(() => false)]);
}

describe("trackWrites", () => {
  test("ждёт колбэк каждой непустой записи и отпускает после последнего", async () => {
    const { fake, stream, settled } = tracked();
    stream.write("a");
    stream.write(new Uint8Array([1, 2]));
    expect(await resolvesNow(settled())).toBe(false);
    fake.calls[0]!.cb!();
    expect(await resolvesNow(settled())).toBe(false);
    fake.calls[1]!.cb!();
    expect(await resolvesNow(settled())).toBe(true);
  });

  test("пустая запись не считается: Bun подтверждает её сразу", async () => {
    const { stream, settled } = tracked();
    stream.write("");
    expect(await resolvesNow(settled())).toBe(true);
  });

  test("колбэк и кодировка вызывающего доходят до потока", async () => {
    const { fake, stream } = tracked();
    const seen: Array<Error | null | undefined> = [];
    stream.write("x", "utf8", (e) => seen.push(e));
    expect(fake.calls[0]!.encoding).toBe("utf8");
    fake.calls[0]!.cb!(null);
    expect(seen).toEqual([null]);
  });

  test("после EPIPE колбэков остальных записей не ждём", async () => {
    const { fake, stream, settled } = tracked();
    stream.write("a");
    stream.write("b"); // её колбэк поток после EPIPE не позовёт никогда
    fake.calls[0]!.cb!(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(await resolvesNow(settled())).toBe(true);
    // И новые записи после поломки ожидания не добавляют.
    stream.write("c");
    expect(await resolvesNow(settled())).toBe(true);
  });

  test("событие error отпускает ожидание и не становится необработанной ошибкой", async () => {
    const { fake, stream, settled } = tracked();
    stream.write("a");
    const waiting = settled();
    fake.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(await resolvesNow(waiting)).toBe(true);
  });
});
