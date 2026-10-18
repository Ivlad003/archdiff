// PHP facts: namespaces, `use`, classes, interfaces, traits, enums, functions
// and methods, calls, type hints, `require`/`include` and PHPDoc. This is the
// source → FileFacts stage for `.php` files: `extractPhp` parses a file with
// tree-sitter and returns its FileFacts, which the graph turns into nodes and
// edges.
//
// PHP names a
// class or a function by its qualified name, never by its file, and a class of
// the file's own namespace needs no `use`. So every class or function name the
// file uses is an import whose specifier is the qualified name the PHP rules
// give it (`App\Domain\Order`, `function App\Support\helper`); the resolver
// finds the file that declares it (`src/php-imports.ts`). A `use` is an import
// where it is written. A name used without one is an optional import at its
// first use: an edge when a file declares that name, nothing otherwise. An
// unqualified function falls back to the global namespace, as PHP does. Calls
// PHP resolves at run time (`$f()`, `$obj->$m()`, `new $class`,
// `call_user_func`) are unsupported facts, and a method through a value whose
// class the syntax does not name is a gap. An untyped property (PHP 7) has the class of the
// constructor parameter assigned to it (`$this->x = $x` with `X $x`), a fact of
// the syntax; without one, the class its `@var` (or the parameter's `@param`)
// writes, which PHP does not check: provenance `docblock`.
//
// Entry points: `extractPhp`, `NAME_ARG_MEMBERS`.

import { asciiLowerCase } from "../languages.ts";
import type { ArgFact, AttributeFact, CallFact, ChainLinkFact, DeclFact, ExportRow, FieldFact, FileFacts, ImportFact, LiteralFact, MethodSigFact, ParamFact, PassFact, PropertyFact, ResultCallFact, ResultTypeFact, TypeRefFact, UnsupportedFact, ValueOfFact, ValueRefFact } from "./facts.ts";
import { blockCommentBody, isLicense, jsdocDescription, nonEmpty } from "./doc-comments.ts";
import { errorLine, fingerprintFacts, located, startCol, unsupportedAt, valuesFingerprint, withTree, type Node } from "./treesitter.ts";

/** Class names PHP gives a meaning of its own: never a class of the repository. */
const SPECIAL_CLASSES = new Set(["self", "static", "parent"]);

/** Type names that are no class (some grammars give them as names, not primitive types). */
const BUILTIN_TYPES = new Set(["self", "static", "parent", "mixed", "iterable", "object", "callable", "array", "bool", "int", "float", "string", "void", "never", "null", "false", "true"]);

/** Built-in functions that call a callable chosen at run time. */
const CALLABLE_CALLS = new Set(["call_user_func", "call_user_func_array", "forward_static_call", "forward_static_call_array"]);

/** Language constructs the grammar reads as calls: no function is called. */
const CONSTRUCTS = new Set(["isset", "empty"]);

/** Grammar nodes that call something: a function, a method (`->`, `?->`, `::`) or a constructor (`new`). */
const CALL_NODES = new Set(["function_call_expression", "member_call_expression", "nullsafe_member_call_expression", "scoped_call_expression", "object_creation_expression"]);

/** Values whose code runs later, when they are called or instantiated: calls inside them are marked `closure`. */
const CLOSURE_NODES = new Set(["anonymous_function", "arrow_function", "anonymous_class"]);

/** Named top-level declarations: each becomes a `DeclFact` and a symbol of the namespace. */
const DECLARATION_NODES = new Set(["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration", "function_definition"]);

/** `include`, `include_once`, `require` and `require_once`: file imports by path. */
const INCLUDE_NODES = new Set(["include_expression", "include_once_expression", "require_expression", "require_once_expression"]);

/** A callee longer than this is written as an opaque call through an expression. */
const MAX_CALLEE = 80;

/** The facts of one PHP file: parses `src` with the PHP grammar and reads the tree; `path` is repository-relative and anchors relative includes. */
export function extractPhp(path: string, src: string): Promise<FileFacts> {
  return withTree("php", src, (tree) => extractTree(path, tree.rootNode));
}


/** What names mean in one namespace: its name and the aliases of its `use` statements (keys in ASCII lower case: PHP class and function names ignore ASCII case). */
interface Names {
  ns: string;
  classes: Map<string, Alias>;
  functions: Map<string, Alias>;
  /** Constants keep their case. */
  consts: Map<string, Alias>;
}

interface Alias {
  /** As written in the `use`: the binding the file's names go through. */
  alias: string;
  qualified: string;
}

/** A class while its members are read: what `self::`, `$this->field->` and `static` name. */
interface ClassContext {
  name: string;
  /** Names of the static methods, in ASCII lower case. */
  statics: ReadonlySet<string>;
  /**
   * Property → its class, for a property typed with one class: `private Store $store`, a promoted
   * constructor parameter, the constructor parameter assigned to it, or its `@var`.
   */
  fields: ReadonlyMap<string, FieldType>;
  /** Property → the constructor parameter that fills it: promoted, or `$this->x = $x` (every assignment of it). */
  params: ReadonlyMap<string, string>;
}

/** The class of a property, and the docblock it comes from when no checked syntax names it. */
interface FieldType {
  /** The class's binding in the file, as `Collector.klass` gives it. */
  cls: string;
  /** The class as PHP qualifies it: what a subclass in another file reads (`DeclFact.fields`). */
  qualified: string;
  /** The property holds an array of the class's values (`@var Item[]`): no receiver, but `foreach` gives one. */
  element?: true;
  docblock?: { line: number; col: number };
}

/** A position in the file with its source fragment. */
interface At {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

/** A class name written in a docblock tag: `@var Foo`, `@param Foo $x`. */
interface DocType {
  written: string;
  at: At;
}

/** Where the class of a property comes from: a constructor parameter (typed, or by its `@param`) or a `@var`. */
interface TypeSource {
  written: string;
  /** The qualified name PHP gives it, in ASCII lower case: two spellings of one class compare equal. */
  key: string;
  local: string;
  qualified: string;
  element?: true;
  docblock?: { line: number; col: number };
}

/** Per file: the imports, the values read and the unsupported facts the names of the code add. */
class Collector {
  readonly imports = new Map<string, ImportFact>();
  readonly values = new Map<string, ValueRefFact>();
  readonly unsupported: UnsupportedFact[] = [];
  /** The comment that documents the file: it documents no declaration. */
  header: number | null = null;

  /** A class the code names: the binding it goes through, registered as an optional import unless a `use` binds it. */
  klass(written: string, node: Node, names: Names): string {
    return this.klassAt(written, located(node), names, false);
  }

  /** The same for a name at `at`; `docblock`: written only in a docblock, so the import is one of provenance `docblock` unless the code names it too. */
  klassAt(written: string, at: At, names: Names, docblock: boolean): string {
    const name = canonicalClass(written.trim(), names);

    if (!name.explicit && name.qualified !== null) this.implicit(name.local, name.qualified, at, docblock);

    return name.local;
  }

  /** A function the code calls by name, likewise. */
  fn(written: string, node: Node, names: Names): string {
    const name = canonicalFunction(written.trim(), names);

    if (!name.explicit) this.implicit(name.local, name.spec, located(node), false);

    return name.local;
  }

  /** A name's first use is its import; a use in the code replaces one in a docblock, whichever came first. */
  private implicit(local: string, spec: string, at: At, docblock: boolean): void {
    const key = `${spec}\0${local}`;
    const existing = this.imports.get(key);

    // Keep the first import, unless it came from a docblock and the code now names the class itself.
    if (existing && (docblock || !existing.docblock)) return;
    // The imported name is the last segment of the qualified name: strip the `function `/`const ` prefix and the `?? global` fallback.
    const imported = spec.replace(/^(function|const) /, "").replace(/ \?\? .*$/, "");
    const fact: ImportFact = { source: spec, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: firstLine(at.text), bindings: [{ kind: "named", local, imported: lastSegment(imported) }], reexport: false, optional: true };

    if (docblock) fact.docblock = true;
    this.imports.set(key, fact);
  }

  /** A name read as a value (`X::class`, `'m'` of `[$obj, 'm']`, `f(...)`), once per name; `member`: a method name, not a top-level one. */
  value(name: string, node: Node, member: boolean): void {
    const key = `${member ? "." : ""}${name}`;

    if (!this.values.has(key)) this.values.set(key, member ? { name, member: true, line: node.startPosition.row + 1, col: node.startPosition.column + 1 } : { name, line: node.startPosition.row + 1, col: node.startPosition.column + 1 });
  }

  /** Holes already recorded, by position and reason: typing a variable reads a call once more. */
  private readonly unsupportedSeen = new Set<string>();

  /** Records an unsupported fact at `node` (once per position and reason); `symbol` is the declaration whose behaviour it leaves unknown, if any. */
  noteUnsupported(node: Node, reason: string, symbol: string | null): void {
    const key = `${node.startIndex}:${node.endIndex}:${reason}`;

    if (this.unsupportedSeen.has(key)) return;
    this.unsupportedSeen.add(key);
    const fact = unsupportedAt(node, reason);

    if (symbol) fact.symbol = symbol;
    this.unsupported.push(fact);
  }
}

/** The FileFacts of a parsed tree: declarations and symbols per namespace region, then imports, unsupported facts and values gathered across the file. */
function extractTree(path: string, root: Node): FileFacts {
  const facts: FileFacts = { path, endLine: 1, endCol: 1, imports: [], decls: [], exports: new Set(), reexportsAll: [], exportRows: [], unsupported: [], valueRefs: [], moduleCalls: [], completeness: "complete", parseError: null, symbols: [] };
  const collector = new Collector();
  const header = fileDoc(root);
  collector.header = header?.id ?? null;
  const explicit: ImportFact[] = [];

  // Each namespace region has its own aliases: a `use` in one namespace does not reach the next.
  for (const region of regionsOf(root)) {
    const names: Names = { ns: region.ns, classes: new Map(), functions: new Map(), consts: new Map() };
    const statements: Node[] = [];

    for (const node of region.statements) collectTopLevel(node, statements);

    // `use` binds for the whole namespace: read them all before any name is resolved.
    for (const node of statements) if (node.type === "namespace_use_declaration") explicit.push(...usesOf(node, names));

    for (const node of statements) {
      if (node.type === "namespace_use_declaration") continue;

      // A named declaration: its fact, its qualified symbol (classes and functions live in separate tables) and an export row.
      if (DECLARATION_NODES.has(node.type)) {
        const decl = declarationOf(node, names, collector);

        if (!decl) continue;
        facts.decls.push(decl);
        const table = node.type === "function_definition" ? "function" : "class";
        facts.symbols!.push({ name: decl.name, qualified: qualify(names.ns, decl.name), table });
        exportRow(facts, decl.name, decl.kind === "fn" ? "fn" : decl.kind === "type" ? "type" : "class");
        continue;
      }

      // `const A = 1, B = 2;` at the top level: each name is a constant symbol of the namespace.
      if (node.type === "const_declaration") {
        for (const element of node.namedChildren.filter((c) => c.type === "const_element")) {
          const name = element.namedChildren.find((c) => c.type === "name")?.text;

          if (!name) continue;
          facts.symbols!.push({ name, qualified: qualify(names.ns, name), table: "const" });
          exportRow(facts, name, "value");
        }
      }

      // Code outside declarations runs when the file is included.
      facts.moduleCalls.push(...callsIn(node, { names, ctx: null, bound: new Map(), vars: () => null, symbol: null }, collector, false));
    }
  }

  // Imports and value reads in source order, so the facts are stable whatever order the walk found them in.
  facts.imports = [...explicit, ...includesIn(root, path, collector), ...collector.imports.values()].sort((a, b) => a.line - b.line || a.col - b.col);
  facts.unsupported = collector.unsupported;
  facts.valueRefs = [...collector.values.values()].sort((a, b) => a.line - b.line || a.col - b.col);

  if (header) facts.doc = header.doc;
  const values = valuesFingerprint(root.namedChildren, facts.decls);

  if (values !== undefined) facts.values = values;
  const end = located(root);
  facts.endLine = end.endLine;
  facts.endCol = end.endCol;

  // A syntax error anywhere makes the whole file opaque: what tree-sitter recovered is not trusted as complete.
  if (root.hasError) {
    facts.completeness = "opaque";
    facts.parseError = { line: errorLine(root), reason: "syntax error" };
  }

  return facts;
}

/** A stretch of the file under one namespace (`""` for the global one) and its top-level statements. */
interface Region {
  ns: string;
  statements: Node[];
}

/**
 * The file in namespace regions: `namespace A;` runs to the next namespace
 * statement, `namespace A { … }` is its block, and code before the first
 * namespace (or in `namespace { … }`) is global.
 */
function regionsOf(root: Node): Region[] {
  const out: Region[] = [];
  let current: Region = { ns: "", statements: [] };
  out.push(current);

  // One pass over the top level: any statement joins the current region; a namespace statement starts a new one.
  for (const node of root.namedChildren) {
    if (node.type !== "namespace_definition") {
      current.statements.push(node);
      continue;
    }

    const ns = node.childForFieldName("name")?.text.replace(/\s+/g, "") ?? "";
    const body = node.childForFieldName("body");

    // A bracketed namespace is a region of its own; code after its `}` is global again.
    if (body) {
      out.push({ ns, statements: body.namedChildren });
      current = { ns: "", statements: [] };
    } else current = { ns, statements: [] };
    out.push(current);
  }

  // The opening global region and the ones after `}` are often empty.
  return out.filter((region) => region.statements.length > 0);
}

/** Statements of a namespace, including those under a top-level `if` (`if (!function_exists('x')) { function x() {} }`) and in plain blocks. */
function collectTopLevel(node: Node, out: Node[]): void {
  // Descend into conditional and block statements, skipping the condition itself, so a guarded declaration still counts.
  if (node.type === "if_statement" || node.type === "else_clause" || node.type === "else_if_clause" || node.type === "compound_statement") {
    for (const child of node.namedChildren) if (child.type !== "parenthesized_expression") collectTopLevel(child, out);

    return;
  }

  out.push(node);
}

/** `name` in namespace `ns`: `A\B\name`, or `name` itself in the global namespace. */
function qualify(ns: string, name: string): string {
  return ns === "" ? name : `${ns}\\${name}`;
}

/** The last segment of a qualified name: `A\B\Foo` → `Foo`. */
function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf("\\") + 1);
}

/** The first line of a source fragment: what a fact quotes. */
function firstLine(text: string): string {
  return text.split("\n")[0]!;
}

/** `function` or `const` of a `use` or one of its clauses; null for a class. */
function useKind(node: Node): "function" | "const" | null {
  const kind = node.childForFieldName("type")?.text;

  return kind === "function" || kind === "const" ? kind : null;
}

/**
 * The imports of one `use` statement, one per clause (`use A\{B, C as D}` is
 * two), and the aliases they add to `names`. A function is `function <name>`,
 * a constant `const <name>`, a class its name.
 */
function usesOf(decl: Node, names: Names): ImportFact[] {
  const out: ImportFact[] = [];
  // A group use (`use A\{B, C}`) has a body; its prefix `A` is prepended to every clause.
  const group = decl.childForFieldName("body");
  const prefix = group ? (decl.namedChildren.find((c) => c.type === "namespace_name")?.text.replace(/\s+/g, "") ?? "") : "";
  const clauses = (group ?? decl).namedChildren.filter((c) => c.type === "namespace_use_clause");
  // Every clause is placed at the whole `use` statement.
  const at = located(decl);

  for (const clause of clauses) {
    const aliasNode = clause.childForFieldName("alias");
    const nameNode = clause.namedChildren.find((c) => (c.type === "name" || c.type === "qualified_name") && c.id !== aliasNode?.id);

    if (!nameNode) continue;
    // A `use` name is always fully qualified: a leading `\` changes nothing.
    const written = nameNode.text.replace(/\s+/g, "").replace(/^\\/, "");
    const qualified = prefix ? `${prefix}\\${written}` : written;
    // The clause's own `function`/`const` wins over the statement's (`use A\{function f, B}`); the default is a class.
    const kind = useKind(clause) ?? useKind(decl) ?? "class";
    const alias = aliasNode?.text ?? lastSegment(qualified);
    const table = kind === "function" ? names.functions : kind === "const" ? names.consts : names.classes;
    // Class and function aliases are keyed case-insensitively, as PHP compares them; constants are case-sensitive.
    table.set(kind === "const" ? alias : asciiLowerCase(alias), { alias, qualified });
    out.push({ source: kind === "class" ? qualified : `${kind} ${qualified}`, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: firstLine(at.text), bindings: [{ kind: "named", local: alias, imported: lastSegment(qualified) }], reexport: false });
  }

  return out;
}

interface CanonicalClass {
  local: string;
  qualified: string | null;
  explicit: boolean;
}

/**
 * A class name as the code writes it → the binding it goes through (`local`)
 * and the qualified name PHP gives it. `explicit`: a `use` binds exactly this
 * name. A name through an alias keeps the alias's spelling, so a call written
 * in another case still finds the binding. Null `qualified` for `self`,
 * `static` and `parent`.
 */
function canonicalClass(written: string, names: Names): CanonicalClass {
  // PHP's name resolution rules, in order: fully qualified, special, `namespace\` relative, aliased, then the current namespace.
  if (written.startsWith("\\")) return { local: written, qualified: written.slice(1), explicit: false };
  const lower = asciiLowerCase(written);

  // `explicit` here only stops an import: `self` and friends name no class of the repository.
  if (SPECIAL_CLASSES.has(lower)) return { local: written, qualified: null, explicit: true };

  if (lower.startsWith("namespace\\")) return { local: written, qualified: qualify(names.ns, written.slice("namespace\\".length)), explicit: false };
  const [head = "", ...rest] = written.split("\\");
  const alias = names.classes.get(asciiLowerCase(head));

  // An alias replaces the first segment; only the bare alias is the `use` itself, `Alias\Sub` is a new name under it.
  if (alias) return rest.length === 0 ? { local: alias.alias, qualified: alias.qualified, explicit: true } : { local: [alias.alias, ...rest].join("\\"), qualified: [alias.qualified, ...rest].join("\\"), explicit: false };

  return { local: written, qualified: qualify(names.ns, written), explicit: false };
}

interface CanonicalFunction {
  local: string;
  spec: string;
  explicit: boolean;
}

/**
 * A called function name → its binding and the specifier PHP resolves:
 * `function A\f`, or for an unqualified name in a namespace
 * `function A\f ?? f` (the global function when the namespace has none).
 */
function canonicalFunction(written: string, names: Names): CanonicalFunction {
  if (written.startsWith("\\")) return { local: written, spec: `function ${written.slice(1)}`, explicit: false };

  // A qualified function name resolves like a class name (alias of its first segment, or the namespace); no global fallback.
  if (written.includes("\\")) {
    const name = canonicalClass(written, names);

    return { local: name.local, spec: `function ${name.qualified ?? written}`, explicit: false };
  }

  const alias = names.functions.get(asciiLowerCase(written));

  if (alias) return { local: alias.alias, spec: `function ${alias.qualified}`, explicit: true };

  // An unqualified name: the namespace's function, else the global one (`?? f`), which the resolver tries in that order.
  return { local: written, spec: names.ns === "" ? `function ${written}` : `function ${names.ns}\\${written} ?? ${written}`, explicit: false };
}

/** Adds `name` to the file's exports once: every top-level PHP declaration is public. */
function exportRow(facts: FileFacts, name: string, kind: ExportRow["kind"]): void {
  if (facts.exports.has(name)) return;
  facts.exports.add(name);
  facts.exportRows.push({ name, kind, local: null });
}

/** A class name in a name or qualified-name node, as written. */
function classNameOf(node: Node | null): string | null {
  return node && (node.type === "name" || node.type === "qualified_name") ? node.text.replace(/\s+/g, "") : null;
}

/** A top-level class, interface, trait, enum or function. */
function declarationOf(node: Node, names: Names, collector: Collector): DeclFact | null {
  const name = node.childForFieldName("name")?.text;

  if (!name) return null;

  if (node.type === "function_definition") return fnDecl(node, name, names, null, collector, name);
  const at = located(node);
  const types: TypeRefFact[] = [];
  let base: string | undefined;
  /** `implements A, B` of a class; `extends A, B` of an interface. */
  const supers: string[] = [];

  // The header clauses: `extends` and `implements`, each name registered as an import.
  for (const child of node.namedChildren) {
    if (child.type === "base_clause") {
      // A class has one parent; `extends` of an interface lists several, and those are types.
      for (const parent of child.namedChildren) {
        const written = classNameOf(parent);

        if (!written) continue;
        const local = collector.klass(written, parent, names);

        if (node.type === "class_declaration" && base === undefined) base = local;
        else {
          types.push(typeRef(local, parent));

          if (node.type === "interface_declaration") supers.push(local);
        }
      }
    } else if (child.type === "class_interface_clause") {
      for (const iface of child.namedChildren) {
        const written = classNameOf(iface);

        if (!written) continue;
        const local = collector.klass(written, iface, names);
        types.push(typeRef(local, iface));
        supers.push(local);
      }
    }
  }

  const doc = docOf(node, collector.header);

  if (node.type === "interface_declaration") {
    // An interface is a type: a call through a value typed with it stays a gap, as in TypeScript.
    // What its methods return is a fact every class implementing it keeps (PHP checks it).
    const methods = interfaceMethods(node, names, collector);

    const decl: DeclFact = { kind: "type", name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature: null, exported: true, calls: [], types, members: [], ...fingerprintFacts(node) };

    if (supers.length > 0) decl.implements = supers;

    if (doc !== undefined) decl.doc = doc;

    if (methods.length > 0) decl.methods = methods;

    return decl;
  }

  // A class, trait or enum: read its body.
  const body = node.childForFieldName("body");
  const items = body?.namedChildren ?? [];
  const methods = items.filter((item) => item.type === "method_declaration");
  const statics = new Set(methods.filter((m) => m.namedChildren.some((c) => c.type === "static_modifier")).map((m) => asciiLowerCase(m.childForFieldName("name")?.text ?? "")));
  const fields = new Map<string, FieldType>();
  /** Untyped properties: their declarations and their `@var`, for the constructor to type. */
  const untyped = new Map<string, { node: Node; doc: DocType | null }>();
  /** Properties the constructor settled: typed, or an unsupported fact for conflicting classes. */
  const decided = new Set<string>();
  const traits: string[] = [];
  const traitRules: NonNullable<DeclFact["traitRules"]> = [];
  /** Property → the constructor parameter assigned to it; null when assignments disagree or are no parameter. */
  const params = new Map<string, string | null>();

  // First pass over the body: property types, and traits with their conflict rules.
  for (const item of items) {
    if (item.type === "property_declaration") {
      const type = singleClass(item.childForFieldName("type"));

      // One declaration may list several properties (`private A $a, $b;`): they share the type.
      for (const element of item.namedChildren.filter((c) => c.type === "property_element")) {
        const prop = element.childForFieldName("name")?.text.replace(/^\$/, "");

        if (!prop) continue;

        // Typed with one class: a checked fact. Untyped: left for the constructor or `@var`. Any other type: no class.
        if (type) fields.set(prop, { cls: collector.klass(type, item, names), qualified: classQualified(type, names) });
        else if (!item.childForFieldName("type")) untyped.set(prop, { node: item, doc: docTag(item, collector.header, /@var\s+(\S+)/) });
        else if (["array", "iterable", "?array", "?iterable"].includes(asciiLowerCase(item.childForFieldName("type")!.text.replace(/\s+/g, "")))) {
          // `private array $items` with `@var Item[]`: what `foreach` over it gives.
          const doc = docTag(item, collector.header, /@var\s+(\S+)/);
          const source = doc ? docSource(doc, names, collector, true) : null;

          if (source?.element) fields.set(prop, { cls: source.local, qualified: source.qualified, element: true, docblock: source.docblock! });
        }
      }

      for (const named of namedTypes(item.childForFieldName("type"))) types.push(typeRef(collector.klass(named.text, named.node, names), named.node));
    } else if (item.type === "use_declaration") {
      // `use SomeTrait;` in a class: its methods become the class's own (`$this->log()`); the trait is a dependency.
      for (const traitNode of item.namedChildren) {
        const written = classNameOf(traitNode);

        if (!written) continue;
        const local = collector.klass(written, traitNode, names);
        types.push(typeRef(local, traitNode));
        traits.push(local);
      }

      // `{ Loud::hello insteadof Quiet; Quiet::hello as whisper; }`: which trait's method the class takes.
      for (const clause of item.namedChildren.find((c) => c.type === "use_list")?.namedChildren ?? []) {
        if (clause.type !== "use_instead_of_clause" && clause.type !== "use_as_clause") continue;
        const [subject, ...rest] = clause.namedChildren;

        if (!subject) continue;
        // The subject is `Trait::method` (the grammar reads it as a constant access) or a bare `method`.
        const qualified = subject.type === "class_constant_access_expression" ? subject.namedChildren : null;
        const traitName = qualified ? classNameOf(qualified[0] ?? null) : null;
        const method = qualified ? qualified[1]?.text : subject.type === "name" ? subject.text : undefined;

        if (!method) continue;
        const trait = traitName ? collector.klass(traitName, qualified![0]!, names) : null;

        if (clause.type === "use_instead_of_clause") {
          const insteadof: string[] = [];

          for (const other of rest) {
            const written = classNameOf(other);

            if (written) insteadof.push(collector.klass(written, other, names));
          }

          if (trait) traitRules.push({ trait, method, insteadof });
        } else {
          // `as protected whisper` and `as whisper`: the new name is the last name; a visibility-only `as` has none.
          const alias = rest.filter((c) => c.type === "name").at(-1)?.text;

          if (alias) traitRules.push({ trait, method, alias });
        }
      }
    }
  }

  // The constructor types properties: promoted parameters directly, then `$this->x = $x` assignments.
  for (const method of methods) {
    if (asciiLowerCase(method.childForFieldName("name")?.text ?? "") !== "__construct") continue;

    for (const param of method.childForFieldName("parameters")?.namedChildren ?? []) {
      if (param.type !== "property_promotion_parameter") continue;
      const typeNode = param.childForFieldName("type");
      const type = singleClass(typeNode);
      const prop = param.childForFieldName("name")?.text.replace(/^\$/, "");

      if (prop) params.set(prop, prop);

      if (prop && type && typeNode) fields.set(prop, { cls: collector.klass(type, typeNode, names), qualified: classQualified(type, names) });
    }

    for (const prop of constructorFields(method, name, names, collector, fields, untyped, params)) decided.add(prop);
  }

  // A property the constructor neither types nor contradicts: its `@var`.
  for (const [prop, { doc }] of untyped) {
    if (fields.has(prop) || decided.has(prop) || !doc) continue;
    const source = docSource(doc, names, collector, true);

    if (source) fields.set(prop, classType(source.local, source.qualified, source.element === true, source.docblock!));
  }

  // Only properties every assignment fills from the same parameter keep it.
  const filled = new Map<string, string>();

  for (const [prop, param] of params) if (param !== null) filled.set(prop, param);
  const self = qualify(names.ns, name);
  const properties: PropertyFact[] = [];

  // Property defaults a framework adapter may read (`protected $listen = [...]`); uninformative ones are dropped.
  for (const item of items) {
    if (item.type !== "property_declaration") continue;

    for (const element of item.namedChildren.filter((c) => c.type === "property_element")) {
      const prop = element.childForFieldName("name")?.text.replace(/^\$/, "");
      const value = element.childForFieldName("default_value");
      const literal = value ? literalOf(value, names, self) : OTHER;

      if (prop && informative(literal)) properties.push({ name: prop, value: literal, line: element.startPosition.row + 1, col: element.startPosition.column + 1 });
    }
  }

  const attributes = attributesOf(node, names, self);
  const ctx: ClassContext = { name, statics, fields, params: filled };
  const members: DeclFact[] = [];

  // Methods last, once the class context (statics, typed properties) is complete.
  for (const method of methods) {
    const written = method.childForFieldName("name")?.text;

    if (!written) continue;
    // PHP names the constructor in any case; its ID is `<class>.__construct`, the name `new X()` runs.
    const member = asciiLowerCase(written) === "__construct" ? "__construct" : written;
    const decl = fnDecl(method, member, names, ctx, collector, `${name}.${member}`);
    const own = attributesOf(method, names, self);

    if (own.length > 0) decl.attributes = own;
    // A method without a visibility modifier is public in PHP.
    const visibility = asciiLowerCase(method.namedChildren.find((c) => c.type === "visibility_modifier")?.text ?? "");
    decl.exported = visibility !== "private" && visibility !== "protected";

    if (statics.has(asciiLowerCase(member))) decl.static = true;
    members.push(decl);
  }

  const values = valuesFingerprint(items, members);
  const fieldFacts = [...fields].map(([prop, f]) => fieldFact(prop, f));
  const decl: DeclFact = { kind: "class", name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature: null, exported: true, calls: [], types, members, ...fingerprintFacts(node) };

  if (values !== undefined) decl.values = values;

  if (base !== undefined) decl.base = base;

  if (traits.length > 0) decl.traits = traits;

  if (traitRules.length > 0) decl.traitRules = traitRules;

  if (supers.length > 0) decl.implements = supers;

  if (doc !== undefined) decl.doc = doc;

  if (attributes.length > 0) decl.attributes = attributes;

  if (properties.length > 0) decl.properties = properties;

  if (fieldFacts.length > 0) decl.fields = fieldFacts;

  return decl;
}

/** A typed property as `DeclFact.fields` stores it: the qualified class, with `element` and `docblock` when set. */
function fieldFact(name: string, field: FieldType): FieldFact {
  const fact: FieldFact = { name, class: field.qualified };

  if (field.element) fact.element = true;

  if (field.docblock) fact.docblock = field.docblock;

  return fact;
}

/** The methods of an interface with their result types. */
function interfaceMethods(node: Node, names: Names, collector: Collector): MethodSigFact[] {
  const out: MethodSigFact[] = [];

  for (const item of node.childForFieldName("body")?.namedChildren ?? []) {
    if (item.type !== "method_declaration") continue;
    const name = item.childForFieldName("name")?.text;

    if (!name) continue;
    const result = resultOf(item, names, collector);
    const sig: MethodSigFact = { name };

    if (item.namedChildren.some((c) => c.type === "static_modifier")) sig.static = true;

    if (result) sig.result = result;
    out.push(sig);
  }

  return out;
}

/**
 * The classes the constructor gives the class's untyped properties. `$this->x = $x`
 * with a parameter `X $x` is a fact of the syntax; with an untyped `$x` and
 * `@param X $x`, or no assignment and `@var X` above the property, the class
 * comes from a docblock PHP does not check. Only a parameter assigned as it is
 * counts: an expression (`$x ?: new X()`) has no class the syntax names.
 * Assignments of two classes, or a `@var` the constructor contradicts, type
 * nothing: an unsupported fact `ambiguous property type` of the class. Returns the
 * properties settled either way; the rest may still have a `@var`.
 */
function constructorFields(method: Node, className: string, names: Names, collector: Collector, fields: Map<string, FieldType>, untyped: ReadonlyMap<string, { node: Node; doc: DocType | null }>, filledBy: Map<string, string | null>): Set<string> {
  const decided = new Set<string>();
  const paramDocs = new Map<string, DocType>();

  // `@param Type $name` (also `...$name`, `&$name`): the first tag per parameter wins.
  for (const doc of docTags(method, collector.header, /@param\s+(\S+)\s+(?:\.\.\.)?&?\$([A-Za-z_\x80-\uffff][A-Za-z0-9_\x80-\uffff]*)/)) if (doc.name && !paramDocs.has(doc.name)) paramDocs.set(doc.name, doc);
  /** Parameter → the class it names, or null for one of no single class. */
  const params = new Map<string, TypeSource | null>();

  // A declared type decides the parameter's class; only an untyped parameter falls back to its `@param`.
  for (const param of method.childForFieldName("parameters")?.namedChildren ?? []) {
    const variable = param.childForFieldName("name")?.text.replace(/^\$/, "");

    if (!variable) continue;
    const typeNode = param.childForFieldName("type");

    if (typeNode) {
      const written = singleClass(typeNode);
      params.set(variable, written ? { written, key: classKey(written, names), local: collector.klass(written, typeNode, names), qualified: classQualified(written, names) } : null);
      continue;
    }

    const doc = paramDocs.get(variable);
    params.set(variable, doc ? docSource(doc, names, collector) : null);
  }

  /** Property → what each constructor assignment gives it, in order; null for a value of no known class. */
  const assigned = new Map<string, { node: Node; sources: (TypeSource | null)[] }>();
  const body = method.childForFieldName("body");

  // Collect every `$this->prop = …` in the constructor body.
  if (body) {
    walkScope(body, (n) => {
      if (n.type !== "assignment_expression") return;
      const left = n.childForFieldName("left");

      if (left?.type !== "member_access_expression" || left.childForFieldName("object")?.text !== "$this") return;
      const prop = left.childForFieldName("name");

      if (prop?.type !== "name") return;
      const right = n.childForFieldName("right");
      const value = right ? unparenthesized(right) : null;
      // Which constructor argument the property holds, whatever its class: a framework may set that argument.
      const param = value?.type === "variable_name" && params.has(value.text.replace(/^\$/, "")) ? value.text.replace(/^\$/, "") : null;
      const before = filledBy.get(prop.text);
      filledBy.set(prop.text, before === undefined || before === param ? param : null);

      // A property already typed by its declaration or promotion needs no inference.
      if (fields.has(prop.text)) return;
      const source = value?.type === "variable_name" ? (params.get(value.text.replace(/^\$/, "")) ?? null) : null;
      const entry = assigned.get(prop.text) ?? { node: n, sources: [] };
      entry.sources.push(source);
      assigned.set(prop.text, entry);
    });
  }

  // Decide each assigned property: one class from every assignment, or an unsupported fact when they disagree.
  for (const [prop, { node, sources }] of assigned) {
    const known = sources.filter((source): source is TypeSource => source !== null);

    // No assignment names a class: nothing settled, a `@var` may still type it.
    if (known.length === 0) continue;
    decided.add(prop);
    const declared = untyped.get(prop);
    const where = declared?.node ?? node;
    // Distinct classes by qualified key, each shown in its first spelling.
    const distinct = [...new Map(known.map((source) => [source.key, source.written])).values()];

    // Two classes, or a class and a value of no known class: ambiguous.
    if (distinct.length > 1 || known.length < sources.length) {
      const listed = [...distinct, ...(known.length < sources.length ? ["a value of no known class"] : [])].map((item, i) => (i < distinct.length ? `\`${item}\`` : item));
      collector.noteUnsupported(where, `ambiguous property type \`$${prop}\`: assigned ${listed.join(" and ")} in the constructor`, className);
      continue;
    }

    const first = known[0]!;
    const doc = declared?.doc ? docSource(declared.doc, names, collector) : null;

    // A `@var` that names another class contradicts the constructor: trust neither.
    if (doc && doc.key !== first.key) {
      collector.noteUnsupported(where, `ambiguous property type \`$${prop}\`: \`@var ${doc.written}\`, assigned \`${first.written}\` in the constructor`, className);
      continue;
    }

    // One class from every assignment: a fact of the syntax when any parameter is typed.
    const syntactic = known.find((source) => !source.docblock);
    fields.set(prop, syntactic ? { cls: syntactic.local, qualified: syntactic.qualified } : { cls: first.local, qualified: first.qualified, docblock: first.docblock! });
  }

  return decided;
}

/** The qualified name of a class as written, in ASCII lower case: how two spellings compare. */
function classKey(written: string, names: Names): string {
  return asciiLowerCase(canonicalClass(written, names).qualified ?? written);
}

/** The qualified name of a class as written (the enclosing class for `self`/`static` is not known here: the name as written). */
function classQualified(written: string, names: Names): string {
  return canonicalClass(written, names).qualified ?? written;
}

/**
 * The class a docblock type names, registered as a docblock import; null when it names no
 * single class. `arrays`: an array of one class (`Item[]`) counts too, with `element`.
 */
function docSource(doc: DocType, names: Names, collector: Collector, arrays = false): TypeSource | null {
  // With `arrays`, an array of one class wins; otherwise (or failing that) the one class the type names.
  const type = arrays ? docType(doc.written) : null;
  const array = type && "cls" in type && type.element ? type.cls : null;
  const written = array ?? singleDocClass(doc.written);

  if (!written) return null;

  const source: TypeSource = { written, key: classKey(written, names), local: collector.klassAt(written, doc.at, names, true), qualified: classQualified(written, names) };

  if (array) source.element = true;
  source.docblock = { line: doc.at.line, col: doc.at.col };

  return source;
}

/**
 * The one class a docblock type names: `Foo`, `?Foo`, `Foo|null`, `\App\Foo`.
 * Null for a union of classes, an array (`Foo[]`, `array<Foo>`), a built-in
 * type or anything else PHPDoc writes.
 */
function singleDocClass(written: string): string | null {
  // Drop nullability (`?Foo`, `Foo|null`): what is left must be exactly one name.
  const parts = written
    .replace(/^\?/, "")
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part !== "" && asciiLowerCase(part) !== "null");

  if (parts.length !== 1) return null;
  const name = parts[0]!;

  // A PHP name, optionally fully qualified: `Foo`, `\App\Foo`; rejects `Foo[]`, `array<Foo>`, `$this`.
  if (!/^\\?[A-Za-z_\x80-\uffff][A-Za-z0-9_\x80-\uffff]*(\\[A-Za-z_\x80-\uffff][A-Za-z0-9_\x80-\uffff]*)*$/.test(name)) return null;

  return BUILTIN_TYPES.has(asciiLowerCase(name)) ? null : name;
}

/** A class name as PHPDoc writes one: `Foo`, `\App\Foo`. */
const DOC_CLASS = /^\\?[A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*(\\[A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*)*$/;

/**
 * What a docblock type says of a value: one class (`Foo`, `?Foo`, `Foo|null`), an array of one
 * class (`Foo[]`, `array<Foo>`, `array<int, Foo>`, `iterable<Foo>`, `list<Foo>`), or the class
 * itself (`$this`, `static`, `self`). Null for a union of classes, a built-in type, generics of
 * a class (`Collection<Foo>`: what it yields is the class's business) and anything else.
 */
function docType(written: string): { cls: string; element?: true } | { self: "self" | "static" } | null {
  const parts = written
    .replace(/^\?/, "")
    .split("|")
    .map((part) => part.trim())
    .filter((part) => part !== "" && asciiLowerCase(part) !== "null");

  if (parts.length !== 1) return null;
  const part = parts[0]!;
  const lower = asciiLowerCase(part);

  if (lower === "$this" || lower === "static") return { self: "static" };

  if (lower === "self") return { self: "self" };
  // `Foo[]`, or a one-parameter array generic with an optional key type: `array<Foo>`, `array<int, Foo>`, `list<Foo>`.
  const array = /^(.+)\[\]$/.exec(part) ?? /^(?:array|iterable|list|non-empty-array|non-empty-list)<(?:[^,<>]+,\s*)?([^,<>]+)>$/i.exec(part);
  const name = array ? array[1]!.trim() : part;

  if (!DOC_CLASS.test(name) || BUILTIN_TYPES.has(asciiLowerCase(name))) return null;

  return array ? { cls: name, element: true } : { cls: name };
}

/**
 * The result type of a function or method: the declared return type when it names one class
 * (`: Order`, `: ?Order`, `: Order|null`, `: static`, `: self`), else its `@return` when the
 * declared type leaves room for it (none, `mixed`, `object`, or `array`/`iterable` for an array
 * of a class). The class is qualified as PHP resolves it.
 */
function resultOf(node: Node, names: Names, collector: Collector): ResultTypeFact | undefined {
  const returns = node.childForFieldName("return_type");
  const declared = returns ? returns.text.replace(/\s+/g, "") : null;

  // The declared return type first: PHP checks it, so it outranks any `@return`.
  if (declared !== null) {
    const parts = declared.replace(/^\?/, "").split("|").filter((part) => asciiLowerCase(part) !== "null");

    if (parts.length === 1) {
      const lower = asciiLowerCase(parts[0]!);

      if (lower === "static") return { self: "static" };

      if (lower === "self") return { self: "self" };

      if (!BUILTIN_TYPES.has(lower) && DOC_CLASS.test(parts[0]!)) {
        const qualified = canonicalClass(parts[0]!, names).qualified;

        return qualified ? { class: qualified } : undefined;
      }
    }
  }

  // How much a `@return` may say: anything for no type, `mixed` or `object`; only an array of a class for `array`/`iterable`; nothing otherwise.
  const room = declared === null ? "any" : ["mixed", "object"].includes(asciiLowerCase(declared.replace(/^\?/, ""))) ? "any" : ["array", "iterable"].includes(asciiLowerCase(declared.replace(/^\?/, ""))) ? "array" : null;

  if (room === null) return undefined;
  const tag = docTag(node, collector.header, /@return\s+(\S+)/);
  const type = tag ? docType(tag.written) : null;

  if (!tag || !type) return undefined;
  const docblock = { line: tag.at.line, col: tag.at.col };

  // `@return $this`/`static`/`self` fits only where any value may come back.
  if ("self" in type) return room === "any" ? { self: type.self, docblock } : undefined;

  // A declared `array` admits `Foo[]` but not a single `Foo`.
  if (room === "array" && !type.element) return undefined;
  const qualified = canonicalClass(type.cls, names).qualified;

  if (!qualified) return undefined;

  const result: ResultTypeFact = { class: qualified };

  if (type.element) result.element = true;
  result.docblock = docblock;

  return result;
}

/** The one class a type names: `Store`, `?Store`; null for a union, an intersection, a built-in type or none. */
function singleClass(type: Node | null): string | null {
  if (!type) return null;
  const inner = type.type === "optional_type" ? type.namedChildren[0] : type;

  if (inner?.type !== "named_type") return null;
  const written = classNameOf(inner.namedChildren[0] ?? null);

  return written && !BUILTIN_TYPES.has(asciiLowerCase(written)) ? written : null;
}

/** Every class a type names, in unions, intersections and nullable types. */
function namedTypes(type: Node | null): { text: string; node: Node }[] {
  const out: { text: string; node: Node }[] = [];

  const walk = (node: Node): void => {
    if (node.type === "named_type") {
      const nameNode = node.namedChildren[0] ?? null;
      const written = classNameOf(nameNode);

      if (written && nameNode && !BUILTIN_TYPES.has(asciiLowerCase(written))) out.push({ text: written, node: nameNode });

      return;
    }

    for (const child of node.namedChildren) walk(child);
  };

  if (type) walk(type);

  return out;
}

/** A reference to the class `name` (its binding in the file) at `node`: a type dependency of the declaration. */
function typeRef(name: string, node: Node): TypeRefFact {
  const at = located(node);

  return { name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: firstLine(at.text) };
}

/**
 * What the code says of a variable's value: a class (`cls` its binding in the file, as
 * `Collector.klass` gives it; `element`: an array of that class's values), or the result of a
 * call whose declared result type the graph reads (`of`).
 */
type VarType = { cls: string; qualified: string; element?: true; docblock?: { line: number; col: number } } | { of: ValueOfFact };

/** One way a function binds a variable: a type known as written, an assigned expression, or the element of what `foreach` iterates. */
type Binding = { type: VarType | null } | { value: Node } | { elementOf: Node };

/** Two bindings agree: the same class (by qualified name) both ways, or both arrays of it; a call's result agrees with nothing else. */
function sameType(a: VarType, b: VarType): boolean {
  if ("of" in a || "of" in b) return a === b;

  return asciiLowerCase(a.qualified) === asciiLowerCase(b.qualified) && a.element === b.element;
}

/** The type of a value of a class, its keys in the order every class type keeps: `element`, then `docblock`. */
function classType(cls: string, qualified: string, element: boolean, docblock: FieldType["docblock"]): FieldType {
  const type: FieldType = { cls, qualified };

  if (element) type.element = true;

  if (docblock) type.docblock = docblock;

  return type;
}

/** What `foreach` over a value gives: an element of an array of a class, or of the array a call returns. */
function elementType(type: VarType | null): VarType | null {
  if (type === null) return null;

  if ("of" in type) return type.of.element ? null : { of: { ...type.of, element: true } };

  return type.element ? classType(type.cls, type.qualified, false, type.docblock) : null;
}

/**
 * The class of an expression's value as the syntax tells it: `new X(…)`, a variable, `$this->x`
 * of a property the class types, `clone`, or a call (`of`: its declared result type, read by the
 * graph). Null for anything else.
 */
function valueType(expr: Node, scope: Scope, collector: Collector): VarType | null {
  const n = unparenthesized(expr);

  // `new X(…)`: the class it names; `new self`/`new static` the enclosing class; `new parent` and anonymous classes no known class.
  if (n.type === "object_creation_expression") {
    const target = n.namedChildren[0] ?? null;
    const written = target && target.type !== "anonymous_class" ? classNameOf(target) : null;

    if (!written) return null;
    const lower = asciiLowerCase(written);

    if (lower === "parent") return null;

    if (lower === "self" || lower === "static") return scope.ctx ? { cls: scope.ctx.name, qualified: qualify(scope.names.ns, scope.ctx.name) } : null;

    return { cls: collector.klass(written, target!, scope.names), qualified: classQualified(written, scope.names) };
  }

  if (n.type === "variable_name") {
    const variable = n.text.replace(/^\$/, "");

    // `$this` is handled by the callers as `this.…`, never as a typed variable.
    return variable === "this" ? null : scope.vars(variable);
  }

  if (n.type === "clone_expression") return n.namedChildren[0] ? valueType(n.namedChildren[0], scope, collector) : null;

  if (n.type === "member_access_expression" && n.childForFieldName("object")?.text === "$this") {
    const prop = n.childForFieldName("name");
    const field = prop?.type === "name" ? scope.ctx?.fields.get(prop.text) : undefined;

    return field ? classType(field.cls, field.qualified, field.element === true, field.docblock) : null;
  }

  // A call: its result class is not known here, only which call it is; the graph looks up the declared result type.
  if (CALL_NODES.has(n.type) && n.type !== "object_creation_expression" && !firstClassCallable(n)) {
    const call = resultCall(n, scope, collector);

    return call ? { of: { call } } : null;
  }

  return null;
}

/** A call as the receiver of another: its callee as `calleeOf` reads it, and the member it calls; null when the graph could not look it up. */
function resultCall(n: Node, scope: Scope, collector: Collector): ResultCallFact | null {
  const fact = calleeOf(n, scope, collector);

  // An opaque callee is only usable when it is itself a call on a known result (`on`).
  if (!fact || (fact.opaque && !fact.on)) return null;
  const nameNode = n.type === "function_call_expression" ? n.childForFieldName("function") : n.childForFieldName("name");

  if (nameNode?.type !== "name" && nameNode?.type !== "qualified_name") return null;
  const member = n.type === "function_call_expression" ? fact.callee : nameNode.text;
  const args = argsOf(n, scope.names, scope.ctx ? qualify(scope.names.ns, scope.ctx.name) : null);

  // Arguments are kept only when one of them is an informative literal, as on a call fact.
  const call: ResultCallFact = args.some((a) => informative(a.value)) ? { args, callee: fact.callee, member } : { callee: fact.callee, member };

  if (fact.bound) call.bound = fact.bound;

  if (fact.receiver) call.receiver = fact.receiver;

  if (fact.docblock) call.docblock = fact.docblock;

  if (fact.on) call.on = fact.on;

  if (fact.opaque) call.opaque = true;

  return call;
}

/**
 * The `@var` tags of a comment in a function body: `@var Foo $x`, `@var $x Foo`, or a bare
 * `@var Foo` right above `$x = …`. A class or an array of one.
 */
function inlineVars(comment: Node, names: Names, collector: Collector): { variable: string; type: VarType }[] {
  // Only block comments carry PHPDoc; `// @var` is ignored.
  if (!comment.text.startsWith("/*")) return [];
  const out: { variable: string; type: VarType }[] = [];
  // A bare `@var Foo` types the variable the next statement assigns, if it assigns one.
  const next = comment.nextNamedSibling;
  const assigned = next?.type === "expression_statement" && next.namedChildren[0]?.type === "assignment_expression" ? next.namedChildren[0].childForFieldName("left") : null;
  const following = assigned?.type === "variable_name" ? assigned.text.replace(/^\$/, "") : null;
  // One tag per line, tried in three forms: `@var Type $x`, then `@var $x Type`, then a bare `@var Type`.
  comment.text.split("\n").forEach((text, i) => {
    const named = /@var\s+([^\s$][^\s]*)\s+\$([A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*)/.exec(text);
    const reversed = named ? null : /@var\s+\$([A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*)\s+([^\s*]+)/.exec(text);
    const bare = named || reversed ? null : /@var\s+([^\s*$][^\s*]*)/.exec(text);
    const match = named ?? reversed ?? bare;

    if (!match) return;
    const written = named ? named[1]! : reversed ? reversed[2]! : bare![1]!;
    const variable = named ? named[2]! : reversed ? reversed[1]! : following;

    if (!variable) return;
    // The tag's position: only the comment's first line starts at the comment's column.
    const line = comment.startPosition.row + 1 + i;
    const col = (i === 0 ? comment.startPosition.column : 0) + match.index + match[0].indexOf("@") + 1;
    const source = docSource({ written, at: { line, col, endLine: line, endCol: col + match[0].length, text: text.trim() } }, names, collector, true);

    if (source) out.push({ variable, type: classType(source.local, source.qualified, source.element === true, source.docblock!) });
  });

  return out;
}

/** What a call in a function sees: the namespace's names, the class, the function's variables and their classes. */
interface Scope {
  names: Names;
  ctx: ClassContext | null;
  /** Variables of the function, without `$`: parameters, then any other assigned name. */
  bound: ReadonlyMap<string, "parameter" | "local">;
  /** The class of a variable's value, when its bindings name one (`scope.vars` of `fnDecl`); null otherwise. */
  vars: (variable: string) => VarType | null;
  /** The declaration as a dotted path in the file (`Order.place`), for an unsupported fact of its own behaviour. */
  symbol: string | null;
}

/** A function or a method. `symbol` is its dotted path in the file. */
function fnDecl(node: Node, name: string, names: Names, ctx: ClassContext | null, collector: Collector, symbol: string): DeclFact {
  const at = located(node);
  const params = node.childForFieldName("parameters");
  const returns = node.childForFieldName("return_type");
  // The signature is the parameter list and return type as written, whitespace collapsed to single spaces.
  const signature = params ? `${params.text.replace(/\s+/g, " ")}${returns ? ` → ${returns.text.replace(/\s+/g, " ")}` : ""}` : null;
  const types: TypeRefFact[] = [];
  const bound = new Map<string, "parameter" | "local">();
  /** Each way the function binds a variable, in order: what archdiff can type it from, or `other`. */
  const bindings = new Map<string, Binding[]>();

  const bindAs = (variable: string, binding: Binding): void => {
    bindings.set(variable, [...(bindings.get(variable) ?? []), binding]);
  };

  const self = ctx ? qualify(names.ns, ctx.name) : null;
  const paramFacts: ParamFact[] = [];
  const paramDocs = new Map<string, DocType>();

  // `@param Type $name` (also `...$name`, `&$name`): the first tag per parameter wins.
  for (const doc of docTags(node, collector.header, /@param\s+(\S+)\s+(?:\.\.\.)?&?\$([A-Za-z_\x80-\uffff][A-Za-z0-9_\x80-\uffff]*)/)) if (doc.name && !paramDocs.has(doc.name)) paramDocs.set(doc.name, doc);

  // Each parameter: its fact (with the qualified class when typed), its binding for variable typing, and the classes its type names.
  for (const param of params?.namedChildren ?? []) {
    const variable = param.childForFieldName("name")?.text.replace(/^\$/, "");

    if (!variable) continue;
    bound.set(variable, "parameter");
    const type = param.childForFieldName("type");
    const single = singleClass(type);
    // The parameter fact's type: `self`/`static` is the enclosing class, `parent` unknown.
    const qualified = single === null ? null : SPECIAL_CLASSES.has(asciiLowerCase(single)) ? (asciiLowerCase(single) === "parent" ? null : self) : canonicalClass(single, names).qualified;
    paramFacts.push(qualified ? { name: variable, type: qualified } : { name: variable });
    // A class PHP checks; else the `@param` where the declared type leaves room for one (none, `mixed`, `object`, an array of a class).
    const declared = type ? asciiLowerCase(type.text.replace(/\s+/g, "").replace(/^\?/, "")) : null;
    const doc = paramDocs.get(variable);
    const room = declared === null || declared === "mixed" || declared === "object" ? "any" : declared === "array" || declared === "iterable" ? "array" : null;
    const fromDoc = !single && room && doc ? docSource(doc, names, collector, true) : null;
    const typed: VarType | null = single && !SPECIAL_CLASSES.has(asciiLowerCase(single)) ? { cls: collector.klass(single, type!, names), qualified: classQualified(single, names) } : fromDoc && (room === "any" || fromDoc.element) ? classType(fromDoc.local, fromDoc.qualified, fromDoc.element === true, fromDoc.docblock!) : null;
    bindAs(variable, { type: typed });

    for (const named of namedTypes(type)) types.push(typeRef(collector.klass(named.text, named.node, names), named.node));
  }

  for (const named of namedTypes(returns)) types.push(typeRef(collector.klass(named.text, named.node, names), named.node));
  const body = node.childForFieldName("body");

  /** Variables bound some other way than one archdiff types (`list()`, `global`, `static`, `&=`): their class is not known. */
  const bindAll = (target: Node | null): void => {
    if (!target) return;

    const walk = (n: Node): void => {
      if (n.type === "variable_name") {
        const variable = n.text.replace(/^\$/, "");

        if (!bound.has(variable)) bound.set(variable, "local");
        bindAs(variable, { type: null });

        return;
      }

      if (!CLOSURE_NODES.has(n.type)) for (const child of n.namedChildren) walk(child);
    };

    walk(target);
  };

  /** `/** @var Foo $x *\/` in the body: the class the author gives the variable, whatever it is assigned. */
  const inline = new Map<string, VarType | null>();

  // One walk of the body records every way a variable is bound, and the types `catch` and `instanceof` name.
  if (body) {
    walkScope(body, (n) => {
      // Inline `@var` tags for one variable must agree, or they type nothing.
      if (n.type === "comment") {
        for (const tag of inlineVars(n, names, collector)) {
          const before = inline.get(tag.variable);
          inline.set(tag.variable, before === undefined || (before !== null && sameType(before, tag.type)) ? (before ?? tag.type) : null);
        }
      } else if (n.type === "assignment_expression" || n.type === "augmented_assignment_expression" || n.type === "reference_assignment_expression") {
        const left = n.childForFieldName("left");

        // Destructuring (`[$a, $b] = …`, `list(…) = …`): bound, class unknown.
        if (left?.type === "list_literal" || left?.type === "array_creation_expression") return bindAll(left);

        if (left?.type !== "variable_name") return;
        const variable = left.text.replace(/^\$/, "");

        if (!bound.has(variable)) bound.set(variable, "local");
        const right = n.childForFieldName("right");
        // Only a plain `=` keeps the value to type later; `.=`, `+=` and `=&` leave the class unknown.
        bindAs(variable, n.type === "assignment_expression" && right ? { value: right } : { type: null });
      } else if (n.type === "foreach_statement") {
        // `foreach ($items as $k => $v)`: what follows `as` is bound; the iterated expression is only read.
        const [iterated, target] = n.namedChildren.filter((c) => c.id !== n.childForFieldName("body")?.id && c.type !== "comment");
        const value = target?.type === "pair" ? target.namedChildren[1] : target;

        if (iterated && value?.type === "variable_name") {
          const variable = value.text.replace(/^\$/, "");

          if (!bound.has(variable)) bound.set(variable, "local");
          bindAs(variable, { elementOf: iterated });

          if (target?.type === "pair") bindAll(target.namedChildren[0] ?? null);
        } else bindAll(target ?? null);
      } else if (n.type === "global_declaration" || n.type === "function_static_declaration") {
        bindAll(n);
      } else if (n.type === "catch_clause") {
        // `catch (A $e)` types `$e`; `catch (A | B $e)` only registers both classes as types.
        const variable = n.childForFieldName("name")?.text.replace(/^\$/, "");
        const typeNode = n.childForFieldName("type");
        const caught = singleClass(typeNode) ?? (typeNode?.type === "type_list" && typeNode.namedChildren.length === 1 ? singleClass(typeNode.namedChildren[0]!) : null);

        if (variable && !bound.has(variable)) bound.set(variable, "local");

        if (variable) bindAs(variable, { type: caught && !SPECIAL_CLASSES.has(asciiLowerCase(caught)) ? { cls: collector.klass(caught, typeNode!, names), qualified: classQualified(caught, names) } : null });

        for (const named of namedTypes(typeNode)) types.push(typeRef(collector.klass(named.text, named.node, names), named.node));
      } else if (n.type === "binary_expression" && n.childForFieldName("operator")?.text === "instanceof") {
        // `$x instanceof Foo` depends on `Foo`; the narrowing itself happens in `callsIn`.
        const right = n.childForFieldName("right");
        const written = classNameOf(right);

        if (written && right && !SPECIAL_CLASSES.has(asciiLowerCase(written))) types.push(typeRef(collector.klass(written, right, names), right));
      }
    });
  }

  // `vars` is filled in below: it needs the scope itself to type assigned expressions.
  const scope: Scope = { names, ctx, bound, vars: () => null, symbol };
  // Memo of resolved variables, and the ones being resolved: `$a = $b; $b = $a;` must not loop.
  const memo = new Map<string, VarType | null>();
  const visiting = new Set<string>();
  /**
   * The class of a variable: its inline `@var`, else what every binding of it gives when they
   * agree on one class (a parameter's type, `new X`, a call's declared result, `foreach` over an
   * array of a class, `catch (X $e)`). Bindings of different or unknown classes: none.
   */
  scope.vars = (variable: string): VarType | null => {
    const known = memo.get(variable);

    if (known !== undefined) return known;

    // A cycle through this variable names no class (and is not memoised: the outer call decides).
    if (visiting.has(variable)) return null;
    visiting.add(variable);
    const written = inline.get(variable);
    let type: VarType | null = null;

    // An inline `@var` overrides the bindings; otherwise every binding must give the same class.
    if (written !== undefined) type = written;
    else {
      const each = (bindings.get(variable) ?? []).map((b) => ("type" in b ? b.type : "value" in b ? valueType(b.value, scope, collector) : elementType(valueType(b.elementOf, scope, collector))));
      const first = each[0] ?? null;
      type = first !== null && each.every((t) => t !== null && sameType(t, first)) ? first : null;
    }

    visiting.delete(variable);
    memo.set(variable, type);

    return type;
  };

  const calls = body ? callsIn(body, scope, collector, false) : [];
  const doc = docOf(node, collector.header);
  // `return [Event::class => 'on'];` as the whole body: a literal a framework reads.
  const statements = body?.namedChildren.filter((c) => c.type !== "comment") ?? [];
  const returned = statements.length === 1 && statements[0]!.type === "return_statement" && statements[0]!.namedChildren[0] ? literalOf(statements[0]!.namedChildren[0], names, self) : OTHER;
  // Parameter facts only when at least one parameter names a class.
  const typed = paramFacts.some((p) => p.type !== undefined);
  // A method's attributes are read by `declarationOf`, with the class as `self`.
  const attributes = node.type === "function_definition" ? attributesOf(node, names, null) : [];
  const result = resultOf(node, names, collector);

  const decl: DeclFact = {
    kind: "fn",
    name,
    line: at.line,
    col: at.col,
    endLine: at.endLine,
    endCol: at.endCol,
    signature,
    exported: true,
    calls,
    types,
    members: [],
    ...fingerprintFacts(node),
  };

  if (doc !== undefined) decl.doc = doc;

  if (typed) decl.params = paramFacts;

  if (informative(returned)) decl.returns = returned;

  if (attributes.length > 0) decl.attributes = attributes;

  if (result) decl.result = result;

  return decl;
}

/** Every node of a function body that runs in its own scope: not into a nested named function or class. */
function walkScope(node: Node, visit: (n: Node) => void): void {
  visit(node);

  for (const child of node.namedChildren) {
    if (child.type === "function_definition" || child.type === "class_declaration") continue;
    walkScope(child, visit);
  }
}

/**
 * The calls under `node`: in a function body, or in code outside declarations.
 * A call inside a closure, an arrow function or an anonymous class has
 * `closure`: it runs when that value is called.
 */
function callsIn(node: Node, scope: Scope, collector: Collector, closure: boolean): CallFact[] {
  const out: CallFact[] = [];
  const self = scope.ctx ? qualify(scope.names.ns, scope.ctx.name) : null;

  /** `nested`: the closure literals passed as arguments the walk is in, outermost first. */
  const walk = (n: Node, inner: ClosureState, nested: readonly { line: number; col: number }[], sc: Scope): void => {
    // A nested named declaration is its own declaration: its calls are not this one's.
    if (DECLARATION_NODES.has(n.type) && n.id !== node.id) return;

    // A call: its callee, then what archdiff reads around it (callables passed, a name argument, literal arguments, the chain).
    if (CALL_NODES.has(n.type)) {
      const fact = callOf(n, sc, collector);

      if (fact) {
        const at = located(n);
        const passes = passesOf(n, sc, collector);
        const nameArg = nameArgOf(n, fact.callee);
        const args = argsOf(n, scope.names, self);
        const chain = chainOf(n, scope.names, self);
        const unplaced: UnplacedCall = { ...fact };

        if (passes.length > 0) unplaced.passes = passes;

        if (nameArg) unplaced.nameArg = nameArg;
        // Object.assign appends the position after `passes` and `nameArg`, the key order of every call fact.
        const call: CallFact = Object.assign(unplaced, { line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol });

        // Inside a closure the call runs later; inside a closure passed as an argument it also records where that closure starts.
        if (inner) call.closure = true;

        if (inner && inner !== "stored") call.closureArg = inner;

        if (inner && inner !== "stored" && nested.length > 1) call.closures = [...nested];

        if (args.some((a) => informative(a.value))) call.args = args;

        if (chain) call.chain = chain;
        out.push(call);
      }
    } else if (n.type === "class_constant_access_expression") {
      // `X::class` reads the class as a value: whoever holds it may construct it.
      const [scopeNode, member] = n.namedChildren;
      const written = classNameOf(scopeNode ?? null);

      if (asciiLowerCase(member?.text ?? "") === "class" && written && !SPECIAL_CLASSES.has(asciiLowerCase(written))) collector.value(collector.klass(written, scopeNode!, scope.names), n, false);
      else if (written && !SPECIAL_CLASSES.has(asciiLowerCase(written))) collector.klass(written, scopeNode!, scope.names);
    } else if (n.type === "scoped_property_access_expression") {
      // `X::$prop` depends on the class `X`.
      const written = classNameOf(n.childForFieldName("scope"));

      if (written && !SPECIAL_CLASSES.has(asciiLowerCase(written))) collector.klass(written, n.childForFieldName("scope")!, scope.names);
    } else if (n.type === "array_creation_expression") arrayCallable(n, sc, collector);

    // Entering a closure changes the closure state of everything under it; `nested` grows only through argument closures.
    if (CLOSURE_NODES.has(n.type)) {
      const state = closureState(n, inner);
      const here = state === null || state === "stored" ? [] : [...nested, { line: n.startPosition.row + 1, col: startCol(n) }];

      for (const child of n.namedChildren) walk(child, state, here, sc);

      return;
    }

    // `if ($x instanceof Foo) { … }`: in the branch, `$x` is a `Foo` — PHP checked it.
    const narrowed = n.type === "if_statement" ? narrowing(n, sc, collector) : null;
    const branch = narrowed ? n.childForFieldName("body") : null;

    for (const child of n.namedChildren) walk(child, inner, nested, branch && child.id === branch.id ? narrowed! : sc);
  };

  // `closure`: the whole node already runs later, as a stored value.
  walk(node, closure ? "stored" : null, [], scope);

  return out;
}

/** The scope of the branch of `if (… $x instanceof Foo …)` (a conjunction may hold several): those variables are of those classes. Null when the condition narrows none. */
function narrowing(n: Node, scope: Scope, collector: Collector): Scope | null {
  const condition = n.childForFieldName("condition");
  const narrowed = new Map<string, VarType>();

  const visit = (e: Node | null): void => {
    if (!e) return;
    const inner = unparenthesized(e);

    if (inner.type !== "binary_expression") return;
    const operator = asciiLowerCase(inner.childForFieldName("operator")?.text ?? "");

    // Both sides of a conjunction hold in the branch; a disjunction or negation narrows nothing.
    if (operator === "&&" || operator === "and") {
      visit(inner.childForFieldName("left"));
      visit(inner.childForFieldName("right"));

      return;
    }

    if (operator !== "instanceof") return;
    const left = inner.childForFieldName("left");
    const right = inner.childForFieldName("right");
    const written = classNameOf(right);

    if (left?.type !== "variable_name" || !written || !right || SPECIAL_CLASSES.has(asciiLowerCase(written))) return;
    narrowed.set(left.text.replace(/^\$/, ""), { cls: collector.klass(written, right, scope.names), qualified: classQualified(written, scope.names) });
  };

  visit(condition);

  if (narrowed.size === 0) return null;

  // The narrowed classes shadow whatever the bindings say; other variables are typed as before.
  return { ...scope, vars: (variable) => narrowed.get(variable) ?? scope.vars(variable) };
}

/** The literal of an expression archdiff does not read as one. */
const OTHER: LiteralFact = { kind: "other" };

/** A string longer than this is no name a framework reads: `other`. */
const MAX_LITERAL = 300;

/** A literal that says something: anything but `other`, and an array only when some key or value does. */
function informative(value: LiteralFact): boolean {
  if (value.kind === "other") return false;

  return value.kind !== "array" || value.items.some((item) => (item.key !== null && informative(item.key)) || informative(item.value));
}

/** The qualified class a literal names: `self`/`static` the enclosing class; null for `parent` or anything but a name. */
function literalClass(scopeNode: Node | null, names: Names, self: string | null): string | null {
  if (!scopeNode) return null;

  // `self`/`static`/`parent`: the grammar gives them as `relative_scope` or as a plain name.
  if (scopeNode.type === "relative_scope" || SPECIAL_CLASSES.has(asciiLowerCase(scopeNode.text))) return asciiLowerCase(scopeNode.text) === "parent" ? null : self;
  const written = classNameOf(scopeNode);

  return written ? canonicalClass(written, names).qualified : null;
}

/** An expression as a literal a framework adapter reads (`LiteralFact`). */
function literalOf(node: Node, names: Names, self: string | null, depth = 0): LiteralFact {
  const n = unparenthesized(node);
  const text = stringValue(n);

  // A plain string (no interpolation), unless too long to be a name.
  if (text !== null) return text.length <= MAX_LITERAL ? { kind: "string", value: text } : OTHER;

  // `X::class` is the class name itself; `X::CONST` a constant of it.
  if (n.type === "class_constant_access_expression") {
    const [scopeNode, member] = n.namedChildren;
    const cls = literalClass(scopeNode ?? null, names, self);

    if (!cls || member?.type !== "name") return OTHER;

    return asciiLowerCase(member.text) === "class" ? { kind: "class", name: cls } : { kind: "const", class: cls, name: member.text };
  }

  if (n.type === "object_creation_expression") {
    const target = n.namedChildren[0] ?? null;
    const cls = target && target.type !== "anonymous_class" ? literalClass(target, names, self) : null;

    return cls ? { kind: "new", name: cls } : OTHER;
  }

  // An array, recursively, up to 8 levels deep; an array nested deeper reads as `other`.
  if (n.type === "array_creation_expression" && depth < 8) {
    const items: { key: LiteralFact | null; value: LiteralFact }[] = [];

    for (const element of n.namedChildren) {
      if (element.type !== "array_element_initializer") continue;
      const parts = element.namedChildren.filter((c) => c.type !== "comment");

      // `key => value` has two parts, a list item one; a spread (`...$x`) or anything else is skipped.
      if (parts.length === 2) items.push({ key: literalOf(parts[0]!, names, self, depth + 1), value: literalOf(parts[1]!, names, self, depth + 1) });
      else if (parts.length === 1) items.push({ key: null, value: literalOf(parts[0]!, names, self, depth + 1) });
    }

    return { kind: "array", items };
  }

  // A closure literal is identified by its start position, which the calls inside it can be matched against.
  if (n.type === "anonymous_function" || n.type === "arrow_function") return { kind: "closure", line: n.startPosition.row + 1, col: startCol(n) };

  return OTHER;
}

/** The arguments of an `arguments` node as literals, named or positional. */
function argList(args: Node | null | undefined, names: Names, self: string | null): ArgFact[] {
  const out: ArgFact[] = [];

  for (const arg of args?.namedChildren ?? []) {
    if (arg.type !== "argument") continue;
    const name = arg.childForFieldName("name");
    // The value is the last child; for a named argument the first child is its name.
    const value = arg.namedChildren.filter((c) => c.type !== "comment").at(-1);
    const literal = value && value.id !== name?.id ? literalOf(value, names, self) : OTHER;
    out.push(name ? { name: name.text, value: literal } : { value: literal });
  }

  return out;
}

/** The arguments of a call node as literals (`argList`); the grammar names the `arguments` field on some call nodes only. */
function argsOf(call: Node, names: Names, self: string | null): ArgFact[] {
  return argList(call.childForFieldName("arguments") ?? call.namedChildren.find((c) => c.type === "arguments"), names, self);
}

/** `X::a(…)->b(…)->c(…)`: the calls of the chain, root first; null for a call on no other call. */
function chainOf(n: Node, names: Names, self: string | null): ChainLinkFact[] | null {
  const links: ChainLinkFact[] = [];
  let cur: Node | null = n;

  // Walk from the outermost `->m()` down its object, collecting links in reverse; a dynamic member name ends the chain.
  while (cur && (cur.type === "member_call_expression" || cur.type === "nullsafe_member_call_expression")) {
    const name = cur.childForFieldName("name");

    if (name?.type !== "name") return null;
    links.unshift({ name: name.text, args: argsOf(cur, names, self) });
    const object = cur.childForFieldName("object");
    cur = object ? unparenthesized(object) : null;
  }

  // The root: a static call (`X::a()`) or a function call (`f()`); any other root (a variable, `$this`) adds no link.
  if (cur?.type === "scoped_call_expression") {
    const name = cur.childForFieldName("name");

    if (name?.type !== "name") return null;
    const cls = literalClass(cur.childForFieldName("scope"), names, self);
    const args = argsOf(cur, names, self);
    links.unshift(cls ? { name: name.text, class: cls, args } : { name: name.text, args });
  } else if (cur?.type === "function_call_expression") {
    const fn = cur.childForFieldName("function");

    if (fn?.type !== "name" && fn?.type !== "qualified_name") return null;
    links.unshift({ name: fn.text.replace(/\s+/g, ""), args: argsOf(cur, names, self) });
  }

  // A single call is no chain.
  return links.length >= 2 ? links : null;
}

/** `#[A(…), B] #[C]` on a declaration, names qualified as PHP resolves them. */
function attributesOf(decl: Node, names: Names, self: string | null): AttributeFact[] {
  const out: AttributeFact[] = [];

  // attribute_list → attribute_group (`#[…]`) → attribute; an attribute whose name does not resolve is skipped.
  for (const list of decl.namedChildren) {
    if (list.type !== "attribute_list") continue;

    for (const group of list.namedChildren) {
      if (group.type !== "attribute_group") continue;

      for (const attribute of group.namedChildren) {
        if (attribute.type !== "attribute") continue;
        const written = classNameOf(attribute.namedChildren[0] ?? null);
        const qualified = written ? canonicalClass(written, names).qualified : null;

        if (!qualified) continue;
        out.push({ name: qualified, args: argList(attribute.childForFieldName("parameters"), names, self), line: attribute.startPosition.row + 1, col: startCol(attribute) });
      }
    }
  }

  return out;
}

/**
 * Where a call sits with respect to closures: null outside them; `stored`
 * under a closure some value holds (`$f = fn() => …`, a returned closure, an
 * anonymous class); otherwise the position of the outermost closure, every
 * closure between being an argument of a call (`$mutex->execute($id, fn() => …)`).
 */
type ClosureState = null | "stored" | { line: number; col: number };

/** A call fact before its position is known. */
type UnplacedCall = Omit<CallFact, "line" | "col" | "endLine" | "endCol">;

/** The closure state under `closure`, given the state `inner` around it (see `ClosureState`). */
function closureState(closure: Node, inner: ClosureState): ClosureState {
  // Once stored, always stored: an argument closure inside a stored one still runs only when the stored one does.
  if (inner === "stored") return "stored";

  if (closure.type === "anonymous_class" || closure.parent?.type !== "argument") return "stored";

  // An argument closure inside another keeps the outermost one's position.
  if (inner) return inner;
  const at = located(closure);

  return { line: at.line, col: at.col };
}

/** Builtins whose string argument PHP reads as a function name: `'helper'` there is a callable, not text. */
const CALLABLE_TAKING = new Set([...CALLABLE_CALLS, "array_map", "array_filter", "array_walk", "array_walk_recursive", "array_reduce", "usort", "uasort", "uksort", "iterator_apply", "is_callable", "register_shutdown_function", "spl_autoload_register", "set_error_handler", "set_exception_handler"]);

/**
 * Callable references among the arguments of a call: `[$this, 'm']`,
 * `[self::class, 'm']`, `[$obj, 'm']` with the class of `$obj` known,
 * `[Order::class, 'm']`, `'Order::m'`, `\Closure::fromCallable(<any of these>)`,
 * the first-class callable `$this->m(...)` / `Order::m(...)` / `f(...)`, and a
 * plain `'f'` where PHP reads the string as a function name. A closure literal
 * is not a pass: its calls carry `closureArg`.
 */
function passesOf(call: Node, scope: Scope, collector: Collector): PassFact[] {
  const args = call.childForFieldName("arguments") ?? call.namedChildren.find((c) => c.type === "arguments");

  if (!args) return [];
  const fn = call.type === "function_call_expression" ? call.childForFieldName("function") : null;
  // A bare string is a function name only as an argument of a builtin known to take a callable.
  const plain = fn?.type === "name" || fn?.type === "qualified_name" ? CALLABLE_TAKING.has(asciiLowerCase(lastSegment(fn.text.replace(/\s+/g, "")))) : false;
  const out: PassFact[] = [];
  args.namedChildren
    .filter((a) => a.type === "argument")
    .forEach((arg, index) => {
      // A named argument (`callback: $f`) holds its value last.
      const value = arg.namedChildren.at(-1);
      const found = value ? callableOf(value, scope, collector, plain) : null;

      if (!found) return;
      const at = located(found.node);
      const pass: Omit<PassFact, "text" | "line" | "col" | "endLine" | "endCol"> = { arg: index, path: "", callee: found.callee };

      if (found.bound) pass.bound = found.bound;

      if (found.receiver) pass.receiver = found.receiver;

      if (found.docblock) pass.docblock = found.docblock;
      // Object.assign appends the text and position after the optional keys, in the key order of a pass fact.
      out.push(Object.assign(pass, { text: firstLine(at.text), line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol }));
    });

  return out;
}

/** A callable an expression names, with the node that spells it. */
interface CallableRef extends Pick<CallFact, "callee" | "bound" | "receiver" | "docblock"> {
  node: Node;
}

/** The callable an expression names, with the node that spells it; null when it names none archdiff can follow. */
function callableOf(value: Node, scope: Scope, collector: Collector, plainStrings: boolean): CallableRef | null {
  const node = unparenthesized(value);
  const method = (holder: string | null, name: string): string | null => (holder ? `${holder}.${name}` : null);

  // `[target, 'method']`: exactly two elements, the second a string that is a valid PHP identifier.
  if (node.type === "array_creation_expression") {
    const elements = node.namedChildren.filter((c) => c.type === "array_element_initializer");

    if (elements.length !== 2) return null;
    const [target, member] = elements.map((e) => e.namedChildren[0] ?? null);
    const name = member ? stringValue(member) : null;

    if (!target || !name || !/^[A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*$/.test(name)) return null;

    if (target.type === "variable_name") {
      const variable = target.text.replace(/^\$/, "");

      if (variable === "this") return scope.ctx ? { callee: `this.${name}`, node } : null;
      const type = scope.vars(variable);

      // `[$obj, 'm']` is followed only when `$obj` has one known class (not a call result, not an array).
      if (!type || !("cls" in type) || type.element) return null;
      const ref: CallableRef = { callee: `${variable}.${name}`, bound: scope.bound.get(variable) ?? "local", receiver: type.cls, node };

      if (type.docblock) ref.docblock = type.docblock;

      return ref;
    }

    // `[$this->store, 'flush']`: a property whose class the class body names (or its docblock does).
    if ((target.type === "member_access_expression" || target.type === "nullsafe_member_access_expression") && target.childForFieldName("object")?.text === "$this") {
      const prop = target.childForFieldName("name");
      const field = prop?.type === "name" ? scope.ctx?.fields.get(prop.text) : undefined;

      if (!prop || !field || field.element) return null;

      const ref: CallableRef = { callee: `this.${prop.text}.${name}`, receiver: field.cls, node };

      if (field.docblock) ref.docblock = field.docblock;

      return ref;
    }

    if (target.type === "class_constant_access_expression") {
      const [scopeNode, constant] = target.namedChildren;

      if (asciiLowerCase(constant?.text ?? "") !== "class" || !scopeNode) return null;
      const callee = method(classHolder(scopeNode, name, scope, collector), name);

      return callee ? { callee, node } : null;
    }

    // A class name in a string is fully qualified, whatever `use` and namespace surround it.
    const written = stringValue(target);

    if (written && /^\\?[A-Za-z_\x80-￿][A-Za-z0-9_\\\x80-￿]*$/.test(written) && !SPECIAL_CLASSES.has(asciiLowerCase(written))) return { callee: `${collector.klass(qualifiedString(written), target, scope.names)}.${name}`, node };

    return null;
  }

  if (node.type === "string" || node.type === "encapsed_string") {
    const text = stringValue(node);

    if (!text) return null;
    // `'Class::method'`: a static method named in a string.
    const scoped = /^(\\?[A-Za-z_\x80-￿][A-Za-z0-9_\\\x80-￿]*)::([A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*)$/.exec(text);

    if (scoped) {
      if (SPECIAL_CLASSES.has(asciiLowerCase(scoped[1]!))) return null;

      return { callee: `${collector.klass(qualifiedString(scoped[1]!), node, scope.names)}.${scoped[2]}`, node };
    }

    // `'helper'` or `'App\helper'`: a function name, where the callee reads strings as callables.
    if (plainStrings && /^\\?[A-Za-z_\x80-￿][A-Za-z0-9_\\\x80-￿]*$/.test(text)) return { callee: collector.fn(qualifiedString(text), node, scope.names), node };

    return null;
  }

  // `\Closure::fromCallable($x)` makes a closure of the callable `$x`.
  if (node.type === "scoped_call_expression" && asciiLowerCase(node.childForFieldName("name")?.text ?? "") === "fromcallable" && asciiLowerCase((node.childForFieldName("scope")?.text ?? "").replace(/^\\/, "")) === "closure") {
    const inner = node.childForFieldName("arguments")?.namedChildren.find((c) => c.type === "argument")?.namedChildren.at(-1);

    return inner ? callableOf(inner, scope, collector, true) : null;
  }

  // `f(...)`, `$this->m(...)`, `X::m(...)`: the callee as a call would read it, kept only when its target is known.
  if (CALL_NODES.has(node.type) && firstClassCallable(node)) {
    const fact = calleeOf(node, scope, collector);

    // A variable of unknown class (`$x->m(...)`) names no method archdiff can follow.
    if (!fact || fact.opaque || (fact.bound && !fact.receiver)) return null;

    const ref: CallableRef = { callee: fact.callee, node };

    if (fact.bound) ref.bound = fact.bound;

    if (fact.receiver) ref.receiver = fact.receiver;

    if (fact.docblock) ref.docblock = fact.docblock;

    return ref;
  }

  return null;
}

/** A name in a string (`'Shop\Infra\Logger'`, `'helper'`) is fully qualified: PHP reads no `use` or namespace into it. */
function qualifiedString(name: string): string {
  return name.startsWith("\\") ? name : `\\${name}`;
}

/** What `X::class` in `[X::class, 'm']` holds: `this` for `self`/`static` (the class for a static `m`), the class for a name; null for `parent`. */
function classHolder(scopeNode: Node, member: string, scope: Scope, collector: Collector): string | null {
  const written = classNameOf(scopeNode);

  if (scopeNode.type === "relative_scope" || (written && SPECIAL_CLASSES.has(asciiLowerCase(written)))) {
    const relative = asciiLowerCase(scopeNode.text);

    if (!scope.ctx || relative === "parent") return null;

    // A static method lives on the class itself; an instance method on `$this`.
    return scope.ctx.statics.has(asciiLowerCase(member)) ? scope.ctx.name : "this";
  }

  return written ? collector.klass(written, scopeNode, scope.names) : null;
}

/** `[$this, 'save']`, `[$this->repo, 'save']`, `[Order::class, 'place']`, `['Order', 'place']`: a method read as a callable value. */
function arrayCallable(n: Node, scope: Scope, collector: Collector): void {
  const elements = n.namedChildren.filter((c) => c.type === "array_element_initializer");

  if (elements.length !== 2) return;
  const [target, method] = elements.map((e) => e.namedChildren[0] ?? null);
  const name = method?.type === "string" || method?.type === "encapsed_string" ? stringValue(method) : null;

  if (!name || !/^[A-Za-z_\x80-￿][A-Za-z0-9_\x80-￿]*$/.test(name)) return;

  // Only a first element that can hold an object or name a class makes the pair a callable; the method name is then read as a value.
  const holder =
    target?.type === "variable_name" ||
    target?.type === "member_access_expression" ||
    target?.type === "nullsafe_member_access_expression" ||
    target?.type === "class_constant_access_expression" ||
    target?.type === "string" ||
    target?.type === "encapsed_string";

  if (holder) collector.value(name, n, true);
}

/** Members whose first argument a framework reads as a name: Magento's event manager `dispatch('event_name', …)`. */
export const NAME_ARG_MEMBERS: ReadonlySet<string> = new Set(["dispatch"]);

/** The first argument of a method call `NAME_ARG_MEMBERS` lists: its literal value, or null with its text. */
function nameArgOf(n: Node, callee: string): CallFact["nameArg"] | undefined {
  if (n.type !== "member_call_expression" && n.type !== "nullsafe_member_call_expression" && n.type !== "scoped_call_expression") return undefined;

  // The member is the callee's last dotted segment, compared case-insensitively like PHP method names.
  if (!NAME_ARG_MEMBERS.has(asciiLowerCase(callee.slice(callee.lastIndexOf(".") + 1)))) return undefined;
  const args = n.childForFieldName("arguments") ?? n.namedChildren.find((c) => c.type === "arguments");
  const first = args?.namedChildren.find((a) => a.type === "argument");
  const value = first?.namedChildren.at(-1);

  if (!value) return undefined;
  const inner = unparenthesized(value);

  return { literal: stringValue(inner), text: value.text.replace(/\s+/g, " ").slice(0, MAX_CALLEE) };
}

/** The text of a string literal without interpolation; null for anything else. */
function stringValue(node: Node): string | null {
  if (node.type !== "string" && node.type !== "encapsed_string") return null;

  // Any child other than text or an escape is an interpolation (`"{$x}"`): the value is not known.
  if (node.namedChildren.some((c) => c.type !== "string_content" && c.type !== "string_value" && c.type !== "escape_sequence")) return null;

  // Escapes are kept as written (`\n` stays two characters).
  return node.namedChildren.map((c) => c.text).join("");
}

/** The callable `f(...)`, `$x->m(...)`, `X::m(...)` makes from its callee: a value, not a call. */
function firstClassCallable(n: Node): boolean {
  const args = n.childForFieldName("arguments") ?? n.namedChildren.find((c) => c.type === "arguments");

  return args?.namedChildren.length === 1 && args.namedChildren[0]!.type === "variadic_placeholder";
}

/**
 * One call: `f()` → `f`, `A\f()` → `A\f`; `$this->m()` → `this.m`;
 * `$this->store->m()` → `this.store.m` with the property's class;
 * `$x->m()` → `x.m`, bound, with the variable's class when the syntax names
 * it; `X::m()` → `X.m`; `self::m()` / `static::m()` → `this.m`, or `X.m` for a
 * static method; `parent::m()` → `super.m`; `new X()` → `X`;
 * `(new X())->m()` → `(new X()).m` and PHP 8.4's `new X()->m()` → `new X().m`,
 * with the class `X`. A name chosen at run time is a call through a value or
 * an opaque expression. Null for a first-class callable (`f(...)`), which is a
 * value.
 */
function callOf(n: Node, scope: Scope, collector: Collector): Pick<CallFact, "callee" | "bound" | "receiver" | "opaque" | "docblock" | "param" | "on" | "member"> | null {
  // `f(...)` calls nothing: record the name as read, and no call.
  if (n.type !== "object_creation_expression" && firstClassCallable(n)) {
    callableValue(n, scope, collector);

    return null;
  }

  return calleeOf(n, scope, collector);
}

/** The callee of a call node as `callOf` reads it, whether or not the arguments are `(...)`. */
function calleeOf(n: Node, scope: Scope, collector: Collector): Pick<CallFact, "callee" | "bound" | "receiver" | "opaque" | "docblock" | "param" | "on" | "member"> | null {
  // A call archdiff cannot name: its text, whitespace collapsed and cut to `MAX_CALLEE`.
  const opaque = (): Pick<CallFact, "callee" | "opaque"> => ({ callee: n.text.replace(/\s+/g, " ").slice(0, MAX_CALLEE), opaque: true });

  // `new X`, `new self`, `new parent`, `new $class`; an anonymous class constructs nothing named.
  if (n.type === "object_creation_expression") {
    const target = n.namedChildren[0];

    if (!target || target.type === "anonymous_class") return null;
    const written = classNameOf(target);

    if (written) {
      const lower = asciiLowerCase(written);

      if (lower === "self" || lower === "static") return scope.ctx ? { callee: scope.ctx.name } : opaque();

      if (lower === "parent") return scope.ctx ? { callee: "super" } : opaque();

      return { callee: collector.klass(written, target, scope.names) };
    }

    if (target.type === "variable_name") return variableCall(target.text.replace(/^\$/, ""), scope);

    return opaque();
  }

  // A function call by name, through a variable (`$f()`), or through any other expression (opaque).
  if (n.type === "function_call_expression") {
    const fn = n.childForFieldName("function");

    if (fn?.type === "name" || fn?.type === "qualified_name") {
      const written = fn.text.replace(/\s+/g, "");
      const lower = asciiLowerCase(lastSegment(written));

      // `isset`/`empty` only when unqualified: `A\isset` would be a real function.
      if (CONSTRUCTS.has(lower) && !written.includes("\\")) return null;

      // A call that dispatches at run time is still a call of the builtin, plus an unsupported fact for what it runs.

      if (CALLABLE_CALLS.has(lower)) collector.noteUnsupported(n, `\`${lastSegment(written)}\` calls a callable chosen at run time`, scope.symbol);

      if (lower === "eval") collector.noteUnsupported(n, "`eval` runs code archdiff cannot read", scope.symbol);

      return { callee: collector.fn(written, fn, scope.names) };
    }

    if (fn?.type === "variable_name") return variableCall(fn.text.replace(/^\$/, ""), scope);

    return opaque();
  }

  // A method call: a member name computed at run time (`$obj->$m()`) is opaque.
  const name = n.childForFieldName("name");

  if (name?.type !== "name") return opaque();
  const member = name.text;

  // `X::m()`: relative (`self`, `static`, `parent`), a class name, or `$class::m()`.
  if (n.type === "scoped_call_expression") {
    const scopeNode = n.childForFieldName("scope");

    if (scopeNode?.type === "relative_scope" || (scopeNode && SPECIAL_CLASSES.has(asciiLowerCase(scopeNode.text)))) {
      const relative = asciiLowerCase(scopeNode.text);

      if (!scope.ctx) return opaque();

      if (relative === "parent") return { callee: `super.${member}` };

      // `self::m()` of an instance method is a call on `$this`; of a static one, a call on the class.
      return scope.ctx.statics.has(asciiLowerCase(member)) ? { callee: `${scope.ctx.name}.${member}` } : { callee: `this.${member}` };
    }

    const written = classNameOf(scopeNode);

    if (written) return { callee: `${collector.klass(written, scopeNode!, scope.names)}.${member}` };

    if (scopeNode?.type === "variable_name") return variableCall(`${scopeNode.text.replace(/^\$/, "")}.${member}`, scope);

    return opaque();
  }

  // `->` and `?->`.
  const object = n.childForFieldName("object");

  if (object?.type === "variable_name") {
    const variable = object.text.replace(/^\$/, "");

    // `$this` outside a class (a closure bound later) is a value of unknown class.
    if (variable === "this") return scope.ctx ? { callee: `this.${member}` } : { callee: `this.${member}`, bound: "local" };
    const fact = variableCall(`${variable}.${member}`, scope);
    const type = scope.vars(variable);

    // `$x = $this->repo->get(); $x->save()`: the class of the result `get` declares, which the graph reads.
    if (type && "of" in type) return { ...fact, on: type.of, member };

    // No class, or an array of one (no methods to call): a call through a value.
    if (!type || type.element) return fact;
    const typed: Pick<CallFact, "callee" | "bound" | "receiver" | "docblock"> = { ...fact, receiver: type.cls };

    if (type.docblock) typed.docblock = type.docblock;

    return typed;
  }

  // `$this->prop->m()`: the property's class, and the constructor parameter that fills it.
  if ((object?.type === "member_access_expression" || object?.type === "nullsafe_member_access_expression") && object.childForFieldName("object")?.text === "$this") {
    const prop = object.childForFieldName("name");

    if (prop?.type === "name") {
      const field = scope.ctx?.fields.get(prop.text);
      const param = scope.ctx?.params.get(prop.text);
      // A property of unknown class: a call through a value, as `self.queue.put()` in Python.
      const call: Pick<CallFact, "callee" | "bound" | "receiver" | "docblock" | "param"> = !field || field.element ? { callee: `this.${prop.text}.${member}`, bound: "local" } : { callee: `this.${prop.text}.${member}`, receiver: field.cls };

      if (field && !field.element && field.docblock) call.docblock = field.docblock;

      if (param !== undefined) call.param = param;

      return call;
    }
  }

  // `(new Order())->total()` and `new Order()->total()`: a method of the class `new` names. The
  // callee ends in `.total`, the member the graph looks up in that class.
  const creation = object ? unparenthesized(object) : null;
  const created = creation?.type === "object_creation_expression" ? classNameOf(creation.namedChildren[0] ?? null) : null;

  if (object && creation && created && !SPECIAL_CLASSES.has(asciiLowerCase(created))) {
    const callee = `${object.text.replace(/\s+/g, " ")}.${member}`;

    // A long constructor expression falls through to opaque rather than being cut.
    if (callee.length <= MAX_CALLEE) return { callee, receiver: collector.klass(created, creation, scope.names) };
  }

  // `$this->repo()->save()`, `->total()->tax()`: an expression archdiff does not name, whose class is
  // the declared result type of the call it is — the graph reads it (`on`).
  if (creation && CALL_NODES.has(creation.type) && creation.type !== "object_creation_expression" && !firstClassCallable(creation)) {
    const inner = resultCall(creation, scope, collector);

    if (inner) return { ...opaque(), on: { call: inner }, member };
  }

  return opaque();
}

/** The expression inside any parentheses around it: `((new X()))` → `new X()`. */
function unparenthesized(node: Node): Node {
  let inner = node;

  while (inner.type === "parenthesized_expression" && inner.namedChildren[0]) inner = inner.namedChildren[0];

  return inner;
}

/** A call through a variable: `$f()`, `$x->m()`, `$class::m()`. */
function variableCall(callee: string, scope: Scope): Pick<CallFact, "callee" | "bound"> {
  const head = callee.split(".")[0]!;

  // A variable the function never binds (a closure's `use`, a global read implicitly) counts as local.
  return { callee, bound: scope.bound.get(head) ?? "local" };
}

/** `f(...)`, `$this->m(...)`, `X::m(...)`: the function or method read as a value. */
function callableValue(n: Node, scope: Scope, collector: Collector): void {
  if (n.type === "function_call_expression") {
    const fn = n.childForFieldName("function");

    if (fn?.type === "name" || fn?.type === "qualified_name") collector.value(collector.fn(fn.text.replace(/\s+/g, ""), fn, scope.names), n, false);

    return;
  }

  const name = n.childForFieldName("name");

  if (name?.type === "name") collector.value(name.text, n, true);
}

/**
 * `require`/`include` of a path the code spells out: a string, or `__DIR__`
 * (`dirname(__DIR__)`, `dirname(__FILE__)`) joined with one. The specifier is
 * `include <path>`, relative to the repository root; a path computed at run
 * time is an unsupported fact.
 */
function includesIn(root: Node, path: string, collector: Collector): ImportFact[] {
  const out: ImportFact[] = [];

  // Includes may sit anywhere (in functions, conditions, closures): walk the whole tree.
  const walk = (n: Node): void => {
    if (INCLUDE_NODES.has(n.type)) {
      const target = includedPath(n.namedChildren[0] ?? null, path);
      const at = located(n);

      if (target === null) collector.noteUnsupported(n, "an include of a path computed at run time", null);
      else out.push({ source: `include ${target}`, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: firstLine(at.text), bindings: [], reexport: false });
    }

    for (const child of n.namedChildren) walk(child);
  };

  walk(root);

  return out;
}

/**
 * The repository-relative path an include expression names: string literals,
 * `__DIR__`, `dirname(__DIR__[, n])` and `dirname(__FILE__[, n])` joined with
 * `.`; a relative literal is taken from the file's directory. Null when part of
 * it is computed at run time.
 */
function includedPath(expr: Node | null, file: string): string | null {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
  // `levels` directories above `path`.
  const up = (path: string, levels: number): string => normalize([path, ...Array<string>(levels).fill("..")].filter((part) => part !== "").join("/"));

  /** A constant fold of the path expression; `anchored`: the text starts at a known directory (from `__DIR__`/`__FILE__`). */
  const evaluate = (node: Node | null): { text: string; anchored: boolean } | null => {
    if (!node) return null;

    if (node.type === "parenthesized_expression") return evaluate(node.namedChildren[0] ?? null);
    const literal = stringValue(node);

    if (literal !== null) return { text: literal, anchored: false };

    if (node.type === "name" && node.text === "__DIR__") return { text: dir, anchored: true };

    if (node.type === "function_call_expression" && asciiLowerCase(node.childForFieldName("function")?.text ?? "") === "dirname") {
      const args = (node.childForFieldName("arguments")?.namedChildren ?? []).map((a) => a.namedChildren[0] ?? null);
      // The optional second argument is a literal positive level count; anything else is computed.
      const levels = args[1] ? Number(args[1].text) : 1;

      if (!Number.isInteger(levels) || levels < 1) return null;

      // `dirname(__FILE__)` is the file's own directory: one level above the file.
      if (args[0]?.type === "name" && args[0].text === "__FILE__") return { text: up(dir, levels - 1), anchored: true };
      const inner = evaluate(args[0] ?? null);

      // `dirname` of a bare string literal is not followed: only anchored paths.
      return inner?.anchored ? { text: up(inner.text, levels), anchored: true } : null;
    }

    // Concatenation: the anchor may only come first (`__DIR__ . '/x.php'`).
    if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === ".") {
      const left = evaluate(node.childForFieldName("left"));
      const right = evaluate(node.childForFieldName("right"));

      return left && right && !right.anchored ? { text: `${left.text}${right.text}`, anchored: left.anchored } : null;
    }

    return null;
  };

  const value = evaluate(expr);

  if (value === null) return null;

  if (value.anchored) return normalize(value.text);

  // An absolute path names no file of the repository: the resolver says so.
  return value.text.startsWith("/") ? value.text : normalize(dir === "" ? value.text : `${dir}/${value.text}`);
}

/** `a/./b/../c` → `a/c`; a path above the root keeps its leading `..`. */
function normalize(path: string): string {
  const out: string[] = [];

  // A stack of segments: `..` pops a real segment, but piles up above the root.
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;

    if (part === ".." && out.length > 0 && out.at(-1) !== "..") out.pop();
    else out.push(part);
  }

  return out.join("/");
}

/**
 * The PHPDoc of a declaration: the `/** … *\/` right above it. Line comments
 * may stand between them, other code may not. Its description is the text
 * before the first tag (`@param` and the rest).
 */
function docOf(node: Node, header: number | null): string | undefined {
  const at = docComment(node, header);

  if (!at) return undefined;
  const text = jsdocDescription(blockCommentBody(at.text)).trim();

  return isLicense(text) ? undefined : (nonEmpty(text) ?? undefined);
}

/** The PHPDoc comment node right above a declaration, as `docOf` finds it; null without one. */
function docComment(node: Node, header: number | null): Node | null {
  let at = node.previousNamedSibling;

  // Skip `//` and `#` comments; stop at the first block comment or code.
  while (at?.type === "comment" && !at.text.startsWith("/*")) at = at.previousNamedSibling;

  // Only `/** */` is PHPDoc, and the file's header comment documents the file, not this declaration.
  return at?.type === "comment" && at.text.startsWith("/**") && at.id !== header ? at : null;
}

/**
 * The tags of a declaration's PHPDoc that `tag` matches, one per line, with
 * the type (first group) and the variable name (second group, if any) and the
 * position of the `@`. The fragment is the tag's line.
 */
function docTags(node: Node, header: number | null, tag: RegExp): (DocType & { name?: string })[] {
  const comment = docComment(node, header);

  if (!comment) return [];
  const out: (DocType & { name?: string })[] = [];
  // Line by line; the `@` column is offset by the comment's column only on its first line.
  comment.text.split("\n").forEach((text, i) => {
    const match = tag.exec(text);

    if (!match?.[1]) return;
    const line = comment.startPosition.row + 1 + i;
    const col = (i === 0 ? comment.startPosition.column : 0) + match.index + match[0].indexOf("@") + 1;
    const found: DocType & { name?: string } = { written: match[1], at: { line, col, endLine: line, endCol: col + match[0].length, text: text.trim() } };

    if (match[2]) found.name = match[2];
    out.push(found);
  });

  return out;
}

/** The first tag of a declaration's PHPDoc that `tag` matches; null without one. */
function docTag(node: Node, header: number | null, tag: RegExp): DocType | null {
  return docTags(node, header, tag)[0] ?? null;
}

/**
 * The file's PHPDoc and its comment: the first `/** … *\/` after `<?php` (and
 * `declare`), unless it stands right above a declaration, which it documents
 * instead. A license documents nothing.
 */
function fileDoc(root: Node): { doc: string; id: number } | null {
  // The first statement past `<?php`, `declare(…)` and inline HTML must be a `/** */` comment.
  const first = root.namedChildren.find((c) => c.type !== "php_tag" && c.type !== "declare_statement" && c.type !== "text");

  if (first?.type !== "comment" || !first.text.startsWith("/**")) return null;
  const next = first.nextNamedSibling;

  // Directly above a declaration (no blank line between), it documents that declaration.
  if (next && DECLARATION_NODES.has(next.type) && next.startPosition.row <= first.endPosition.row + 1) return null;
  const text = jsdocDescription(blockCommentBody(first.text)).trim();
  const doc = isLicense(text) ? null : nonEmpty(text);

  return doc === null ? null : { doc, id: first.id };
}

