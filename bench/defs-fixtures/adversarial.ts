// ОСНАСТКА ЗАМЕРА, а не рабочий код. Файл нарочно составлен из конструкций,
// на которых ломается текстовый разбор: скобка в строке, вложенный шаблон с
// ${...}, скобка в регулярном литерале и в комментарии, дженерик со скобками в
// позиции типа, деструктуризация с умолчаниями, вычисляемое имя метода,
// перегрузки, многострочное объединение типов, стрелка в const.
//
// Зачем: корпус, набранный из настоящих репозиториев, состоит из ТИПИЧНОГО кода
// и потому не содержит атипичного. Замер на нём дал 100.0%/100.0% — и это была
// правда о том, что измерено, но не о покрытии. На этом файле нашлись два
// расхождения с graft: пропущенный метод с вычисляемым именем и перегрузки,
// отданные как отдельные определения. Оснастка держит находку измеримой.
//
// Эталон graft skeleton на 2026-09-05 — 14 определений:
//   L2-L5 function braceInString, L8-L10 nestedTemplate, L13-L15 regexBrace,
//   L18-L21 commentBrace, L24-L26 generic, L29-L31 destructured,
//   L35-L43 class Tricky, L37-L39 method [KEY], L40-L42 method make,
//   L48-L50 function over, L53-L55 type Wide, L57-L59 interface Shape,
//   L61-L64 enum Color, L67-L70 function arrow.

// Ловушка 1: скобка в обычной строке
export function braceInString(): string {
  const s = "не закрывающая } скобка";
  return s;
}

// Ловушка 2: вложенный шаблон с ${} и скобками внутри
export function nestedTemplate(x: number): string {
  return `a${x > 0 ? `{вложено ${x}}` : "}"}b`;
}

// Ловушка 3: скобка в регулярном литерале
export function regexBrace(s: string): boolean {
  return /^\{.*\}$/.test(s) && !/}/.test(s.slice(1));
}

// Ловушка 4: скобка в комментарии } и в блочном /* } */
export function commentBrace(): number {
  /* здесь } одна */
  return 1; // и здесь }
}

// Ловушка 5: дженерик со стрелкой в позиции типа
export function generic<T extends { a: number }>(v: T): (x: T) => T {
  return (x) => x;
}

// Ловушка 6: деструктуризация с умолчанием
export function destructured({ a = 1, b = { c: 2 } }: { a?: number; b?: { c: number } }): number {
  return a + b.c;
}

// Ловушка 7: класс с вычисляемым именем метода и приватным полем
const KEY = "dyn";
export class Tricky {
  #hidden = "}";
  [KEY](): string {
    return this.#hidden;
  }
  static make(): Tricky {
    return new Tricky();
  }
}

// Ловушка 8: перегрузки
export function over(a: string): string;
export function over(a: number): number;
export function over(a: unknown): unknown {
  return a;
}

// Ловушка 9: тип-объединение через несколько строк
export type Wide =
  | { kind: "a"; v: number }
  | { kind: "b"; v: string };

export interface Shape {
  area(): number;
}

export enum Color {
  Red = "}",
  Blue = "{",
}

// Ловушка 10: стрелка, присвоенная const, с телом в скобках
export const arrow = (n: number): number => {
  const t = `${n}`;
  return t.length;
};
