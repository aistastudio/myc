/**
 * Экспорт "onnxruntime-web/wasm" в exports map пакета запрещён для
 * node-условия ("node": null), поэтому у него нет типов из package.json.
 * Рантайм-резолвинг даёт tsconfig paths (Bun уважает их и в рантайме),
 * типы — это объявление: тождественно корневым типам onnxruntime-web.
 */
declare module "onnxruntime-web/wasm" {
  export * from "onnxruntime-web";
}
