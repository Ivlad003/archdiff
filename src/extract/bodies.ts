// Function bodies by declaration position, for trace instrumentation: the
// tracer rewrites TS/JS sources to record calls at run time, and needs to know
// where each function's body starts and ends. Sits beside the TS frontend
// (source → FileFacts) and parses with the same tree-sitter grammar.
// Entry points: `functionBodies` and `parsesCleanly`. Positions match the declaration ranges of `FileFacts` (1-based line/col of
// the declaring node); offsets index the JS string (UTF-16 code units).

import { startCol, type Node } from "./treesitter.ts";
import { unwrapValue, withTsTree } from "./ts.ts";

/** Where one function's body lies in the source, and what kind of function it is. */
export interface FunctionBody {
  /** Offset of the body: after `{` for a block, the expression start otherwise. */
  start: number;
  /** Offset of the closing `}` for a block, the expression end otherwise. */
  end: number;
  /** An arrow function with an expression body (`=> expr`). */
  expression: boolean;
  generator: boolean;
  async: boolean;
}

/** Tree-sitter node types that are a function with a body. */
const FUNCTIONS = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "generator_function", "arrow_function", "method_definition"]);

/** `line:col` of each declaring node → the body of its function. */
export function functionBodies(path: string, src: string): Promise<Map<string, FunctionBody>> {
  return withTsTree(path, src, (tree) => bodiesOf(tree.rootNode));
}

/**
 * The source parses without a syntax error: an instrumented copy is checked before it replaces the
 * original. `export type * from`, which the bundled grammar does not know, is no error here either.
 */
export function parsesCleanly(path: string, src: string): Promise<boolean> {
  return withTsTree(path, src, (tree) => !tree.rootNode.hasError);
}

/** Walk the tree and record the body of every function, keyed by the position of the node that declares it. */
function bodiesOf(root: Node): Map<string, FunctionBody> {
  const out = new Map<string, FunctionBody>();

  const add = (declaring: Node, fn: Node): void => {
    const body = fn.childForFieldName("body");

    // A signature or abstract method has no body to instrument.
    if (!body) return;
    const block = body.type === "statement_block";
    const key = `${declaring.startPosition.row + 1}:${startCol(declaring)}`;

    // One body per declaring position: the first function recorded wins
    // (the visit is pre-order, so the outer construct comes first).
    if (out.has(key)) return;
    out.set(key, {
      start: block ? body.startIndex + 1 : body.startIndex,
      end: block ? body.endIndex - 1 : body.endIndex,
      expression: !block,
      generator: fn.type.includes("generator") || fn.children.some((c) => c.type === "*"),
      async: fn.children.some((c) => c.type === "async"),
    });
  };

  /** The function a value is: `(f) as T`, `f satisfies T`, and the first argument of a wrapper call (`memo(() => …)`). */
  const fnOf = (value: Node | null): Node | null => {
    if (!value) return null;
    const at = unwrapValue(value);

    if (FUNCTIONS.has(at.type)) return at;

    // A wrapper call: look through to its first non-comment argument.
    if (at.type !== "call_expression") return null;
    const arg = at.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment");
    const fn = arg ? unwrapValue(arg) : null;

    return fn && FUNCTIONS.has(fn.type) ? fn : null;
  };

  // Depth-first over named nodes: every function records itself, and the
  // constructs below also record the function under the position of the
  // name that declares it, which is the key the facts use.
  const visit = (node: Node): void => {
    if (FUNCTIONS.has(node.type)) add(node, node);

    // `const f = () => …`, `const f = ((…) => …) satisfies H` and a class field `handler = () => …` are declared by
    // the declarator or the field; `const C = memo(() => …)` by the declarator too (extract keeps it a value unless
    // the wrapper is React's, so a key it never asks for is harmless).
    if (node.type === "variable_declarator" || node.type === "public_field_definition" || node.type === "field_definition") {
      const fn = fnOf(node.childForFieldName("value"));

      if (fn) add(node, fn);
    }

    // CommonJS: `exports.a = function () {}` and `module.exports = f` are declared by the assignment,
    // `module.exports = { b: function () {} }` by the pair.
    if (node.type === "assignment_expression") {
      const fn = fnOf(node.childForFieldName("right"));

      if (fn) add(node, fn);
    }

    if (node.type === "pair") {
      const fn = fnOf(node.childForFieldName("value"));

      if (fn) add(node, fn);
    }

    // An overloaded function or method is declared by its first signature; its body is the implementation's.
    if (node.type === "function_signature" || (node.type === "method_signature" && node.parent?.type === "class_body")) {
      const impl = implementationOf(node);

      if (impl) add(node, impl);
    }

    for (const child of node.namedChildren) visit(child);
  };

  visit(root);

  return out;
}

/**
 * The implementation an overload signature belongs to: the next function
 * declaration (or method) of the same name, past the other signatures and
 * comments between them. `export function f(…);` is a signature in an
 * `export_statement`, so siblings are compared through that wrapper.
 */
function implementationOf(signature: Node): Node | null {
  const name = signature.childForFieldName("name")?.text;

  // An anonymous signature has nothing to match against.
  if (!name) return null;
  const method = signature.type === "method_signature";
  const exported = !method && signature.parent?.type === "export_statement";
  const inner = (n: Node): Node | null => (exported ? (n.type === "export_statement" ? (n.childForFieldName("declaration") ?? n.namedChildren.find((c) => c.type !== "comment" && c.type !== "decorator") ?? null) : null) : n);

  // Scan forward over the siblings: skip comments, stop at the first
  // declaration of another name, return the first implementation, and keep
  // going over further signatures of the same name.
  for (let at = (exported ? signature.parent! : signature).nextNamedSibling; at; at = at.nextNamedSibling) {
    if (at.type === "comment") continue;
    const decl = inner(at);

    if (!decl || decl.childForFieldName("name")?.text !== name) return null;

    if (decl.type === (method ? "method_definition" : "function_declaration") || (!method && decl.type === "generator_function_declaration")) return decl;

    if (decl.type !== signature.type) return null;
  }

  return null;
}
