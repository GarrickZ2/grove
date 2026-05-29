import type { ContextSnapshot } from "./types";

/**
 * When-expression parser + evaluator. Supports boolean variables joined
 * by &&, ||, ! with parentheses. Whitespace insignificant.
 *
 * Grammar:
 *   expression = or
 *   or         = and ('||' and)*
 *   and        = unary ('&&' unary)*
 *   unary      = '!' unary | atom
 *   atom       = identifier | '(' expression ')'
 *
 * Identifiers may contain letters, digits, underscore, dot. Unknown
 * identifiers evaluate to false (never throw at runtime — keeps Settings
 * UI editing forgiving). Empty / whitespace-only expression = always true.
 *
 * Future v2 extensions (==, in, regex, typed context keys) plug into
 * tokenize + atom without changing this surface.
 */

type Node =
  | { type: "id"; name: string }
  | { type: "not"; expr: Node }
  | { type: "and"; left: Node; right: Node }
  | { type: "or"; left: Node; right: Node };

export class WhenParseError extends Error {
  public position?: number;
  constructor(message: string, position?: number) {
    super(message);
    this.name = "WhenParseError";
    this.position = position;
  }
}

export type WhenEvaluator = (ctx: ContextSnapshot) => boolean;

const ALWAYS_TRUE: WhenEvaluator = () => true;

export function parseWhen(expr: string | undefined): WhenEvaluator {
  if (!expr || !expr.trim()) return ALWAYS_TRUE;

  const tokens = tokenize(expr);
  if (tokens.length === 0) return ALWAYS_TRUE;

  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const consume = (): string | undefined => tokens[pos++];

  function parseOr(): Node {
    let left = parseAnd();
    while (peek() === "||") {
      consume();
      left = { type: "or", left, right: parseAnd() };
    }
    return left;
  }

  function parseAnd(): Node {
    let left = parseUnary();
    while (peek() === "&&") {
      consume();
      left = { type: "and", left, right: parseUnary() };
    }
    return left;
  }

  function parseUnary(): Node {
    if (peek() === "!") {
      consume();
      return { type: "not", expr: parseUnary() };
    }
    return parseAtom();
  }

  function parseAtom(): Node {
    const t = consume();
    if (t === undefined) {
      throw new WhenParseError("unexpected end of expression");
    }
    if (t === "(") {
      const inner = parseOr();
      if (consume() !== ")") {
        throw new WhenParseError("expected ')'");
      }
      return inner;
    }
    if (t === "!" || t === "&&" || t === "||" || t === ")") {
      throw new WhenParseError(`unexpected token: ${t}`);
    }
    return { type: "id", name: t };
  }

  const ast = parseOr();
  if (pos !== tokens.length) {
    throw new WhenParseError(`extra tokens after expression: ${tokens.slice(pos).join(" ")}`);
  }

  return (ctx) => evaluate(ast, ctx);
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "(" || c === ")") {
      out.push(c);
      i++;
      continue;
    }
    if (c === "!") {
      out.push("!");
      i++;
      continue;
    }
    if (c === "&" && s[i + 1] === "&") {
      out.push("&&");
      i += 2;
      continue;
    }
    if (c === "|" && s[i + 1] === "|") {
      out.push("||");
      i += 2;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_.]/.test(s[j])) j++;
      out.push(s.slice(i, j));
      i = j;
      continue;
    }
    throw new WhenParseError(`unexpected character '${c}' at position ${i}`, i);
  }
  return out;
}

function evaluate(n: Node, ctx: ContextSnapshot): boolean {
  switch (n.type) {
    case "id":
      return !!ctx[n.name];
    case "not":
      return !evaluate(n.expr, ctx);
    case "and":
      return evaluate(n.left, ctx) && evaluate(n.right, ctx);
    case "or":
      return evaluate(n.left, ctx) || evaluate(n.right, ctx);
  }
}

/**
 * Validate a when expression — returns null if valid, or the parse error
 * message. Used by Settings UI for live validation as the user types.
 */
export function validateWhen(expr: string | undefined): string | null {
  if (!expr || !expr.trim()) return null;
  try {
    parseWhen(expr);
    return null;
  } catch (e) {
    if (e instanceof WhenParseError) return e.message;
    throw e;
  }
}

/**
 * Extract all context-key identifiers referenced in an expression.
 * Used by Settings UI to show "this command depends on: editorFocus,
 * canOperate" and for catalog-lint to flag references to unknown keys.
 */
export function extractContextKeys(expr: string | undefined): string[] {
  if (!expr || !expr.trim()) return [];
  const tokens = tokenize(expr);
  const out = new Set<string>();
  for (const t of tokens) {
    if (t === "(" || t === ")" || t === "!" || t === "&&" || t === "||") continue;
    out.add(t);
  }
  return Array.from(out);
}
