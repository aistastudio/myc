// Заполняется задачей T3 (memory-ktr5yhk1qmw5): регулярные определения для
// ts/tsx/js/jsx и граница блока по скобкам. См. 05-code-intelligence.md §4.3.

export type LangId = "ts" | "tsx" | "js" | "jsx";

export type DefKind = "function" | "class" | "method" | "type" | "interface" | "enum";

export interface Def {
  readonly name: string;
  readonly kind: DefKind;
  readonly startLine: number;
  readonly endLine: number;
}

export interface DefsOptions {
  readonly ignoreStrings?: boolean;
  readonly ignoreTemplateExprs?: boolean;
  readonly naiveEnd?: boolean;
}

const IDENT = "[A-Za-z_$][\\w$]*";
const PREFIX = "(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?";

interface DefRule {
  readonly kind: DefKind;
  readonly constValue: boolean;
  readonly re: RegExp;
}

const rule = (kind: DefKind, constValue: boolean, body: string): DefRule => ({
  kind,
  constValue,
  re: new RegExp(`^(?:${PREFIX}${body})`),
});

const FUNCTION_BODY = `(?:async\\s+)?function\\s*\\*?\\s*(${IDENT})`;
const CLASS_BODY = `(?:abstract\\s+)?class\\s+(${IDENT})`;
const CONST_BODY = `(?:const|let|var)\\s+(${IDENT})\\s*(?::[^=\\n]+?)?=(?![=>])`;

const TS_RULES: readonly DefRule[] = [
  rule("function", false, FUNCTION_BODY),
  rule("class", false, CLASS_BODY),
  rule("function", true, CONST_BODY),
  rule("interface", false, `interface\\s+(${IDENT})`),
  rule("enum", false, `(?:const\\s+)?enum\\s+(${IDENT})`),
  rule("type", false, `type\\s+(${IDENT})\\b[^;\\n]*?=(?![=>])`),
];

const JS_RULES: readonly DefRule[] = [
  rule("function", false, FUNCTION_BODY),
  rule("class", false, CLASS_BODY),
  rule("function", true, CONST_BODY),
];

export const DEF_RULES: Record<LangId, readonly DefRule[]> = {
  ts: TS_RULES,
  tsx: TS_RULES,
  js: JS_RULES,
  jsx: JS_RULES,
};

const METHOD_RE = new RegExp(
  `^[ \\t]+(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\\s+|\\*\\s+)*` +
    `(#?${IDENT})\\s*(?:<[^<>()]*>)?\\s*` +
    `\\(((?:[^()]|\\([^()]*\\))*)\\)\\s*(?::[^;\\n{]+)?\\{`,
);

const METHOD_LOOSE_RE = new RegExp(
  `^[ \\t]+(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\\s+|\\*\\s+)*` +
    `(#?${IDENT})\\s*(?:<[^<>()]*>)?\\s*\\([^)]*$`,
);

const COMPUTED_KEY = `\\[(?:${IDENT}|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')\\]`;

const METHOD_COMPUTED_RE = new RegExp(
  `^[ \\t]+(?:(?:public|private|protected|static|readonly|abstract|override|async|get|set)\\s+|\\*\\s+)*` +
    `(${COMPUTED_KEY})\\s*(?:<[^<>()]*>)?\\s*` +
    `\\(((?:[^()]|\\([^()]*\\))*)\\)\\s*(?::[^;\\n{]+)?\\{`,
);

const METHOD_NAME_STOPWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "with",
  "function",
  "class",
  "interface",
  "enum",
  "namespace",
  "const",
  "let",
  "var",
  "return",
  "new",
  "typeof",
  "delete",
  "void",
  "in",
  "of",
  "instanceof",
  "do",
  "else",
  "try",
  "case",
  "default",
  "await",
  "yield",
  "throw",
  "import",
  "export",
]);

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

const WALK_STOP_WORDS = new Set([
  ...METHOD_NAME_STOPWORDS,
  "constructor",
  "type",
  "declare",
  "abstract",
  "static",
  "readonly",
  "public",
  "private",
  "protected",
  "get",
  "set",
  "async",
  "override",
  "satisfies",
  "namespace",
]);

const MASK_CODE = 1;

interface Mask {
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

export function classifyCode(source: string, opts: DefsOptions = {}): Mask {
  return classify(source, opts);
}

function classify(source: string, opts: DefsOptions): Mask {
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

function inExpressionPosition(mask: Mask, src: string, lineFirst: number): boolean {
  let i = lineFirst - 1;
  while (i >= 0) {
    if (mask.code[i] !== MASK_CODE || src[i] === " " || src[i] === "\t" || src[i] === "\n" || src[i] === "\r") {
      i--;
      continue;
    }
    return src[i] === "(" || src[i] === ",";
  }
  return false;
}

function lineAt(lineStarts: Int32Array, offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function balanceEnd(mask: Mask, src: string, open: number): number {
  let depth = 1;
  let i = open + 1;
  const n = src.length;
  while (i < n && depth > 0) {
    if (mask.code[i] !== MASK_CODE) {
      i++;
      continue;
    }
    const ch = src[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    i++;  }
  return Math.min(i - 1, n - 1);
}

function isFunctionValueAt(src: string, i: number): boolean {
  if (src[i] !== "f" || src.slice(i, i + 8) !== "function") return false;
  const prev = i > 0 ? src[i - 1]! : " ";
  return !/[A-Za-z0-9_$]/.test(prev);
}

function candidateIsAnnotation(mask: Mask, src: string, braceAt: number): boolean {
  let i = braceAt - 1;
  while (i >= 0) {
    if (mask.code[i] !== MASK_CODE) {
      const c = src[i]!;
      if (c === " " || c === "\t" || c === "\n" || c === "\r") {
        i--;
        continue;
      }
      return false;
    }
    const c = src[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i--;
      continue;
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let wordStart = i;
      while (wordStart > 0 && /[A-Za-z0-9_$]/.test(src[wordStart - 1]!)) wordStart--;
      const word = src.slice(wordStart, i + 1);
      return word === "extends" || word === "implements" || word === "keyof" || word === "readonly";
    }
    switch (c) {
      case "<":
      case ":":
      case "|":
      case "&":
      case "(":
      case "[":
      case ",":
      case "?":
      case "=":
        return true;
      default:
        return false;
    }
  }
  return false;
}

function endOfDef(
  mask: Mask,
  src: string,
  from: number,
  constValue: boolean,
  isMethod: boolean,
  braceAfterParen: boolean,
  defLine: Uint8Array | null,
  opts: DefsOptions,
  requiresBody: boolean = false,
): { end: number; confirmed: boolean } {
  const n = src.length;

  if (opts.naiveEnd) {
    const lineEnd = src.indexOf("\n", from);
    const stop = lineEnd === -1 ? n : lineEnd;
    for (let i = from; i < stop; i++) {
      if (src[i] === "}") return { end: i, confirmed: true };
    }
    return { end: Math.max(stop - 1, from), confirmed: true };
  }

  let paren = braceAfterParen ? 1 : 0;
  let bracket = 0;
  let valueSeen = !constValue;
  let i = from;
  while (i < n) {
    if (mask.code[i] !== MASK_CODE) {
      if (src[i] === "\n" && paren === 0 && bracket === 0 && defLine !== null) {
        const nextLine = lineAt(mask.lineStarts, i) + 1;
        if (defLine[nextLine] === 1) {
          if (constValue && !valueSeen) return { end: i, confirmed: false };
          return { end: Math.max(i - 1, from), confirmed: true };
        }
      }
      i++;
      continue;
    }
    const ch = src[i]!;
    if (paren === 0 && bracket === 0) {
      if (ch === "=" && src[i + 1] === ">" && mask.code[i + 1] === MASK_CODE) {
        valueSeen = true;
        i += 2;
        continue;
      }
      if (constValue && !valueSeen && isFunctionValueAt(src, i)) valueSeen = true;
    }
    if (ch === "(") paren++;
    else if (ch === ")") {
      paren = Math.max(paren - 1, 0);
      if (braceAfterParen && paren === 0) {
        const lineEnd = src.indexOf("\n", i);
        const stop = lineEnd === -1 ? n : lineEnd;
        let j = i + 1;
        let brace = -1;
        while (j < stop) {
          if (mask.code[j] !== MASK_CODE) {
            j++;
            continue;
          }
          if (src[j] === "{") {
            brace = j;
            break;
          }
          j++;
        }
        if (brace === -1) return { end: i, confirmed: false };
      }
    }
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket = Math.max(bracket - 1, 0);
    else if (ch === "{" && paren === 0 && bracket === 0) {
      if (constValue && !valueSeen) return { end: i, confirmed: false };
      let open = i;
      let annotation = candidateIsAnnotation(mask, src, open);
      for (;;) {
        const close = balanceEnd(mask, src, open);
        if (isMethod) {
          let k = close + 1;
          while (k < n && (src[k] === " " || src[k] === "\t" || src[k] === ">" || src[k] === "[" || src[k] === "]")) k++;
          if (src[k] === ";") return { end: close, confirmed: false };
        }
        if (!annotation) return { end: close, confirmed: true };
        let j = close + 1;
        let next = -1;
        walk: while (j < n) {
          if (mask.code[j] !== MASK_CODE) {
            const c = src[j]!;
            if (c === "\n" || c === " " || c === "\t") {
              j++;
              continue;
            }
            if (c === "/" && src[j + 1] === "/") {
              while (j < n && src[j] !== "\n") j++;
              continue;
            }
            if (c === "/" && src[j + 1] === "*") {
              const closeC = src.indexOf("*/", j + 2);
              j = closeC === -1 ? n : closeC + 2;
              continue;
            }
            if (c === '"' || c === "'" || c === "`") {
              const q = c;
              let k = j + 1;
              while (k < n && src[k] !== q && src[k] !== "\n") {
                if (src[k] === "\\") k++;
                k++;
              }
              if (src[k] === q) {
                j = k + 1;
                continue;
              }
              break walk;
            }
            break walk;
          }
          const c = src[j]!;
          if (c === " " || c === "\t" || c === "(" || c === ")" || c === ":" || c === "," || c === "?" || c === "!" || c === "<" || c === ">" || c === "|" || c === "&" || c === "[" || c === "]") {
            j++;
            continue;
          }
          if (c === "=" && src[j + 1] === ">") {
            j += 2;
            continue;
          }
          if (c === "=" && src[j + 1] !== "=") {
            j++;
            continue;
          }
          if (/[A-Za-z0-9_$]/.test(c)) {
            let wordEnd = j;
            while (wordEnd < n && /[A-Za-z0-9_$]/.test(src[wordEnd]!)) wordEnd++;
            if (WALK_STOP_WORDS.has(src.slice(j, wordEnd))) break walk;
            j = wordEnd;
            continue;
          }
          if (c === "{") {
            next = j;
            break;
          }
          break walk;
        }
        if (next === -1) return { end: close, confirmed: true };
        open = next;
        annotation = candidateIsAnnotation(mask, src, open);
      }
    } else if (ch === ";" && paren === 0 && bracket === 0) {
      if (constValue && !valueSeen) return { end: i, confirmed: false };
      if (requiresBody) return { end: i, confirmed: false };
      return { end: i, confirmed: true };
    }
    i++;
  }
  return { end: n - 1, confirmed: true };
}

interface LineHit {
  readonly kind: DefKind;
  readonly constValue: boolean;
  readonly name: string;
  readonly after: number;
  readonly openBrace: number | null;
  readonly braceAfterParen: boolean;
}

function topRuleOnLine(trimmed: string, rules: readonly DefRule[]): LineHit | null {
  for (const r of rules) {
    const m = r.re.exec(trimmed);
    if (m) {
      return {
        kind: r.kind,
        constValue: r.constValue,
        name: m[1]!,
        after: m[0].length,
        openBrace: null,
        braceAfterParen: false,
      };
    }
  }
  return null;
}

function firstDefOnLine(line: string, rules: readonly DefRule[]): LineHit | null {
  const top = topRuleOnLine(line.trimStart(), rules);
  if (top) return top;
  if (line[0] === " " || line[0] === "\t") {
    const mm = METHOD_RE.exec(line);
    if (mm) {
      const name = mm[1]!;
      if (!METHOD_NAME_STOPWORDS.has(name)) {
        return {
          kind: "method",
          constValue: false,
          name,
          after: mm[0].trimStart().length,
          openBrace: mm.index + mm[0].length - 1,
          braceAfterParen: false,
        };
      }
    }
    const mc = METHOD_COMPUTED_RE.exec(line);
    if (mc) {
      return {
        kind: "method",
        constValue: false,
        name: mc[1]!,
        after: mc[0].trimStart().length,
        openBrace: mc.index + mc[0].length - 1,
        braceAfterParen: false,
      };
    }
    const ml = METHOD_LOOSE_RE.exec(line);
    if (ml) {
      const name = ml[1]!;
      if (!METHOD_NAME_STOPWORDS.has(name) && !line.trimEnd().endsWith(";")) {
        return {
          kind: "method",
          constValue: false,
          name,
          after: ml[0].trimStart().length,
          openBrace: null,
          braceAfterParen: true,
        };
      }
    }
  }
  return null;
}

export function listDefs(source: string, lang: LangId, opts: DefsOptions = {}): Def[] {
  const mask = classify(source, opts);
  const lines = source.split("\n");
  const rules = DEF_RULES[lang];
  const defLine = new Uint8Array(lines.length + 2);
  for (let ln = 0; ln < lines.length; ln++) {
    if (topRuleOnLine(lines[ln]!.trimStart(), rules) !== null) defLine[ln + 1] = 1;
  }
  const defs: Def[] = [];

  for (let ln = 0; ln < lines.length; ln++) {
    const first = mask.lineFirstCode[ln];
    if (first === undefined || first === -1) continue;
    const hit = firstDefOnLine(lines[ln]!, rules);
    if (!hit) continue;
    if (!hit.constValue && hit.kind !== "method" && inExpressionPosition(mask, source, first)) continue;
    const from =
      hit.openBrace !== null
        ? mask.lineStarts[ln]! + hit.openBrace
        : first + hit.after;
    const res = endOfDef(
      mask,
      source,
      from,
      hit.constValue,
      hit.kind === "method",
      hit.braceAfterParen,
      defLine,
      opts,
      hit.kind === "function" && !hit.constValue,
    );
    if (!res.confirmed) continue;
    defs.push({
      name: hit.name,
      kind: hit.kind,
      startLine: ln + 1,
      endLine: lineAt(mask.lineStarts, res.end),
    });
  }

  return defs;
}

export function findBlockEnd(source: string, startLine: number, opts: DefsOptions = {}): number {
  const mask = classify(source, opts);
  const lines = source.split("\n");
  const line = lines[startLine - 1];
  if (line === undefined) return startLine;
  const lineStart = mask.lineStarts[startLine - 1]!;
  const res = endOfDef(
    mask,
    source,
    lineStart + (line.length - line.trimStart().length),
    false,
    false,
    false,
    null,
    opts,
  );
  return lineAt(mask.lineStarts, res.end);
}
