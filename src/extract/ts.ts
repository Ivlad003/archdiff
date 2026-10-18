// TypeScript / JavaScript facts: imports, declarations, exports, calls.
// A tree walk over the top level plus tree-sitter queries inside bodies.
//
// Pipeline: source → `FileFacts` (this module, via `extractTs`) → graph.
// The graph resolves the import sources, callee texts and export
// rows recorded here; nothing here touches other files. Entry points:
// `extractTs` for one file and `withTsTree` for callers that need the parsed
// tree. Key terms: an *opaque* call is kept as text because it does not name
// a resolvable symbol (the graph makes it a gap); a *pass* is a function
// handed to a call as a value.

import { builtinModules } from "node:module";
import type { CallFact, DeclFact, CodeDecorator, DecoratorArg, EntryFact, WebCallFact, WebFacts, FileFacts, HookFact, ImportBinding, ImportFact, PassFact, ResultCallFact, ResultTypeFact, TypeFieldFact, TypeRefFact, ValueOfFact, ValueRefFact } from "./facts.ts";
import { addMember } from "./facts.ts";
import { blockCommentBody, isLicense, jsdocDescription, lineCommentsBody, nonEmpty } from "./doc-comments.ts";
import { collapse, errorLine, fingerprintFacts, grammarFor, located, query, startCol, unsupportedAt, valuesFingerprint, withTree, type Grammar, type Language, type Node, type Query, type Tree } from "./treesitter.ts";
import { collectTsMachines, collectTsStates, countBranches, guardsOf, TS_CONTROL } from "./control.ts";

// Every call and `new`, whatever its callee: each becomes an edge or a gap, never nothing.
const CALLS_QUERY = `
(call_expression function: (_) @call)
(new_expression constructor: (_) @new)
`;

/**
 * A JSX tag that names a component is a call of it. The `typescript` grammar
 * has no JSX nodes (a `<` there is a type assertion), and a query naming
 * them fails to compile on it, so this query is built for `tsx` and
 * `javascript` only. A closing tag is not a second call.
 */
const JSX_QUERY = `
(jsx_self_closing_element name: (_) @tag)
(jsx_opening_element name: (_) @tag)
`;

// `require("./x")` and `import("./x")` with a plain string argument: the module source each loads.
const REQUIRE_QUERY = `
(call_expression function: (identifier) @fn arguments: (arguments (string (string_fragment) @source)) (#eq? @fn "require"))
(call_expression function: (import) arguments: (arguments (string (string_fragment) @source)))
`;

/** A callee longer than this is not a name archdiff resolves; it stays a gap with a shortened text. */
const MAX_CALLEE = 80;

/** Members whose first string argument framework adapters read: the global route prefix (`CallFact.literal`). */
const LITERAL_CALLS = new Set(["setGlobalPrefix"]);

/** Members whose first argument names an event (`CallFact.nameArg`): emitters (`emit('order.created')`, `publish`, `dispatch`) and listeners (`on`, `once`, `addEventListener`, `subscribe`). */
const NAME_ARG_CALLS = new Set(["emit", "emitAsync", "publish", "dispatch", "trigger", "fire", "on", "once", "addListener", "addEventListener", "subscribe", "listen"]);

/**
 * Import type expressions — `import("./scene.ts").SceneElement`,
 * `typeof import("./x.ts")` — are not in the tree-sitter grammar, and one of
 * them makes the whole file a syntax error. They are masked before parsing
 * by an identifier padded to the same length (`Imp     .SceneElement`), so
 * every position stays the same; a dynamic import call (`import("x").then`)
 * is left alone, told apart by the lowercase member after it.
 */
export function maskImportTypes(src: string): string {
  if (!src.includes("import(")) return src;

  const mask = (text: string): string => `Imp${" ".repeat(Math.max(0, text.length - 3))}`;

  return src.replace(/typeof\s+import\(\s*["'][^"']*["']\s*\)/g, (text) => mask(text)).replace(/import\(\s*["'][^"']*["']\s*\)(?=\s*\.\s*[A-Z_$])/g, (text) => mask(text));
}

/** The facts of one TypeScript or JavaScript file: what the graph reads to build its declarations, edges and gaps. */
export function extractTs(path: string, src: string): Promise<FileFacts> {
  const g = grammarFor(path);

  return withTsTree(path, maskImportTypes(src), (tree, language, typeStars) => extractTree(path, tree.rootNode, language, g, typeStars));
}

/**
 * Parse a TypeScript or JavaScript source and run `use` on the tree.
 * `export type * from` and `export type * as NS from` (TypeScript 5.0) are
 * syntax errors for the bundled grammar, while the same statement without
 * `type` is `export * from`: such a `type` is blanked with spaces — the same
 * length, so every position stays — and the source parsed again.
 * `typeStars`: the start offset of each such statement → its text as written.
 */
export async function withTsTree<T>(path: string, src: string, use: (tree: Tree, language: Language, typeStars: ReadonlyMap<number, string>) => T): Promise<T> {
  const g = grammarFor(path);

  // First parse. Most files have no `export type *`, so the tree is used as it is.
  const first = await withTree(g, src, (tree, language): { done: T } | { keywords: TypeStar[] } => {
    const keywords = typeStarKeywords(tree.rootNode);

    return keywords.length === 0 ? { done: use(tree, language, new Map()) } : { keywords };
  });

  if ("done" in first) return first.done;
  // Blank each `type` keyword in place (same length, so offsets, lines and columns stay) and parse again.
  let blanked = src;

  for (const k of first.keywords) blanked = `${blanked.slice(0, k.start)}${" ".repeat(k.end - k.start)}${blanked.slice(k.end)}`;
  const typeStars = new Map(first.keywords.map((k) => [k.statement, k.text]));

  return withTree(g, blanked, (tree, language) => use(tree, language, typeStars));
}

/** The `type` of an `export type * from` statement the grammar could not read: offsets in the source (UTF-16 code units). */
interface TypeStar {
  start: number;
  end: number;
  statement: number;
  text: string;
}

/** `export type * from "./t"` read as `export`, an error node holding `type`, then `*` or `* as NS`. */
function typeStarKeywords(root: Node): TypeStar[] {
  // A clean tree has none of these errors. Only top-level `export` statements can hold one.
  if (!root.hasError) return [];
  const out: TypeStar[] = [];

  for (const stmt of root.namedChildren) {
    if (stmt.type !== "export_statement") continue;
    // The broken shape is `export`, then an ERROR node holding just `type`, then `*` or `* as NS`.
    const [keyword, error, next] = stmt.children;

    if (keyword?.type !== "export" || error?.type !== "ERROR" || error.text !== "type" || (next?.type !== "*" && next?.type !== "namespace_export")) continue;
    out.push({ start: error.startIndex, end: error.endIndex, statement: stmt.startIndex, text: stmt.text });
  }

  return out;
}

/**
 * Syntax nested deeper than this (thousands of `+` terms, parentheses, a
 * member chain) is not read: scope lookups walk every ancestor, and a
 * recursive walk would overflow the stack. The file is opaque, with a parse
 * error at the first node that deep.
 */
const MAX_DEPTH = 1000;

/**
 * Parents of the named nodes of the tree being extracted, by node id.
 * tree-sitter's `parent` walks down from the root, so walking up every
 * ancestor with it is quadratic in depth; scope lookups do that for each
 * identifier. Set only while `extractTree` runs, which is synchronous.
 */
let parents: Map<number, Node> | null = null;

/** The parent of a named node: from the index while `extractTree` runs, else from tree-sitter. */
function parentOf(node: Node): Node | null {
  return parents?.get(node.id) ?? node.parent;
}

/** Index every named node's parent by node id. An explicit stack, so a deep tree does not overflow. */
function parentIndex(root: Node): Map<number, Node> {
  const index = new Map<number, Node>();
  const stack: Node[] = [root];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    for (const child of node.namedChildren) {
      if (!child) continue;
      index.set(child.id, node);
      stack.push(child);
    }
  }

  return index;
}

/**
 * Extract one parsed file. Sets the module-wide `parents` and `header` state
 * that the walk reads, and always clears it, even when extraction throws.
 */
function extractTree(path: string, root: Node, language: Language, g: Grammar, typeStars: ReadonlyMap<number, string>): FileFacts {
  parents = parentIndex(root);
  const head = moduleHeader(root);
  header = head.nodes;

  try {
    const facts = extractIndexed(path, root, language, g, typeStars);

    if (head.doc !== null) facts.doc = head.doc;

    return facts;
  } finally {
    parents = null;
    header = new Set();
  }
}

/** Comments of the file's header, which document the module and never a declaration. Set while `extractTree` runs. */
let header: ReadonlySet<number> = new Set();

/** Statements a declaration sits in: a comment above any of them documents it. */
const DOC_WRAPPERS = new Set(["export_statement", "lexical_declaration", "variable_declaration", "variable_declarator", "ambient_declaration", "expression_statement", "assignment_expression"]);

// `/**` that opens a JSDoc block; `/**/` (an empty block comment) is not one.
const JSDOC = /^\/\*\*(?!\/)/;

/**
 * The declaration's JSDoc: the nearest `/** … *\/` right above it or above the
 * statements that wrap it (`export`, `const x =`), with decorators and line
 * comments between them allowed. A line comment is a note, not documentation;
 * other code in between, the file's header and a license document nothing.
 */
function docOf(node: Node): string | undefined {
  // Look above the declaration first, then above each statement that wraps it.
  for (let at: Node | null = node; at; ) {
    // Scan earlier siblings, nearest first. Decorators and line comments are stepped over; any other node ends the search.
    for (let prev = at.previousNamedSibling; prev; prev = prev.previousNamedSibling) {
      if (prev.type === "decorator") continue;

      if (prev.type !== "comment" || header.has(prev.id)) return undefined;

      if (!JSDOC.test(prev.text)) continue;

      if (isLicense(prev.text)) return undefined;

      return nonEmpty(jsdocDescription(blockCommentBody(prev.text))) ?? undefined;
    }

    // No JSDoc among the siblings: climb to the wrapping statement, if there is one.
    const parent = parentOf(at);
    at = parent && DOC_WRAPPERS.has(parent.type) ? parent : null;
  }

  return undefined;
}

/** The module's doc comment and the comment nodes it is made of. */
interface ModuleHeader {
  doc: string | null;
  nodes: Set<number>;
}

/**
 * The module's documentation: the first block of comments in the file (after
 * `#!`; license notices, `/// <reference>` directives and blocks without text
 * skipped), unless it sits right above the first statement that is not an
 * import or a directive (`"use strict"`): then it documents that statement. Comments on adjacent lines are one block.
 */
function moduleHeader(root: Node): ModuleHeader {
  const leading: Node[] = [];
  let first: Node | null = null;

  // The comments before the first statement (a `#!` line is skipped), and that statement.
  for (const child of root.namedChildren) {
    if (child.type === "hash_bang_line") continue;

    if (child.type !== "comment") {
      first = child;
      break;
    }

    leading.push(child);
  }

  // Group them into blocks: a comment that starts on the line after the previous one ends joins its block.
  const blocks: Node[][] = [];

  for (const comment of leading) {
    const last = blocks.at(-1)?.at(-1);

    if (last && comment.startPosition.row <= last.endPosition.row + 1) blocks.at(-1)!.push(comment);
    else blocks.push([comment]);
  }

  // The first block with real text is the candidate; license notices and `/// <reference>` blocks are skipped.
  for (const [i, block] of blocks.entries()) {
    const text = block.map((c) => c.text).join("\n");

    if (isLicense(text) || block.every((c) => c.text.startsWith("/// <"))) continue;
    const doc = nonEmpty(jsdocDescription(block.map((c) => (c.text.startsWith("//") ? lineCommentsBody([c.text], /^\/\/[/!]?/) : blockCommentBody(c.text))).join("\n")));

    if (doc === null) continue;
    const end = block.at(-1)!.endPosition.row;
    // The block belongs to the module when another block follows it, no statement follows, a blank line
    // separates it from the first statement, or that statement is an import or a directive.
    // Otherwise it documents the first statement, and the module has no doc.
    const own = i < blocks.length - 1 || first === null || first.startPosition.row > end + 1 || first.type === "import_statement" || (first.type === "expression_statement" && first.namedChildren[0]?.type === "string");

    return own ? { doc, nodes: new Set(block.map((c) => c.id)) } : { doc: null, nodes: new Set() };
  }

  return { doc: null, nodes: new Set() };
}

/**
 * One file's extraction as it goes: the facts so far, the tree, the queries compiled for its grammar (no JSX tags in
 * the `typescript` one), what value imports from React bind, and the bodies whose calls a declaration claimed —
 * every other call is module-level code.
 */
interface Extraction {
  facts: FileFacts;
  root: Node;
  calls: Query;
  jsxTags: Query | null;
  requires: Query;
  react: ReactBindings;
  covered: Set<number>;
}

/** `declarationCalls` bound to the extraction, as the class and CommonJS readers take it. */
function callsOf(x: Extraction): (body: Node, cls?: ClassScope | null) => CallFact[] {
  return (body, cls = null) => declarationCalls(x, body, cls);
}

/** The facts of a file once the parent index and header are set: the top-level walk, then the whole-tree collectors. */
function extractIndexed(path: string, root: Node, language: Language, g: Grammar, typeStars: ReadonlyMap<number, string>): FileFacts {
  const facts: FileFacts = { path, endLine: 1, endCol: 1, imports: [], decls: [], exports: new Set(), reexportsAll: [], exportRows: [], unsupported: [], valueRefs: [], moduleCalls: [], completeness: "complete", parseError: null };
  const end = located(root);
  facts.endLine = end.endLine;
  facts.endCol = end.endCol;
  // A tree too deep for the ancestor walks is not read at all: opaque, with the line where it gets too deep.
  const tooDeep = lineDeeperThan(root, MAX_DEPTH);

  if (tooDeep !== null) {
    facts.completeness = "opaque";
    facts.parseError = { line: tooDeep, reason: `syntax nested deeper than ${MAX_DEPTH} levels` };

    return facts;
  }

  // Queries are compiled once per grammar. The `typescript` grammar has no JSX nodes, so no tag query there. Imports
  // hoist, so a wrapper or factory may sit above its import: the React bindings are read once, before the walk.
  const x: Extraction = {
    facts,
    root,
    calls: query(language, g, "calls", CALLS_QUERY),
    jsxTags: g === "typescript" ? null : query(language, g, "jsx", JSX_QUERY),
    requires: query(language, g, "require", REQUIRE_QUERY),
    react: reactBindings(root),
    covered: new Set<number>(),
  };
  // Declarations exported later by name: `function a() {}; export { a }`.
  const localExports = new Set<string>();

  // The top-level walk, in source order: imports, exports, CommonJS assignments and declarations.
  for (const node of root.namedChildren) {
    switch (node.type) {
      case "import_statement":
        facts.imports.push(...importStatement(node));
        break;
      case "export_statement": {
        const source = node.childForFieldName("source");

        // `export … from "./x"`: a re-export, which is also an import of that module.
        if (source) {
          const spec = stringValue(source);

          if (spec !== null) reexport(x, node, spec, typeStars);
          break;
        }

        localExport(x, node, localExports);
        break;
      }

      case "expression_statement":
        commonJsExports(node, facts, callsOf(x));
        break;
      default:
        visitDeclaration(x, node, false);
    }
  }

  // `export { a }` and `export default a` may come after `a`; mark those declarations exported now.
  for (const d of facts.decls) if (localExports.has(d.name)) d.exported = true;

  // Module-level calls: every call outside the bodies a declaration already claimed.
  const inDeclaration = (n: Node): boolean => {
    for (let at: Node | null = n; at; at = parentOf(at)) if (x.covered.has(at.id)) return true;

    return false;
  };

  facts.moduleCalls = declarationCalls(x, root, null, (n) => !inDeclaration(n));
  // Whole-tree collectors, each adding its own kind of fact.
  collectDynamicImports(root, facts);
  collectUnsupported(root, facts);
  collectValueRefs(root, facts);
  collectRouteEntries(root, facts);
  collectWebFacts(root, facts);
  // The states the file writes and reads as literals, and the machines a library declares (control.ts).
  const states = collectTsStates(root, language, g);

  if (states.length > 0) facts.states = states;
  const machines = collectTsMachines(root, language, g);

  if (machines.length > 0) facts.machines = machines;
  // A hash of the module's value code (constants, top-level calls), so a change outside declarations is seen.
  const values = valuesFingerprint(root.namedChildren, facts.decls);

  if (values !== undefined) facts.values = values;

  // A syntax error anywhere keeps the facts read so far, but marks them opaque.
  if (root.hasError) {
    facts.completeness = "opaque";
    facts.parseError = { line: errorLine(root), reason: "syntax error" };
  }

  return facts;
}

/**
 * The calls and component uses inside `body`, as facts of the declaration that owns it. `cls` is the enclosing
 * class, for `this.m()`; `keep` filters the captured nodes (module-level calls skip those inside declaration
 * bodies). Marks `body` as covered.
 */
function declarationCalls(x: Extraction, body: Node, cls: ClassScope | null = null, keep: (n: Node) => boolean = () => true): CallFact[] {
  if (body.id !== x.root.id) x.covered.add(body.id);
  const out: CallFact[] = [];

  for (const c of x.calls.captures(body)) {
    if (!keep(c.node)) continue;
    const fact = calleeOfCall(c.node, body, cls);

    if (!fact) continue;
    const call = parentOf(c.node);
    // `setGlobalPrefix("api")` and `emit("order.created")`: keep the first argument, which framework adapters read.
    const member = fact.callee.slice(fact.callee.lastIndexOf(".") + 1);
    const first = call?.type === "call_expression" && !fact.opaque && (LITERAL_CALLS.has(member) || NAME_ARG_CALLS.has(member)) ? call.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment") : undefined;

    if (first) {
      const value = stringValue(unwrapValue(first)) ?? templateValue(unwrapValue(first));

      if (LITERAL_CALLS.has(member)) fact.literal = value;
      else fact.nameArg = { literal: value, text: collapse(first.text).slice(0, MAX_CALLEE) };
    }

    // Functions the call receives as values (`later(save)`), and whether the call sits in a closure.
    const passes = call ? passesOf(call, body, cls) : [];

    if (passes.length > 0) fact.passes = passes;
    markClosure(fact, c.node, body);
    // The branches, loops and handlers the call sits under, for the sequence's fragments.
    const guards = guardsOf(c.node, body, TS_CONTROL);

    if (guards.length > 0) fact.guards = guards;
    out.push(fact);

    // `jsx(Cart)` is the same call as `<Cart />` when `jsx` is React's. The factory call and its `passes` stay.
    if (!call) continue;
    const component = componentOfFactory(call, c.node, body, cls, x.react);

    if (!component) continue;
    markClosure(component, c.node, body);
    out.push(component);
  }

  if (!x.jsxTags) return out;

  // JSX tags are calls of the component they name.
  for (const c of x.jsxTags.captures(body)) {
    if (!keep(c.node)) continue;
    const fact = componentOfTag(c.node, body, cls);

    if (!fact) continue;
    markClosure(fact, c.node, body);
    out.push(fact);
  }

  // Two queries walk the body in turn; the facts are kept in source order.
  return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

/**
 * One top-level declaration, bare or under `export`: pushes its declaration, import and export facts. Named
 * declarations `break` to the export bookkeeping after the switch; the rest `return` having done their own.
 */
function visitDeclaration(x: Extraction, node: Node, exported: boolean): void {
  const { facts } = x;
  const calls = callsOf(x);

  switch (node.type) {
    case "function_declaration":
    case "generator_function_declaration":
    case "function_signature": {
      const name = node.childForFieldName("name")?.text;

      if (!name) return;
      facts.decls.push(fnDecl(name, node, node, exported, calls(node), collectTypeRefs(node)));
      break;
    }

    case "lexical_declaration":
    case "variable_declaration":
      variableDeclaration(x, node, exported);

      return;

    case "class_declaration":
    case "abstract_class_declaration": {
      const name = node.childForFieldName("name")?.text;

      if (!name) return;
      facts.decls.push(classDecl(name, node, node, exported, calls, facts));
      break;
    }

    case "type_alias_declaration":
    case "interface_declaration":
    case "enum_declaration": {
      const name = node.childForFieldName("name")?.text;

      if (!name) return;
      const fact = decl("type", name, node, typeSignature(node), exported, [], collectTypeRefs(node), []);
      const shape = typeShape(node);

      if (shape !== undefined) fact.shape = shape;
      // `interface Store extends Repo`: a class implementing Store implements Repo too (a call through Repo reaches it).
      const extended = node.type === "interface_declaration" ? heritageNames(node.namedChildren.find((c) => c.type === "extends_type_clause")) : [];

      if (extended.length > 0) fact.implements = extended;
      facts.decls.push(fact);
      break;
    }

    case "ambient_declaration": {
      // `export declare function f(): void;`, `export declare const x: T;`
      const inner = node.namedChildren.find((c) => c.type !== "comment");

      if (inner) visitDeclaration(x, inner, exported);

      return;
    }

    case "internal_module":
    case "module": {
      // `export namespace Util {}` exports the name `Util`; its members are not indexed (`unsupported`).
      const nameNode = node.childForFieldName("name");
      const name = nameNode?.type === "nested_identifier" ? nameNode.text.split(".")[0]?.trim() : nameNode?.type === "identifier" ? nameNode.text : undefined;

      if (exported && name) {
        facts.exports.add(name);
        facts.exportRows.push({ name, kind: "value", local: name, form: "namespace" });
      }

      return;
    }

    default:
      return;
  }

  // The declarations that reached `break`: the export row's kind comes from the node type.
  if (exported) {
    const name = node.childForFieldName("name")?.text;

    if (name) {
      facts.exports.add(name);
      const kind = node.type.includes("class") ? "class" : node.type.includes("type") || node.type.includes("interface") || node.type.includes("enum") ? "type" : node.type.includes("function") ? "fn" : "value";
      facts.exportRows.push({ name, kind, local: name });
    }
  }
}

/** A `const`, `let` or `var` at the top level: each declarator is a `require` import, a function value, a class value or a plain value; a destructured `require` imports its names. */
function variableDeclaration(x: Extraction, node: Node, exported: boolean): void {
  const { facts } = x;
  const calls = callsOf(x);
  // Each declarator is a `require` import, a function value, a class value or a plain value.
  for (const d of node.namedChildren) {
    if (d.type !== "variable_declarator") continue;
    const nameNode = d.childForFieldName("name");
    const value = d.childForFieldName("value");

    if (!nameNode || nameNode.type !== "identifier") continue;
    const name = nameNode.text;
    // `const x = require("./x")` (or SFCC's `module.superModule`) binds a whole module: an import, not a declaration.
    const req = value ? (requireSource(value, x.requires) ?? superModuleSource(value)) : null;

    if (req) {
      facts.imports.push(importAt(d, req.source, [req.namespace ? { kind: "module", local: name, namespace: true } : { kind: "module", local: name }], false));
      continue;
    }

    // `(() => …) as Handler` and `(function () {}) satisfies T` are the function itself.
    const fnValue = value ? unwrapValue(value) : null;
    // `const Cart = memo(() => …)` is the fn the React wrapper wraps; `let`/`var` stay values.
    const wrapped = fnValue && node.children.some((c) => c.type === "const") ? reactWrapperFn(fnValue, x.react) : null;
    const fnNode = wrapped ?? (fnValue && FUNCTION_VALUES.has(fnValue.type) ? fnValue : null);

    if (fnNode) {
      facts.decls.push(fnDecl(name, d, fnNode, exported, calls(fnNode), collectTypeRefs(fnNode)));
    } else if (fnValue && fnValue.type === "class") {
      facts.decls.push(classDecl(name, fnValue, d, exported, calls, facts));
    } else if (fnValue && node.children.some((c) => c.type === "const")) {
      // `const store = new Store()`, `const db = createDb()`: a singleton, whose methods are called through its name;
      // `const LIMITS = ["a", "b"]`: a value of the language, whose methods are the language's.
      const made = fnValue.type === "new_expression" ? fnValue.childForFieldName("constructor") : null;
      const literal = LITERAL_CLASSES.get(fnValue.type);
      const of = made || literal ? null : resultValue(fnValue, d, null, 0);

      if (made && (made.type === "identifier" || made.type === "member_expression")) facts.instances = [...(facts.instances ?? []), { name, class: made.text }];
      else if (literal) facts.instances = [...(facts.instances ?? []), { name, class: literal }];
      else if (of) facts.instances = [...(facts.instances ?? []), { name, of }];
    }

    // Every exported declarator is an export row, whatever its value; the kind tells the graph what it stands for.
    if (exported) {
      facts.exports.add(name);
      const kind = fnNode ? "fn" : fnValue?.type === "class" ? "class" : "value";
      facts.exportRows.push({ name, kind, local: name });
    }
  }

  // `const { a, b } = require("./x")`
  for (const d of node.namedChildren) {
    const nameNode = d.childForFieldName("name");
    const value = d.childForFieldName("value");

    if (d.type !== "variable_declarator" || !nameNode || nameNode.type !== "object_pattern" || !value) continue;
    // `const { a } = mod;` where `mod` is an imported module binding.
    const req = requireSource(value, x.requires)?.source ?? (value.type === "identifier" ? moduleSource(facts, value.text) : null);

    if (!req) continue;
    const bindings: ImportBinding[] = [];

    for (const p of nameNode.namedChildren) {
      if (p.type === "shorthand_property_identifier_pattern") bindings.push({ kind: "named", local: p.text, imported: p.text });
      else if (p.type === "pair_pattern") {
        const k = p.childForFieldName("key")?.text;
        const v = p.childForFieldName("value")?.text;

        if (k && v) bindings.push({ kind: "named", local: v, imported: k });
      }
    }

    facts.imports.push(importAt(d, req, bindings, false));
  }
}

/** `export … from "./x"`: a re-export of names, of a namespace or of everything, which is also an import of that module. */
function reexport(x: Extraction, node: Node, spec: string, typeStars: ReadonlyMap<number, string>): void {
  const { facts } = x;
    const clause = node.namedChildren.find((c) => c.type === "export_clause");
    const star = node.children.some((c) => c.type === "*");
    const ns = node.namedChildren.find((c) => c.type === "namespace_export");
    const bindings: ImportBinding[] = [];

    if (clause) {
      for (const s of clause.namedChildren) {
        if (s.type !== "export_specifier") continue;
        const name = s.childForFieldName("name")?.text;
        const alias = s.childForFieldName("alias")?.text ?? name;

        if (name && alias) {
          bindings.push({ kind: "named", local: alias, imported: name });
          facts.exports.add(alias);
          facts.exportRows.push({ name: alias, kind: "value", local: name, form: "reexport", from: spec });
        }
      }
    } else if (ns) {
      const alias = ns.namedChildren[0]?.text;

      if (alias) {
        bindings.push({ kind: "module", local: alias, namespace: true });
        facts.exports.add(alias);
        facts.exportRows.push({ name: alias, kind: "value", local: null, form: "namespace", from: spec });
      }
    } else if (star) {
      facts.reexportsAll.push(spec);
      facts.exportRows.push({ name: "*", kind: "reexport", local: null, form: "reexport", from: spec });
    }

    // `export type { A } from`, `export type * from` (read without its blanked `type`): types only.
    const written = typeStars.get(node.startIndex);
    const fact = importAt(node, spec, bindings, true);

    if (written !== undefined) fact.text = written;

    if (written !== undefined || typeKeyword(node)) fact.typeOnly = true;
    else if (clause && inlineTypesOnly(clause, "export_specifier")) fact.inlineTypeOnly = true;
    facts.imports.push(fact);
}

/** A local export: `export <declaration>`, `export { … }`, or the module's default value (`export default …`, TypeScript's `export = …`); names exported after their declaration go into `localExports`. */
function localExport(x: Extraction, node: Node, localExports: Set<string>): void {
  const { facts } = x;
  const declaration = node.childForFieldName("declaration");
  const isDefault = node.children.some((c) => c.type === "default");

  if (declaration) {
    const before = facts.exportRows.length;
    visitDeclaration(x, declaration, true);

    // `export default function main() {}` is imported as `default`, not `main`.
    if (isDefault) {
      for (const row of facts.exportRows.slice(before)) {
        facts.exports.delete(row.name);
        facts.exports.add("default");
        row.local = row.name;
        row.name = "default";
        row.form = "default";
      }
    }
  } else {
    // `export { a, b as c }`, `export { x as default }`
    const clause = node.namedChildren.find((c) => c.type === "export_clause");

    for (const s of clause?.namedChildren ?? []) {
      if (s.type !== "export_specifier") continue;
      const alias = s.childForFieldName("alias")?.text ?? s.childForFieldName("name")?.text;

      if (alias) {
        const local = s.childForFieldName("name")?.text ?? alias;
        facts.exports.add(alias);
        facts.exportRows.push({ name: alias, kind: "value", local, ...(alias === "default" ? { form: "default" as const } : alias !== local ? { form: "alias" as const } : {}) });
        localExports.add(local);
      }
    }

    // `export default <expression>` and TypeScript `export = <expression>`: the module's default value.
    const written = node.childForFieldName("value") ?? (node.children.some((c) => c.type === "=") ? node.namedChildren.find((c) => c.type !== "comment") : undefined);
    const value = written ? unwrapValue(written) : null;

    if (value) {
      facts.exports.add("default");

      if (value.type === "identifier") {
        facts.exportRows.push({ name: "default", kind: "value", local: value.text, form: "default" });
        localExports.add(value.text);
      } else if (FUNCTION_VALUES.has(value.type)) {
        facts.decls.push(fnDecl("default", value, value, true, callsOf(x)(value), collectTypeRefs(value)));
        facts.exportRows.push({ name: "default", kind: "fn", local: "default", form: "default" });
      } else if (value.type === "class") {
        const name = value.childForFieldName("name")?.text ?? "default";
        facts.decls.push(classDecl(name, value, value, true, callsOf(x), facts));
        facts.exportRows.push({ name: "default", kind: "class", local: name, form: "default" });
      } else {
        // `export default 3`, `export default { a, b }`, `export default make()`: a value, no declaration.
        facts.exportRows.push({ name: "default", kind: "value", local: null, form: "default" });
      }
    }
  }
}

/** The React exports archdiff reads, per module: wrappers from `react`, factories from `react` and its JSX runtimes. */
const REACT_EXPORTS = new Map<string, ReadonlySet<string>>([
  ["react", new Set(["memo", "forwardRef", "lazy", "createElement", "jsx", "jsxs", "jsxDEV"])],
  ["react/jsx-runtime", new Set(["createElement", "jsx", "jsxs", "jsxDEV"])],
  ["react/jsx-dev-runtime", new Set(["createElement", "jsx", "jsxs", "jsxDEV"])],
]);

/** What value imports from React bind in one file. */
interface ReactBindings {
  /** Local name → the React export it binds: `h` → `createElement`. */
  names: Map<string, string>;
  /** Default or namespace object → the React exports read as its members (`React.memo`). */
  objects: Map<string, ReadonlySet<string>>;
}

/**
 * React bindings of one file: the single source for wrappers and factories,
 * so both follow one type-only rule. Imports hoist, so a `const` above its
 * import still counts; `require("react")` binds only below itself and is not
 * read. `import type`, `import type * as React` and `import { type memo }`
 * bind no value.
 */
function reactBindings(root: Node): ReactBindings {
  const names = new Map<string, string>();
  const objects = new Map<string, ReadonlySet<string>>();

  // Only value imports from the React modules; `import type` binds nothing at runtime.
  for (const stmt of root.namedChildren) {
    if (stmt.type !== "import_statement" || typeKeyword(stmt)) continue;

    for (const fact of importStatement(stmt)) {
      const exported = REACT_EXPORTS.get(fact.source);

      if (!exported) continue;

      for (const b of fact.bindings) {
        // A named import binds one export; a default or namespace import binds an object whose members are the exports.
        if (b.kind === "named") {
          if (exported.has(b.imported) && !typeOnlySpecifier(stmt, b.local)) names.set(b.local, b.imported);
        } else objects.set(b.local, exported);
      }
    }
  }

  return { names, objects };
}

/** The React export a callee names through a binding of the file (`memo`, `h`, `React.memo`), with the local it goes through. Shadowing is the caller's. */
function reactExportOf(callee: Node, react: ReactBindings): { name: string; local: string } | null {
  if (callee.type === "identifier") {
    const name = react.names.get(callee.text);

    return name ? { name, local: callee.text } : null;
  }

  if (callee.type !== "member_expression") return null;
  const object = callee.childForFieldName("object");
  const prop = callee.childForFieldName("property")?.text;

  if (object?.type !== "identifier" || !prop) return null;

  return react.objects.get(object.text)?.has(prop) ? { name: prop, local: object.text } : null;
}

/** The `type` keyword of `import type` or `import { type name }` — an unnamed child, not an identifier. */
function typeKeyword(node: Node): boolean {
  return node.children.some((c) => c.type === "type");
}

/**
 * `{ type A, type B as C }` of an import or an `export … from`: at least one
 * name, and every one of them `type`. Whether such a statement runs is the
 * tsconfig's to say (`ImportFact.inlineTypeOnly`), so it stays a fact of the
 * syntax here.
 */
function inlineTypesOnly(list: Node, specifier: "import_specifier" | "export_specifier"): boolean {
  const names = list.namedChildren.filter((c) => c.type === specifier);

  return names.length > 0 && names.every(typeKeyword);
}

/** `import { type memo as m }`: the specifier that binds `local` is type-only. */
function typeOnlySpecifier(stmt: Node, local: string): boolean {
  const named = stmt.namedChildren.find((c) => c.type === "import_clause")?.namedChildren.find((c) => c.type === "named_imports");

  for (const s of named?.namedChildren ?? []) {
    if (s.type !== "import_specifier") continue;
    const imported = s.childForFieldName("name")?.text;
    const alias = s.childForFieldName("alias")?.text ?? imported;

    if (alias === local) return typeKeyword(s);
  }

  return false;
}

/** A declaration fact at `node`'s span, with its JSDoc and its fingerprint facts. */
function decl(kind: DeclFact["kind"], name: string, node: Node, signature: string | null, exported: boolean, calls: CallFact[], types: TypeRefFact[], members: DeclFact[]): DeclFact {
  const at = located(node);
  const doc = docOf(node);

  const fact: DeclFact = { kind, name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature, exported, calls, types, members, ...fingerprintFacts(node) };

  if (doc !== undefined) fact.doc = doc;
  // How much a function branches, for the logic view's list (a class counts its members' branches each on its own).
  const branches = kind === "fn" ? countBranches(node, TS_CONTROL) : 0;

  if (branches > 0) fact.branches = branches;

  return fact;
}

/** A function's declaration fact: its signature and, when it names one, the class its result has. */
function fnDecl(name: string, at: Node, fn: Node, exported: boolean, calls: CallFact[], types: TypeRefFact[]): DeclFact {
  const fact = decl("fn", name, at, signature(fn), exported, calls, types, []);
  const result = resultOf(fn);

  if (result) fact.result = result;

  return fact;
}

/**
 * The class a function's result has, for a member called on it to be found: the class its return annotation names
 * (`: Store`; `: Promise<Store>`, a Store once awaited), else — without an annotation — the `new X()` an arrow's body
 * or every `return` of its body gives (an `async` function's: a Promise of it). Null for anything else.
 */
function resultOf(fn: Node): ResultTypeFact | null {
  const annotation = fn.childForFieldName("return_type");

  if (annotation) {
    const type = annotation.type === "type_annotation" ? annotation.namedChildren[0] : null;

    if (type?.type === "type_identifier") return { class: type.text };
    const args = type?.type === "generic_type" && type.childForFieldName("name")?.text === "Promise" ? type.childForFieldName("type_arguments")?.namedChildren : undefined;

    return args?.length === 1 && args[0]!.type === "type_identifier" ? { class: args[0]!.text, promise: true } : null;
  }

  const body = fn.childForFieldName("body");
  const made = !body ? null : body.type === "statement_block" ? returnedClass(body) : newClass(unwrapValue(body));

  if (!made) return null;

  return fn.children.some((c) => c.type === "async") ? { class: made, promise: true } : { class: made };
}

/** The class every `return` of a body gives with `new X()`, the functions nested in it aside; null when one returns anything else, or none returns. */
function returnedClass(body: Node): string | null {
  let made: string | null | undefined;

  walkNamed(body, (node) => {
    // A nested function's `return` is its own.
    if (node.id !== body.id && (FUNCTION_NODES.has(node.type) || node.type === "class_declaration" || node.type === "class")) return false;

    if (node.type !== "return_statement") return;
    const value = node.namedChildren[0];
    const cls = value ? newClass(unwrapValue(value)) : null;

    made = made === undefined || made === cls ? cls : null;
  });

  return made ?? null;
}

/**
 * The call a value is the result of — `makeStore()`, `repo.load()`, `await load()` — for the graph to read the class
 * its target returns; null for any other value. `depth` bounds a chain of locals each made from the one before.
 */
function resultValue(written: Node, stop: Node, cls: ClassScope | null, depth: number): ValueOfFact | null {
  let value = unwrapValue(written);
  const awaited = value.type === "await_expression";

  if (awaited) {
    const operand = value.namedChildren[0];

    if (!operand) return null;
    value = unwrapValue(operand);
  }

  const fn = value.type === "call_expression" ? value.childForFieldName("function") : null;
  const inner = fn ? calleeFact(unwrapValue(fn), stop, cls, depth + 1) : null;

  if (!inner || inner.opaque) return null;
  const call: ResultCallFact = { callee: inner.callee, member: inner.member ?? inner.callee.slice(inner.callee.lastIndexOf(".") + 1) };

  if (inner.bound) call.bound = inner.bound;

  if (inner.receiver) call.receiver = inner.receiver;

  if (inner.on) call.on = inner.on;

  return awaited ? { call, awaited: true } : { call };
}

/** The call a `const` local without a type annotation holds the result of (`const s = makeStore()`); null for any other binding. */
function localResult(from: Node, name: string, stop: Node, cls: ClassScope | null, depth: number): ValueOfFact | null {
  const binding = declarationOf(from, name, stop);

  if (depth > MAX_RESULT_CHAIN || binding?.kind !== "local" || binding.node.childForFieldName("name")?.type !== "identifier" || binding.node.childForFieldName("type")) return null;
  // A `let` may hold another value by the time of the call.
  const written = binding.node.parent?.children[0]?.type === "const" ? binding.node.childForFieldName("value") : null;

  return written ? resultValue(written, stop, cls, depth) : null;
}

/** How many locals made one from the next (`const a = f(); const b = a.g(); b.h()`) a receiver is followed through. */
const MAX_RESULT_CHAIN = 4;

/** A member callee too long to keep whole (`fetch(url, { … }).then`): its object cut short, then the member — still a member of a value to the graph, never a name. */
function shortMember(n: Node): string {
  const member = n.childForFieldName("property")?.text ?? "";
  const object = (n.childForFieldName("object")?.text ?? "").replace(/\s+/g, "");

  return `${object.slice(0, Math.max(MAX_CALLEE - member.length - 2, 16))}….${member}`;
}

/** Whether `name` at `from` is a parameter of the function a `new Promise(…)` runs: its `resolve` or `reject`, the language's. */
function promiseExecutorParameter(from: Node, name: string, stop: Node): boolean {
  const binding = declarationOf(from, name, stop);
  const args = binding?.kind === "parameter" ? parentOf(binding.fn) : null;
  const made = args?.type === "arguments" ? parentOf(args) : null;
  const ctor = made?.type === "new_expression" ? made.childForFieldName("constructor") : null;

  return binding?.kind === "parameter" && binding.index <= 1 && args?.namedChildren[0]?.id === binding.fn.id && ctor?.type === "identifier" && ctor.text === "Promise" && bindingOf(ctor, "Promise", stop) === null;
}

/**
 * The export a local names when a `require` or an awaited `import()` in the function binds it: `const { getSetting }
 * = await import("./features.js")` is `getSetting`, `const { a: b } = require("./x")` names `a` as `b`, `const mod =
 * require("./x")` is the module itself (`*`). Null for any other local.
 */
function localImport(from: Node, name: string, stop: Node): { source: string; name: string } | null {
  const binding = declarationOf(from, name, stop);
  const written = binding?.kind === "local" ? binding.node.childForFieldName("value") : null;
  const source = written ? loadedModule(written) : null;
  const pattern = binding?.kind === "local" ? binding.node.childForFieldName("name") : null;

  if (!source || !pattern) return null;

  if (pattern.type === "identifier") return { source, name: "*" };

  // `{ f }`, `{ f = fallback }`, `{ f: g }`: the property the local is bound from.
  for (const property of pattern.type === "object_pattern" ? pattern.namedChildren : []) {
    if (property.type === "shorthand_property_identifier_pattern" && property.text === name) return { source, name };

    if (property.type === "object_assignment_pattern" && property.childForFieldName("left")?.text === name) return { source, name };
    const key = property.type === "pair_pattern" && property.childForFieldName("value")?.text === name ? property.childForFieldName("key") : null;

    if (key?.type === "property_identifier") return { source, name: key.text };
  }

  return null;
}

/** The module a value loads: `require("./x")` with Node's `require`, `await import("./x")`; null for anything else. */
function loadedModule(written: Node): string | null {
  let call = unwrapValue(written);
  const awaited = call.type === "await_expression";

  if (awaited && call.namedChildren[0]) call = unwrapValue(call.namedChildren[0]);
  const fn = call.type === "call_expression" ? call.childForFieldName("function") : null;
  const arg = call.type === "call_expression" ? call.childForFieldName("arguments")?.namedChildren[0] : undefined;
  const source = arg ? stringValue(arg) : null;

  if (!fn || !source) return null;

  // An `import()` not awaited is a Promise of the module, not the module.
  if (fn.type === "import") return awaited ? source : null;

  return fn.type === "identifier" && fn.text === "require" && requireKind(fn) !== "shadowed" ? source : null;
}

/** The call, marked as made through a parameter or local binding when it is one. */
function boundCall(call: CallFact, bound: "parameter" | "local" | null): CallFact {
  return bound ? { ...call, bound } : call;
}

/** A call fact named `callee` at `node`'s span. */
function callFact(callee: string, node: Node): CallFact {
  const at = located(node);

  return { callee, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol };
}

/** A call through an expression archdiff does not name: an opaque call with the source text, a gap in the graph. */
function opaqueCall(node: Node): CallFact {
  const text = collapse(node.text);

  return { ...callFact(text.length <= MAX_CALLEE ? text : `${text.slice(0, MAX_CALLEE - 1)}…`, node), opaque: true };
}

/**
 * The fact of one call or `new` from its callee node. Null only for a call
 * archdiff records another way: `require()` and `import()` (imports),
 * `import.meta.resolve()` (an import), a function literal called in place
 * (the calls of its body are read where they are), a class expression under
 * `new`, `obj[k]()` (an `unsupported` fact). Any other callee archdiff cannot
 * name is an `opaque` fact.
 */
function calleeOfCall(node: Node, body: Node, cls: ClassScope | null): CallFact | null {
  // Strip parentheses and type assertions around the callee.
  let n = unwrapValue(node);

  // `(0, f.g)()` calls `f.g` without its `this`.
  while (n.type === "sequence_expression" && n.namedChildren.length > 0) n = unwrapValue(n.namedChildren.at(-1)!);

  switch (n.type) {
    case "identifier": {
      // Node's `require(...)` is an import, read by the require query; a shadowed `require` is an ordinary call.
      if (n.text === "require" && parentOf(node)?.type === "call_expression" && requireKind(n) !== "shadowed") return null;
      // A callee named by a parameter or local is bound; through a local, it may be a hook with a default, or a
      // module's export the function loads (`const { f } = await import("./x")`); through a parameter, the `resolve`
      // of a `new Promise` executor.
      const fact = boundCall(callFact(n.text, n), bindingOf(n, n.text, body));
      const hook = fact.bound ? localHook(n, n.text, body) : null;
      const imported = fact.bound === "local" && !hook ? localImport(n, n.text, body) : null;

      if (hook) fact.hook = hook;

      if (imported) fact.imported = imported;

      if (fact.bound === "parameter" && promiseExecutorParameter(n, n.text, body)) fact.language = true;

      return fact;
    }

    case "member_expression": {
      // `import.meta.resolve()` is the platform's; its module is an import edge.
      if (n.childForFieldName("object")?.type === "meta_property") return null;
      const fact = calleeFact(n, body, cls);

      if (fact) return fact;
      // `a.b.c()`, `f().m()`, `super.m()`: the text keeps the head, which the graph resolves or leaves a gap; a chain too
      // long to keep is cut short in its object, still a member of a value.
      const text = n.text.replace(/\s+/g, "");

      return callFact(text.length < MAX_CALLEE ? text : shortMember(n), n);
    }

    case "super":
      return callFact("super", n);
    // `import()`, `obj[k]()` and `new class {}` are recorded elsewhere or as `unsupported`.
    case "import":
    case "subscript_expression":
    case "class":
      return null;
    default:
      // A function literal called in place has its calls read where they are; anything else is an opaque call, a gap.
      return FUNCTION_VALUES.has(n.type) ? null : opaqueCall(n);
  }
}

/**
 * The call a JSX tag makes, from its name node: `<Cart />` calls `Cart`,
 * `<Cart.Item />` calls `Cart.Item`, as the call expressions would. Null
 * when the tag is not a component: an intrinsic element (`<div />`,
 * `<my-button />`: a lowercase first letter), a namespace name
 * (`<svg:path />`), or a fragment (no name). A tag through a parameter or
 * local (`<Comp />`) is bound, a gap, as the call of a parameter is.
 */
function componentOfTag(name: Node, body: Node, cls: ClassScope | null): CallFact | null {
  if (name.type === "identifier") {
    // A lowercase ASCII first letter (a–z) marks an intrinsic element, as in JSX itself.
    const first = name.text.codePointAt(0) ?? 0;

    if (first >= 0x61 && first <= 0x7a) return null;

    return calleeFact(name, body, cls);
  }

  if (name.type !== "member_expression") return null;
  const fact = calleeFact(name, body, cls);

  if (fact) return fact;
  // A member tag with no binding to resolve: its text, or an opaque call when it is too long.
  const text = collapse(name.text);

  return text.length < MAX_CALLEE ? callFact(text, name) : opaqueCall(name);
}

/** The factory names. Which module bound the callee decides, not the spelling at the call. */
const REACT_FACTORIES = new Set(["createElement", "jsx", "jsxs", "jsxDEV"]);

/**
 * The component call hidden in a React factory: `createElement(Cart)`,
 * `jsx(Cart)`, `jsxs(Cart.Item)`, `jsxDEV(Cart)` are the call `<Cart />`
 * would be, when the callee is bound by an import from `react`,
 * `react/jsx-runtime` or `react/jsx-dev-runtime` (`h` for
 * `createElement as h`, `React.createElement` for a default or namespace
 * import). A local function or an import from anywhere else is not one, so
 * a helper named `createElement` keeps a single ordinary call. The first
 * argument is the component, by the same rule as a tag: a capital
 * identifier or a member. A string (`"div"`) or a lowercase identifier is
 * not a call.
 */
function componentOfFactory(call: Node, calleeNode: Node, body: Node, cls: ClassScope | null, react: ReactBindings): CallFact | null {
  if (call.type !== "call_expression" || !factoryCallee(calleeNode, body, react)) return null;
  const arg = call.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment");

  return arg ? componentOfTag(unwrapValue(arg), body, cls) : null;
}

/** The callee node is a React factory binding, and nothing between here and the body shadows it. */
function factoryCallee(node: Node, body: Node, react: ReactBindings): boolean {
  let n = unwrapValue(node);

  // `(0, jsx)(Cart)`: the last expression of a sequence is the callee.
  while (n.type === "sequence_expression" && n.namedChildren.length > 0) n = unwrapValue(n.namedChildren.at(-1)!);
  const bound = reactExportOf(n, react);

  return bound !== null && REACT_FACTORIES.has(bound.name) && bindingOf(n, bound.local, body) === null;
}

/**
 * What a `require` identifier is: Node's (`global`), one made by
 * `createRequire(…)` (`created`), which also loads modules, or a parameter or
 * local of another value (`shadowed`), whose call is not an import.
 */
function requireKind(node: Node): "global" | "created" | "shadowed" {
  const binding = declarationOf(node, "require", node.tree.rootNode);

  if (binding === null) return "global";

  if (binding.kind !== "local") return "shadowed";
  // A local `require`: a module loader only when it is `createRequire(…)`'s result.
  const value = binding.node.childForFieldName("value");
  const init = value ? unwrapValue(value) : null;
  const fn = init?.type === "call_expression" ? init.childForFieldName("function")?.text.replace(/\s+/g, "") : undefined;

  return fn === "createRequire" || fn?.endsWith(".createRequire") ? "created" : "shadowed";
}

/** An import fact of `source` at `node`'s span, with the statement's text as written. */
function importAt(node: Node, source: string, bindings: ImportBinding[], reexport: boolean): ImportFact {
  const at = located(node);

  return { source, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: at.text, bindings, reexport };
}

/** Node types that declare something of their own; type-reference collection stops at them. */
const NESTED_DECL = new Set(["function_declaration", "generator_function_declaration", "function_signature", "class_declaration", "abstract_class_declaration", "method_definition", "interface_declaration", "type_alias_declaration", "enum_declaration", "internal_module"]);

/**
 * A declaration of its own below the one whose type names are collected. A method signature
 * is one in a class body (an overload of a member); in an interface or an object type
 * (`{ save(o: Order): void }`) it is part of that type.
 */
function nestedDeclaration(node: Node): boolean {
  return NESTED_DECL.has(node.type) || (node.type === "method_signature" && node.parent?.type === "class_body");
}

/** 1-based line of the first node nested deeper than `limit` below `root`; null when none is. */
function lineDeeperThan(root: Node, limit: number): number | null {
  // A cursor walk instead of recursion: the tree being measured may be too deep to recurse over.
  const cursor = root.walk();

  try {
    // Depth-first: down to the first child; else to the next sibling, climbing while there is none.
    for (let depth = 0; ; ) {
      if (depth > limit) return cursor.startPosition.row + 1;

      if (cursor.gotoFirstChild()) {
        depth++;
        continue;
      }

      while (!cursor.gotoNextSibling()) {
        if (depth === 0 || !cursor.gotoParent()) return null;
        depth--;
      }
    }
  } finally {
    cursor.delete();
  }
}

/**
 * Pre-order walk over named nodes with an explicit stack: an expression
 * nested thousands deep must not overflow the call stack. `enter` returns
 * false to skip the node's subtree.
 */
function walkNamed(root: Node, enter: (node: Node) => boolean | void): void {
  const stack: Node[] = [root];

  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (enter(node) === false) continue;
    const children = node.namedChildren;

    // Push children in reverse, so they pop in source order.
    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];

      if (child) stack.push(child);
    }
  }
}

/** The empty scope: no type names bound. */
const NO_NAMES: ReadonlySet<string> = new Set();

/**
 * Type names used by `node`, excluding its own declared name, nested
 * declarations and the names a generic binds in its scope: a type parameter
 * (`<T>`), a mapped type's key (`[K in keyof T]`), an `infer U`. `bound`: the
 * type parameters already in scope, a class's for its members.
 */
function collectTypeRefs(node: Node, bound: ReadonlySet<string> = NO_NAMES): TypeRefFact[] {
  const skip = node.childForFieldName("name");
  const out: TypeRefFact[] = [];
  // An explicit stack, as in `walkNamed`, with the names bound at each node.
  const stack: { node: Node; bound: ReadonlySet<string> }[] = [{ node, bound }];

  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const current = item.node;

    // A nested declaration has its own type references; the root itself is always read.
    if (current.id !== node.id && nestedDeclaration(current)) continue;

    // `ns.Order` is one qualified reference; its parts are not read again.
    if (current.type === "nested_type_identifier") {
      const at = located(current);
      out.push({ name: at.text.replace(/\s+/g, ""), line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: at.text });
      continue;
    }

    const scope = typeNamesBound(current, item.bound);

    // A type name that is not the declaration's own name and not bound by a generic in scope.
    if (current.type === "type_identifier" && current.id !== skip?.id && !scope.has(current.text)) {
      const at = located(current);
      out.push({ name: at.text, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: at.text });
    }

    const children = current.namedChildren;

    for (let i = children.length - 1; i >= 0; i--) {
      const child = children[i];

      if (child) stack.push({ node: child, bound: scope });
    }
  }

  return out;
}

/** `bound` and the type names `node` binds for its subtree: its type parameters, a mapped type's key, the `infer` names of a conditional type. */
function typeNamesBound(node: Node, bound: ReadonlySet<string>): ReadonlySet<string> {
  const names: string[] = [];

  // `<T, U>` on a function, class, alias or interface.
  for (const param of node.childForFieldName("type_parameters")?.namedChildren ?? []) {
    const name = param.type === "type_parameter" ? param.childForFieldName("name") : null;

    if (name) names.push(name.text);
  }

  // `[K in keyof T]: …`: the mapped type's key.
  if (node.type === "index_signature") {
    for (const clause of node.namedChildren) {
      const name = clause.type === "mapped_type_clause" ? clause.childForFieldName("name") : null;

      if (name) names.push(name.text);
    }
  }

  // `T extends Array<infer U> ? U : never`: `U` is bound in the whole conditional type.
  const tested = node.type === "conditional_type" ? node.childForFieldName("right") : null;

  if (tested) {
    walkNamed(tested, (n) => {
      const name = n.type === "infer_type" ? n.namedChildren[0] : undefined;

      if (name?.type === "type_identifier") names.push(name.text);
    });
  }

  return names.length === 0 ? bound : new Set([...bound, ...names]);
}

/**
 * Members of a class. Methods and function-valued fields (`handler = () => …`)
 * are fns with their own calls and types. Any other field is no node: the
 * types its annotation and initializer name (`repo!: Order`,
 * `s = new Map<string, Item>()`), and an index signature's, are the
 * class's. Instance field initializers run on
 * construction: their calls belong to `constructor`, synthesized when the
 * class has none. Static field initializers and `static {}` blocks run once
 * when the class is evaluated: their calls belong to a synthesized `static`
 * member, never to the constructor. A computed member name (`[key]() {}`) is
 * unsupported: nothing names it statically.
 */
function classDecl(name: string, cls: Node, at: Node, exported: boolean, declCalls: (n: Node, scope: ClassScope | null) => CallFact[], facts: FileFacts): DeclFact {
  const body = cls.childForFieldName("body");
  const items = body?.namedChildren ?? [];
  // The class's member names, for resolving `this.m()` in its bodies.
  const scope = classScope(items);
  // `class C<T>`: `T` is no type reference in its heritage or its members.
  const typeParams = typeNamesBound(cls, NO_NAMES);
  const members: DeclFact[] = [];
  const fieldTypes: TypeRefFact[] = [];
  const instance: { node: Node; calls: CallFact[] }[] = [];
  const statics: { node: Node; calls: CallFact[] }[] = [];
  // Decorators of the next member: tree-sitter writes them as siblings before it in the class body.
  let pending: CodeDecorator[] = [];

  // One pass over the class body, in source order: decorators wait for their member.
  for (const m of items) {
    if (m.type === "decorator") {
      const fact = decoratorFact(m);

      if (fact) pending.push(fact);
      continue;
    }

    // The member's decorators: those written as siblings before it, plus any tree-sitter nested under it.
    const memberDecorators = [...pending, ...decoratorsOf(m)];
    pending = [];
    const isField = m.type === "public_field_definition" || m.type === "field_definition";

    if (m.type === "class_static_block") {
      statics.push({ node: m, calls: declCalls(m, scope) });
      continue;
    }

    if (m.type === "index_signature") {
      fieldTypes.push(...collectTypeRefs(m, typeParams));
      continue;
    }

    // Only methods, method signatures and fields are members; anything else in the body is skipped.
    if (!isField && m.type !== "method_definition" && m.type !== "method_signature" && m.type !== "abstract_method_signature") continue;
    const nameNode = m.childForFieldName("name") ?? m.childForFieldName("property");

    if (!nameNode) continue;

    if (nameNode.type === "computed_property_name") {
      facts.unsupported.push(unsupportedAt(m, `unsupported construct \`computed class member\``, "whole"));
      continue;
    }

    // Static and private flags. `#name` is private by the language; `private` only by TypeScript.
    const mname = memberName(nameNode);
    const hash = nameNode.type === "private_property_identifier";
    const isStatic = m.children.some((c) => c.type === "static");
    const isPrivate = hash || m.children.some((c) => c.type === "accessibility_modifier" && c.text === "private");

    const flag = (member: DeclFact): DeclFact => {
      if (isStatic) member.static = true;

      if (hash) member.hash = true;

      return member;
    };

    if (!isField) {
      // A method: a fn member, exported unless private; only a method with a body has calls.
      const member = flag(fnDecl(mname, m, m, !isPrivate, m.type === "method_definition" ? declCalls(m, scope) : [], collectTypeRefs(m, typeParams)));

      const accessor = m.children.find((c) => c.type === "get" || c.type === "set")?.type;

      if (accessor === "get" || accessor === "set") member.accessor = accessor;
      // A constructor also carries its parameters' decorators (`@Inject(T) private x`).
      const withParams = mname === "constructor" ? [...memberDecorators, ...parameterDecorators(m)] : memberDecorators;

      if (withParams.length > 0) member.decorators = withParams;
      addMember(members, member);
      continue;
    }

    // A field: a function value makes it a fn member; any other value adds its types and initializer calls.
    const written = m.childForFieldName("value");
    const value = written ? unwrapValue(written) : null;

    if (value && FUNCTION_VALUES.has(value.type)) {
      members.push(flag(fnDecl(mname, m, value, !isPrivate, declCalls(value, scope), collectTypeRefs(m, typeParams))));
      continue;
    }

    fieldTypes.push(...collectTypeRefs(m, typeParams));

    if (!value) continue;
    const calls = declCalls(value, scope);

    if (calls.length === 0) continue;
    (m.children.some((c) => c.type === "static") ? statics : instance).push({ node: m, calls });
  }

  // Instance initializers run before the constructor body, so their calls come first in it.
  if (instance.length > 0) {
    const constructor = members.find((m) => m.kind === "fn" && m.name === "constructor");

    if (constructor) constructor.calls.unshift(...instance.flatMap((item) => item.calls));
    else members.push(initializer("constructor", instance));
  }

  // Static initializers become a synthesized `static` member, unless the class already has one by that name.
  if (statics.length > 0) {
    if (members.some((m) => m.name === "static")) for (const item of statics) facts.unsupported.push(unsupportedAt(item.node, "static initializer of a class with a member named `static`", "whole"));
    else members.push(initializer("static", statics));
  }

  // The class's own types: type-parameter constraints and defaults, heritage, and its fields.
  const heritageNode = cls.namedChildren.find((c) => c.type === "class_heritage" || c.type === "extends_type_clause" || c.type === "extends_clause");
  // `class C<T extends Order, U = Item>`: a constraint and a default name types; the parameters themselves do not.
  const typeParamsNode = cls.childForFieldName("type_parameters");
  const types = [...(typeParamsNode ? collectTypeRefs(typeParamsNode, typeParams) : []), ...(heritageNode ? collectTypeRefs(heritageNode, typeParams) : []), ...fieldTypes];
  const out = decl("class", name, at, heritage(cls), exported, [], types, members);
  // A hash of the class body's value code, as for a module.
  const values = valuesFingerprint(items, members);

  if (values !== undefined) out.values = values;
  const base = heritageNode ? baseClass(heritageNode) : null;

  if (base) out.base = base;
  // `implements Repo, Store<T>`: the interfaces by the names written, so a call through one reaches this class.
  const implemented = heritageNames(heritageNode?.namedChildren.find((c) => c.type === "implements_clause"));

  if (implemented.length > 0) out.implements = implemented;
  // `@Controller('x') export class X` puts the decorator on the `export` statement.
  const wrapper = parentOf(cls);
  const classDecorators = [...(wrapper?.type === "export_statement" ? decoratorsOf(wrapper) : []), ...decoratorsOf(cls)];

  if (classDecorators.length > 0) out.decorators = classDecorators;
  // The class's shape: its public typed instance fields. Without any (a JavaScript class) it stays unknown.
  const shape = items.flatMap((m) => classField(m) ?? []);

  if (shape.length > 0) out.shape = shape;

  return out;
}

/**
 * The shape of an interface (its body) or of a type alias whose value is an
 * object type literal; undefined for an enum, any other alias and a body
 * tree-sitter could not read. `planned type` fields are checked against it.
 */
function typeShape(node: Node): TypeFieldFact[] | undefined {
  const body = node.type === "interface_declaration" ? node.childForFieldName("body") : node.type === "type_alias_declaration" ? node.childForFieldName("value") : null;

  if (!body || (body.type !== "interface_body" && body.type !== "object_type")) return undefined;

  return body.namedChildren.flatMap((m) => signatureField(m) ?? []);
}

/**
 * One member of an interface or object type: `name?: T` from a property
 * signature, `name?: (params) => R` from a method signature. Null for an
 * index, call or construct signature, a quoted or computed name, and a
 * member without a type annotation (a method without a return type).
 */
function signatureField(m: Node): TypeFieldFact | null {
  const name = m.childForFieldName("name");

  if (!name || name.type !== "property_identifier") return null;
  const optional = m.children.some((c) => c.type === "?");

  if (m.type === "property_signature") {
    const type = annotation(m.childForFieldName("type"));

    return type === null ? null : { name: name.text, optional, type };
  }

  if (m.type !== "method_signature") return null;
  const params = m.childForFieldName("parameters");
  const ret = annotation(m.childForFieldName("return_type"));

  return params && ret !== null ? { name: name.text, optional, type: `${collapse(params.text)} => ${ret}` } : null;
}

/**
 * A public instance field of a class with a type annotation: not `static`,
 * `private`, `protected` or `#private`, and not a field whose value is a
 * function (that one is a method of the map). Null for anything else.
 */
function classField(m: Node): TypeFieldFact | null {
  if (m.type !== "public_field_definition" && m.type !== "field_definition") return null;
  const name = m.childForFieldName("name") ?? m.childForFieldName("property");

  if (!name || name.type !== "property_identifier") return null;

  if (m.children.some((c) => c.type === "static" || (c.type === "accessibility_modifier" && c.text !== "public"))) return null;
  const value = m.childForFieldName("value");

  if (value && FUNCTION_VALUES.has(unwrapValue(value).type)) return null;
  const type = annotation(m.childForFieldName("type"));

  return type === null ? null : { name: name.text, optional: m.children.some((c) => c.type === "?"), type };
}

/** The type of a `: T` annotation node, whitespace collapsed; null without one. */
function annotation(node: Node | null): string | null {
  if (!node) return null;
  const type = collapse(node.text.replace(/^:\s*/, ""));

  return type === "" ? null : type;
}

/** The decorators that are children of a node: a class, an `export` statement, a member, a parameter. */
function decoratorsOf(node: Node): CodeDecorator[] {
  return node.children.flatMap((c) => (c.type === "decorator" ? (decoratorFact(c) ?? []) : []));
}

/** `constructor(@Inject(T) private readonly x: I)`: each parameter's decorators, with its position, name and type. */
function parameterDecorators(ctor: Node): CodeDecorator[] {
  const params = ctor.childForFieldName("parameters")?.namedChildren.filter((p) => p.type === "required_parameter" || p.type === "optional_parameter") ?? [];

  return params.flatMap((param, index) => {
    const pattern = param.childForFieldName("pattern");
    const name = pattern?.type === "identifier" ? pattern.text : null;
    const type = typeName(param.childForFieldName("type"));

    return decoratorsOf(param).map((d) => ({ ...d, param: { index, name, type } }));
  });
}

/** `@Get(':id')` → `Get` with its arguments; `@Injectable` → no arguments. Null for a decorator that names nothing (`@(x)`). */
function decoratorFact(node: Node): CodeDecorator | null {
  const expr = node.namedChildren.find((c) => c.type !== "comment");

  if (!expr) return null;
  const at = located(node);
  // `@Get(':id')` is a call of `Get`; `@Injectable` is the bare name. Anything else names nothing.
  const callee = expr.type === "call_expression" ? expr.childForFieldName("function") : expr;

  if (!callee || (callee.type !== "identifier" && callee.type !== "member_expression")) return null;
  const args = expr.type === "call_expression" ? (expr.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? []) : [];

  return { name: collapse(callee.text), args: args.map(decoratorArg), line: at.line, col: at.col };
}

/** A decorator argument as a value archdiff reads without running code. */
function decoratorArg(node: Node): DecoratorArg {
  const n = unwrapValue(node);
  const literal = stringValue(n) ?? templateValue(n);

  if (literal !== null) return { kind: "string", value: literal };

  if (n.type === "number" && Number.isFinite(Number(n.text))) return { kind: "number", value: Number(n.text) };

  // A plain identifier or a dotted name (`Role.Admin`): the regex rejects calls, indexes and spaces.
  if (n.type === "identifier" || (n.type === "member_expression" && /^[\w$.]+$/.test(n.text))) return { kind: "name", name: n.text };

  if (FUNCTION_VALUES.has(n.type)) return { kind: "function" };

  if (n.type === "array") return { kind: "array", items: n.namedChildren.filter((c) => c.type !== "comment").map((c) => ({ ...decoratorArg(c), line: located(c).line, col: located(c).col })) };

  // An object literal: each property whose key is static. Spreads and computed keys are dropped.
  if (n.type === "object") {
    const props: { key: string; value: DecoratorArg; line: number; col: number }[] = [];

    for (const p of n.namedChildren) {
      const at = located(p);

      if (p.type === "pair") {
        const k = p.childForFieldName("key");
        const v = p.childForFieldName("value");
        const key = k ? (stringValue(k) ?? (k.type === "property_identifier" ? k.text : null)) : null;

        if (key !== null && v) props.push({ key, value: decoratorArg(v), line: at.line, col: at.col });
      } else if (p.type === "shorthand_property_identifier") props.push({ key: p.text, value: { kind: "name", name: p.text }, line: at.line, col: at.col });
      else if (p.type === "method_definition") {
        const k = p.childForFieldName("name");

        if (k) props.push({ key: k.text, value: { kind: "function" }, line: at.line, col: at.col });
      }
    }

    return { kind: "object", props };
  }

  const text = collapse(n.text);

  // Anything else is kept as shortened text.
  return { kind: "other", text: text.length <= MAX_CALLEE ? text : `${text.slice(0, MAX_CALLEE - 1)}…` };
}

/** A template literal without substitutions: its text; null otherwise. */
function templateValue(n: Node): string | null {
  if (n.type !== "template_string" || n.namedChildren.some((c) => c.type === "template_substitution")) return null;

  return n.text.slice(1, -1);
}

/** The type names of an `implements` or an interface's `extends` clause, their type arguments left off (`Store<T>` → `Store`). */
function heritageNames(clause: Node | undefined): string[] {
  return (clause?.namedChildren ?? []).map((type) => collapse(type.text).replace(/<[\s\S]*$/, "").trim()).filter((name) => name !== "");
}

/** The `extends` expression: `(extends_clause value: …)` in TypeScript, the bare expression in JavaScript. */
function baseClass(heritage: Node): string | null {
  const clause = heritage.type === "extends_clause" ? heritage : heritage.namedChildren.find((c) => c.type === "extends_clause");
  const value = clause ? clause.childForFieldName("value") : heritage.type === "class_heritage" ? heritage.namedChildren[0] : null;

  return value && value.type !== "implements_clause" ? collapse(value.text) : null;
}

/** `(f)`, `f as T`, `f satisfies T`, `f!`: the expression they wrap. */
export function unwrapValue(node: Node): Node {
  let at = node;

  while ((at.type === "parenthesized_expression" || at.type === "as_expression" || at.type === "satisfies_expression" || at.type === "non_null_expression") && at.namedChildren[0]) at = at.namedChildren[0];

  return at;
}

/** Expression node types that are a function value. */
const FUNCTION_VALUES = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

/** Literals by the class of the language their value is: a method called on a constant holding one is that class's. */
const LITERAL_CLASSES: ReadonlyMap<string, string> = new Map([["array", "Array"], ["string", "String"], ["template_string", "String"], ["number", "Number"], ["regex", "RegExp"]]);

/** Wrappers that return the component they wrap; their `const` is the fn of the wrapped render. */
const REACT_WRAPPERS = new Set(["memo", "forwardRef", "lazy"]);

/**
 * The function a React wrapper call hides: `memo(() => …)` is the function it
 * wraps when — and only when — the callee is bound by an import from `react`
 * (the `names` / `objects` such an import binds; `React.memo` through a
 * default or namespace import counts). By name alone a `forwardRef` from
 * `@nestjs/common` or a local `memo` would unwrap too, so the import decides,
 * not the text. The wrapped function is the first argument; any other shape
 * keeps the declarator a value.
 */
function reactWrapperFn(value: Node, react: ReactBindings): Node | null {
  if (value.type !== "call_expression") return null;
  const callee = value.childForFieldName("function");
  const bound = callee ? reactExportOf(callee, react) : null;

  if (!bound || !REACT_WRAPPERS.has(bound.name)) return null;
  const arg = value.childForFieldName("arguments")?.namedChildren.find((c) => c.type !== "comment");
  const fn = arg ? unwrapValue(arg) : null;

  return fn && FUNCTION_VALUES.has(fn.type) ? fn : null;
}

/** A synthesized member over the initializers it runs, from the first to the last. */
function initializer(name: "constructor" | "static", items: { node: Node; calls: CallFact[] }[]): DeclFact {
  // The span runs from the first initializer to the last; the fingerprint joins theirs in order,
  // and the imported names they read are deduplicated and sorted for stable output.
  const first = located(items[0]!.node);
  const last = located(items[items.length - 1]!.node);
  const prints = items.map((item) => fingerprintFacts(item.node));
  const readsImports = [...new Set(prints.flatMap((p) => p.readsImports ?? []))].sort();

  const fact: DeclFact = { kind: "fn", name, line: first.line, col: first.col, endLine: last.endLine, endCol: last.endCol, signature: null, exported: true, calls: items.flatMap((item) => item.calls), types: [], members: [], fingerprint: prints.map((p) => p.fingerprint).join(":") };

  if (readsImports.length > 0) fact.readsImports = readsImports;

  return fact;
}

/** A member's name as code calls it: a string key unquoted, a `#private` name without its `#`. */
function memberName(node: Node): string {
  const text = node.type === "string" ? (stringValue(node) ?? node.text) : node.text;

  return text.replace(/^#/, "");
}

/** Where `this.<field>` values come from, for `this.decoder.feed()` and `this.run()`. */
interface ClassScope {
  /** Field → class named by its type annotation, `new X()` initializer, or constructor assignment. */
  fields: Map<string, string>;
  /** Field → hook set in the constructor: `this.analyzer = options.analyzer ?? analyze`. */
  hooks: Map<string, HookFact>;
  /** Field → the constructor parameter that fills it: a parameter property (`private readonly x`), or `this.x = p`. */
  params: Map<string, string>;
}

/** What the class body says about its fields: their classes, constructor hooks and the parameters that fill them. */
function classScope(items: readonly Node[]): ClassScope {
  const fields = new Map<string, string>();
  const hooks = new Map<string, HookFact>();
  const fromParams = new Map<string, string>();

  // Declared fields: the class from the type annotation, else from a `new X()` initializer.
  for (const m of items) {
    if (m.type !== "public_field_definition" && m.type !== "field_definition") continue;
    const nameNode = m.childForFieldName("name") ?? m.childForFieldName("property");

    if (!nameNode || nameNode.type === "computed_property_name") continue;
    const type = typeName(m.childForFieldName("type")) ?? newClass(m.childForFieldName("value"));

    if (type) fields.set(memberName(nameNode), type);
  }

  // The constructor adds parameter properties and `this.x = …` assignments.
  const ctor = items.find((m) => m.type === "method_definition" && m.childForFieldName("name")?.text === "constructor");

  if (!ctor) return { fields, hooks, params: fromParams };
  const params = ctor.childForFieldName("parameters")?.namedChildren.filter((p) => p.type === "required_parameter" || p.type === "optional_parameter") ?? [];
  params.forEach((param, index) => {
    // `constructor(private readonly x: X = fallback)` declares a field.
    if (!param.children.some((c) => c.type === "accessibility_modifier" || c.type === "readonly" || c.type === "override_modifier")) return;
    const pattern = param.childForFieldName("pattern");

    if (pattern?.type !== "identifier") return;
    fromParams.set(pattern.text, pattern.text);
    const type = typeName(param.childForFieldName("type"));

    if (type) fields.set(pattern.text, type);
    const fallback = param.childForFieldName("value");
    const callee = fallback ? fallbackCallee(fallback, ctor) : null;

    if (callee) hooks.set(pattern.text, { name: pattern.text, fallback: callee, param: index, path: "", owner: "constructor" });
  });
  const paramIndex = (name: string): number => params.findIndex((p) => p.childForFieldName("pattern")?.text === name);

  // Top-level `this.x = …` statements of the constructor body: `new X()` gives the class,
  // a parameter gives the parameter (and its type).
  for (const stmt of ctor.childForFieldName("body")?.namedChildren ?? []) {
    const expr = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;

    if (expr?.type !== "assignment_expression") continue;
    const left = expr.childForFieldName("left");
    const right = expr.childForFieldName("right");

    if (left?.type !== "member_expression" || left.childForFieldName("object")?.type !== "this" || !right) continue;
    const field = memberName(left.childForFieldName("property")!);
    const created = newClass(right);

    if (created) fields.set(field, created);
    else if (right.type === "identifier" && paramIndex(right.text) !== -1) {
      fromParams.set(field, right.text);
      const type = typeName(params[paramIndex(right.text)]!.childForFieldName("type"));

      if (type) fields.set(field, type);
    }

    // `this.run = options.run ?? defaultRun`: the default runs unless a caller injects one.
    const hook = fallbackOf(right, ctor);

    if (!hook) continue;
    const source = hook.source;
    let param: number | null = null;
    let path = "";

    // The injecting side: a parameter (`p ?? f`) or a property of one (`options.run ?? f`). Anything else injects nothing known.
    if (source.type === "identifier") param = paramIndex(source.text);
    else if (source.type === "member_expression" && source.childForFieldName("object")?.type === "identifier") {
      param = paramIndex(source.childForFieldName("object")!.text);
      path = source.childForFieldName("property")?.text ?? "";
    }

    hooks.set(field, { name: field, fallback: hook.fallback, param: param === -1 ? null : param, path: param === -1 ? "" : path, owner: "constructor" });
  }

  return { fields, hooks, params: fromParams };
}

/** The import facts of one `import` statement: none when its source is not a plain string. */
function importStatement(node: Node): ImportFact[] {
  // TypeScript `import y = require("./y")`: `y` is the whole module.
  const required = node.namedChildren.find((c) => c.type === "import_require_clause");

  if (required) {
    const local = required.namedChildren.find((c) => c.type === "identifier")?.text;
    const from = required.childForFieldName("source");
    const spec = from ? stringValue(from) : null;

    return local && spec !== null ? [importAt(node, spec, [{ kind: "module", local }], false)] : [];
  }

  const source = node.childForFieldName("source");
  const spec = source ? stringValue(source) : null;

  if (spec === null) return [];
  const bindings: ImportBinding[] = [];
  const clause = node.namedChildren.find((c) => c.type === "import_clause");

  // The clause binds a default (`a`), a namespace (`* as ns`) and named imports (`{ b as c }`).
  for (const c of clause?.namedChildren ?? []) {
    if (c.type === "identifier") bindings.push({ kind: "default", local: c.text });
    else if (c.type === "namespace_import") {
      const id = c.namedChildren.find((x) => x.type === "identifier");

      if (id) bindings.push({ kind: "module", local: id.text, namespace: true });
    } else if (c.type === "named_imports") {
      for (const s of c.namedChildren) {
        if (s.type !== "import_specifier") continue;
        const name = s.childForFieldName("name")?.text;
        const alias = s.childForFieldName("alias")?.text ?? name;

        if (name && alias) bindings.push({ kind: "named", local: alias, imported: name });
      }
    }
  }

  // `import type …` is erased from the code that runs. `import { type A }` is erased unless
  // `verbatimModuleSyntax` keeps it as `import {} from`: the graph decides, with the tsconfig.
  const fact = importAt(node, spec, bindings, false);
  const parts = clause?.namedChildren.filter((c) => c.type !== "comment") ?? [];

  if (typeKeyword(node)) fact.typeOnly = true;
  else if (parts.length === 1 && parts[0]!.type === "named_imports" && inlineTypesOnly(parts[0]!, "import_specifier")) fact.inlineTypeOnly = true;

  return [fact];
}

/** Literal `import("…")` / `require("…")` anywhere in the file. A non-literal specifier is coverage, not an edge. */
function collectDynamicImports(root: Node, facts: FileFacts): void {
  // Record one dynamic import, unless the same source on the same line is already an import (a top-level `require`).
  const add = (node: Node, spec: string, optional: boolean, typeOnly = false): void => {
    const line = node.startPosition.row + 1;
    const same = facts.imports.find((i) => i.source === spec && i.line === line);

    if (same) {
      // One runtime `import()` on the line makes the dependency a runtime one.
      if (same.typeOnly && !typeOnly) delete same.typeOnly;

      return;
    }

    const fact = importAt(node, spec, [], false);

    if (optional) fact.optional = true;

    if (typeOnly) fact.typeOnly = true;
    facts.imports.push(fact);
  };

  // Every call and `new` in the file, inside declarations or not.
  walkNamed(root, (node) => {
    if (node.type === "new_expression" || node.type === "call_expression") {
      // `new URL("./w.ts", import.meta.url)` and similar module URLs; null means the specifier is computed.
      const specs = moduleUrlSpecs(node);

      if (specs === null) facts.unsupported.push(unsupportedAt(node, "computed specifier", "whole"));

      for (const spec of specs ?? []) add(node, spec.spec, spec.optional);
    }

    // SFCC `module.superModule`: the same file in the next cartridge of the cartridge path, an import the resolver places.
    if (node.type === "member_expression" && isSuperModule(node)) add(node, SUPER_MODULE, false);

    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const isImport = fn?.type === "import";
      // A `require` parameter or local is not Node's; `createRequire(…)`'s is.
      const isRequire = fn?.type === "identifier" && fn.text === "require" && requireKind(fn) !== "shadowed";
      // `import.meta.resolve("./w.ts")` names a module the way `import()` does.
      const isResolve = fn?.type === "member_expression" && fn.text.replace(/\s+/g, "") === "import.meta.resolve";

      if (isImport || isRequire || isResolve) {
        const arg = node.childForFieldName("arguments")?.namedChildren[0];

        // A literal specifier is an import; any other argument is a computed specifier, recorded as unsupported.
        if (arg?.type === "string") {
          const spec = stringValue(arg);

          if (spec) add(node, spec, false, isImport && inTypePosition(node));
        } else if (arg) {
          facts.unsupported.push(unsupportedAt(node, "computed specifier", "whole"));
        }
      }
    }
  });
}

/** Nodes whose whole subtree is a type: an `import("./a")` in one is erased by tsc. */
const TYPE_CONTEXT = new Set(["type_annotation", "opting_type_annotation", "omitting_type_annotation", "asserts_annotation", "type_predicate_annotation", "type_query", "type_arguments", "type_parameters", "type_alias_declaration", "interface_declaration", "implements_clause"]);

/**
 * Whether an `import(…)` call is written where a type goes (`x: import("./a").A`,
 * `typeof import("./a")`, `v as import("./a").T`): a type-only dependency, as `import type` is.
 */
function inTypePosition(node: Node): boolean {
  // Climb until a type context says yes, or a statement block or the program says the call is in value code.
  for (let child = node, parent = node.parent; parent !== null; child = parent, parent = parent.parent) {
    if (TYPE_CONTEXT.has(parent.type)) return true;

    // `v as T`, `v satisfies T`: the operand after the value is the type.
    if ((parent.type === "as_expression" || parent.type === "satisfies_expression") && parent.namedChildren[0]?.id !== child.id) return true;

    if (parent.type === "statement_block" || parent.type === "program") return false;
  }

  return false;
}

/** Namespace, `eval`, `new Function`, and a call through `obj[expr]` are coverage, not edges. */
function collectUnsupported(root: Node, facts: FileFacts): void {
  walkNamed(root, (node) => {
    if (node.type === "internal_module" || (node.type === "module" && parentOf(node)?.type !== "ambient_declaration")) facts.unsupported.push(unsupportedAt(node, "unsupported construct `namespace`", "whole"));

    if (node.type === "call_expression" || node.type === "new_expression") {
      const written = node.childForFieldName(node.type === "call_expression" ? "function" : "constructor");
      const fn = written ? unwrapValue(written) : null;

      if (node.type === "call_expression" && fn?.type === "identifier" && fn.text === "eval") facts.unsupported.push(unsupportedAt(fn, "unsupported construct `eval`", "whole"));

      if (fn?.type === "subscript_expression") facts.unsupported.push(unsupportedAt(fn, "unsupported construct `computed call`", "whole"));

      if (node.type === "new_expression" && fn?.type === "identifier" && fn.text === "Function") facts.unsupported.push(unsupportedAt(fn, "unsupported construct `Function`", "whole"));
    }
  });
}


/**
 * The callee of a call or a function value in an argument: `f`, `a.b`,
 * `this.m`, or `this.field.m` when the field's class is known. Null for any
 * other shape.
 */
function calleeFact(n: Node, stop: Node, cls: ClassScope | null, depth = 0): CallFact | null {
  // A plain name: bound when a parameter or local of an enclosing scope declares it; a local may be a module's export
  // the function loads (`const { f } = await import("./x")`).
  if (n.type === "identifier" || n.type === "shorthand_property_identifier") {
    const fact = boundCall(callFact(n.text, n), bindingOf(n, n.text, stop));
    const imported = fact.bound === "local" ? localImport(n, n.text, stop) : null;

    if (imported) fact.imported = imported;

    return fact;
  }

  if (n.type !== "member_expression") return null;
  const obj = n.childForFieldName("object");
  const prop = n.childForFieldName("property");

  if (!obj || !prop) return null;

  // `this.m`: a member of the class, possibly a hook its constructor set.
  if (obj.type === "this") {
    // `this` of an object-literal method or a nested `function` is not the class.
    if (!classThis(n)) return { ...callFact(`this.${prop.text}`, n), bound: "local" };
    const fact = callFact(`this.${prop.text}`, n);
    const hook = cls?.hooks.get(memberName(prop));

    if (hook) fact.hook = hook;

    return fact;
  }

  // `a.b`: bound when `a` is local; then a local `const a = new A()` may name the receiver's class, and a local
  // `const a = makeA()` the call whose result it is.
  if (obj.type === "identifier") {
    const fact = boundCall(callFact(`${obj.text}.${prop.text}`, n), bindingOf(n, obj.text, stop));
    const receiver = fact.bound ? localClass(n, obj.text, stop) : null;
    // `const x = require("./x"); x.f()`: the export `f` of the module the function loads.
    const loaded = fact.bound === "local" ? localImport(n, obj.text, stop) : null;
    const on = fact.bound === "local" && !receiver && !loaded ? localResult(n, obj.text, stop, cls, depth) : null;

    if (loaded?.name === "*") fact.imported = { source: loaded.source, name: prop.text };

    if (receiver) fact.receiver = receiver;

    if (on) {
      fact.on = on;
      fact.member = prop.text;
    }

    return fact;
  }

  // `this.decoder.feed()`: the receiver is a field whose class the class body names.
  const field = obj.type === "member_expression" && obj.childForFieldName("object")?.type === "this" ? obj.childForFieldName("property") : null;
  const type = field ? cls?.fields.get(memberName(field)) : undefined;

  if (field && type && classThis(n)) {
    const param = cls?.params.get(memberName(field));

    const fact = callFact(`this.${field.text}.${prop.text}`, n);
    fact.receiver = type;

    if (param !== undefined) fact.param = param;

    return fact;
  }

  // `this.repo.save()` with `constructor(@Inject(T) private repo)` and no class archdiff can name: a framework's config may set it.
  const param = field && classThis(n) ? cls?.params.get(memberName(field)) : undefined;

  if (field && param !== undefined) return { ...callFact(`this.${field.text}.${prop.text}`, n), param };
  // `new Foo().run()`: an instance of the class `new` names, unless `Foo` is rebound here.
  const created = newClass(unwrapValue(obj));
  const text = collapse(n.text);

  if (created && bindingOf(obj, created, stop) === null) return { ...callFact(text.length < MAX_CALLEE ? text : shortMember(n), n), receiver: created };

  return null;
}

/** `this` at `n` is the class instance: the nearest enclosing non-arrow function is a class member, or a field initializer or `static {}` holds it. */
function classThis(n: Node): boolean {
  // Arrow functions keep the outer `this`, so they are climbed through.
  for (let at = parentOf(n); at; at = parentOf(at)) {
    if (at.type === "class_body") return true;

    if (FUNCTION_NODES.has(at.type) && at.type !== "arrow_function") return at.type === "method_definition" && parentOf(at)?.type === "class_body";
  }

  return false;
}

/**
 * Function values in the arguments: the argument itself (`run(save)`,
 * `run(this.m)`, `run(obj.m)` with the class of `obj` known, `run(this.m.bind(this))`)
 * or a property of an object literal. A closure literal is not a pass: its
 * calls carry `closureArg`.
 */
function passesOf(call: Node, stop: Node, cls: ClassScope | null): PassFact[] {
  if (call.type !== "call_expression" && call.type !== "new_expression") return [];
  const args = call.childForFieldName("arguments");

  if (args?.type !== "arguments") return [];
  const out: PassFact[] = [];
  // Each argument, by its position among the arguments (comments do not count).
  args.namedChildren.filter((arg) => arg.type !== "comment").forEach((arg, index) => {
    const add = (node: Node, path: string, written: Node = node): void => {
      const fact = calleeFact(node, stop, cls);

      // A local value of unknown class names nothing the graph can resolve.
      if (!fact || (fact.bound && !fact.receiver)) return;
      const at = located(written);
      const pass: Omit<PassFact, "text" | "line" | "col" | "endLine" | "endCol"> = { arg: index, path, callee: fact.callee };

      if (fact.bound) pass.bound = fact.bound;

      if (fact.receiver) pass.receiver = fact.receiver;
      // Object.assign appends the text and position after the optional keys, in the key order of a pass fact.
      out.push(Object.assign(pass, { text: collapse(at.text).slice(0, MAX_CALLEE), line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol }));
    };

    // The argument itself is a function value: `run(save)`, `run(this.m)`.
    if (arg.type === "identifier" || arg.type === "member_expression") add(arg, "");
    // `this.m.bind(this)`: the function `this.m`, with `this` fixed.
    const bound = arg.type === "call_expression" ? arg.childForFieldName("function") : null;
    const fn = bound?.type === "member_expression" && bound.childForFieldName("property")?.text === "bind" ? bound.childForFieldName("object") : null;

    if (fn && (fn.type === "identifier" || fn.type === "member_expression")) add(fn, "", arg);

    // An object literal: each property that names a function, by its key (`{ generate: worker.generate }`).
    if (arg.type !== "object") return;

    for (const p of arg.namedChildren) {
      if (p.type === "shorthand_property_identifier") add(p, p.text);

      if (p.type !== "pair") continue;
      const key = p.childForFieldName("key");
      const value = p.childForFieldName("value");

      if (key && value && (key.type === "property_identifier" || key.type === "string")) add(value, memberName(key));
    }
  });

  return out;
}

/**
 * A call inside a function nested in the declaration `stop` gets `closure`;
 * when every such function is a closure literal written as an argument of a
 * call (`items.map(() => hit())`, `new Promise((ok) => hit())`), also
 * `closureArg` at the outermost one. A closure stored in a value, a method of
 * an object literal, a nested `function` declaration: `closure` alone.
 */
function markClosure(fact: CallFact, n: Node, stop: Node): void {
  let outermost: Node | null = null;
  let stored = false;

  // Climb from the call to the declaration: remember the outermost function and whether any is stored rather than passed.
  for (let at = parentOf(n); at && at.id !== stop.id; at = parentOf(at)) {
    if (!FUNCTION_NODES.has(at.type)) continue;
    outermost = at;

    if (parentOf(at)?.type !== "arguments") stored = true;
  }

  if (!outermost) return;
  fact.closure = true;

  if (!stored) fact.closureArg = { line: outermost.startPosition.row + 1, col: startCol(outermost) };
}

/** `: X` → `X`; generics, unions and qualified names are not a class the graph can resolve. */
function typeName(annotation: Node | null): string | null {
  const type = annotation?.type === "type_annotation" ? annotation.namedChildren[0] : null;

  return type?.type === "type_identifier" ? type.text : null;
}

/** `new X(…)` → `X`. */
function newClass(value: Node | null): string | null {
  const ctor = value?.type === "new_expression" ? value.childForFieldName("constructor") : null;

  return ctor?.type === "identifier" ? ctor.text : null;
}

/** What binds a name in scope: a declarator, a parameter (with its function and position), or another kind of binding. */
type BindingSite = { kind: "local"; node: Node } | { kind: "parameter"; node: Node; fn: Node; index: number } | { kind: "other" };

/**
 * The nearest binding of `name` between `from` and `stop`, in the scopes
 * `bindingOf` walks: a declarator or a parameter; `other` for a loop or
 * `catch` variable, a nested function or class name. Null when nothing binds it.
 */
function declarationOf(from: Node, name: string, stop: Node): BindingSite | null {
  // Walk out from `from` to `stop`, checking at each level the scope that level opens. The nearest binding wins.
  for (let at: Node | null = from; at; at = parentOf(at)) {
    // A function: its parameters (`x =>` has a single one), then its own name, which a named
    // function expression binds inside itself.
    if (FUNCTION_NODES.has(at.type)) {
      const single = at.childForFieldName("parameter");

      if (single?.type === "identifier" && single.text === name) return { kind: "parameter", node: single, fn: at, index: 0 };
      const params = at.childForFieldName("parameters")?.namedChildren.filter((p) => p.type !== "comment") ?? [];

      for (const [index, param] of params.entries()) if (patternNames(param).includes(name)) return { kind: "parameter", node: param, fn: at, index };

      if (at.id !== stop.id && at.type !== "arrow_function" && at.childForFieldName("name")?.text === name) return { kind: "other" };
    }

    // A block or the module: `const`/`let`/`var` declarators and other declarations among its statements.
    // Position is not checked: a declaration anywhere in the block binds the name in all of it, as JS scoping does.
    if (BLOCK_NODES.has(at.type) || at.type === "program") {
      for (const stmt of blockStatements(at)) {
        const target = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;

        if (!target) continue;

        if (target.type === "lexical_declaration" || target.type === "variable_declaration") {
          for (const d of target.namedChildren) {
            const pattern = d.type === "variable_declarator" ? d.childForFieldName("name") : null;

            if (pattern && patternNames(pattern).includes(name)) return { kind: "local", node: d };
          }
        } else if (declaredNames(target).includes(name)) return { kind: "other" };
      }
    }

    // Loop and `catch` variables bind the name, but carry no value archdiff reads.
    if (at.type === "for_in_statement") {
      const left = at.childForFieldName("left");

      if (left && patternNames(left).includes(name)) return { kind: "other" };
    }

    if (at.type === "for_statement") {
      const init = at.childForFieldName("initializer");

      if (init && declaredNames(init).includes(name)) return { kind: "other" };
    }

    if (at.type === "catch_clause") {
      const param = at.childForFieldName("parameter");

      if (param && patternNames(param).includes(name)) return { kind: "other" };
    }

    if (at.id === stop.id) break;
  }

  return null;
}

/**
 * Class of a local or parameter: `const w = new X()`, `const w: X = …`, `(w: X) =>`.
 * Null when a nearer binding (a loop variable) hides the declaration, or when
 * `X` itself is rebound between the declaration and `stop` (`const X = Ctor`).
 */
function localClass(from: Node, name: string, stop: Node): string | null {
  const binding = declarationOf(from, name, stop);

  if (!binding || binding.kind === "other") return null;
  let type: string | null;

  // A local: its annotation, else its `new X()` initializer. A parameter: its annotation. Destructured names have no class.
  if (binding.kind === "local") type = binding.node.childForFieldName("name")?.type === "identifier" ? (typeName(binding.node.childForFieldName("type")) ?? newClass(binding.node.childForFieldName("value"))) : null;
  else type = binding.node.childForFieldName("pattern")?.type === "identifier" ? typeName(binding.node.childForFieldName("type")) : null;

  // The class name must not itself be shadowed in scope, or it names something else.
  return type && bindingOf(binding.node, type, stop) === null ? type : null;
}

/** `x ?? f` / `x || f` with a callee `f`: the value `x` and the default. */
function fallbackOf(expr: Node, stop: Node): { source: Node; fallback: string } | null {
  if (expr.type !== "binary_expression") return null;
  const operator = expr.childForFieldName("operator")?.text;
  const left = expr.childForFieldName("left");
  const right = expr.childForFieldName("right");

  if ((operator !== "??" && operator !== "||") || !left || !right) return null;
  const fallback = fallbackCallee(right, stop);

  return fallback ? { source: left, fallback } : null;
}

/** A default that names a declaration: an unbound `f`, `mod.f`, or `this.m`. */
function fallbackCallee(node: Node, stop: Node): string | null {
  if (node.type === "identifier") return bindingOf(node, node.text, stop) === null ? node.text : null;

  if (node.type !== "member_expression") return null;
  const obj = node.childForFieldName("object");
  const prop = node.childForFieldName("property");

  if (!obj || !prop) return null;

  if (obj.type === "this") return `this.${prop.text}`;

  return obj.type === "identifier" && bindingOf(node, obj.text, stop) === null ? `${obj.text}.${prop.text}` : null;
}

/**
 * The hook behind a call of a local or parameter `name`:
 * `const g = request.generate ?? generateMap`, `const { g = f } = request`,
 * `function run(g = f)`, `function run({ g = f })`. Injection is known only
 * for a parameter of the declaration itself.
 */
function localHook(from: Node, name: string, stop: Node): HookFact | null {
  const binding = declarationOf(from, name, stop);

  if (!binding || binding.kind === "other") return null;

  // A parameter with a default: `function run(g = f)`. Callers inject only into the declaration's own parameters.
  if (binding.kind === "parameter") {
    const found = defaultIn(binding.node, name, "");
    const fallback = found ? fallbackCallee(found.value, stop) : null;

    if (!found || !fallback) return null;

    return { name, fallback, param: binding.fn.id === stop.id ? binding.index : null, path: found.path, owner: "self" };
  }

  const pattern = binding.node.childForFieldName("name");
  const value = binding.node.childForFieldName("value");

  if (!pattern || !value) return null;
  let source: Node;
  let fallback: string;
  let path = "";

  // `const g = x ?? f`: `x` is what a caller may inject.
  if (pattern.type === "identifier") {
    const hook = fallbackOf(value, stop);

    if (!hook) return null;
    source = hook.source;
    fallback = hook.fallback;
  } else {
    // `const { generate = generateMap } = request`
    const found = defaultIn(pattern, name, "");
    const callee = found ? fallbackCallee(found.value, stop) : null;

    if (!found || !callee) return null;
    source = value;
    fallback = callee;
    path = found.path;
  }

  // The injecting value: `request` itself, or its property in `request.generate`.
  const head = source.type === "member_expression" ? source.childForFieldName("object") : source;

  if (source.type === "member_expression") path = source.childForFieldName("property")?.text ?? "";
  const param = head?.type === "identifier" ? declarationOf(binding.node, head.text, stop) : null;
  // Callers inject through a plain parameter of this declaration, not a destructured one or a closure's.
  const index = param?.kind === "parameter" && param.fn.id === stop.id && plainParameter(param.node) ? param.index : null;

  return { name, fallback, param: index, path: index === null ? "" : path, owner: "self" };
}

/** The parameter is a plain name (`p`, `p: T`, `p = d`), not a destructuring pattern. */
function plainParameter(node: Node): boolean {
  if (node.type === "identifier") return true;

  if (node.type === "required_parameter" || node.type === "optional_parameter") return node.childForFieldName("pattern")?.type === "identifier";

  return node.type === "assignment_pattern" && node.childForFieldName("left")?.type === "identifier";
}

/** The default value of `name` in a parameter or pattern, with its property path. */
function defaultIn(node: Node, name: string, path: string): { value: Node; path: string } | null {
  switch (node.type) {
    case "required_parameter":
    case "optional_parameter": {
      const pattern = node.childForFieldName("pattern");
      const value = node.childForFieldName("value");

      if (pattern?.type === "identifier") return pattern.text === name && value ? { value, path } : null;

      return pattern ? defaultIn(pattern, name, path) : null;
    }

    case "assignment_pattern": {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");

      return left?.type === "identifier" && left.text === name && right ? { value: right, path } : null;
    }

    case "object_assignment_pattern": {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");

      return left?.text === name && right ? { value: right, path: left.text } : null;
    }

    case "pair_pattern": {
      const key = node.childForFieldName("key");
      const value = node.childForFieldName("value");
      const found = value ? defaultIn(value, name, path) : null;

      return found && key ? { value: found.value, path: memberName(key) } : null;
    }

    case "object_pattern":
      for (const child of node.namedChildren) {
        const found = defaultIn(child, name, path);

        if (found) return found;
      }

      return null;
    default:
      return null;
  }
}

/**
 * Names read as values: identifiers outside callee and binding positions,
 * shorthand properties, and member names read without a call. The first
 * position of each name in the file.
 */
function collectValueRefs(root: Node, facts: FileFacts): void {
  // The first position of each name; a member read is keyed with a leading `.` so it never collides with a plain name.
  const first = new Map<string, ValueRefFact>();

  const note = (name: string, node: Node, member: boolean): void => {
    const key = `${member ? "." : ""}${name}`;

    if (!first.has(key)) first.set(key, member ? { name, member: true, line: node.startPosition.row + 1, col: startCol(node) } : { name, line: node.startPosition.row + 1, col: startCol(node) });
  };

  // Every node in the file: plain identifiers, destructured properties and member reads.
  walkNamed(root, (node) => {
    const parent = parentOf(node);

    // A local binding of the name is not the module-level declaration; exporting a name is not reading it.
    if (((node.type === "identifier" && parent && !bindsOrCalls(node, parent)) || node.type === "shorthand_property_identifier") && !exportedValue(node) && !memberObject(node, parent, facts)) {
      if (bindingOf(node, node.text, root) === null) note(node.text, node, false);
    }

    // Destructuring reads properties: `const { feed } = decoder` takes the method as a value.
    if (node.type === "shorthand_property_identifier_pattern" || (node.type === "property_identifier" && parent?.type === "pair_pattern" && parent.childForFieldName("key")?.id === node.id)) note(node.text, node, true);

    // `a.b` read without a call and not assigned: a member read, or `mod.b` when `a` is an imported module.
    if ((node.type === "property_identifier" || node.type === "private_property_identifier") && parent?.type === "member_expression" && parent.childForFieldName("property")?.id === node.id) {
      const grand = parentOf(parent);
      const called = calledMember(parent);
      const written = grand?.type === "assignment_expression" && grand.childForFieldName("left")?.id === parent.id;
      const object = parent.childForFieldName("object");
      // `mod.save` of an imported module reads the module function itself.
      const moduleRead = object?.type === "identifier" && moduleSource(facts, object.text, true) !== null && bindingOf(object, object.text, root) === null;

      if (!called && !written) {
        if (moduleRead) note(`${object.text}.${node.text}`, node, false);
        else note(memberName(node), node, true);
      }
    }

    return true;
  });
  // Source order, so the facts are stable whatever order the walk noted them in.
  facts.valueRefs = [...first.values()].sort((a, b) => a.line - b.line || a.col - b.col);
}

/**
 * The identifier is the object of a member access that uses only a member of
 * it: `ns.helper()`, `new ns.X()`, and any `mod.x` of a module binding (the
 * read is `mod.x`, noted on its own). `.call`, `.apply` and `.bind` use the
 * function itself, so they read it.
 */
function memberObject(node: Node, parent: Node | null, facts: FileFacts): boolean {
  if (parent?.type !== "member_expression" || parent.childForFieldName("object")?.id !== node.id) return false;
  const property = parent.childForFieldName("property")?.text;

  if (property === "call" || property === "apply" || property === "bind") return false;

  return calledMember(parent) || moduleSource(facts, node.text, true) !== null;
}

/** The member expression is what a call or `new` runs: `a.b()`, `new a.B()`. */
function calledMember(member: Node): boolean {
  const grand = parentOf(member);

  return (grand?.type === "call_expression" && grand.childForFieldName("function")?.id === member.id) || (grand?.type === "new_expression" && grand.childForFieldName("constructor")?.id === member.id);
}

/**
 * A name the module exports as a value: `export default handler`, `export =
 * handler`, `module.exports = handler` or `= { handler }`, `exports.run = run`.
 * Importers that call it are resolved callers, as for `export { handler }`.
 */
function exportedValue(node: Node): boolean {
  let at = node;
  let parent = parentOf(at);

  // `module.exports = { a, b: impl }`: the property value is the export.
  if (parent?.type === "pair" && parent.childForFieldName("value")?.id === at.id) {
    at = parent;
    parent = parentOf(at);
  }

  // Then from the object literal to what holds it; a shorthand outside an object literal exports nothing.
  if (parent?.type === "object" && (node.type === "shorthand_property_identifier" || at.type === "pair")) {
    at = parent;
    parent = parentOf(at);
  } else if (node.type === "shorthand_property_identifier") return false;

  // `export default handler` / `export = handler`, not `export const` or `export … from`, and not an object.
  if (parent?.type === "export_statement") return at.type !== "object" && parent.childForFieldName("declaration") === null && parent.childForFieldName("source") === null;
  // Otherwise only a top-level assignment to `module.exports` or one of its properties counts.
  const statement = parent ? parentOf(parent) : null;

  if (parent?.type !== "assignment_expression" || parent.childForFieldName("right")?.id !== at.id || statement?.type !== "expression_statement" || (statement ? parentOf(statement) : null)?.type !== "program") return false;
  const left = parent.childForFieldName("left")?.text.replace(/\s+/g, "") ?? "";

  return left === "module.exports" || ((left.startsWith("exports.") || left.startsWith("module.exports.")) && at.type !== "object");
}

/** Parents under which an identifier is a binding or a label, never a value read. */
const BINDING_PARENTS = new Set(["import_specifier", "export_specifier", "namespace_import", "import_clause", "namespace_export", "labeled_statement", "break_statement", "continue_statement", "object_pattern", "array_pattern", "rest_pattern"]);

/** The identifier is a callee, a declared name, or a binding — not a value read. */
function bindsOrCalls(node: Node, parent: Node): boolean {
  const is = (field: string): boolean => parent.childForFieldName(field)?.id === node.id;

  if (parent.type === "call_expression" && is("function")) return true;

  if (parent.type === "new_expression" && is("constructor")) return true;

  if (BINDING_PARENTS.has(parent.type)) return true;

  if ((parent.type === "assignment_pattern" || parent.type === "object_assignment_pattern") && is("left")) return true;

  if (parent.type === "pair_pattern" && is("value")) return true;

  if ((parent.type === "required_parameter" || parent.type === "optional_parameter") && is("pattern")) return true;

  if (parent.type === "variable_declarator" && is("name")) return true;

  if (FUNCTION_NODES.has(parent.type) && (is("name") || is("parameter"))) return true;

  if (parent.type === "formal_parameters") return true;

  if ((parent.type === "class_declaration" || parent.type === "class" || parent.type === "abstract_class_declaration") && is("name")) return true;

  return false;
}

/** Strings an expression can evaluate to: a literal, a ternary of literals, a `const` bound to one. */
function stringsOf(node: Node): string[] | null {
  if (node.type === "string") return [stringValue(node) ?? ""];

  if (node.type === "template_string") return node.namedChildren.some((c) => c.type === "template_substitution") ? null : [node.text.slice(1, -1)];

  if (node.type === "parenthesized_expression") return node.namedChildren[0] ? stringsOf(node.namedChildren[0]) : null;

  if (node.type === "ternary_expression") {
    const a = node.childForFieldName("consequence");
    const b = node.childForFieldName("alternative");
    const left = a ? stringsOf(a) : null;
    const right = b ? stringsOf(b) : null;

    return left && right ? [...new Set([...left, ...right])] : null;
  }

  // An identifier: follow it to a single-name `const` declarator and read that value.
  if (node.type !== "identifier") return null;
  const binding = declarationOf(node, node.text, node.tree.rootNode);
  const decl = binding?.kind === "local" ? binding.node : null;
  const value = decl?.childForFieldName("value");
  const holder = decl ? parentOf(decl) : null;
  const isConst = holder?.type === "lexical_declaration" && holder.children.some((c) => c.type === "const");

  return isConst && value && decl?.childForFieldName("name")?.type === "identifier" ? stringsOf(value) : null;
}

// A module file name: `.js`, `.ts`, `.jsx`, `.tsx`, and their `c`/`m` variants (`.mjs`, `.cts`).
const MODULE_FILE = /\.[cm]?[jt]sx?$/;

/** The node is `import.meta.url`, whatever the spacing. */
function isImportMetaUrl(node: Node | undefined): boolean {
  return node !== undefined && node.text.replace(/\s+/g, "") === "import.meta.url";
}

/**
 * Module files named relative to this module: `new URL("./worker.ts", import.meta.url)`
 * (a `Worker`, a loader) and `register(spec, import.meta.url | { parentURL: import.meta.url })`.
 * Null when the specifier is not a string the syntax fixes: a module edge may
 * be hidden there. A computed URL whose fixed suffix names a non-module file
 * (`./img/${n}.png` in a template) is not a module. A relative URL without an
 * extension (`./worker`) is `optional`: a module when it resolves to a source
 * file, which a bundler would load, and nothing otherwise.
 */
function moduleUrlSpecs(node: Node): { spec: string; optional: boolean }[] | null {
  const args = node.childForFieldName("arguments")?.namedChildren.filter((c) => c.type !== "comment") ?? [];
  const [spec, base] = args;

  if (!spec) return [];

  // `new URL(spec, import.meta.url)`: relative module files only; extensionless ones are optional.
  // A computed spec whose literal tail names a non-module file (`.png`) is no import; any other computed spec is an unsupported fact.
  if (node.type === "new_expression" && node.childForFieldName("constructor")?.text === "URL" && isImportMetaUrl(base)) {
    const strings = stringsOf(spec);

    if (strings === null) return NON_MODULE_SUFFIX.test(staticSuffix(spec)) && !MODULE_FILE.test(staticSuffix(spec)) ? [] : null;

    return strings.filter((s) => s.startsWith(".") && (MODULE_FILE.test(s) || extensionless(s))).map((s) => ({ spec: s, optional: !MODULE_FILE.test(s) }));
  }

  // `register(spec, import.meta.url)` or `{ parentURL: import.meta.url }`: a loader hook named relative to this module.
  const fn = node.type === "call_expression" ? node.childForFieldName("function") : null;
  const isRegister = fn?.text === "register" || fn?.text.replace(/\s+/g, "") === "module.register";
  const parentUrl = isImportMetaUrl(base) || (base?.type === "object" && base.namedChildren.some((p) => p.type === "pair" && p.childForFieldName("key")?.text === "parentURL" && isImportMetaUrl(p.childForFieldName("value") ?? undefined)));

  return isRegister && parentUrl ? (stringsOf(spec)?.map((s) => ({ spec: s, optional: false })) ?? null) : [];
}

/** `./worker`, `../lib/job`: a path whose last segment has no extension (not a directory `./dir/`, not `.` or `..`). */
function extensionless(spec: string): boolean {
  const last = spec.slice(spec.lastIndexOf("/") + 1);

  return last !== "" && last !== "." && last !== ".." && !last.includes(".");
}

// A file extension at the end of a string: `.png`, `.json`.
const NON_MODULE_SUFFIX = /\.[A-Za-z0-9]+$/;

/** The literal end of a computed string: the tail of a template, the last operand of `+`. */
function staticSuffix(node: Node): string {
  if (node.type === "string") return stringValue(node) ?? "";

  if (node.type === "template_string") {
    const last = node.namedChildren.at(-1);

    return last && last.type !== "template_substitution" ? node.text.slice(last.startIndex - node.startIndex, -1) : "";
  }

  if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
    const right = node.childForFieldName("right");

    return right ? staticSuffix(right) : "";
  }

  if (node.type === "parenthesized_expression" && node.namedChildren[0]) return staticSuffix(node.namedChildren[0]);

  return "";
}

/** Function node types: each opens a scope for its parameters and the locals declared directly in it, not inside a nested one. */
const FUNCTION_NODES = new Set(["function_declaration", "generator_function_declaration", "function_expression", "function", "generator_function", "arrow_function", "method_definition", "function_signature"]);

/** Node types whose statements declare names for the whole block. */
const BLOCK_NODES = new Set(["statement_block", "switch_body", "class_body"]);

/**
 * Where the head identifier of a call is bound between the call and `stop`
 * (the declaration being extracted): a parameter, a local, a destructured
 * name, a nested function or class, a loop or catch variable. Such a call
 * does not name the module-level symbol of the same name.
 */
function bindingOf(call: Node, name: string, stop: Node): "parameter" | "local" | null {
  // Walk out from the call to `stop`; the first scope that binds the name decides.
  for (let at: Node | null = call; at; at = parentOf(at)) {
    if (FUNCTION_NODES.has(at.type)) {
      const params = at.childForFieldName("parameters") ?? at.childForFieldName("parameter");

      if (params && patternNames(params).includes(name)) return "parameter";

      // A named function expression sees its own name.
      if (at.id !== stop.id && at.type !== "arrow_function" && at.childForFieldName("name")?.text === name) return "local";
    }

    // A block, or the body of the declaration itself (its locals shadow module names too).
    if (BLOCK_NODES.has(at.type) || (at.id === stop.id && at.childForFieldName("body")?.type === "statement_block")) {
      const block = BLOCK_NODES.has(at.type) ? at : at.childForFieldName("body");

      if (block && blockDeclares(block, name)) return "local";
    }

    // Loop and `catch` variables are locals of their statement.
    if (at.type === "for_in_statement") {
      const left = at.childForFieldName("left");

      if (left && patternNames(left).includes(name)) return "local";
    }

    if (at.type === "for_statement") {
      const init = at.childForFieldName("initializer");

      if (init && declaredNames(init).includes(name)) return "local";
    }

    if (at.type === "catch_clause") {
      const param = at.childForFieldName("parameter");

      if (param && patternNames(param).includes(name)) return "local";
    }

    if (at.id === stop.id) break;
  }

  return null;
}

/** The statements of a block. A `switch` is one block: a `const` or `function` of one case is in scope in every case. */
function blockStatements(block: Node): Node[] {
  if (block.type !== "switch_body") return block.namedChildren;

  return block.namedChildren.flatMap((c) => (c.type === "switch_case" || c.type === "switch_default" ? c.childrenForFieldName("body") : []));
}

/** Some statement of the block (or an `export` of one) declares `name`. */
function blockDeclares(block: Node, name: string): boolean {
  for (const stmt of blockStatements(block)) {
    const target = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;

    if (!target) continue;

    if (declaredNames(target).includes(name)) return true;
  }

  return false;
}

/** Names a statement declares: every name of its declarators, or a function's or class's name. */
function declaredNames(stmt: Node): string[] {
  if (stmt.type === "lexical_declaration" || stmt.type === "variable_declaration") {
    return stmt.namedChildren.filter((d) => d.type === "variable_declarator").flatMap((d) => {
      const nameNode = d.childForFieldName("name");

      return nameNode ? patternNames(nameNode) : [];
    });
  }

  if (FUNCTION_NODES.has(stmt.type) || stmt.type === "class_declaration" || stmt.type === "abstract_class_declaration") {
    const nameNode = stmt.childForFieldName("name");

    return nameNode ? [nameNode.text] : [];
  }

  return [];
}

/** Every identifier bound by a parameter list or a destructuring pattern. */
function patternNames(node: Node): string[] {
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      return [node.text];
    case "pair_pattern": {
      const value = node.childForFieldName("value");

      return value ? patternNames(value) : [];
    }

    case "assignment_pattern":
    case "object_assignment_pattern": {
      const left = node.childForFieldName("left");

      return left ? patternNames(left) : [];
    }

    case "required_parameter":
    case "optional_parameter": {
      const pattern = node.childForFieldName("pattern");

      return pattern ? patternNames(pattern) : [];
    }

    case "lexical_declaration":
    case "variable_declaration":
      return declaredNames(node);
    default:
      // Object and array patterns, rest patterns and parameter lists: the names of every part.
      if (node.type.endsWith("_pattern") || node.type === "formal_parameters" || node.type === "rest_pattern") return node.namedChildren.flatMap(patternNames);

      return [];
  }
}

/**
 * Source of the import that bound `local` as a whole module (a namespace or
 * `require`), if any; with `orDefault`, also as a default import, whose
 * members the graph resolves on the default export.
 */
function moduleSource(facts: FileFacts, local: string, orDefault = false): string | null {
  return facts.imports.find((i) => i.bindings.some((b) => (b.kind === "module" || (orDefault && b.kind === "default")) && b.local === local))?.source ?? null;
}

/**
 * `require("./x")`, `import("./x")`, `await import("./x")` as the whole value:
 * the module a declarator binds. A `require` parameter or local is not Node's.
 * `namespace`: `import()` gives the module's namespace object, `require()`
 * its `module.exports`.
 */
function requireSource(value: Node, requires: ReturnType<typeof query>): { source: string; namespace: boolean } | null {
  const call = value.type === "await_expression" ? value.namedChildren[0] : value;

  if (call?.type !== "call_expression") return null;

  // The require query also matches nested calls; only a string argument of `call` itself counts.
  for (const m of requires.matches(call)) {
    const src = m.captures.find((c) => c.name === "source");

    if (!src) continue;
    // `(string (string_fragment))` in the arguments of `call` itself.
    const string = parentOf(src.node);
    const args = string ? parentOf(string) : null;

    if ((args ? parentOf(args) : null)?.id !== call.id) continue;
    const fn = m.captures.find((c) => c.name === "fn");

    // The `require` form captures `fn`; the `import()` form does not, so it binds a namespace.
    if (fn && requireKind(fn.node) === "shadowed") continue;

    return { source: src.node.text, namespace: fn === undefined };
  }

  return null;
}

/** The specifier of SFCC's `module.superModule` (`src/frameworks/cartridges.ts` resolves the same literal). */
const SUPER_MODULE = "module.superModule";

/** The node is `module.superModule`, whatever the spacing. */
function isSuperModule(node: Node): boolean {
  return node.type === "member_expression" && node.text.replace(/\s+/g, "") === SUPER_MODULE;
}

/** `const base = module.superModule`: the whole module of the next cartridge, as `require` binds one. */
function superModuleSource(value: Node): { source: string; namespace: boolean } | null {
  return isSuperModule(value) ? { source: SUPER_MODULE, namespace: false } : null;
}

/**
 * `module.exports = {…}`, `module.exports = f`, `exports.x = …`. A function
 * value assigned there is a fn of the module, like `export const x = () => …`:
 * `exports.run = function () {}` and `module.exports = { go() {} }` declare
 * `run` and `go`; `module.exports = function () {}` declares `default`.
 */
function commonJsExports(stmt: Node, facts: FileFacts, declCalls: (n: Node) => CallFact[]): void {
  let expr = stmt.namedChildren[0];

  if (!expr || expr.type !== "assignment_expression") return;
  // `exports = module.exports = f`: the chained assignment on the right is the one that exports.
  while (expr.childForFieldName("left")?.text.replace(/\s+/g, "") === "exports" && expr.childForFieldName("right")?.type === "assignment_expression") expr = expr.childForFieldName("right")!;
  const left = expr.childForFieldName("left")?.text.replace(/\s+/g, "");
  const written = expr.childForFieldName("right");

  if (!left || !written) return;
  const right = unwrapValue(written);

  /** A function value becomes the fn `name`; the kind of the module's declaration of that name, if any. */
  const declare = (name: string, fn: Node, at: Node): DeclFact["kind"] | null => {
    // A name the module already declares keeps that declaration; only a fresh function value adds one.
    const existing = facts.decls.find((d) => d.name === name);

    if (existing) return existing.kind;

    if (!FUNCTION_VALUES.has(fn.type) && fn.type !== "method_definition") return null;
    facts.decls.push(fnDecl(name, at, fn, true, declCalls(fn), collectTypeRefs(fn)));

    return "fn";
  };

  /** The row of `name = value`: a local it names, a declared fn, or a value archdiff does not follow. */
  const row = (name: string, value: Node | null, at: Node): void => {
    facts.exports.add(name);
    const target = value ? unwrapValue(value) : null;
    const form = name === "default" ? { form: "default" as const } : {};

    // `exports.run = run` exports the local `run`; a different name makes it an alias.
    if (target?.type === "identifier" || target?.type === "shorthand_property_identifier") {
      facts.exportRows.push({ name, kind: "value", local: target.text, ...(name === "default" ? form : target.text !== name ? { form: "alias" as const } : {}) });

      return;
    }

    const kind = target ? declare(name, target, at) : null;
    facts.exportRows.push({ name, kind: kind ?? "value", local: kind ? name : null, ...form });
  };

  // `module.exports = { a, b: impl, go() {} }`: each property is a named export.
  if (left === "module.exports") {
    if (right.type === "object") {
      for (const p of right.namedChildren) {
        if (p.type === "shorthand_property_identifier") row(p.text, p, p);
        else if (p.type === "pair") {
          const k = p.childForFieldName("key")?.text;

          if (!k) continue;
          // A quoted key (`"a": f`) is unquoted: the regex strips one leading and one trailing quote.
          row(k.replace(/^['"]|['"]$/g, ""), p.childForFieldName("value"), p);
        } else if (p.type === "method_definition") {
          const name = p.childForFieldName("name");

          if (name?.type === "property_identifier") row(name.text, p, p);
        }
      }
    } else {
      // `module.exports = handler`, `= function () {}`: the module's value, `default` to an ESM importer.
      row("default", right, expr);
    }
  // `exports.x = …`, `module.exports.x = …`: the export is the last segment.
  } else if (left.startsWith("exports.") || left.startsWith("module.exports.")) {
    row(left.slice(left.lastIndexOf(".") + 1), right, expr);
  }
}

/**
 * The text of a string literal without its quotes: its first fragment only, so
 * an escape sequence ends it. `""` for an empty string, null for any other node.
 */
function stringValue(n: Node): string | null {
  if (n.type !== "string") return null;

  return n.namedChildren.find((c) => c.type === "string_fragment")?.text ?? "";
}

/** HTTP verbs of a router's registration methods, as Express, Koa-router, Fastify and Hono write them. */
const ROUTE_METHODS = new Set(["get", "post", "put", "patch", "delete", "all"]);

/** SFRA's `server` registrations: a route (`get`, `post`, `use`) or a change of one another cartridge declared. */
const SFRA_METHODS = new Set(["get", "post", "use", "append", "prepend", "replace"]);

// A controller of an SFCC cartridge: `cartridges/<name>/cartridge/controllers/<Controller>.js`.
const SFRA_CONTROLLER = /(?:^|\/)cartridges\/[^/]+\/cartridge\/controllers\/[^/]+\.js$/;

/**
 * `app.get('/x', h)`, `router.post('/x', auth, h)`: a handler registered on a
 * literal path — a `route` entry labelled `GET /x` whose callee is the last
 * argument when it is a name (`h`, `handlers.save`). A computed path, or a
 * handler written in place, is not recorded: nothing in the code names it.
 */
function collectRouteEntries(root: Node, facts: FileFacts): void {
  const entries: NonNullable<FileFacts["entries"]> = [];
  const controller = SFRA_CONTROLLER.test(facts.path);

  // Recursion is safe here: `extractIndexed` already refused trees deeper than `MAX_DEPTH`.
  const walk = (node: Node): void => {
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const property = fn?.type === "member_expression" ? fn.childForFieldName("property") : null;
      const method = property?.type === "property_identifier" ? property.text : null;
      const args = node.childForFieldName("arguments")?.namedChildren.filter((arg) => arg.type !== "comment") ?? [];
      const path = args[0] === undefined ? null : stringValue(args[0]);
      const handler = args.length >= 2 ? args[args.length - 1] : undefined;

      // `<anything>.<verb>("/path" | "*", …, handler)` with a named handler last: a route entry.
      if (method !== null && ROUTE_METHODS.has(method) && path !== null && (path.startsWith("/") || path === "*") && handler !== undefined && (handler.type === "identifier" || handler.type === "member_expression")) {
        const at = located(node);
        entries.push({ kind: "route", label: `${method.toUpperCase()} ${path}`, callee: collapse(handler.text), line: at.line, col: at.col });
      }

      // SFRA: `server.get('Show', mw, handler)` in a cartridge's `controllers/<Name>.js`; the adapter names it `<Name>-Show`.
      const target = fn?.type === "member_expression" ? fn.childForFieldName("object") : null;

      if (controller && method !== null && SFRA_METHODS.has(method) && target?.type === "identifier" && target.text === "server" && path !== null && path !== "" && handler !== undefined) {
        const at = located(node);
        const named = handler.type === "identifier" || handler.type === "member_expression";
        entries.push({ kind: "sfra", label: path, method, callee: named ? collapse(handler.text) : null, line: at.line, col: at.col });
      }
    }

    // `{ path: '/cart', component: Cart }` in an array of a `routes` file: a page of the router.
    if (pages !== null && node.type === "object" && parentOf(node)?.type === "array") {
      const page = pageOf(node, pages);

      if (page !== null) entries.push(page);
    }

    for (const child of node.namedChildren) walk(child);
  };

  // Router pages are read only in a `routes` file, where `lazy(() => import(…))` names their modules.
  const pages = ROUTES_FILE.test(facts.path) ? lazyImports(root) : null;
  walk(root);

  if (entries.length > 0) facts.entries = entries;
}

/** Registration methods the web adapters read: HTTP verbs, `use` (Express mounts and middleware), `register` and `route` (Fastify, Express `route('/x')`). */
const WEB_METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "head", "options", "use", "register", "route"]);

/** Callees that create a router or an app: `express()`, `express.Router()`, `Router()`, `fastify()`, `Fastify()`. */
// The regex matches the callee's last segment: `express`, `fastify`, `Fastify`, or `Router` (`express.Router`).
const WEB_CREATORS = /(?:^|\.)(?:Router|express|fastify|Fastify)$/;

/** HTTP verbs among the registration methods. */
const WEB_VERBS = new Set(["get", "post", "put", "patch", "delete", "all", "head", "options"]);

/**
 * What the web adapters (Express, Fastify, Next.js) read (`FileFacts.web`):
 * registration calls on a named receiver with their arguments, the values
 * the top level creates by a call, `'use server'` directives and an exported
 * `config`. Nothing is resolved here: the adapter follows the names.
 */
function collectWebFacts(root: Node, facts: FileFacts): void {
  const web: WebFacts = { values: [], calls: [] };
  const argsOf = (call: Node): Node[] => call.childForFieldName("arguments")?.namedChildren.filter((a) => a.type !== "comment") ?? [];

  const withAt = (n: Node): DecoratorArg & { line: number; col: number } => {
    const at = located(n);

    return { ...decoratorArg(n), line: at.line, col: at.col };
  };

  // Top-level declarators whose value comes from a call or `new` (`const app = express()`), and an exported `config` object.
  for (const stmt of root.namedChildren) {
    const exported = stmt.type === "export_statement";
    const decl = exported ? stmt.childForFieldName("declaration") : stmt;

    if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") continue;

    for (const d of decl.namedChildren) {
      const name = d.type === "variable_declarator" ? d.childForFieldName("name") : null;
      const written = d.childForFieldName("value");

      if (name?.type !== "identifier" || !written) continue;
      const value = unwrapValue(written);

      if (exported && name.text === "config" && value.type === "object") web.config = decoratorArg(value);
      const callee = value.type === "call_expression" ? value.childForFieldName("function") : value.type === "new_expression" ? value.childForFieldName("constructor") : null;

      // Only a plain or dotted name as the callee: the regex rejects calls, indexes and spaces.
      if (callee && (callee.type === "identifier" || callee.type === "member_expression") && /^[\w$.]+$/.test(callee.text)) {
        const at = located(d);
        web.values.push({ name: name.text, callee: callee.text, line: at.line, col: at.col });
      }
    }
  }

  // A file-level `'use server'` makes every export a server action; a function-level one marks that function.
  if (directives(root).includes("use server")) web.useServer = true;
  // One walk for server actions and for registration calls (`<receiver>.<method>(…)`).
  walkNamed(root, (node) => {
    if (FUNCTION_NODES.has(node.type)) {
      const body = node.childForFieldName("body");

      if (body?.type === "statement_block" && directives(body).includes("use server")) {
        const at = located(node);
        const named = functionName(node);
        (web.actions ??= []).push({ name: named.name, top: named.top, line: at.line, col: at.col });
      }

      return;
    }

    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");

    if (fn?.type !== "member_expression") return;
    const method = fn.childForFieldName("property")?.text ?? "";

    if (!WEB_METHODS.has(method)) return;
    const args = argsOf(node);
    let object = fn.childForFieldName("object");
    let route: DecoratorArg | undefined;

    // `router.route('/x').get(h).post(h2)`: down the chain of verbs to the `route('/x')` call.
    if (WEB_VERBS.has(method)) {
      while (object?.type === "call_expression") {
        const inner = object.childForFieldName("function");
        const innerMethod = inner?.type === "member_expression" ? inner.childForFieldName("property")?.text : undefined;

        if (inner?.type !== "member_expression" || innerMethod === undefined) break;

        if (innerMethod === "route") {
          const first = argsOf(object)[0];
          route = first === undefined ? { kind: "other", text: "" } : decoratorArg(first);
          object = inner.childForFieldName("object");
          break;
        }

        if (!WEB_VERBS.has(innerMethod)) break;
        object = inner.childForFieldName("object");
      }
    }

    // Only a named receiver, and only argument counts a registration can have: a verb needs a path and a handler,
    // unless `route('/x')` already gave the path.
    if (object?.type !== "identifier") return;

    // `route('/x')` of a chain is read with its verbs; `route({ … })` is Fastify's.
    if (method === "route" && args[0] && unwrapValue(args[0]).type !== "object") return;

    if (WEB_VERBS.has(method) && route === undefined && args.length < 2) return;

    if (WEB_VERBS.has(method) && route !== undefined && args.length < 1) return;

    if (args.length === 0) return;
    const at = located(node);
    const fact: WebCallFact = { receiver: object.text, method, args: args.map(withAt), line: at.line, col: at.col };

    if (route !== undefined) fact.route = route;

    // A registration on a function's first parameter (`(app) => app.get(…)`, a Fastify plugin) is done within that function.
    for (let up = parentOf(node); up; up = parentOf(up)) {
      if (!FUNCTION_NODES.has(up.type) || firstParameter(up) !== object.text) continue;
      const fnAt = located(up);
      fact.within = { name: functionName(up).name, line: fnAt.line, col: fnAt.col };
      break;
    }

    web.calls.push(fact);
  });

  // The values matter beside registrations, or as a router or an app another file registers on.
  if (web.calls.length === 0) web.values = web.values.filter((v) => WEB_CREATORS.test(v.callee));

  if (web.values.length > 0 || web.calls.length > 0 || web.useServer || web.actions || web.config) facts.web = web;
}

/** The string directives (`'use server'`, `'use strict'`) at the start of a program or a function body. */
function directives(block: Node): string[] {
  const out: string[] = [];

  for (const stmt of block.namedChildren) {
    // Directives are the leading string statements; the first other statement ends them.
    if (stmt.type === "comment") continue;
    const expr = stmt.type === "expression_statement" ? stmt.namedChildren[0] : null;
    const value = expr ? stringValue(expr) : null;

    if (value === null) break;
    out.push(value);
  }

  return out;
}

/** A function's first parameter when it is a plain name. */
function firstParameter(fn: Node): string | null {
  const single = fn.childForFieldName("parameter");

  if (single?.type === "identifier") return single.text;
  const first = fn.childForFieldName("parameters")?.namedChildren.find((p) => p.type !== "comment");

  if (!first) return null;

  if (first.type === "identifier") return first.text;
  const pattern = first.type === "required_parameter" || first.type === "optional_parameter" ? first.childForFieldName("pattern") : null;

  return pattern?.type === "identifier" ? pattern.text : null;
}

/** A function's name, if any, and whether it is declared at the top level of the module. */
interface FunctionName {
  name: string | null;
  top: boolean;
}

/** A function's name — its own, its declarator's, `default` for an anonymous default export — and whether it is a top-level declaration. */
function functionName(fn: Node): FunctionName {
  const parent = parentOf(fn);
  const topLevel = (n: Node | null): boolean => n?.type === "program" || (n?.type === "export_statement" && parentOf(n)?.type === "program");

  if (fn.type === "function_declaration" || fn.type === "generator_function_declaration") return { name: fn.childForFieldName("name")?.text ?? null, top: topLevel(parent) };
  let at: Node | null = parent;

  // A function expression: look through wrappers to what holds it.
  while (at && (at.type === "parenthesized_expression" || at.type === "as_expression" || at.type === "satisfies_expression")) at = parentOf(at);

  if (at?.type === "variable_declarator") {
    const name = at.childForFieldName("name");
    const list = parentOf(at);

    return { name: name?.type === "identifier" ? name.text : null, top: topLevel(list ? parentOf(list) : null) };
  }

  if (at?.type === "export_statement" && parentOf(at)?.type === "program") return { name: "default", top: true };

  // `module.exports = async function (fastify) {}`: the module's default value.
  if (at?.type === "assignment_expression" && at.childForFieldName("left")?.text.replace(/\s+/g, "") === "module.exports") return { name: "default", top: true };

  return { name: fn.childForFieldName("name")?.text ?? null, top: false };
}

// A router's route table: a file named `routes` with a JS or TS extension.
const ROUTES_FILE = /(?:^|\/)routes\.(?:js|jsx|ts|tsx|mjs)$/;

/** `const Cart = loadable(() => import('./pages/cart'))` (or `lazy`, `React.lazy`) at the top level: name → specifier. */
function lazyImports(root: Node): Map<string, string> {
  const out = new Map<string, string>();

  for (const stmt of root.namedChildren) {
    const decl = stmt.type === "export_statement" ? stmt.childForFieldName("declaration") : stmt;

    if (decl?.type !== "lexical_declaration" && decl?.type !== "variable_declaration") continue;

    for (const d of decl.namedChildren) {
      const name = d.type === "variable_declarator" ? d.childForFieldName("name") : null;
      const value = d.childForFieldName("value");

      if (name?.type !== "identifier" || !value) continue;
      const call = unwrapValue(value);
      // The call's first argument is an arrow or function whose body is an `import("…")` call.
      const loader = call.type === "call_expression" ? call.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment") : undefined;
      const body = loader && FUNCTION_VALUES.has(loader.type) ? loader.childForFieldName("body") : null;
      const imported = body ? unwrapValue(body) : null;

      if (imported?.type !== "call_expression" || imported.childForFieldName("function")?.type !== "import") continue;
      const spec = imported.childForFieldName("arguments")?.namedChildren.find((a) => a.type !== "comment");
      const source = spec ? stringValue(spec) : null;

      if (source !== null) out.set(name.text, source);
    }
  }

  return out;
}

/** A route object with a literal `path` and a named `component`; null for any other object. */
function pageOf(node: Node, lazy: ReadonlyMap<string, string>): EntryFact | null {
  let path: string | null = null;
  let component: string | null = null;

  // A literal `path` (string or plain template) and a `component` that is a name.
  for (const p of node.namedChildren) {
    if (p.type !== "pair") continue;
    const key = p.childForFieldName("key")?.text;
    const value = p.childForFieldName("value");

    if (!value) continue;

    if (key === "path") path = stringValue(unwrapValue(value)) ?? templateValue(unwrapValue(value));
    else if (key === "component" && (value.type === "identifier" || value.type === "member_expression")) component = collapse(value.text);
  }

  if (path === null || component === null) return null;
  const at = located(node);
  const source = lazy.get(component);

  const entry: Omit<EntryFact, "line" | "col"> = { kind: "page", label: path, callee: component };

  if (source !== undefined) entry.source = source;

  // Object.assign appends the position after `source`, in the key order of an entry fact.
  return Object.assign(entry, { line: at.line, col: at.col });
}

/** A function's signature as written: its parameters (parenthesized for `x =>`), then `→` and the return type. */
function signature(fn: Node): string {
  const params = fn.childForFieldName("parameters") ?? fn.childForFieldName("parameter");
  const ret = fn.childForFieldName("return_type");
  let s = params ? collapse(withoutParamDecorators(params)) : "()";

  if (params && params.type !== "formal_parameters") s = `(${s})`;

  if (ret) s += ` → ${collapse(ret.text.replace(/^:\s*/, ""))}`;

  return s;
}

/** `(@Body() body: Dto)` is `(body: Dto)`: a parameter decorator is framework wiring, not the signature a `planned fn` declares. */
function withoutParamDecorators(params: Node): string {
  let text = params.text;

  // Decorators are removed in source order, so the first match is always the one being removed.
  for (const param of params.namedChildren) for (const d of param.children) if (d.type === "decorator") text = text.replace(d.text, "");

  return text;
}

/** A type's signature: `= <type>` for a short alias (60 characters at most), else its heritage. */
function typeSignature(n: Node): string | null {
  const v = n.childForFieldName("value");

  if (n.type === "type_alias_declaration" && v) {
    const t = collapse(v.text);

    return t.length <= 60 ? `= ${t}` : null;
  }

  return heritage(n);
}

/** A class or interface's `extends`/`implements` clause, whitespace collapsed. */
function heritage(n: Node): string | null {
  const h = n.namedChildren.find((c) => c.type === "class_heritage" || c.type === "extends_type_clause" || c.type === "extends_clause");

  return h ? collapse(h.text) : null;
}


/** Is this specifier a Node built-in (`fs`, `node:fs`)? */
export function isNodeBuiltin(spec: string): boolean {
  return spec.startsWith("node:") || builtinModules.includes(spec);
}

// The grammar type, re-exported from `treesitter.ts` beside the extractor.
export type { Grammar };
