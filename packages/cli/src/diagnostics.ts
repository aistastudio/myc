/**
 * Единственный источник деградации: собирается один раз в обработчике команды,
 * отрисовывается дважды — строкой `WARN` в человеческом выводе и `warn[]` +
 * `meta.degraded[]` в конверте `--json`. Молчаливой деградации не бывает.
 */
export type Diagnostic = { code: string; msg: string };

export class Diagnostics {
  #items: Diagnostic[] = [];

  add(code: string, msg: string): void {
    this.#items.push({ code, msg });
  }

  get items(): readonly Diagnostic[] {
    return this.#items;
  }

  get codes(): string[] {
    return this.#items.map((d) => d.code);
  }

  get size(): number {
    return this.#items.length;
  }
}
