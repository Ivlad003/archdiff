// C# facts: classes, structs, records, interfaces and enums with their
// methods, properties and fields, `using` directives, calls. A `using` names
// a namespace, not a file, and a namespace is many files, so the imports are
// written per class used, as Java's and PHP's are: a class named in a type or
// called on is the candidates C# tries — the namespaces around the file's
// own, outermost last, then each namespace it uses
// (`Shop.Orders.Order ?? Shop.Order ?? Order ?? Shop.Store.Order`). The
// resolver (csharp-imports.ts) finds the file by `FileFacts.symbols`, after
// the `global using` directives of the other files. A `partial` class is a
// part (`QualifiedSymbol.part`): the graph looks a member up in every part.
// A call is followed by the types the code writes: `this`, a field, a
// property, a parameter or a local declared with a class (or made with
// `new`, or by a call whose target declares its result — awaited, of a
// `Task<T>`), a class named for a static method. Top-level statements are
// the program's `Main`. A call through `var` of an untracked value, a
// lambda's untyped parameter, an extension method or `dynamic` is a gap;
// every call is an edge or a gap, never dropped.
//
// The C# frontend of the code pipeline (source → FileFacts → graph): parses
// one file with tree-sitter and returns its `FileFacts`. Entry point:
// `extractCSharp`. Terms: decl (a type or a member archdiff indexes), class
// reference (a simple name of a class, bound to its import), candidates (the
// qualified names a simple name may stand for), part (one file's share of a
// `partial` class), gap (a call the graph cannot follow).

import { addMember, type CallFact, type Callee as CalleeForm, type DeclFact, type FieldFact, type FileFacts, type ImportFact, type PassFact, type ResultTypeFact, type TypeFieldFact } from "./facts.ts";
import { countBranches, CSHARP_CONTROL, guardsOf } from "./control.ts";
import { isLicense, nonEmpty } from "./doc-comments.ts";
import { collapse, errorLine, fingerprintFacts, located, valuesFingerprint, withTree, type Node } from "./treesitter.ts";

/** The classes of the base library code names most: never a class of the repository's namespaces, so no import is written for them. */
const BCL = new Set(
  "Object String Console Math Convert Guid DateTime DateTimeOffset TimeSpan Task ValueTask Func Action Predicate List Dictionary HashSet Queue Stack IEnumerable IEnumerator ICollection IList IDictionary IReadOnlyList IReadOnlyCollection IReadOnlyDictionary IAsyncEnumerable Enumerable Nullable Tuple Type Attribute Exception ArgumentException ArgumentNullException InvalidOperationException NotSupportedException NotImplementedException KeyNotFoundException EventArgs EventHandler IDisposable IAsyncDisposable CancellationToken StringBuilder Array Enum Environment Activator Lazy Span Memory Encoding".split(" "),
);

/** The declarations that make a type, and the kind each is: an interface and a delegate are types, the others classes. */
const TYPE_DECLARATIONS = new Map<string, DeclFact["kind"]>([["class_declaration", "class"], ["struct_declaration", "class"], ["record_declaration", "class"], ["enum_declaration", "class"], ["interface_declaration", "type"], ["delegate_declaration", "type"]]);

/** The wrappers of a result that is there once awaited. */
const AWAITABLE = new Set(["Task", "ValueTask"]);

/** How many calls a receiver is followed through (`a().b().c()`, a local made by a call on a local made by a call). */
const MAX_CHAIN = 4;

/** The facts of one C# file: imports (of the namespaces it uses and the classes it names), types with their members and calls, and what it did not follow. */
export function extractCSharp(path: string, src: string): Promise<FileFacts> {
  return withTree("c-sharp", src, (tree) => extractTree(path, tree.rootNode));
}

/** A parameter or a local of a method: the class its declaration writes, or the call it is made by. */
interface Local {
  kind: "parameter" | "local";
  type?: string;
  call?: Node;
  /** The call's result was awaited: the local is what the task gives. */
  awaited?: true;
  /** A local function or a delegate: called as a name. */
  callable?: true;
}

/** The class a member is written in: its name, its fields' and properties' classes, its methods, and the class around it. */
interface ClassScope {
  name: string;
  fields: ReadonlyMap<string, string>;
  fieldNames: ReadonlySet<string>;
  methods: ReadonlySet<string>;
  /** The class has a base class: a method it does not declare may be inherited. */
  extended: boolean;
  outer: ClassScope | null;
}

/** Where a call is written: the class (none in top-level statements), and the names the method binds. */
interface CallScope {
  owner: ClassScope | null;
  locals: ReadonlyMap<string, Local>;
}

/** The file being read: its namespace, what it uses and declares, and the imports its uses add. */
class CSharpFile {
  readonly facts: FileFacts;
  /** The namespaces a class named without one is looked for in, in order: the file's own and those around it, then each `using`. */
  readonly namespaces: string[] = [];
  /** The classes whose static members are in scope (`using static Shop.Util.Checks`). */
  readonly statics: string[] = [];
  /** The types the file declares, nested ones too: in scope by their simple names. */
  readonly declared = new Map<string, DeclFact["kind"]>();
  /** The type parameters written anywhere in the file (`<T>`): a name that is one is no class. */
  readonly typeParams = new Set<string>();
  /** The fields and properties of the file's classes whose type names one class, by class. */
  readonly fields = new Map<string, Map<string, string>>();
  /** The first names of the classes written with their namespace (`Shop` of `Shop.Util.Strings.Trim()`), by node: a namespace, no class. */
  readonly qualifiedHeads = new Set<number>();
  private readonly bound = new Set<string>();

  constructor(path: string) {
    this.facts = { path, endLine: 1, endCol: 1, imports: [], decls: [], exports: new Set(), reexportsAll: [], exportRows: [], unsupported: [], valueRefs: [], moduleCalls: [], completeness: "complete", parseError: null, symbols: [] };
  }

  /** A name an alias or a `using static` binds: it stands for its class. */
  bind(local: string): void {
    this.bound.add(local);
  }

  /**
   * A class named by its simple name at `node`: bound already (declared here, an alias), or one of the namespaces in
   * scope — an optional import of the candidates, since a class of the base library, of a `global using` the resolver
   * adds, or a property archdiff took for a class is nothing missing.
   */
  classRef(name: string, node: Node): void {
    if (this.bound.has(name) || this.declared.has(name) || this.typeParams.has(name) || BCL.has(name) || !/^[A-Z]/.test(name)) return;
    this.bound.add(name);
    // .NET's own namespaces hold no class of the repository: they are left out of the candidates.
    const candidates = this.namespaces.filter((ns) => ns !== "System" && !ns.startsWith("System.")).map((ns) => (ns === "" ? name : `${ns}.${name}`));
    this.facts.imports.push({ ...importAt(node, candidates.join(" ?? "), [{ kind: "named", local: name, imported: name }]), optional: true });
  }

  /** `Shop.Util.Strings` written in full at `node`: the class of that name when there is one (a chain of properties reads the same). */
  qualifiedRef(qualified: string, node: Node): void {
    if (this.bound.has(qualified)) return;
    this.bound.add(qualified);
    this.facts.imports.push({ ...importAt(node, qualified, [{ kind: "named", local: qualified, imported: qualified.slice(qualified.lastIndexOf(".") + 1) }]), optional: true });
  }

  /** Every class a written type names: `Order`, `List<Order>`, `Order?`, `Order[]`, `(Order, Line)`. */
  typeRefs(type: Node | null): void {
    if (!type) return;

    if (type.type === "identifier") this.classRef(type.text, type);
    else if (type.type !== "qualified_name" && type.type !== "predefined_type") for (const child of type.namedChildren) this.typeRefs(child);
  }
}

/** Collect the facts of a parsed file in passes: the namespace and the usings, the names it declares, the types with their members, the top-level statements, the classes it names, then file-level data. */
function extractTree(path: string, root: Node): FileFacts {
  const file = new CSharpFile(path);
  const { facts } = file;
  // The declarations of the file, through its namespaces: `namespace A { … }` holds its own, `namespace A;` those after it.
  const spaces: { ns: string; items: Node[] }[] = [];
  const collect = (nodes: readonly Node[], ns: string): void => {
    let current = ns;
    let items: Node[] = [];
    spaces.push({ ns: current, items });

    for (const node of nodes) {
      if (node.type === "file_scoped_namespace_declaration") {
        current = join(ns, node.childForFieldName("name")?.text ?? "");
        items = [];
        spaces.push({ ns: current, items });
      } else if (node.type === "namespace_declaration") collect(node.childForFieldName("body")?.namedChildren ?? [], join(current, node.childForFieldName("name")?.text ?? ""));
      else items.push(node);
    }
  };

  collect(root.namedChildren, "");
  // The namespaces in scope: the first namespace of the file and those around it, the global one, then the usings in order.
  const own = spaces.find((space) => space.ns !== "")?.ns ?? "";

  for (let ns = own; ns !== ""; ns = ns.includes(".") ? ns.slice(0, ns.lastIndexOf(".")) : "") file.namespaces.push(ns);
  file.namespaces.push("");

  for (const node of root.descendantsOfType("using_directive")) if (node) usingOf(node, file);

  // Every type of the file, nested ones too, and every type parameter, before any body is read.
  for (const node of root.descendantsOfType([...TYPE_DECLARATIONS.keys()])) {
    const name = node?.childForFieldName("name")?.text;

    if (name) file.declared.set(name, TYPE_DECLARATIONS.get(node!.type)!);
  }

  for (const node of root.descendantsOfType("type_parameter")) {
    const name = node?.childForFieldName("name")?.text ?? node?.namedChildren.find((child) => child.type === "identifier")?.text;

    if (name) file.typeParams.add(name);
  }

  for (const node of root.descendantsOfType([...TYPE_DECLARATIONS.keys()])) if (node) classFields(node, file);

  for (const { ns, items } of spaces) {
    for (const node of items) {
      if (!TYPE_DECLARATIONS.has(node.type)) continue;
      const decl = typeDecl(node, null, file);

      if (!decl) continue;
      // The parts of a `partial` class in one file are one declaration.
      const twin = facts.decls.find((other) => other.name === decl.name && other.kind === decl.kind);

      if (twin) {
        twin.members.push(...decl.members);
        twin.calls.push(...decl.calls);
        twin.fields = [...(twin.fields ?? []), ...(decl.fields ?? [])];
        continue;
      }

      facts.decls.push(decl);
      const part = isPartial(node);
      facts.symbols!.push(part ? { name: decl.name, qualified: join(ns, decl.name), table: "class", part: true } : { name: decl.name, qualified: join(ns, decl.name), table: "class" });
      facts.exports.add(decl.name);
      facts.exportRows.push({ name: decl.name, kind: decl.kind === "class" ? "class" : "type", local: null });

      // A nested type is named by its own name where its namespace is used: the row names the member it stands for.
      const nested = (owner: DeclFact, prefix: string): void => {
        for (const member of owner.members) {
          if (member.kind === "fn") continue;
          const dotted = `${prefix}.${member.name}`;
          facts.symbols!.push({ name: member.name, qualified: join(ns, dotted), table: "class" });

          if (!facts.exports.has(member.name)) {
            facts.exports.add(member.name);
            facts.exportRows.push({ name: member.name, kind: member.kind === "class" ? "class" : "type", local: dotted });
          }

          nested(member, dotted);
        }
      };

      nested(decl, decl.name);
    }
  }

  // Top-level statements are the program: read as its `Main`, the entry point.
  const statements = root.namedChildren.filter((node) => node.type === "global_statement");

  if (statements.length > 0) facts.decls.unshift(programMain(statements, file));

  // The classes the file names in its types: each a dependency on the file that declares it.
  references(root, file);
  const doc = facts.decls.find((decl) => path.endsWith(`/${decl.name}.cs`) || path === `${decl.name}.cs`)?.doc ?? facts.decls.find((decl) => decl.doc !== undefined)?.doc;

  if (doc !== undefined) facts.doc = doc;
  const end = located(root);
  facts.endLine = end.endLine;
  facts.endCol = end.endCol;

  if (root.hasError) {
    facts.completeness = "opaque";
    facts.parseError = { line: errorLine(root), reason: "syntax error" };
  }

  return facts;
}

/** A name under a namespace (the global namespace is the empty one). */
function join(ns: string, name: string): string {
  return ns === "" ? name : name === "" ? ns : `${ns}.${name}`;
}

/** The modifiers of a declaration as words (`public`, `static`, `partial`). */
function modifiersOf(node: Node): Set<string> {
  return new Set(node.namedChildren.filter((child) => child.type === "modifier").map((child) => child.text));
}

/** The declaration is one part of a class written in several (`partial`). */
function isPartial(node: Node): boolean {
  return modifiersOf(node).has("partial");
}

/**
 * One `using`: a namespace (every class of it is in scope: no binding, and the classes used carry the dependencies),
 * an alias of a class (`using Repo = Shop.Store.OrderRepository`), or the static members of a class (`using static`).
 */
function usingOf(node: Node, file: CSharpFile): void {
  const alias = node.childForFieldName("name")?.text;
  const name = node.namedChildren.find((child) => (child.type === "qualified_name" || child.type === "identifier" || child.type === "generic_name") && child.id !== node.childForFieldName("name")?.id)?.text.replace(/\s+/g, "");

  if (!name) return;
  const isStatic = node.children.some((child) => child?.type === "static");

  if (alias || isStatic) {
    const local = alias ?? name.slice(name.lastIndexOf(".") + 1).replace(/<.*$/, "");

    if (isStatic) file.statics.push(local);
    file.bind(local);
    file.facts.imports.push({ ...importAt(node, name.replace(/<.*$/, ""), [{ kind: "named", local, imported: name.slice(name.lastIndexOf(".") + 1).replace(/<.*$/, "") }]), optional: true });

    return;
  }

  file.namespaces.push(name);
  file.facts.imports.push({ ...importAt(node, `${name}.*`, []), glob: true });
}

/** An import fact placed at `node`. */
function importAt(node: Node, source: string, bindings: ImportFact["bindings"]): ImportFact {
  const at = located(node);

  return { source, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: at.text.split("\n")[0]!.trim(), bindings, reexport: false };
}

/**
 * The one class a written type names, by its simple name: `Order`, `Order?`, `List<Order>` (the `List`). Null for a
 * type of the language, an array, a tuple, a type parameter, `var` and a name written with its namespace.
 */
function namedType(type: Node | null, file: CSharpFile): string | null {
  if (!type) return null;

  switch (type.type) {
    case "identifier":
      return file.typeParams.has(type.text) ? null : type.text;
    case "generic_name":
      return namedType(type.namedChildren.find((child) => child.type === "identifier") ?? null, file);
    case "nullable_type":
      return namedType(type.namedChildren[0] ?? null, file);
    default:
      return null;
  }
}

/** What a method gives as its declaration writes it: `Order`, or — of `Task<Order>` and `ValueTask<Order>` — an Order once awaited. */
function resultOf(type: Node | null, file: CSharpFile): ResultTypeFact | null {
  const name = namedType(type, file);

  if (!name) return null;

  if (!AWAITABLE.has(name)) return { class: name };
  const inner = namedType(type?.descendantsOfType("type_argument_list")[0]?.namedChildren[0] ?? null, file);

  return inner ? { class: inner, promise: true } : null;
}

/** The members of a type's body. */
function membersOf(node: Node): Node[] {
  return (node.childForFieldName("body")?.namedChildren ?? []).filter((child) => child.type !== "comment");
}

/** The parameters a type declares on its own name: a record's components, a primary constructor's parameters. */
function typeParameters(node: Node): Node[] {
  return (node.childForFieldName("parameters") ?? node.namedChildren.find((child) => child.type === "parameter_list"))?.namedChildren.filter((child) => child.type === "parameter") ?? [];
}

/** The fields, the properties and the primary constructor's parameters of a type of the file whose type names one class, for `_repository.Save()` in its methods. */
function classFields(node: Node, file: CSharpFile): void {
  const name = node.childForFieldName("name")?.text;

  if (!name) return;
  const fields = file.fields.get(name) ?? new Map<string, string>();

  for (const member of membersOf(node)) {
    if (member.type === "property_declaration") {
      const type = namedType(member.childForFieldName("type"), file);
      const property = member.childForFieldName("name")?.text;

      if (type && property) fields.set(property, type);
    } else if (member.type === "field_declaration" || member.type === "event_field_declaration") {
      const declaration = member.namedChildren.find((child) => child.type === "variable_declaration");
      const type = namedType(declaration?.childForFieldName("type") ?? null, file);

      if (type) for (const declarator of declaration?.namedChildren ?? []) if (declarator.type === "variable_declarator" && declarator.childForFieldName("name")) fields.set(declarator.childForFieldName("name")!.text, type);
    }
  }

  for (const parameter of typeParameters(node)) {
    const type = namedType(parameter.childForFieldName("type"), file);
    const field = parameter.childForFieldName("name")?.text;

    if (type && field && !fields.has(field)) fields.set(field, type);
  }

  file.fields.set(name, fields);
}

/** A name that reads as an interface: one of the file's, else by the convention (`IOrders`). */
function isInterface(name: string, file: CSharpFile): boolean {
  return file.declared.has(name) ? file.declared.get(name) === "type" : /^I[A-Z]/.test(name);
}

/** A type with its members: methods, constructors and properties with code, nested types with theirs; the calls of its initializers are the class's own. */
function typeDecl(node: Node, outer: ClassScope | null, file: CSharpFile): DeclFact | null {
  const name = node.childForFieldName("name")?.text;
  const kind = TYPE_DECLARATIONS.get(node.type);

  if (!name || !kind) return null;
  const at = located(node);
  const items = membersOf(node);
  const modifiers = modifiersOf(node);
  const methods = new Set(items.filter((item) => item.type === "method_declaration").map((item) => item.childForFieldName("name")?.text ?? ""));
  // Every field and property, typed with a class or not: a name that is one is no class.
  const fieldNames = new Set(file.fields.get(name)?.keys() ?? []);

  for (const item of items) {
    const declared = item.type === "property_declaration" ? [item] : item.type === "field_declaration" || item.type === "event_field_declaration" ? (item.namedChildren.find((child) => child.type === "variable_declaration")?.namedChildren.filter((child) => child.type === "variable_declarator") ?? []) : [];

    for (const each of declared) if (each.childForFieldName("name")) fieldNames.add(each.childForFieldName("name")!.text);
  }
  // The base list: a class's first entry is its base unless it reads as an interface; every other entry is one.
  const bases = (node.namedChildren.find((child) => child.type === "base_list")?.namedChildren ?? []).map((entry) => namedType(entry.type === "primary_constructor_base_type" ? entry.childForFieldName("type") : entry, file)).filter((each) => each !== null);
  const base = node.type === "class_declaration" || node.type === "record_declaration" ? bases.find((entry, index) => index === 0 && !isInterface(entry, file)) : undefined;
  const interfaces = bases.filter((entry) => entry !== base);
  const owner: ClassScope = { name, fields: file.fields.get(name) ?? new Map(), fieldNames, methods, extended: base !== undefined, outer };
  const inInterface = node.type === "interface_declaration";
  const decl: DeclFact = { kind, name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature: null, exported: modifiers.has("public") || (outer === null && modifiers.has("internal")), calls: [], types: [], members: [], ...fingerprintFacts(node) };
  const doc = docOf(node);

  if (doc !== undefined) decl.doc = doc;

  if (base) decl.base = base;

  if (interfaces.length > 0) decl.implements = interfaces;
  const fields: FieldFact[] = [];
  const shape: TypeFieldFact[] = [];
  const classLevel = (item: Node): void => {
    decl.calls.push(...bodyCalls(item, { owner, locals: scopeOf(item, file) }, file));
  };

  if (node.type === "delegate_declaration") decl.signature = `${collapse(node.childForFieldName("parameters")?.text ?? "()")} → ${collapse(node.childForFieldName("type")?.text ?? "void")}`;

  for (const parameter of typeParameters(node)) {
    const field = parameter.childForFieldName("name")?.text;

    if (field && node.type !== "delegate_declaration") fields.push({ name: field, class: collapse(parameter.childForFieldName("type")?.text ?? "") });
  }

  for (const item of items) {
    switch (item.type) {
      case "enum_member_declaration": {
        const constant = item.childForFieldName("name")?.text;

        if (constant) fields.push({ name: constant, class: name });
        break;
      }

      case "field_declaration":
      case "event_field_declaration": {
        const declaration = item.namedChildren.find((child) => child.type === "variable_declaration");

        for (const declarator of declaration?.namedChildren ?? []) if (declarator.type === "variable_declarator" && declarator.childForFieldName("name")) fields.push({ name: declarator.childForFieldName("name")!.text, class: collapse(declaration?.childForFieldName("type")?.text ?? "") });
        // An initializer runs when the class loads or an instance is made: outside every method.
        classLevel(item);
        break;
      }

      case "property_declaration": {
        const property = item.childForFieldName("name")?.text;
        const type = collapse(item.childForFieldName("type")?.text ?? "");

        if (!property) break;
        const accessors = item.childForFieldName("accessors")?.namedChildren.filter((accessor) => accessor.type === "accessor_declaration") ?? [];
        const arrow = item.childForFieldName("value")?.type === "arrow_expression_clause" ? item.childForFieldName("value") : null;
        const coded = accessors.filter((accessor) => accessor.childForFieldName("body") !== null);

        if (inInterface) shape.push({ name: property, optional: false, type });
        else fields.push({ name: property, class: type });

        // A property with code runs it on access, without a call: a member that is an accessor, as a getter is; `{ get; set; }` is a field, its initializer the class's own code.
        if (arrow || coded.length > 0) {
          const placed = located(item);
          const member: DeclFact = { kind: "fn", name: property, line: placed.line, col: placed.col, endLine: placed.endLine, endCol: placed.endCol, signature: `() → ${type}`, exported: modifiersOf(item).has("public") || inInterface, calls: bodyCalls(arrow ?? item.childForFieldName("accessors")!, { owner, locals: scopeOf(item, file) }, file), types: [], members: [], ...fingerprintFacts(item) };
          const reads = arrow !== null || coded.some((accessor) => accessor.text.startsWith("get"));
          const writes = coded.some((accessor) => /^(set|init)/.test(accessor.text));
          member.accessor = reads && writes ? "get/set" : writes ? "set" : "get";

          if (modifiersOf(item).has("static")) member.static = true;
          addMember(decl.members, member);
        } else classLevel(item);

        break;
      }

      case "method_declaration":
      case "constructor_declaration": {
        const member = fnDecl(item, owner, inInterface, file);

        if (item.type === "method_declaration") shape.push({ name: member.name, optional: false, type: `${collapse(item.childForFieldName("parameters")?.text ?? "()")} => ${collapse(item.childForFieldName("returns")?.text ?? "void")}` });

        // An interface's method without a body is its shape only: a call of it goes to the classes implementing the interface.
        if (kind === "class" || item.childForFieldName("body")) decl.members.push(member);
        break;
      }

      // A destructor, an operator and an indexer run without a call that names them: what they call is the class's own.
      case "destructor_declaration":
      case "operator_declaration":
      case "conversion_operator_declaration":
      case "indexer_declaration":
        classLevel(item);
        break;
      default: {
        const nested = TYPE_DECLARATIONS.has(item.type) ? typeDecl(item, owner, file) : null;

        if (nested) decl.members.push(nested);
      }
    }
  }

  if (fields.length > 0 && kind === "class") decl.fields = fields;

  if (shape.length > 0 && inInterface) decl.shape = shape;
  const values = valuesFingerprint(items, decl.members);

  if (values !== undefined) decl.values = values;

  return decl;
}

/** The names a method binds, lambdas and local functions included — one scope for the whole method: parameters, locals, the variables of a `foreach`, a `catch`, a `using` and a pattern, the local functions. A name declared twice keeps its class only when both say the same. */
function scopeOf(fn: Node, file: CSharpFile): Map<string, Local> {
  const locals = new Map<string, Local>();

  const bind = (name: Node | null, kind: Local["kind"], type: string | null, value: Node | null): void => {
    if (!name) return;
    const before = locals.get(name.text);
    const local: Local = { kind: before?.kind === "parameter" ? "parameter" : kind };
    const awaited = value?.type === "await_expression";
    const made = awaited ? (value.namedChildren[0] ?? null) : value;
    // `var x = new Order()` is an Order; `var x = repo.Find()` what the call returns, `await` of it what its task gives.
    const written = type ?? (made?.type === "object_creation_expression" ? namedType(made.childForFieldName("type"), file) : null);

    if (written && (!before || before.type === written)) local.type = written;

    if (!written && !before && made?.type === "invocation_expression") {
      local.call = made;

      if (awaited) local.awaited = true;
    }

    if (value?.type === "lambda_expression" || value?.type === "anonymous_method_expression") local.callable = true;
    locals.set(name.text, local);
  };

  const walk = (node: Node): void => {
    switch (node.type) {
      case "parameter":
        bind(node.childForFieldName("name"), "parameter", namedType(node.childForFieldName("type"), file), null);
        break;
      case "implicit_parameter":
        locals.set(node.text, { kind: "parameter" });
        break;
      case "variable_declaration": {
        // A field's declaration is the class's, not the method's: only a local one binds here.
        if (node.parent?.type === "field_declaration" || node.parent?.type === "event_field_declaration") break;
        const type = namedType(node.childForFieldName("type"), file);

        for (const declarator of node.namedChildren) if (declarator.type === "variable_declarator") bind(declarator.childForFieldName("name"), "local", type, declarator.namedChildren.find((child) => child.id !== declarator.childForFieldName("name")?.id) ?? null);
        break;
      }

      case "foreach_statement":
        bind(node.childForFieldName("left"), "local", namedType(node.childForFieldName("type"), file), null);
        break;
      case "catch_declaration":
      case "declaration_pattern":
        bind(node.childForFieldName("name"), "local", namedType(node.childForFieldName("type"), file), null);
        break;
      case "local_function_statement": {
        const name = node.childForFieldName("name");

        if (name) locals.set(name.text, { kind: "local", callable: true });
        break;
      }
    }

    for (const child of node.namedChildren) walk(child);
  };

  walk(fn);

  return locals;
}

/** The declaration of a method or a constructor (named `constructor`): signature, calls, branches, doc and the class of its result. */
function fnDecl(node: Node, owner: ClassScope, inInterface: boolean, file: CSharpFile): DeclFact {
  const at = located(node);
  const isConstructor = node.type === "constructor_declaration";
  const name = isConstructor ? "constructor" : (node.childForFieldName("name")?.text ?? "?");
  const params = node.childForFieldName("parameters");
  const returns = isConstructor ? null : node.childForFieldName("returns");
  const signature = `${collapse(params?.text ?? "()")}${returns ? ` → ${collapse(returns.text)}` : ""}`;
  const modifiers = modifiersOf(node);
  const body = node.childForFieldName("body");
  const scope: CallScope = { owner, locals: scopeOf(node, file) };
  // `: base(…)` and `: this(…)` run before the body.
  const initializer = node.namedChildren.find((child) => child.type === "constructor_initializer");
  const calls = [...(initializer ? bodyCalls(initializer, scope, file, true) : []), ...(body ? bodyCalls(body, scope, file) : [])];
  const decl: DeclFact = { kind: "fn", name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature, exported: modifiers.has("public") || (inInterface && !modifiers.has("private")), calls, types: [], members: [], ...fingerprintFacts(node) };
  const doc = docOf(node);

  if (doc !== undefined) decl.doc = doc;

  if (modifiers.has("static")) decl.static = true;
  const branches = body ? countBranches(body, CSHARP_CONTROL) : 0;

  if (branches > 0) decl.branches = branches;
  const result = resultOf(returns, file);

  if (result) decl.result = result;

  return decl;
}

/** Top-level statements as the program's `Main`: what they call, with the local functions among them. */
function programMain(statements: readonly Node[], file: CSharpFile): DeclFact {
  const first = located(statements[0]!);
  const last = located(statements.at(-1)!);
  const locals = new Map<string, Local>();

  for (const statement of statements) for (const [name, local] of scopeOf(statement, file)) if (!locals.has(name)) locals.set(name, local);
  const scope: CallScope = { owner: null, locals };
  // The fingerprint is the file's: a change to any statement is a change to the program.
  const decl: DeclFact = { kind: "fn", name: "Main", line: first.line, col: first.col, endLine: last.endLine, endCol: last.endCol, signature: "(string[] args)", exported: false, calls: statements.flatMap((statement) => bodyCalls(statement, scope, file)), types: [], members: [], ...fingerprintFacts(statements[0]!.parent ?? statements[0]!) };
  const branches = statements.reduce((sum, statement) => sum + countBranches(statement, CSHARP_CONTROL), 0);

  if (branches > 0) decl.branches = branches;

  return decl;
}

/** A call fact before its position is known. */
type UnplacedCall = Omit<CallFact, "line" | "col" | "endLine" | "endCol">;

/** What a callee expression names: the callee as written, and its form. */
type Callee = Pick<CallFact, "callee" | "form">;

/** Every call under `body` as a call fact — a method called, a class made with `new`, `base(…)` and `this(…)` of a constructor — with the methods it is handed and the guards it sits under; lambdas and local functions are walked too. */
function bodyCalls(body: Node, scope: CallScope, file: CSharpFile, initializer = false): CallFact[] {
  const out: CallFact[] = [];

  const place = (node: Node, fact: Callee): void => {
    const at = located(node);
    const passes = passesOf(node, scope, file);
    const unplaced: UnplacedCall = { ...fact };

    if (passes.length > 0) unplaced.passes = passes;
    const call: CallFact = Object.assign(unplaced, { line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol });
    const guards = guardsOf(node, body, CSHARP_CONTROL);

    if (guards.length > 0) call.guards = guards;
    out.push(call);
  };

  if (initializer) place(body, /:\s*base\b/.test(body.text) ? { callee: "base", form: { kind: "super", member: "constructor" } } : { callee: "this", form: { kind: "own", member: "constructor" } });

  const walk = (node: Node): void => {
    const fact = node.type === "invocation_expression" || node.type === "object_creation_expression" ? callOf(node, scope, file) : null;

    if (fact) place(node, fact);

    // A class named for a constant, an enum's member or a static property (`Status.New`, `Limits.Max`) is a class the file uses.
    if (node.type === "member_access_expression") {
      const head = node.childForFieldName("expression");

      if (head?.type === "identifier" && !file.qualifiedHeads.has(head.id) && isClassName(head.text, scope)) file.classRef(head.text, head);
    }

    for (const child of node.namedChildren) walk(child);
  };

  walk(body);

  return out;
}

/** A capitalised name nothing of the method or the class binds: a class, by C#'s convention (a property of a base class reads the same, and resolves to nothing). */
function isClassName(name: string, scope: CallScope): boolean {
  if (!/^[A-Z]/.test(name) || scope.locals.has(name)) return false;

  for (let owner = scope.owner; owner; owner = owner.outer) if (owner.fieldNames.has(name) || owner.methods.has(name)) return false;

  return true;
}

/** The methods among the arguments (a method group): `app.MapPost("/orders", Handlers.Place)`, `items.Select(Map)`, `Run(this.Step)`. A lambda is not one: its calls are the caller's own. */
function passesOf(call: Node, scope: CallScope, file: CSharpFile): PassFact[] {
  const out: PassFact[] = [];

  (call.childForFieldName("arguments")?.namedChildren ?? [])
    .filter((arg) => arg.type === "argument")
    .forEach((arg, index) => {
      const value = arg.namedChildren.at(-1);

      if (!value) return;
      let fact: Callee | null = null;

      if (value.type === "identifier" && !scope.locals.has(value.text) && isMethodName(value.text, scope)) fact = { callee: value.text, form: { kind: "own", member: value.text } };
      else if (value.type === "member_access_expression") {
        const target = value.childForFieldName("expression");
        const member = nameOf(value.childForFieldName("name"));

        if (target && member) fact = memberCall(target, member, compact(value.text), scope, file, 0);
      }

      if (!fact || fact.form.kind === "value") return;
      const at = located(value);
      out.push({ arg: index, path: "", callee: fact.callee, form: fact.form, text: collapse(at.text), line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol });
    });

  return out;
}

/** A name that is a method of the class or of one around it. */
function isMethodName(name: string, scope: CallScope): boolean {
  for (let owner = scope.owner; owner; owner = owner.outer) if (owner.methods.has(name)) return true;

  return false;
}

/** Whether a call's result can be followed to a class: a call archdiff names, not one through a value. */
function tracked(form: CalleeForm): boolean {
  return form.kind === "name" || form.kind === "member" || form.kind === "own" || form.kind === "super" || form.kind === "typed" || form.kind === "result";
}

/** The class a field or a property of the class around the call (or of a class around that one) is declared with. */
function fieldType(name: string, scope: CallScope): string | null {
  for (let owner = scope.owner; owner; owner = owner.outer) {
    const type = owner.fields.get(name);

    if (type) return type;

    if (owner.fieldNames.has(name)) return null;
  }

  return null;
}

/** The name of a member as written, without its type arguments (`AddScoped` of `AddScoped<IOrders, Orders>`). */
function nameOf(node: Node | null): string | null {
  if (!node) return null;

  return node.type === "generic_name" ? (node.namedChildren.find((child) => child.type === "identifier")?.text ?? null) : node.text;
}

/**
 * The class of an expression where the code writes it: a typed parameter or local, a field or a property of the class
 * (`_repository`, `this.Repository`), a property of a value of one of the file's classes, `new Order()`, a cast, `x as Order`.
 */
function typeOf(value: Node, scope: CallScope, file: CSharpFile): string | null {
  switch (value.type) {
    case "identifier":
      return scope.locals.has(value.text) ? (scope.locals.get(value.text)!.type ?? null) : fieldType(value.text, scope);
    case "member_access_expression": {
      const object = value.childForFieldName("expression");
      const field = nameOf(value.childForFieldName("name")) ?? "";

      if (object?.type === "this") return fieldType(field, { owner: scope.owner, locals: new Map() });
      const owner = object ? typeOf(object, scope, file) : null;

      return owner ? (file.fields.get(owner)?.get(field) ?? null) : null;
    }

    case "object_creation_expression":
    case "cast_expression":
      return namedType(value.childForFieldName("type"), file);
    case "as_expression":
      return namedType(value.childForFieldName("right"), file);
    case "parenthesized_expression":
      return value.namedChildren[0] ? typeOf(value.namedChildren[0], scope, file) : null;
    default:
      return null;
  }
}

/**
 * `Validate(x)` → a method of the class (of a class around it; of a class `using static` names), or a local function;
 * `this.M()`, `base.M()`; `Orders.First()` → a static method of the class `Orders`; `_repository.Save()` → a member of
 * the class the field, the property, the parameter or the local is declared with, or of what the call that made it
 * returns (awaited or not); `x?.M()` as `x.M()`; `new Order()` → the class. `nameof(…)` and `new()` are no calls; any
 * other receiver is a value archdiff does not track.
 */
function callOf(node: Node, scope: CallScope, file: CSharpFile, depth = 0): Callee | null {
  if (node.type === "object_creation_expression") {
    const type = node.childForFieldName("type");
    const name = namedType(type, file);

    if (!name) return type ? { callee: collapse(type.text), form: { kind: "value" } } : null;
    file.classRef(name, type!);

    return { callee: name, form: { kind: "name", name } };
  }

  const fn = node.childForFieldName("function");

  if (!fn) return null;

  if (fn.type === "identifier" || fn.type === "generic_name") {
    const member = nameOf(fn)!;
    const local = scope.locals.get(member);

    if (member === "nameof" && !local) return null;

    // A local function's calls are the caller's own; a delegate holds what was assigned to it.
    if (local) return { callee: member, form: { kind: "bound", binding: local.callable && local.kind === "local" ? "local" : "parameter" } };

    for (let owner = scope.owner?.outer ?? null; owner && !scope.owner!.methods.has(member); owner = owner.outer) if (owner.methods.has(member)) return { callee: member, form: { kind: "member", head: owner.name, member } };

    // In a class that extends nothing, a method it does not declare is one of a `using static` class.
    if (scope.owner && !scope.owner.methods.has(member) && !scope.owner.extended && file.statics.length > 0) return { callee: member, form: { kind: "member", head: file.statics[0]!, member } };

    return scope.owner ? { callee: member, form: { kind: "own", member } } : { callee: member, form: file.statics.length > 0 ? { kind: "member", head: file.statics[0]!, member } : { kind: "name", name: member } };
  }

  if (fn.type === "member_access_expression") {
    const object = fn.childForFieldName("expression");
    const member = nameOf(fn.childForFieldName("name"));

    return object && member ? memberCall(object, member, `${compact(object.text)}.${member}`, scope, file, depth) : null;
  }

  // `x?.M()`: the member of `x`, when there is one.
  if (fn.type === "conditional_access_expression") {
    const object = fn.childForFieldName("condition");
    const member = nameOf(fn.namedChildren.find((child) => child.type === "member_binding_expression")?.childForFieldName("name") ?? null);

    return object && member ? memberCall(object, member, `${compact(object.text)}?.${member}`, scope, file, depth) : { callee: short(compact(fn.text)), form: { kind: "value" } };
  }

  return { callee: short(compact(fn.text)), form: { kind: "value" } };
}

/** A member called (or handed over) on a receiver: by what the receiver is. */
function memberCall(object: Node, member: string, callee: string, scope: CallScope, file: CSharpFile, depth: number): Callee {
  if (object.type === "this") return { callee: `this.${member}`, form: { kind: "own", member } };

  if (object.type === "base") return { callee: `base.${member}`, form: { kind: "super", member } };

  if (object.type === "identifier") {
    const local = scope.locals.get(object.text);
    const type = typeOf(object, scope, file);

    if (type) {
      file.classRef(type, object);

      return { callee, form: { kind: "typed", type, member } };
    }

    // A local made by a call: a member of what that call returns, awaited or not.
    if (local?.call && depth < MAX_CHAIN) {
      const made = callOf(local.call, scope, file, depth + 1);

      if (made && tracked(made.form)) return { callee, form: { kind: "result", of: local.awaited ? { call: made.form, awaited: true } : { call: made.form }, member } };
    }

    // `Orders.First()`: a static method of a class the file names.
    if (!local && isClassName(object.text, scope)) {
      file.classRef(object.text, object);

      return { callee, form: { kind: "member", head: object.text, member } };
    }

    return { callee, form: { kind: "value" } };
  }

  // `Shop.Util.Strings.Trim(x)`: a class written with its namespace, when the names are no value's.
  if (object.type === "member_access_expression" && /^[A-Z]\w*(\.[A-Z]\w*)+$/.test(compact(object.text)) && isClassName(compact(object.text).split(".")[0]!, scope) && typeOf(object, scope, file) === null) {
    const qualified = compact(object.text);
    file.qualifiedRef(qualified, object);

    for (const head of object.descendantsOfType("identifier")) if (head && head.text === qualified.split(".")[0]) file.qualifiedHeads.add(head.id);

    return { callee, form: { kind: "member", head: qualified, member } };
  }

  // `repository.Find(id).Ship()`, `(await repository.FindAsync(id)).Ship()`: a member of what the call returns.
  const awaited = object.type === "parenthesized_expression" && object.namedChildren[0]?.type === "await_expression" ? object.namedChildren[0].namedChildren[0] : object.type === "await_expression" ? object.namedChildren[0] : undefined;
  const call = awaited ?? object;

  if (call.type === "invocation_expression" && depth < MAX_CHAIN) {
    const inner = callOf(call, scope, file, depth + 1);

    return inner && tracked(inner.form) ? { callee: short(`${inner.callee}().${member}`), form: { kind: "result", of: awaited ? { call: inner.form, awaited: true } : { call: inner.form }, member } } : { callee: short(callee), form: { kind: "value" } };
  }

  const type = typeOf(object, scope, file);

  if (type) file.classRef(type, object);

  return type ? { callee: short(callee), form: { kind: "typed", type, member } } : { callee: short(callee), form: { kind: "value" } };
}

/**
 * Every class the file names in a type: of a field, a property, a parameter, a local and a result, in a base list, as
 * a type argument, after `new`, `as` and `is`, in a cast and a `typeof`.
 */
function references(root: Node, file: CSharpFile): void {
  const walk = (node: Node): void => {
    if (node.type !== "using_directive" && node.type !== "namespace_declaration" && node.type !== "file_scoped_namespace_declaration") {
      file.typeRefs(node.childForFieldName("type"));
      file.typeRefs(node.childForFieldName("returns"));
    }

    if (node.type === "base_list" || node.type === "type_argument_list") for (const child of node.namedChildren) file.typeRefs(child.type === "primary_constructor_base_type" ? child.childForFieldName("type") : child);

    if (node.type === "as_expression" || node.type === "is_expression") file.typeRefs(node.childForFieldName("right"));

    if (node.type !== "using_directive") for (const child of node.namedChildren) walk(child);
  };

  walk(root);
}

/** Source text on one line, without spaces around the dots. */
function compact(text: string): string {
  return text.replace(/\s+/g, " ").replace(/ ?\. ?/g, ".");
}

/** A callee kept to 80 characters. */
function short(callee: string): string {
  return callee.length > 80 ? `${callee.slice(0, 79)}…` : callee;
}

/** The documentation of a declaration: the `///` comments right above it — the text of its `<summary>`, else all of it — without the XML tags. */
function docOf(node: Node): string | undefined {
  const lines: string[] = [];

  for (let prev = node.previousNamedSibling; prev && prev.type === "comment" && prev.text.startsWith("///"); prev = prev.previousNamedSibling) lines.unshift(prev.text.replace(/^\/\/\/ ?/, "").replace(/\r$/, ""));

  if (lines.length === 0) return undefined;
  const all = lines.join("\n");
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(all)?.[1] ?? all;
  const text = summary.replace(/<see\s+cref="([^"]+)"\s*\/>/g, "$1").replace(/<[^>]+>/g, "").split("\n").map((line) => line.trim()).join("\n").trim();

  return isLicense(text) ? undefined : (nonEmpty(text) ?? undefined);
}
