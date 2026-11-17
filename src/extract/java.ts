// Java facts: classes, interfaces, enums and records with their methods and
// fields, imports, calls. A Java import names a class, not a file, so the
// imports are written as PHP's are: `import shop.store.Repo` is the class
// `shop.store.Repo` wherever it is declared, and a class the file uses
// without importing it is one of its own package or of a package imported
// with `.*`, written as the candidates in the order Java tries them
// (`shop.orders.Order ?? shop.store.Order`). The resolver (java-imports.ts)
// finds the file by `FileFacts.symbols`. A call is followed by the types the
// code writes: `this`, a field, a parameter or a local declared with a class
// (or made with `new`, or by a call whose target declares its result), a
// class named for a static method. A call through a value whose type the
// code does not write — a lambda's parameter, a generic's element, an
// inherited field — is a gap; every call is an edge or a gap, never dropped.
//
// The Java frontend of the code pipeline (source → FileFacts → graph): parses
// one file with tree-sitter and returns its `FileFacts`. Entry point:
// `extractJava`. Terms: decl (a type or a method archdiff indexes), class
// reference (a simple name of a class, bound to its import), candidates (the
// qualified names a simple name may stand for), gap (a call the graph cannot
// follow).

import { addMember, type CallFact, type Callee as CalleeForm, type DeclFact, type FieldFact, type FileFacts, type ImportFact, type PassFact, type TypeFieldFact } from "./facts.ts";
import { countBranches, guardsOf, JAVA_CONTROL } from "./control.ts";
import { blockCommentBody, isLicense, jsdocDescription, nonEmpty } from "./doc-comments.ts";
import { collapse, errorLine, fingerprintFacts, located, valuesFingerprint, withTree, type Node } from "./treesitter.ts";

/** The classes of `java.lang` code names most: in scope without an import, and never a class of the repository's packages. */
const JAVA_LANG = new Set(
  "Object String StringBuilder StringBuffer CharSequence Math System Thread Runnable Iterable Comparable Cloneable AutoCloseable Record Enum Class Void Number Boolean Byte Short Integer Long Float Double Character Throwable Exception RuntimeException Error IllegalArgumentException IllegalStateException NullPointerException UnsupportedOperationException IndexOutOfBoundsException ArithmeticException ClassCastException NumberFormatException InterruptedException CloneNotSupportedException AssertionError StackOverflowError OutOfMemoryError Override Deprecated SuppressWarnings FunctionalInterface SafeVarargs ThreadLocal Process ProcessBuilder Runtime StackTraceElement var".split(" "),
);

/** The declarations that make a type, and the kind each is: an interface and an annotation are types, the others classes. */
const TYPE_DECLARATIONS = new Map<string, DeclFact["kind"]>([["class_declaration", "class"], ["enum_declaration", "class"], ["record_declaration", "class"], ["interface_declaration", "type"], ["annotation_type_declaration", "type"]]);

/** How many calls a receiver is followed through (`a().b().c()`, a local made by a call on a local made by a call). */
const MAX_CHAIN = 4;

/** The facts of one Java file: imports (of the classes it names and uses), types with their members and calls, and what it did not follow. */
export function extractJava(path: string, src: string): Promise<FileFacts> {
  return withTree("java", src, (tree) => extractTree(path, tree.rootNode));
}

/** A parameter or a local of a method: the class its declaration writes, or the call it is made by. */
interface Local {
  kind: "parameter" | "local";
  type?: string;
  call?: Node;
}

/** The class a member is written in: its names, its fields' classes, its methods, and the class around it. */
interface ClassScope {
  name: string;
  /** Fields whose declared type names one class, by field. */
  fields: ReadonlyMap<string, string>;
  /** Every field, typed or not: a name that is one is no class. */
  fieldNames: ReadonlySet<string>;
  methods: ReadonlySet<string>;
  /** The class extends another: a method it does not declare may be inherited. */
  extended: boolean;
  outer: ClassScope | null;
}

/** Where a call is written: the class, and the names the method binds. */
interface CallScope {
  owner: ClassScope | null;
  locals: ReadonlyMap<string, Local>;
}

/** The file being read: its package, what it imports and declares, and the imports its uses add. */
class JavaFile {
  readonly facts: FileFacts;
  pkg = "";
  /** The packages imported with `.*`, in order: an unbound class name may be one of theirs. */
  readonly wildcards: string[] = [];
  /** Static imports: the member's name → the class it is a member of, as the file binds it. */
  readonly statics = new Map<string, string>();
  /** The classes whose every static member is imported (`import static x.Checks.*`). */
  readonly staticWildcards: string[] = [];
  /** The types the file declares, nested ones too: in scope by their simple names. */
  readonly declared = new Set<string>();
  /** The type parameters written anywhere in the file (`<T>`): a name that is one is no class. */
  readonly typeParams = new Set<string>();
  /** The fields of the file's classes whose type names one class, by class. */
  readonly fields = new Map<string, Map<string, string>>();
  /** Class names with a binding: an explicit import, or a synthetic one. */
  private readonly bound = new Set<string>();

  constructor(path: string) {
    this.facts = { path, endLine: 1, endCol: 1, imports: [], decls: [], exports: new Set(), reexportsAll: [], exportRows: [], unsupported: [], valueRefs: [], moduleCalls: [], completeness: "complete", parseError: null, symbols: [] };
  }

  /** An explicit import of a class: its simple name stands for it. */
  bind(local: string): void {
    this.bound.add(local);
  }

  /**
   * A class named by its simple name at `node`: bound already (declared here, imported), or one of the file's own
   * package, else of a package imported with `.*` — an optional import of the candidates, since a class of
   * `java.lang`, an inherited nested class or a type parameter archdiff missed is nothing missing.
   */
  classRef(name: string, node: Node): void {
    if (this.bound.has(name) || this.declared.has(name) || this.typeParams.has(name) || JAVA_LANG.has(name) || !/^[A-Z]/.test(name)) return;
    this.bound.add(name);
    const candidates = [this.pkg, ...this.wildcards].map((pkg) => (pkg === "" ? name : `${pkg}.${name}`));
    this.facts.imports.push({ ...importAt(node, candidates.join(" ?? "), [{ kind: "named", local: name, imported: name }]), optional: true });
  }

  /** `shop.util.Strings` written in full at `node`: the import of that class, bound under the name as written. */
  qualifiedRef(qualified: string, node: Node): void {
    if (this.bound.has(qualified)) return;
    this.bound.add(qualified);
    this.facts.imports.push(importAt(node, qualified, [{ kind: "named", local: qualified, imported: qualified.slice(qualified.lastIndexOf(".") + 1) }]));
  }
}

/** Collect the facts of a parsed file in passes: the package and the imports, the names it declares, the types with their members, the classes it uses, then file-level data. */
function extractTree(path: string, root: Node): FileFacts {
  const file = new JavaFile(path);
  const { facts } = file;
  const items = root.namedChildren.filter((node) => !isComment(node));
  file.pkg = items.find((node) => node.type === "package_declaration")?.namedChildren.find((child) => child.type === "scoped_identifier" || child.type === "identifier")?.text.replace(/\s+/g, "") ?? "";

  for (const node of items) if (node.type === "import_declaration") importOf(node, file);

  // Every type of the file, nested ones too, and every type parameter, before any body is read.
  for (const node of root.descendantsOfType([...TYPE_DECLARATIONS.keys()])) {
    const name = node?.childForFieldName("name")?.text;

    if (name) file.declared.add(name);
  }

  for (const node of root.descendantsOfType("type_parameter")) {
    const name = node?.namedChildren.find((child) => child.type === "type_identifier" || child.type === "identifier")?.text;

    if (name) file.typeParams.add(name);
  }

  for (const node of root.descendantsOfType([...TYPE_DECLARATIONS.keys()])) if (node) classFields(node, file);

  for (const node of items) {
    if (!TYPE_DECLARATIONS.has(node.type)) continue;
    const decl = typeDecl(node, null, file);

    if (!decl) continue;
    facts.decls.push(decl);
    const qualify = (name: string): string => (file.pkg === "" ? name : `${file.pkg}.${name}`);
    facts.symbols!.push({ name: decl.name, qualified: qualify(decl.name), table: "class" });
    facts.exports.add(decl.name);
    facts.exportRows.push({ name: decl.name, kind: decl.kind === "class" ? "class" : "type", local: null });

    // A nested type is imported by its own name (`import shop.Order.Line`): the row names the member it stands for.
    const nested = (owner: DeclFact, prefix: string): void => {
      for (const member of owner.members) {
        if (member.kind === "fn") continue;
        const dotted = `${prefix}.${member.name}`;
        facts.symbols!.push({ name: member.name, qualified: qualify(dotted), table: "class" });

        if (!facts.exports.has(member.name)) {
          facts.exports.add(member.name);
          facts.exportRows.push({ name: member.name, kind: member.kind === "class" ? "class" : "type", local: dotted });
        }

        nested(member, dotted);
      }
    };

    nested(decl, decl.name);
  }

  // The classes the file names in its types: each a dependency on the file that declares it.
  for (const node of root.descendantsOfType("type_identifier")) if (node && !declaresType(node)) file.classRef(node.text, node);
  // The file's documentation: a comment before the package, else that of the type the file is named after.
  const header = docOf(items[0] ?? root);
  const primary = facts.decls.find((decl) => path.endsWith(`/${decl.name}.java`) || path === `${decl.name}.java`) ?? facts.decls[0];
  const doc = header ?? primary?.doc;

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

/** A line or a block comment. */
function isComment(node: Node): boolean {
  return node.type === "line_comment" || node.type === "block_comment";
}

/** The identifier is the name a type parameter or a declaration gives, not a class it names. */
function declaresType(node: Node): boolean {
  return node.parent?.type === "type_parameter";
}

/**
 * One import: a class (`import a.b.C`), every class of a package (`import a.b.*`, which binds nothing by itself), a
 * static member (`import static a.b.C.m`: the class, with `m` a member of it) or every static member of a class.
 */
function importOf(node: Node, file: JavaFile): void {
  const name = node.namedChildren.find((child) => child.type === "scoped_identifier" || child.type === "identifier")?.text.replace(/\s+/g, "");

  if (!name) return;
  const isStatic = node.children.some((child) => child?.type === "static");
  const wildcard = node.namedChildren.some((child) => child.type === "asterisk");

  if (!isStatic && wildcard) {
    file.wildcards.push(name);
    file.facts.imports.push({ ...importAt(node, `${name}.*`, []), glob: true });

    return;
  }

  // What is imported is a class: of a static import, the class the member is of.
  const qualified = isStatic && !wildcard ? name.slice(0, name.lastIndexOf(".")) : name;
  const local = qualified.slice(qualified.lastIndexOf(".") + 1);

  if (isStatic && wildcard) file.staticWildcards.push(local);
  else if (isStatic) file.statics.set(name.slice(name.lastIndexOf(".") + 1), local);
  file.bind(local);
  file.facts.imports.push(importAt(node, qualified, [{ kind: "named", local, imported: local }]));
}

/** An import fact placed at `node`. */
function importAt(node: Node, source: string, bindings: ImportFact["bindings"]): ImportFact {
  const at = located(node);

  return { source, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: at.text.split("\n")[0]!, bindings, reexport: false };
}

/**
 * The one class a written type names, by its simple name: `Order`, `List<Order>` (the `List`), `@NonNull Order`.
 * Null for a primitive, an array, a type parameter, `var` and a name written with its package or its outer class.
 */
function namedType(type: Node | null, file: JavaFile): string | null {
  if (!type) return null;

  switch (type.type) {
    case "type_identifier":
      return file.typeParams.has(type.text) || type.text === "var" ? null : type.text;
    case "generic_type":
    case "annotated_type":
      return namedType(type.namedChildren.find((child) => child.type === "type_identifier" || child.type === "generic_type") ?? null, file);
    default:
      return null;
  }
}

/** The members of a type's body: of a class, an interface, a record or an annotation directly, of an enum after its constants. */
function membersOf(node: Node): Node[] {
  const body = node.childForFieldName("body");

  return (body?.namedChildren ?? []).flatMap((child) => (child.type === "enum_body_declarations" ? child.namedChildren : [child])).filter((child) => !isComment(child));
}

/** The fields of a type of the file whose declared type names one class (a record's components too), for `repository.save()` in its methods. */
function classFields(node: Node, file: JavaFile): void {
  const name = node.childForFieldName("name")?.text;

  if (!name) return;
  const fields = new Map<string, string>();

  for (const member of membersOf(node)) {
    if (member.type !== "field_declaration") continue;
    const type = namedType(member.childForFieldName("type"), file);

    if (type) for (const declarator of member.childrenForFieldName("declarator")) if (declarator?.childForFieldName("name")) fields.set(declarator.childForFieldName("name")!.text, type);
  }

  for (const component of node.type === "record_declaration" ? (node.childForFieldName("parameters")?.namedChildren ?? []) : []) {
    const type = namedType(component.childForFieldName("type"), file);
    const field = component.childForFieldName("name")?.text;

    if (type && field) fields.set(field, type);
  }

  file.fields.set(name, fields);
}

/** The modifiers of a declaration as words (`public`, `static`, `abstract`), without its annotations. */
function modifiersOf(node: Node): Set<string> {
  const modifiers = node.namedChildren.find((child) => child.type === "modifiers");

  return new Set((modifiers?.children ?? []).filter((child) => child !== null && !child.type.includes("annotation")).map((child) => child!.text));
}

/** A type with its members: methods and constructors, nested types with theirs; the calls of its field initializers are the class's own. */
function typeDecl(node: Node, outer: ClassScope | null, file: JavaFile): DeclFact | null {
  const name = node.childForFieldName("name")?.text;
  const kind = TYPE_DECLARATIONS.get(node.type);

  if (!name || !kind) return null;
  const at = located(node);
  const items = membersOf(node);
  const modifiers = modifiersOf(node);
  // The methods the type declares, and those a record has for its components.
  const components = node.type === "record_declaration" ? (node.childForFieldName("parameters")?.namedChildren ?? []) : [];
  const written = new Set(items.filter((item) => item.type === "method_declaration").map((item) => item.childForFieldName("name")?.text ?? ""));
  const methods = new Set([...written, ...components.map((component) => component.childForFieldName("name")?.text ?? "")]);
  const fieldNames = new Set(items.filter((item) => item.type === "field_declaration").flatMap((item) => item.childrenForFieldName("declarator").map((declarator) => declarator?.childForFieldName("name")?.text ?? "")));
  const superclass = namedType(node.childForFieldName("superclass")?.namedChildren[0] ?? null, file);
  const owner: ClassScope = { name, fields: file.fields.get(name) ?? new Map(), fieldNames, methods, extended: superclass !== null, outer };
  // An interface's members are public; a type's own visibility is `public` or the package's.
  const inInterface = node.type === "interface_declaration" || node.type === "annotation_type_declaration";
  const decl: DeclFact = { kind, name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature: null, exported: modifiers.has("public") || (outer !== null && !modifiers.has("private")), calls: [], types: [], members: [], ...fingerprintFacts(node) };
  const doc = docOf(node);

  if (doc !== undefined) decl.doc = doc;

  if (superclass) decl.base = superclass;
  // `implements A, B` of a class, `extends A, B` of an interface.
  const interfaces = (node.childForFieldName("interfaces") ?? node.namedChildren.find((child) => child.type === "extends_interfaces"))?.descendantsOfType("type_list")[0]?.namedChildren.map((type) => namedType(type, file)).filter((each) => each !== null);

  if (interfaces && interfaces.length > 0) decl.implements = interfaces;
  const fields: FieldFact[] = [];
  const shape: TypeFieldFact[] = [];

  for (const constant of node.type === "enum_declaration" ? (node.childForFieldName("body")?.namedChildren ?? []) : []) {
    if (constant.type !== "enum_constant") continue;
    const constantName = constant.childForFieldName("name")?.text;

    if (constantName) fields.push({ name: constantName, class: name });
    // `PAID(2)` runs the constructor; a constant's own body is the enum's code.
    decl.calls.push(...bodyCalls(constant, { owner, locals: new Map() }, file));
  }

  for (const component of node.type === "record_declaration" ? (node.childForFieldName("parameters")?.namedChildren ?? []) : []) {
    const componentName = component.childForFieldName("name")?.text;
    const type = component.childForFieldName("type");

    if (!componentName) continue;
    fields.push({ name: componentName, class: collapse(type?.text ?? "") });

    // A record has a method per component (`order.id()`), written or not.
    if (!written.has(componentName)) {
      const placed = located(component);
      const accessor: DeclFact = { kind: "fn", name: componentName, line: placed.line, col: placed.col, endLine: placed.endLine, endCol: placed.endCol, signature: `() → ${collapse(type?.text ?? "")}`, exported: true, calls: [], types: [], members: [], ...fingerprintFacts(component) };
      const result = namedType(type, file);

      if (result) accessor.result = { class: result };
      decl.members.push(accessor);
    }
  }

  for (const item of items) {
    switch (item.type) {
      case "field_declaration":
        for (const declarator of item.childrenForFieldName("declarator")) {
          const fieldName = declarator?.childForFieldName("name")?.text;

          if (fieldName) fields.push({ name: fieldName, class: collapse(item.childForFieldName("type")?.text ?? "") });
        }

        // An initializer runs when the class loads or an instance is made: outside every method.
        decl.calls.push(...bodyCalls(item, { owner, locals: scopeOf(item, file) }, file));
        break;
      case "static_initializer":
      case "block":
        decl.calls.push(...bodyCalls(item, { owner, locals: scopeOf(item, file) }, file));
        break;
      case "method_declaration":
      case "constructor_declaration":
      case "compact_constructor_declaration": {
        const member = fnDecl(item, owner, inInterface, file);

        if (item.type === "method_declaration") shape.push({ name: member.name, optional: false, type: `${collapse(item.childForFieldName("parameters")?.text ?? "()")} => ${collapse(item.childForFieldName("type")?.text ?? "void")}` });

        // An interface's method without a body is its shape only: a call of it goes to the classes implementing the interface.
        if (kind === "class" || item.childForFieldName("body")) addMember(decl.members, member);
        break;
      }

      default: {
        const nested = TYPE_DECLARATIONS.has(item.type) ? typeDecl(item, owner, file) : null;

        if (nested) decl.members.push(nested);
      }
    }
  }

  if (fields.length > 0 && kind === "class") decl.fields = fields;

  if (shape.length > 0 && kind === "type") decl.shape = shape;
  const values = valuesFingerprint(items, decl.members);

  if (values !== undefined) decl.values = values;

  return decl;
}

/** The names a method binds, lambdas and anonymous classes included — one scope for the whole method: parameters, locals, the variables of a `for`, a `catch`, a `try` and a pattern. A name declared twice keeps its class only when both say the same. */
function scopeOf(fn: Node, file: JavaFile): Map<string, Local> {
  const locals = new Map<string, Local>();

  const bind = (name: Node | null, kind: Local["kind"], type: string | null, value: Node | null): void => {
    if (!name) return;
    const before = locals.get(name.text);
    const local: Local = { kind: before?.kind === "parameter" ? "parameter" : kind };
    // `var x = new Order()` is an Order; `var x = repo.find()` what the call returns.
    const made = type ?? (value?.type === "object_creation_expression" ? namedType(value.childForFieldName("type"), file) : null);

    if (made && (!before || before.type === made)) local.type = made;

    if (!made && !before && value?.type === "method_invocation") local.call = value;
    locals.set(name.text, local);
  };

  const walk = (node: Node): void => {
    switch (node.type) {
      case "formal_parameter":
      case "catch_formal_parameter":
        bind(node.childForFieldName("name"), "parameter", namedType(node.childForFieldName("type"), file), null);
        break;
      case "spread_parameter":
        bind(node.descendantsOfType("variable_declarator")[0]?.childForFieldName("name") ?? null, "parameter", null, null);
        break;
      case "local_variable_declaration":
        for (const declarator of node.childrenForFieldName("declarator")) bind(declarator?.childForFieldName("name") ?? null, "local", namedType(node.childForFieldName("type"), file), declarator?.childForFieldName("value") ?? null);
        break;
      case "enhanced_for_statement":
      case "resource":
        bind(node.childForFieldName("name"), "local", namedType(node.childForFieldName("type"), file), node.type === "resource" ? node.childForFieldName("value") : null);
        break;
      case "type_pattern":
        bind(node.namedChildren.find((child) => child.type === "identifier") ?? null, "local", namedType(node.namedChildren[0] ?? null, file), null);
        break;
      case "lambda_expression": {
        // `x -> …`, `(x, y) -> …`: parameters without a type.
        const parameters = node.childForFieldName("parameters");

        for (const parameter of parameters?.type === "identifier" ? [parameters] : parameters?.type === "inferred_parameters" ? parameters.namedChildren : []) bind(parameter, "parameter", null, null);
        break;
      }
    }

    for (const child of node.namedChildren) walk(child);
  };

  walk(fn);

  return locals;
}

/** The declaration of a method or a constructor (named `constructor`): signature, calls, branches, doc and the class of its result. */
function fnDecl(node: Node, owner: ClassScope, inInterface: boolean, file: JavaFile): DeclFact {
  const at = located(node);
  const isConstructor = node.type !== "method_declaration";
  const name = isConstructor ? "constructor" : (node.childForFieldName("name")?.text ?? "?");
  const params = node.childForFieldName("parameters");
  const returns = isConstructor ? null : node.childForFieldName("type");
  const signature = `${collapse(params?.text ?? "()")}${returns ? ` → ${collapse(returns.text)}` : ""}`;
  const modifiers = modifiersOf(node);
  const body = node.childForFieldName("body");
  const scope: CallScope = { owner, locals: scopeOf(node, file) };
  const decl: DeclFact = { kind: "fn", name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature, exported: modifiers.has("public") || (inInterface && !modifiers.has("private")), calls: body ? bodyCalls(body, scope, file) : [], types: [], members: [], ...fingerprintFacts(node) };
  const doc = docOf(node);

  if (doc !== undefined) decl.doc = doc;

  if (modifiers.has("static")) decl.static = true;
  const branches = body ? countBranches(body, JAVA_CONTROL) : 0;

  if (branches > 0) decl.branches = branches;
  const result = namedType(returns, file);

  if (result) decl.result = { class: result };

  return decl;
}

/** A call fact before its position is known. */
type UnplacedCall = Omit<CallFact, "line" | "col" | "endLine" | "endCol">;

/** What a callee expression names: the callee as written, and its form. */
type Callee = Pick<CallFact, "callee" | "form">;

/** Every call under `body` as a call fact — a method called, a class made with `new`, `super(…)` and `this(…)` — with the methods it is handed and the guards it sits under; lambdas and anonymous classes are walked too. */
function bodyCalls(body: Node, scope: CallScope, file: JavaFile): CallFact[] {
  const out: CallFact[] = [];

  const walk = (node: Node): void => {
    const fact = node.type === "method_invocation" || node.type === "object_creation_expression" || node.type === "explicit_constructor_invocation" ? callOf(node, scope, file) : null;

    if (fact) {
      const at = located(node);
      const passes = passesOf(node, scope, file);
      const unplaced: UnplacedCall = { ...fact };

      if (passes.length > 0) unplaced.passes = passes;
      const call: CallFact = Object.assign(unplaced, { line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol });
      const guards = guardsOf(node, body, JAVA_CONTROL);

      if (guards.length > 0) call.guards = guards;
      out.push(call);
    }

    // A class named for a constant or a static field (`Status.NEW`, `Limits.MAX`) is a class the file uses.
    if (node.type === "field_access") {
      const object = node.childForFieldName("object");

      if (object?.type === "identifier" && isClassName(object.text, scope)) file.classRef(object.text, object);
    }

    for (const child of node.namedChildren) walk(child);
  };

  walk(body);

  return out;
}

/** A capitalised name nothing of the method or the class binds: a class, by Java's convention. */
function isClassName(name: string, scope: CallScope): boolean {
  if (!/^[A-Z]/.test(name) || scope.locals.has(name)) return false;

  for (let owner = scope.owner; owner; owner = owner.outer) if (owner.fieldNames.has(name)) return false;

  return true;
}

/** The method references among the arguments: `this::audit`, `Orders::first`, `repository::save`. A lambda is not one: its calls are the caller's own. */
function passesOf(call: Node, scope: CallScope, file: JavaFile): PassFact[] {
  const out: PassFact[] = [];

  (call.childForFieldName("arguments")?.namedChildren ?? [])
    .filter((arg) => !isComment(arg))
    .forEach((arg, index) => {
      if (arg.type !== "method_reference") return;
      const [target, member] = arg.namedChildren;

      if (!target || member?.type !== "identifier") return;
      const fact = memberCall(target, member.text, `${collapse(target.text)}::${member.text}`, scope, file, 0);

      if (fact.form.kind === "value") return;
      const at = located(arg);
      out.push({ arg: index, path: "", callee: fact.callee, form: fact.form, text: collapse(at.text), line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol });
    });

  return out;
}

/** Whether a call's result can be followed to a class: a call archdiff names, not one through a value. */
function tracked(form: CalleeForm): boolean {
  return form.kind === "name" || form.kind === "member" || form.kind === "own" || form.kind === "super" || form.kind === "typed" || form.kind === "result";
}

/** The class a field of the class around the call (or of a class around that one) is declared with. */
function fieldType(name: string, scope: CallScope): string | null {
  for (let owner = scope.owner; owner; owner = owner.outer) {
    const type = owner.fields.get(name);

    if (type) return type;

    if (owner.fieldNames.has(name)) return null;
  }

  return null;
}

/**
 * The class of an expression where the code writes it: a typed parameter or local, a field of the class (`repository`,
 * `this.repository`), a field of a value of one of the file's classes, `new Order()`, a cast.
 */
function typeOf(value: Node, scope: CallScope, file: JavaFile): string | null {
  switch (value.type) {
    case "identifier":
      return scope.locals.has(value.text) ? (scope.locals.get(value.text)!.type ?? null) : fieldType(value.text, scope);
    case "field_access": {
      const object = value.childForFieldName("object");
      const field = value.childForFieldName("field")?.text ?? "";

      if (object?.type === "this") return fieldType(field, { owner: scope.owner, locals: new Map() });
      const owner = object ? typeOf(object, scope, file) : null;

      return owner ? (file.fields.get(owner)?.get(field) ?? null) : null;
    }

    case "object_creation_expression":
    case "cast_expression":
      return namedType(value.childForFieldName("type"), file);
    case "parenthesized_expression":
      return value.namedChildren[0] ? typeOf(value.namedChildren[0], scope, file) : null;
    default:
      return null;
  }
}

/**
 * `validate(x)` → a method of the class (of a class around it; of the class a static import names); `this.m()`,
 * `super.m()`; `Orders.first()` → a static method of the class `Orders`; `repository.save()` → a member of the class
 * the field, the parameter or the local is declared with, or of what the call that made it returns; `new Order()` →
 * the class; `super(…)` and `this(…)` → a constructor. Any other receiver is a value archdiff does not track.
 */
function callOf(node: Node, scope: CallScope, file: JavaFile, depth = 0): Callee | null {
  if (node.type === "object_creation_expression") {
    const type = node.childForFieldName("type");
    const name = namedType(type, file);

    if (!name) return type ? { callee: collapse(type.text), form: { kind: "value" } } : null;
    file.classRef(name, type!);

    return { callee: name, form: { kind: "name", name } };
  }

  if (node.type === "explicit_constructor_invocation") {
    const which = node.childForFieldName("constructor")?.type;

    return which === "super" ? { callee: "super", form: { kind: "super", member: "constructor" } } : { callee: "this", form: { kind: "own", member: "constructor" } };
  }

  const member = node.childForFieldName("name")?.text;
  const object = node.childForFieldName("object");

  if (!member) return null;

  if (object) return memberCall(object, member, `${compact(object.text)}.${member}`, scope, file, depth);

  // A name alone is a method: imported static, the class's own, a class's around it, else inherited or of a static `.*` import.
  const imported = file.statics.get(member);

  if (imported && !scope.owner?.methods.has(member)) return { callee: member, form: { kind: "member", head: imported, member } };

  for (let owner = scope.owner?.outer ?? null; owner && !scope.owner!.methods.has(member); owner = owner.outer) if (owner.methods.has(member)) return { callee: member, form: { kind: "member", head: owner.name, member } };

  if (scope.owner && !scope.owner.methods.has(member) && !scope.owner.extended && file.staticWildcards.length > 0) return { callee: member, form: { kind: "member", head: file.staticWildcards[0]!, member } };

  return { callee: member, form: { kind: "own", member } };
}

/** A member called (or referred to) on a receiver: by what the receiver is. */
function memberCall(object: Node, member: string, callee: string, scope: CallScope, file: JavaFile, depth: number): Callee {
  if (object.type === "this") return { callee: `this.${member}`, form: { kind: "own", member } };

  if (object.type === "super") return { callee: `super.${member}`, form: { kind: "super", member } };

  if (object.type === "identifier") {
    const local = scope.locals.get(object.text);
    const type = typeOf(object, scope, file);

    if (type) {
      file.classRef(type, object);

      return { callee, form: { kind: "typed", type, member } };
    }

    // A local made by a call: a member of what that call returns.
    if (local?.call && depth < MAX_CHAIN) {
      const made = callOf(local.call, scope, file, depth + 1);

      if (made && tracked(made.form)) return { callee, form: { kind: "result", of: { call: made.form }, member } };
    }

    // `Orders.first()`: a static method of a class the file names.
    if (!local && isClassName(object.text, scope)) {
      file.classRef(object.text, object);

      return { callee, form: { kind: "member", head: object.text, member } };
    }

    return { callee, form: { kind: "value" } };
  }

  // `shop.util.Strings.trim(x)`: a class written with its package.
  if (object.type === "field_access" && /^[a-z_]\w*(\.[a-z_]\w*)*\.[A-Z]\w*$/.test(compact(object.text)) && !scope.locals.has(compact(object.text).split(".")[0]!) && fieldType(compact(object.text).split(".")[0]!, scope) === null) {
    const qualified = compact(object.text);
    file.qualifiedRef(qualified, object);

    return { callee, form: { kind: "member", head: qualified, member } };
  }

  // `repository.find(id).orElseThrow()`: a member of what the call returns.
  if (object.type === "method_invocation" && depth < MAX_CHAIN) {
    const inner = callOf(object, scope, file, depth + 1);

    return inner && tracked(inner.form) ? { callee: `${inner.callee}().${member}`, form: { kind: "result", of: { call: inner.form }, member } } : { callee: short(callee), form: { kind: "value" } };
  }

  const type = typeOf(object, scope, file);

  if (type) file.classRef(type, object);

  return type ? { callee: short(callee), form: { kind: "typed", type, member } } : { callee: short(callee), form: { kind: "value" } };
}

/** Source text on one line, without spaces around the dots. */
function compact(text: string): string {
  return text.replace(/\s+/g, " ").replace(/ ?\. ?/g, ".");
}

/** A callee kept to 80 characters. */
function short(callee: string): string {
  return callee.length > 80 ? `${callee.slice(0, 79)}…` : callee;
}

/** The documentation of a declaration: the Javadoc comment right before it, its description without the block tags; a license is none. */
function docOf(node: Node): string | undefined {
  const prev = node.previousNamedSibling;

  if (prev?.type !== "block_comment" || !prev.text.startsWith("/**")) return undefined;
  const text = jsdocDescription(blockCommentBody(prev.text.replace(/\r/g, ""))).trim();

  return isLicense(text) ? undefined : (nonEmpty(text) ?? undefined);
}
