/**
 * Один процесс, открывающий стор ТАК ЖЕ, КАК ЕГО ОТКРЫВАЕТ MCP-СЕРВЕР, — и
 * ничего больше. Нужен ровно для гонки первого открытия
 * (store.vector.test.ts, memory-dm7p05hyskv9): она живёт МЕЖДУ процессами, и
 * внутрипроцессная имитация её не воспроизводит.
 *
 * Второй аргумент — МОМЕНТ СТАРТА (epoch ms), общий для всех процессов.
 * Без него гонки не выходит: `Bun.spawn` запускает процессы по очереди, и
 * пока двенадцатый поднимается, первый успевает накатить набор — окно
 * закрывается само, и тест зеленеет при любой реализации. С общим моментом
 * все двенадцать доходят до открытия одновременно.
 *
 * Вывод — одна строка в stderr при отказе, код выхода 1. Печатать в stdout
 * нельзя: на этой поверхности stdout занят JSON-RPC.
 */
import { openMcpStore } from "./store.ts";

const dir = process.argv[2];
const startAt = Number(process.argv[3] ?? "0");
if (dir === undefined) {
  process.stderr.write("usage: store.vector.worker.ts <dir> [start-at-epoch-ms]\n");
  process.exit(2);
}
while (Date.now() < startAt) {
  // Активное ожидание, а не setTimeout: разброс пробуждения таймера здесь
  // того же порядка, что и само окно гонки.
}
const opened = await openMcpStore(dir, { extensions: true });
if (!opened.ok) {
  process.stderr.write(`${opened.failure.code}: ${opened.failure.msg}\n`);
  process.exit(1);
}
opened.handle.close();
process.exit(0);
