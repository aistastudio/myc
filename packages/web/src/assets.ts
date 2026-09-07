/// <reference path="./shims.d.ts" />
/**
 * Ассеты интерфейса.
 *
 * `with { type: "text" }` вшивает исходники прямо в модуль на этапе сборки —
 * значит, и в `bun build --compile` бинарь: `myc viz` работает в самолёте и в
 * закрытом контуре, ни одного сетевого запроса наружу страница не делает.
 * Проверено: после компиляции бинарь отдаёт страницу при удалённых исходниках.
 *
 * Клиентский TypeScript снимается с типов встроенным в Bun транспайлером —
 * он часть рантайма, а не зависимость. Бандлер не нужен: клиентские модули
 * самодостаточны, их единственный импорт — `import type`, который стирается.
 * Ровно поэтому здесь нет ни Vite, ни esbuild, ни одного `node_modules`.
 */

// Атрибут `type: "text"` меняет загрузчик, а не резолвер: и рантайм Bun, и
// бандлер `bun build --compile` подставляют сюда содержимое файла строкой,
// поэтому интерфейс уезжает внутрь бинаря целиком.
//
// tsc эти же пути резолвит по-своему: .html/.css — через shims.d.ts, а
// .ts — как настоящие модули, и клиентские файлы попадают в программу
// каждого потребителя пакета. Поэтому lib.dom для них объявлена прямо в
// client/app.ts тройным слешем, а не в tsconfig: браузерная библиотека
// приезжает вместе с браузерным файлом, куда бы его ни втянули.
import indexHtmlRaw from "./client/index.html" with { type: "text" };
import appCssRaw from "./client/app.css" with { type: "text" };
// @ts-expect-error — текстовый импорт: tsc видит модуль без default-экспорта
import appTsRaw from "./client/app.ts" with { type: "text" };
// @ts-expect-error — текстовый импорт: tsc видит модуль без default-экспорта
import workerTsRaw from "./client/layout.worker.ts" with { type: "text" };

// bun-types объявляет "*.html" как HTMLBundle (это для HTML-роутов
// Bun.serve); с атрибутом type: "text" загрузчик отдаёт строку.
const indexHtml = indexHtmlRaw as unknown as string;
const appCss = appCssRaw as unknown as string;
const appTs = appTsRaw as string;
const workerTs = workerTsRaw as string;

export interface Asset {
  readonly body: string;
  readonly type: string;
}

const JS_TYPE = "text/javascript; charset=utf-8";

let transpiled: Map<string, Asset> | undefined;

function compile(source: string): string {
  const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
  return transpiler.transformSync(source);
}

/** Транспиляция ленивая и одноразовая: ~4 мс на оба файла, дальше из кеша. */
function assets(): Map<string, Asset> {
  if (transpiled !== undefined) return transpiled;
  const map = new Map<string, Asset>();
  map.set("/", { body: indexHtml, type: "text/html; charset=utf-8" });
  map.set("/index.html", { body: indexHtml, type: "text/html; charset=utf-8" });
  map.set("/app.css", { body: appCss, type: "text/css; charset=utf-8" });
  map.set("/app.js", { body: compile(appTs), type: JS_TYPE });
  map.set("/layout.worker.js", { body: compile(workerTs), type: JS_TYPE });
  transpiled = map;
  return map;
}

export function getAsset(path: string): Asset | undefined {
  return assets().get(path);
}

export function assetPaths(): string[] {
  return [...assets().keys()];
}

/** Суммарный вес интерфейса — им же проверяется бюджет «всё внутри бинаря». */
export function assetBytes(): number {
  let total = 0;
  for (const asset of assets().values()) total += Buffer.byteLength(asset.body, "utf8");
  return total;
}
