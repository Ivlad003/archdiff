// web-tree-sitter runtime with the grammar WASM files from @vscode/tree-sitter-wasm.
// Languages are loaded lazily and cached for the process.
//
// The shared base of every language frontend (source → FileFacts): parsing
// (`withTree`, `loadLanguage`, `query`), code-point positions (`located`,
// `startCol`), syntax errors (`errorLine`) and the syntax fingerprints that
// make a closure stale (`fingerprint`, `fingerprintFacts`, `valuesFingerprint`).

import { createHash, type Hash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser, Query, type Node, type Tree } from "web-tree-sitter";
import { wasmFile, type Grammar } from "./grammars.ts";

const require = createRequire(import.meta.url);

export type { Grammar };

/** The one-time WASM runtime init, shared by every language load. */
let ready: Promise<void> | null = null;

/** Loaded grammars; the promise is cached so concurrent loads share one. */
const languages = new Map<Grammar, Promise<Language>>();

/** Compiled queries by `<grammar>:<name>`. */
const queries = new Map<string, Query>();

/** One parser per grammar: parsing is synchronous, and a parser per call leaks WASM heap. */
const parsers = new Map<Grammar, Parser>();

/**
 * Per tree whose source has characters outside the BMP: the index of the low
 * half of each surrogate pair, ascending. Most sources have none, so their
 * columns cost nothing extra.
 */
const surrogates = new WeakMap<Tree, number[]>();

/** The directory holding the grammar WASM files: bundled in `dist/wasm`, else the dependency's own. */
function wasmDir(): string {
  // prepack copies every grammar of `GRAMMARS` next to the compiled extractor (`dist/wasm`).
  const bundled = join(dirname(fileURLToPath(import.meta.url)), "../wasm");

  if (existsSync(bundled)) return bundled;

  return join(dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");
}

/** The grammar `g`, loaded once per process after the runtime is initialised. */
export function loadLanguage(g: Grammar): Promise<Language> {
  ready ??= Parser.init();
  let l = languages.get(g);

  if (!l) {
    l = ready.then(() => Language.load(readFileSync(join(wasmDir(), wasmFile(g)))));
    languages.set(g, l);
  }

  return l;
}

/**
 * Parse `src` and run `use` on the tree, which is freed afterwards: a tree
 * lives in the WASM heap, so nothing `use` returns may hold a node.
 */
export async function withTree<T>(g: Grammar, src: string, use: (tree: Tree, language: Language) => T): Promise<T> {
  // Reuse one parser per grammar (see `parsers`).
  const language = await loadLanguage(g);
  let parser = parsers.get(g);

  if (!parser) {
    parser = new Parser();
    parser.setLanguage(language);
    parsers.set(g, parser);
  }

  const tree = parser.parse(src);

  if (!tree) throw new Error("tree-sitter: parse returned null");
  // Remember where surrogate pairs sit so columns can be converted to code
  // points; nothing is stored for a pure-BMP source.
  const pairs = surrogatePairs(src);

  if (pairs.length > 0) surrogates.set(tree, pairs);

  try {
    return use(tree, language);
  } finally {
    tree.delete();
  }
}

/** Compile a query once per (grammar, source). */
export function query(language: Language, g: Grammar, name: string, source: string): Query {
  // Keyed by grammar and name only: one name must always carry one source.
  const key = `${g}:${name}`;
  let q = queries.get(key);

  if (!q) {
    q = new Query(language, source);
    queries.set(key, q);
  }

  return q;
}

/** The grammar a file is parsed with, by extension; anything unrecognised is read as JavaScript. */
export function grammarFor(path: string): Grammar {
  if (path.endsWith(".rs")) return "rust";

  if (path.endsWith(".py")) return "python";

  if (path.endsWith(".php")) return "php";

  if (path.endsWith(".tsx")) return "tsx";

  if (/\.[cm]?ts$/.test(path)) return "typescript";

  return "javascript";
}

/** A node's 1-based range (columns in code points) and its source text. */
export interface Located {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

/** 1-based range and text of a node; columns count code points, and `endCol` is the column after it. */
export function located(node: Node): Located {
  return {
    line: node.startPosition.row + 1,
    col: startCol(node),
    endLine: node.endPosition.row + 1,
    endCol: codePointColumn(node.tree, node.endIndex, node.endPosition.column),
    text: node.text,
  };
}

/** The node's 1-based start column in code points (§7), as `located` gives it. */
export function startCol(node: Node): number {
  return codePointColumn(node.tree, node.startIndex, node.startPosition.column);
}

/**
 * web-tree-sitter parses a JS string as UTF-16, so its columns and indices
 * count code units. A surrogate pair between the line start and the point is
 * one code point, and so one column.
 */
function codePointColumn(tree: Tree, index: number, units: number): number {
  const pairs = surrogates.get(tree);

  if (pairs === undefined) return units + 1;

  // Subtract one column for every pair whose low half falls between the line
  // start (`index - units`) and the point: binary searches give the count.
  return units + 1 - (firstAtOrAfter(pairs, index) - firstAtOrAfter(pairs, index - units + 1));
}

/** Indices of the low half of each surrogate pair in `src`, ascending. */
function surrogatePairs(src: string): number[] {
  const out: number[] = [];

  for (const m of src.matchAll(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)) out.push(m.index + 1);

  return out;
}

/** Position of the first element `>= value` in an ascending array. */
function firstAtOrAfter(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;

  while (low < high) {
    const mid = (low + high) >> 1;

    if (sorted[mid]! < value) low = mid + 1;
    else high = mid;
  }

  return low;
}

/** First syntax-error line, or the start of the tree when the grammar only sets `hasError`. */
export function errorLine(node: Node): number {
  // A loop down the first erroneous child, not recursion: a deep tree must not overflow the stack.
  for (let n = node; ; ) {
    if (n.type === "ERROR" || n.isMissing) return n.startPosition.row + 1;
    const child = n.children.find((c) => c.hasError);

    if (!child) return n.startPosition.row + 1;
    n = child;
  }
}

/**
 * SHA-256 of the node's syntax: node types and token texts, without comments
 * and whitespace. `>` → `>=` changes it; reformatting or editing a comment
 * does not. Nesting is part of it, so moving a statement out of a block counts.
 * Line endings inside a token (a multi-line string, docstring or heredoc) are
 * read as LF: a CRLF checkout of the same commit has the same fingerprint, as
 * the languages themselves read CRLF in such literals as LF.
 *
 * The values the node reads by name in its own file are part of it: a module
 * constant, a class field or property, a field the class's constructor
 * assigns (`this.x = …`, `self.x = …`, `$this->x = …`, a TS parameter
 * property, a PHP promoted property), an object table, a Rust `const` or
 * `static` (and, transitively, the values those read). `LIMIT = 100` → `5`
 * changes every fn that reads `LIMIT`. A value imported from another file of
 * the repository is out of reach, so the fingerprint then ends with
 * {@link READS_IMPORTED_VALUE}: the snapshot marks its closure incomplete.
 */
export function fingerprint(node: Node): string {
  return fingerprintFacts(node).fingerprint;
}

/**
 * `fingerprint` of the node, and `readsImports`: the names it reads as values
 * that an import binds whose syntax does not tell whether its target is in the
 * repository (a Python absolute import, a PHP `use`, a bare TS specifier, a
 * Rust `use` of another crate). The graph, which resolves imports, marks the
 * fingerprint like {@link READS_IMPORTED_VALUE} when one of them binds a
 * module of the repository.
 */
export function fingerprintFacts(node: Node): FingerprintFacts {
  // The node's own syntax, then the syntax of every value it reads by name
  // in this file, in document order.
  const hash = createHash("sha256");
  const reads = hashSyntax(node, hash);

  for (const value of valuesRead(node, reads)) hash.update(`=${value.print}\u0002`);
  // Imported values cannot be hashed here: mark the print as incomplete
  // (relative import) or hand the names to the graph to decide.
  const imported = importedValueReads(node, reads);

  const facts: FingerprintFacts = { fingerprint: hash.digest("hex") + (imported.relative ? READS_IMPORTED_VALUE : "") };

  if (imported.other.length > 0) facts.readsImports = imported.other;

  return facts;
}

/** A fingerprint, and the imported names whose origin only the graph can judge. */
export interface FingerprintFacts {
  fingerprint: string;
  readsImports?: string[];
}

/**
 * SHA-256 of the value code among `statements` of a module or a class body:
 * constants, assignments, object tables, fields, top-level calls — every
 * statement but a declaration of `decls` (a fn, class or type, which has its
 * own fingerprint), an import, a comment or a docstring. Syntax only, as in
 * `fingerprint`: a comment or layout does not change it. Undefined when no
 * such statement is there, so a module of declarations only has no value
 * code to hash.
 */
export function valuesFingerprint(statements: readonly Node[], decls: readonly PlacedDecl[]): string | undefined {
  // Flatten the declarations and their members into one list of start points.
  const starts: PlacedDecl[] = [];

  const place = (d: PlacedDecl): void => {
    starts.push(d);

    for (const m of d.members ?? []) place(m);
  };

  for (const d of decls) place(d);

  // Whether a statement's range contains the start of any declaration.
  const holds = (n: Node): boolean => {
    const at = located(n);

    return starts.some((s) => (s.line > at.line || (s.line === at.line && s.col >= at.col)) && (s.line < at.endLine || (s.line === at.endLine && s.col < at.endCol)));
  };

  const hash = createHash("sha256");
  let any = false;

  const add = (n: Node): void => {
    hashSyntax(n, hash);
    hash.update("\u0003");
    any = true;
  };

  // Classify each top-level statement: skip non-value syntax, descend into a
  // PHP namespace block, skip `mod x;` and pure re-exports, hash a statement
  // that holds no declaration, and from a declaration statement hash only its
  // non-fn declarators.
  const visit = (statement: Node): void => {
    if (NO_VALUE_CODE.has(statement.type) || statement.type.includes("comment") || isDocstring(statement)) return;

    if (statement.type === "namespace_definition") {
      // PHP `namespace App { … }`: its statements are the file's.
      for (const child of statement.childForFieldName("body")?.namedChildren ?? []) visit(child);

      return;
    }

    // Rust `mod x;` only points at another file.
    if (statement.type === "mod_item" && statement.childForFieldName("body") === null) return;

    // `export { a } from "./x"` or `export { a }`: names, no value code.
    if (statement.type === "export_statement" && statement.childForFieldName("declaration") === null && (statement.childForFieldName("source") !== null || statement.namedChildren.some((c) => c.type === "export_clause"))) return;

    // No declaration starts inside: the whole statement is value code.
    if (!holds(statement)) {
      add(statement);

      return;
    }

    // `const a = 1, f = () => …`: the declarators that are no fn are values.
    const declaration = statement.type === "export_statement" ? statement.childForFieldName("declaration") : statement;

    if (declaration?.type === "lexical_declaration" || declaration?.type === "variable_declaration") {
      for (const declarator of declaration.namedChildren) if (declarator.type === "variable_declarator" && !holds(declarator)) add(declarator);
    }
  };

  for (const statement of statements) visit(statement);

  return any ? hash.digest("hex") : undefined;
}

/** Where a declaration starts, with its members (a Rust `impl` puts methods under their type). */
interface PlacedDecl {
  line: number;
  col: number;
  members?: readonly PlacedDecl[];
}

/** Statements that are no value code of a module or class: imports and module syntax, `pass`, Rust attributes (which belong to the item after them). */
const NO_VALUE_CODE = new Set([
  "import_statement",
  "import_from_statement",
  "future_import_statement",
  "namespace_use_declaration",
  "use_declaration",
  "extern_crate_declaration",
  "php_tag",
  "text_interpolation",
  "pass_statement",
  "attribute_item",
  "inner_attribute_item",
  "empty_statement",
]);

/** A string on its own: a Python docstring. */
function isDocstring(statement: Node): boolean {
  return statement.type === "expression_statement" && statement.namedChildCount === 1 && statement.namedChildren[0]?.type === "string" && statement.tree.rootNode.type === "module";
}

/**
 * Ends the fingerprint of a node that reads a value imported from another
 * file of the repository (`import { LIMIT } from "./limits"`, `from .limits
 * import MAX`, `use crate::limits::MAX`). Never a hex digit.
 */
export const READS_IMPORTED_VALUE = "+";

/** Leaf types that name something the code reads: a variable, a field or property, a constant. */
const NAME_LEAVES = new Set(["identifier", "property_identifier", "private_property_identifier", "shorthand_property_identifier", "field_identifier", "name"]);

/** Hash the syntax of `node` into `hash` (see `fingerprint`); the names of the leaves in it. */
function hashSyntax(node: Node, hash: Hash): Set<string> {
  const reads = new Set<string>();
  // An explicit stack in document order (a closing mark after a node's children), not recursion.
  const stack: (Node | typeof CLOSE)[] = [node];

  while (stack.length > 0) {
    const n = stack.pop()!;

    if (n === CLOSE) {
      hash.update(")\u0002");
      continue;
    }

    if (n.type.includes("comment")) continue;

    // A leaf hashes its type and text (CRLF read as LF) and, when it is a
    // name, is recorded as a read; an inner node opens a group closed by CLOSE.
    if (n.childCount === 0) {
      hash.update(`${n.type}\u0001${n.text.replace(/\r\n?/g, "\n")}\u0002`);

      if (NAME_LEAVES.has(n.type)) reads.add(n.text);
      continue;
    }

    hash.update(`(${n.type}\u0002`);
    stack.push(CLOSE);
    const children = n.children;

    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }

  return reads;
}

/** The stack mark that closes an inner node's group in `hashSyntax`. */
const CLOSE = Symbol("close");

/** A value declared by name in a scope: a variable, constant or field. */
interface ValueDecl {
  names: readonly string[];
  start: number;
  end: number;
  node: Node;
  /** Syntax hash and names, computed on first use: most values no fingerprinted node reads. */
  print?: string;
  reads?: ReadonlySet<string>;
}

/** Value declarations per scope node (by `Node.id`), per tree: the fns of a file look into the same scopes. */
const scopeValues = new WeakMap<Tree, Map<number, ValueDecl[]>>();

/** The imported names of each tree, computed once (see `importedValueNames`). */
const importedValues = new WeakMap<Tree, ImportedNames>();

/**
 * The value declarations `node` reads by name, transitively, in every scope
 * around it (an enclosing class body, the module), in document order. A
 * declaration that holds `node` itself (`const f = () => …`) is left out.
 */
function valuesRead(node: Node, reads: ReadonlySet<string>): ValueDecl[] {
  const scopes: ValueDecl[][] = [];

  // Every enclosing scope's value declarations, innermost first.
  for (let scope = node.parent; scope !== null; scope = scope.parent) scopes.push(valuesOf(scope));
  const names = new Set(reads);
  const found = new Set<ValueDecl>();

  // Fixed point: a found value adds the names it reads itself, so values read
  // through other values are found too; stop when a pass finds nothing new.
  for (let grew = true; grew; ) {
    grew = false;

    for (const decls of scopes) {
      for (const decl of decls) {
        // A declaration that holds the node (`const f = () => …`), or one inside it (a constructor's own `this.x = …`), is no value it reads.
        if (found.has(decl) || (decl.start <= node.startIndex && decl.end >= node.endIndex) || (decl.start >= node.startIndex && decl.end <= node.endIndex)) continue;

        if (!decl.names.some((name) => names.has(name))) continue;
        found.add(decl);
        grew = true;

        if (decl.print === undefined) {
          const hash = createHash("sha256");
          decl.reads = hashSyntax(decl.node, hash);
          decl.print = hash.digest("hex");
        }

        for (const name of decl.reads ?? []) names.add(name);
      }
    }
  }

  return [...found].sort((a, b) => a.start - b.start);
}

/** The value declarations directly in `scope` (and the fields its constructor sets), cached per tree and scope node. */
function valuesOf(scope: Node): ValueDecl[] {
  let byScope = scopeValues.get(scope.tree);

  if (!byScope) {
    byScope = new Map();
    scopeValues.set(scope.tree, byScope);
  }

  let decls = byScope.get(scope.id);

  if (decls) return decls;
  decls = [];

  for (const child of scope.namedChildren) {
    const decl = valueDeclaration(child);
    const names = decl ? declaredNames(decl) : [];

    if (names.length > 0) decls.push({ names, start: child.startIndex, end: child.endIndex, node: child });

    for (const field of constructorFields(child)) decls.push({ names: [field.name], start: field.node.startIndex, end: field.node.endIndex, node: field.node });
  }

  byScope.set(scope.id, decls);

  return decls;
}

/**
 * Fields a class member that is the constructor sets: `this.x = …` (TS/JS
 * `constructor`), `self.x = …` (Python `__init__`), `$this->x = …` (PHP
 * `__construct`), and the constructor's parameters that declare a property
 * (TS `constructor(private x = 1)`, PHP `__construct(private int $x = 1)`).
 * Each is the node a method reading `x` hashes. None for any other member.
 */
function constructorFields(member: Node): { name: string; node: Node }[] {
  const fn = member.type === "decorated_definition" ? member.childForFieldName("definition") : member;
  const name = fn?.childForFieldName("name")?.text;
  const receiver = fn?.type === "method_definition" && name === "constructor" ? "this" : fn?.type === "function_definition" && name === "__init__" ? "self" : fn?.type === "method_declaration" && name?.toLowerCase() === "__construct" ? "$this" : null;

  if (!fn || receiver === null) return [];
  const out: { name: string; node: Node }[] = [];

  // Parameter properties: PHP promoted properties, and TS parameters with an
  // accessibility, `readonly` or `override` modifier.

  for (const param of fn.childForFieldName("parameters")?.namedChildren ?? []) {
    if (param.type === "property_promotion_parameter") {
      const variable = param.childForFieldName("name");
      const field = variable?.namedChildren.find((c) => c.type === "name");

      if (field) out.push({ name: field.text, node: param });
    } else if ((param.type === "required_parameter" || param.type === "optional_parameter") && param.children.some((c) => c.type === "accessibility_modifier" || c.type === "readonly" || c.type === "override_modifier")) {
      const field = param.childForFieldName("pattern");

      if (field?.type === "identifier") out.push({ name: field.text, node: param });
    }
  }

  // Walk the constructor body for `receiver.x = …` assignments.
  const body = fn.childForFieldName("body");
  const stack: Node[] = body ? [...body.namedChildren] : [];

  while (stack.length > 0) {
    const n = stack.pop()!;

    // A nested function or class sets fields of its own receiver, if any.
    if (NESTED_SCOPES.has(n.type)) continue;

    if (n.type === "assignment_expression" || n.type === "assignment") {
      const field = receiverField(n.childForFieldName("left"), receiver);

      if (field !== null) out.push({ name: field, node: n });
    }

    stack.push(...n.namedChildren);
  }

  return out.sort((a, b) => a.node.startIndex - b.node.startIndex);
}

/** Node types that bind their own receiver: assignments inside them are not the constructor's fields. */
const NESTED_SCOPES = new Set(["function_declaration", "function_expression", "function", "generator_function", "generator_function_declaration", "class_declaration", "class", "function_definition", "class_definition", "lambda", "anonymous_function", "anonymous_function_creation_expression", "method_declaration"]);

/** `this.x`, `self.x`, `$this->x` as an assignment target: `x`. Arrow functions keep the receiver, so they are walked. */
function receiverField(target: Node | null, receiver: string): string | null {
  if (target === null) return null;

  // TS/JS `this.x`.
  if (target.type === "member_expression" && target.childForFieldName("object")?.type === "this") {
    const property = target.childForFieldName("property");

    return property ? property.text : null;
  }

  // Python `self.x`.
  if (target.type === "attribute" && target.childForFieldName("object")?.text === receiver) return target.childForFieldName("attribute")?.text ?? null;

  // PHP `$this->x`.
  if (target.type === "member_access_expression" && target.childForFieldName("object")?.text === receiver) {
    const name = target.childForFieldName("name");

    return name?.type === "name" ? name.text : null;
  }

  return null;
}

/** The value declaration a statement of a scope is, through `export` (TS) and an expression statement (Python). */
function valueDeclaration(statement: Node): Node | null {
  switch (statement.type) {
    case "export_statement": {
      const decl = statement.childForFieldName("declaration");

      return decl ? valueDeclaration(decl) : null;
    }

    case "expression_statement": {
      // Python `MAX = 100`; a TS assignment statement declares nothing.
      const inner = statement.namedChildren[0];

      return inner?.type === "assignment" ? inner : null;
    }

    case "lexical_declaration": // TS/JS `const`, `let`
    case "variable_declaration": // `var`
    case "public_field_definition": // TS class field
    case "field_definition": // JS class field
    case "const_declaration": // PHP `const`
    case "property_declaration": // PHP property
    case "const_item": // Rust
    case "static_item":
      return statement;
    default:
      return null;
  }
}

/** The names a value declaration binds, per declaration syntax of each language. */
function declaredNames(decl: Node): string[] {
  switch (decl.type) {
    case "lexical_declaration":
    case "variable_declaration":
      return decl.namedChildren.filter((d) => d.type === "variable_declarator").flatMap((d) => patternNames(d.childForFieldName("name")));
    case "assignment": {
      const left = decl.childForFieldName("left");

      return left && (left.type === "identifier" || left.type.includes("pattern")) ? patternNames(left) : [];
    }

    case "public_field_definition":
    case "field_definition":
    case "const_item":
    case "static_item": {
      const name = decl.childForFieldName("name") ?? decl.childForFieldName("property");

      return name ? [name.text] : [];
    }

    case "const_declaration":
      return decl.namedChildren.filter((c) => c.type === "const_element").flatMap((c) => c.namedChildren.filter((n) => n.type === "name").slice(0, 1).map((n) => n.text));
    case "property_declaration":
      return decl.namedChildren.filter((c) => c.type === "property_element").flatMap((c) => patternNames(c.namedChildren.find((n) => n.type === "variable_name") ?? null));
    default:
      return [];
  }
}

/** Names a declaration target binds: an identifier, or every identifier of a destructuring pattern. */
function patternNames(target: Node | null): string[] {
  if (target === null) return [];

  if (target.childCount === 0) return NAME_LEAVES.has(target.type) || target.type === "shorthand_property_identifier_pattern" ? [target.text] : [];

  // A default value (`{ a = 1 }`) is code, not a name.
  return target.namedChildren.filter((child) => !child.type.includes("expression") && !child.type.includes("number")).flatMap(patternNames);
}

/** Wrappers whose first child is the object read: `a.b`, `a::b`, `a[0]`. */
const MEMBER_CHAINS = new Set(["member_expression", "attribute", "scoped_identifier", "field_expression", "subscript_expression", "subscript"]);

/** Calls by their callee field: an imported fn that is called is the call graph's to follow, not a read. */
const CALLEES = new Map([["call_expression", "function"], ["call", "function"], ["new_expression", "constructor"], ["macro_invocation", "macro"], ["scoped_call_expression", "scope"], ["function_call_expression", "function"]]);

/**
 * The names `node` reads as values that an import binds: `relative` when one
 * of them is bound by an import whose syntax places it in another file of the
 * repository, `other` those bound by an import whose syntax does not tell.
 */
interface ImportedValueReads {
  relative: boolean;
  other: string[];
}

function importedValueReads(node: Node, reads: ReadonlySet<string>): ImportedValueReads {
  const imported = importedValueNames(node.tree);

  // Fast path: the node reads no name any import binds.
  if (![...reads].some((name) => imported.relative.has(name) || imported.other.has(name))) return { relative: false, other: [] };
  let relative = false;
  const other = new Set<string>();
  // Walk the node's leaves; a name an import binds counts only when it is
  // read as a value, not called.
  const stack: Node[] = [node];

  while (stack.length > 0) {
    const n = stack.pop()!;

    // Types, decorators and JSX are no value reads a closure could follow.
    if (n.type.includes("comment") || n.type.includes("type") || n.type === "decorator" || n.type.startsWith("jsx_")) continue;

    if (n.childCount === 0) {
      // `name`: a PHP class or constant (`Limits::MAX`, `MAX`).
      if ((n.type === "identifier" || n.type === "name") && !isCallee(n)) {
        if (imported.relative.has(n.text)) relative = true;
        else if (imported.other.has(n.text)) other.add(n.text);
      }

      continue;
    }

    stack.push(...n.children);
  }

  return { relative, other: [...other].sort() };
}

/** Whether a leaf is (the head of) what a call or `new` invokes, rather than a value read. */
function isCallee(leaf: Node): boolean {
  // Climb member chains while the leaf is their object (`a` in `a.b.c`).
  let top = leaf;

  for (let parent = top.parent; parent !== null && MEMBER_CHAINS.has(parent.type) && parent.namedChildren[0]?.id === top.id; parent = top.parent) top = parent;
  const call = top.parent;

  // PHP `new Limits()`: the class is named, not read.
  if (call?.type === "object_creation_expression") return true;
  // The chain's top is the callee field of the call around it.
  const field = call ? CALLEES.get(call.type) : undefined;

  return call !== null && field !== undefined && call.childForFieldName(field)?.id === top.id;
}

/** Local names a file binds to values of other files by its top-level imports; see `importedValueNames`. */
interface ImportedNames {
  relative: Set<string>;
  other: Set<string>;
}

/**
 * Local names the file binds to values of other files by its top-level
 * imports. `relative`: the import's syntax places them in the repository — a
 * relative TS/JS specifier, a relative Python `from . import`, a Rust
 * `use crate::`/`super::`/`self::`. `other`: it does not tell — a bare TS/JS
 * specifier, a Python absolute import, a PHP `use` (not `use function`), a
 * Rust `use` of another crate; the graph decides by what the import resolves
 * to. A type-only import binds no value.
 */
function importedValueNames(tree: Tree): ImportedNames {
  const cached = importedValues.get(tree);

  if (cached) return cached;
  const names: ImportedNames = { relative: new Set(), other: new Set() };

  for (const statement of tree.rootNode.namedChildren) collectImportedNames(statement, names);
  importedValues.set(tree, names);

  return names;
}

/** Add the local names one top-level import binds to `names`, by language. */
function collectImportedNames(statement: Node, names: ImportedNames): void {
  if (statement.type === "namespace_definition") {
    // PHP `namespace App { use …; }`.
    for (const child of statement.childForFieldName("body")?.namedChildren ?? []) collectImportedNames(child, names);

    return;
  }

  const source = statement.type === "import_statement" ? statement.childForFieldName("source") : null;

  if (source) {
    // TS/JS; `import type` binds types only.
    if (statement.children.some((c) => !c.isNamed && c.type === "type")) return;
    // A specifier starting with `.` is a file of the repository.
    const into = /^["']\./.test(source.text) ? names.relative : names.other;
    const clause = statement.namedChildren.find((c) => c.type === "import_clause");

    // Default, namespace and named imports; a named `type` specifier binds no value.
    for (const part of clause?.namedChildren ?? []) {
      if (part.type === "identifier") into.add(part.text);
      else if (part.type === "namespace_import") for (const id of part.namedChildren) into.add(id.text);
      else if (part.type === "named_imports") {
        for (const spec of part.namedChildren) {
          if (spec.type !== "import_specifier" || spec.children.some((c) => !c.isNamed && c.type === "type")) continue;
          const local = spec.childForFieldName("alias") ?? spec.childForFieldName("name");

          if (local) into.add(local.text);
        }
      }
    }
  } else if (statement.type === "import_from_statement") {
    // Python `from .limits import MAX as M`, `from app.limits import MAX`.
    const into = statement.childForFieldName("module_name")?.type === "relative_import" ? names.relative : names.other;

    for (const name of statement.childrenForFieldName("name")) {
      const local = name.type === "aliased_import" ? name.childForFieldName("alias") : (name.namedChildren[name.namedChildren.length - 1] ?? name);

      if (local) into.add(local.text);
    }
  } else if (statement.type === "import_statement") {
    // Python `import app.limits` binds `app`; `import app.limits as l` binds `l`.
    for (const name of statement.childrenForFieldName("name")) {
      const local = name.type === "aliased_import" ? name.childForFieldName("alias") : (name.namedChildren[0] ?? name);

      if (local) names.other.add(local.text);
    }
  } else if (statement.type === "use_declaration") {
    // Rust `use crate::limits::{MAX, MIN as LOW};`.
    const argument = statement.childForFieldName("argument");

    if (argument) for (const name of useNames(argument)) (/^(crate|super|self)::/.test(argument.text) ? names.relative : names.other).add(name);
  } else if (statement.type === "namespace_use_declaration") {
    // PHP `use App\Limits;`, `use App\{A, B as C};`, `use const App\MAX;`; `use function` names fns, which are called.
    if (statement.children.some((c) => c.type === "function")) return;
    const clauses = [...statement.namedChildren, ...(statement.childForFieldName("body")?.namedChildren ?? [])].filter((c) => c.type === "namespace_use_clause");

    // Each clause binds its alias, else the last segment of its qualified name.
    for (const clause of clauses) {
      if (clause.childForFieldName("type")?.type === "function") continue;
      const named = clause.namedChildren.find((c) => c.type === "qualified_name" || c.type === "name");
      const local = clause.childForFieldName("alias") ?? (named?.type === "qualified_name" ? (named.childForFieldName("name") ?? named.lastNamedChild) : named);

      if (local) names.other.add(local.text);
    }
  }
}

/** The local names a Rust `use` tree binds: the last segment, an alias, or every name of a `{…}` list. */
function useNames(clause: Node): string[] {
  switch (clause.type) {
    case "identifier":
      return [clause.text];
    case "scoped_identifier": {
      const name = clause.childForFieldName("name");

      return name ? [name.text] : [];
    }

    case "use_as_clause": {
      const alias = clause.childForFieldName("alias");

      return alias ? [alias.text] : [];
    }

    case "scoped_use_list": {
      const list = clause.childForFieldName("list");

      return list ? useNames(list) : [];
    }

    case "use_list":
      return clause.namedChildren.flatMap(useNames);
    default:
      return [];
  }
}

export type { Language, Node, Tree };
