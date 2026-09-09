/**
 * Лексер ts/js: маска «это код, а не строка/комментарий/шаблон/регексп».
 *
 * ПЕРЕЕХАЛ СЮДА ИЗ `defs.ts` БЕЗ ЕДИНОЙ ПРАВКИ ТЕЛА. `defs.ts` был
 * регекспным разбором определений и удалён вместе с переходом на tree-sitter
 * (memory-hrsae2f1mf7a); лексер к разбору символов отношения не имеет — его
 * единственный потребитель `anchors.ts` нормализует им крукс якоря, и делает
 * это на любом языке из `NORMALIZABLE_LANGS`, а не на разобранном дереве.
 * Задача прямо требовала `classifyCode` не трогать: якоря работают именно
 * потому, что не зависят от разбора символов. Поэтому здесь ровно тот же код,
 * только в своём файле.
 */

/** Мутации замера: ослабляют лексер, чтобы стало видно, что он считает. */
export interface LexOptions {
  /** Строковые литералы разбираются как код — скобки внутри строк учитываются. */
  readonly ignoreStrings?: boolean;
  /** Текст шаблона не отличается от `${}` — скобки в тексте учитываются. */
  readonly ignoreTemplateExprs?: boolean;
}

const REGEX_PRECEDING_WORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

export const MASK_CODE = 1;

export interface Mask {
  readonly code: Uint8Array;
  readonly lineFirstCode: Int32Array;
  readonly lineStarts: Int32Array;
}

function regexAllowedBefore(code: Uint8Array, src: string, at: number): boolean {
  let i = at - 1;
  while (i >= 0) {
    const ch = src[i]!;
    if (ch === "`" || ch === '"' || ch === "'") return false;
    if (code[i] !== MASK_CODE || ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i--;
      continue;
    }
    if (/[A-Za-z0-9_$)]/i.test(ch) || ch === "]") {
      const wordEnd = i + 1;
      let wordStart = i;
      while (wordStart > 0 && /[A-Za-z0-9_$]/.test(src[wordStart - 1]!)) wordStart--;
      return REGEX_PRECEDING_WORDS.has(src.slice(wordStart, wordEnd));
    }
    if (ch === "}") return src.slice(i + 1, at).includes("\n");
    if (ch === ">") return src[i - 1] === "=";
    if (ch === "<") return false;
    return !(ch === "+" || ch === "-" || ch === "*" || ch === "%" || ch === ")");
  }
  return true;
}

export function classifyCode(source: string, opts: LexOptions = {}): Mask {
  return classify(source, opts);
}

function classify(source: string, opts: LexOptions): Mask {
  const n = source.length;
  const code = new Uint8Array(n);
  const lineFirst: number[] = [];
  const lineStartsArr: number[] = [0];
  let currentLine = 0;

  const markCode = (i: number): void => {
    code[i] = MASK_CODE;
    if (lineFirst.length === currentLine && source[i] !== " " && source[i] !== "\t") {
      lineFirst.push(i);
    }
  };

  type Frame = { kind: "base" } | { kind: "tmplText" } | { kind: "tmplExpr"; braceDepth: number };
  const stack: Frame[] = [{ kind: "base" }];
  const current = (): Frame => stack[stack.length - 1]!;

  let i = 0;
  while (i < n) {
    const ch = source[i]!;
    const frame = current();

    if (ch === "\n") {
      if (lineFirst.length === currentLine) lineFirst.push(-1);
      currentLine++;
      lineStartsArr.push(i + 1);
      i++;
      continue;
    }

    if (frame.kind === "tmplText") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.pop();
        i++;
        continue;
      }
      if (ch === "$" && source[i + 1] === "{") {
        markCode(i);
        markCode(i + 1);
        stack.push({ kind: "tmplExpr", braceDepth: 0 });
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (ch === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") {
          if (lineFirst.length === currentLine) lineFirst.push(-1);
          currentLine++;
          lineStartsArr.push(i + 1);
        }
        i++;
      }
      if (i < n) i += 2;
      continue;
    }

    if ((ch === '"' || ch === "'") && !opts.ignoreStrings) {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = source[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          break;
        }
        if (c === "\n") break;
        j++;
      }
      if (closed) {
        i = j + 1;
        continue;
      }
      markCode(i);
      i++;
      continue;
    }

    if (ch === "`" && !opts.ignoreTemplateExprs) {
      stack.push({ kind: "tmplText" });
      i++;
      continue;
    }

    if (ch === "/" && regexAllowedBefore(code, source, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = source[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          closed = true;
          break;
        }
        j++;
      }
      if (closed) {
        j++;
        while (j < n && /[A-Za-z]/.test(source[j]!)) j++;
        i = j;
        continue;
      }
      markCode(i);
      i++;
      continue;
    }

    if (ch === "{" ) {
      if (frame.kind === "tmplExpr") frame.braceDepth++;
      markCode(i);
      i++;
      continue;
    }
    if (ch === "}") {
      if (frame.kind === "tmplExpr" && frame.braceDepth === 0) stack.pop();
      else if (frame.kind === "tmplExpr") frame.braceDepth--;
      markCode(i);
      i++;
      continue;
    }

    markCode(i);
    i++;
  }
  if (lineFirst.length === currentLine) lineFirst.push(-1);

  return {
    code,
    lineFirstCode: Int32Array.from(lineFirst),
    lineStarts: Int32Array.from(lineStartsArr),
  };
}
