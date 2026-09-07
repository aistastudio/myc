/**
 * Текстовые импорты ассетов интерфейса: `with { type: "text" }` вшивает
 * содержимое файла строкой прямо в модуль — и в рантайме Bun, и при
 * `bun build --compile`. Про .html/.css tsc сам ничего не знает, отсюда
 * и объявления.
 */
declare module "*.css" {
  const text: string;
  export default text;
}
