// Go facts: functions, types with their methods and fields, imports, calls.
// A Go package is a directory and its files share one scope, so the names a
// file uses are written as imports of declarations, the way PHP's are: an
// `import "shop/store"` names the package (no file), `store.Save` is the
// import `shop/store.Save` (the file of the package that declares `Save`),
// and a name the file uses without declaring it is `.name`, a declaration of
// another file of its own package. The resolver (go-imports.ts) finds the
// file by `FileFacts.symbols`. A method declared in another file than its
// type is a part of that type (`QualifiedSymbol.part`): the graph looks a
// member up in every part. Calls through an interface, a type parameter, a
// function value or a value whose type the code does not write are gaps;
// every call expression is an edge or a gap, never dropped.
//
// The Go frontend of the code pipeline (source → FileFacts → graph): parses
// one file with tree-sitter and returns its `FileFacts`. Entry point:
// `extractGo`. Terms: decl (a declaration archdiff indexes), part (the
// methods a file adds to a type declared elsewhere), qualified name
// (`store.Save`, bound as `store::Save`), own-package name (a name of the
// package another file declares), gap (a call the graph cannot follow).

import { posix } from "node:path";
import { passable, type CallFact, type Callee as CalleeForm, type DeclFact, type ExportRow, type FieldFact, type FileFacts, type ImportFact, type PassFact, type TypeFieldFact, type ValueRefFact } from "./facts.ts";
import { countBranches, GO_CONTROL, guardsOf } from "./control.ts";
import { blockCommentBody, isLicense, lineCommentsBody, nonEmpty } from "./doc-comments.ts";
import { collapse, errorLine, fingerprintFacts, located, unsupportedAt, valuesFingerprint, withTree, type Node } from "./treesitter.ts";

/** The types the language declares: a conversion to one (`string(b)`) is no call, and none is a declaration of a package. */
const PREDECLARED_TYPES = new Set("any bool byte comparable complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr".split(" "));

/** The functions and values the language declares. */
const PREDECLARED = new Set([...PREDECLARED_TYPES, ..."append cap clear close complex copy delete imag len make max min new panic print println real recover true false nil iota _".split(" ")]);

/** Nodes whose `name` is what they declare, not a name they read. */
const DECLARING = new Set(["function_declaration", "parameter_declaration", "variadic_parameter_declaration", "type_parameter_declaration", "const_spec", "var_spec"]);

/** Comment lines that are directives of the toolchain, not documentation. */
const DIRECTIVE = /^\/\/(go:|line |export |nolint|lint:|\s*\+build)/;

/** The facts of one Go file: imports (of packages and of the declarations it uses), declarations with their calls, and what it did not follow. */
export function extractGo(path: string, src: string): Promise<FileFacts> {
  return withTree("go", src, (tree) => extractTree(path, tree.rootNode));
}

/** A parameter, a result or a local of a function: the type its declaration writes, or the call it is made by. */
interface Local {
  kind: "parameter" | "local";
  /** The one type the declaration names (`o *Order`, `var r store.Repo`, `x := &Order{}`), as a name of the file's scope. */
  type?: string;
  /** The call the name is bound to the (first) result of: `x := store.NewRepo()`, `x, err := open()`. */
  call?: Node;
}

/** What the names of a function body stand for. */
interface FnScope {
  /** The receiver's name and type of a method. */
  receiver: { name: string; type: string } | null;
  locals: ReadonlyMap<string, Local>;
  /** The type parameters in scope (`[T any]`): a value typed with one has no type archdiff can name. */
  typeParams: ReadonlySet<string>;
}

const NO_SCOPE: FnScope = { receiver: null, locals: new Map(), typeParams: new Set() };

/** The file being read: what it declares and imports, and the imports its uses add. */
class GoFile {
  readonly facts: FileFacts;
  /** The package names the imports bind (`store` of `import "shop/store"`, an alias), each with its path. */
  readonly packages = new Map<string, string>();
  /** Every name the file declares at its top level: functions, types, constants, variables. */
  readonly declared = new Set<string>();
  /** The fields of the file's structs whose type names one type, by struct and field. */
  readonly fields = new Map<string, Map<string, string>>();
  /** The scope of each function (and of each top-level `var`) read so far, by node: the calls and the references of a body ask for the same one. */
  readonly scopes = new Map<number, FnScope>();
  /** Synthetic imports already written, by the local name they bind. */
  private readonly bound = new Set<string>();
  private readonly firstRefs = new Map<string, ValueRefFact>();

  constructor(path: string) {
    this.facts = { path, endLine: 1, endCol: 1, imports: [], decls: [], exports: new Set(), reexportsAll: [], exportRows: [], unsupported: [], valueRefs: [], moduleCalls: [], completeness: "complete", parseError: null, symbols: [] };
  }

  /** `pkg.Name` used at `node`: the import of that declaration, bound as `pkg::Name`; the name it is bound as. */
  qualified(pkg: string, name: string, node: Node): string {
    const local = `${pkg}::${name}`;

    if (!this.bound.has(local)) {
      this.bound.add(local);
      this.facts.imports.push(importAt(node, `${this.packages.get(pkg)!}.${name}`, [{ kind: "named", local, imported: name }]));
    }

    return local;
  }

  /**
   * A name used at `node` that the file neither declares nor binds: a declaration of another file of the package,
   * when one declares it (an optional import: a name of a dot import, or one archdiff failed to see bound, is nothing missing).
   */
  own(name: string, node: Node): void {
    if (this.declared.has(name) || this.bound.has(name) || this.packages.has(name)) return;
    this.bound.add(name);
    this.facts.imports.push({ ...importAt(node, `.${name}`, [{ kind: "named", local: name, imported: name }]), optional: true });
  }

  /** A name read as a value, once per name: a function so read may be called by whoever holds the value. */
  ref(name: string, node: Node, member: boolean): void {
    const key = `${member ? "." : ""}${name}`;

    if (!this.firstRefs.has(key)) this.firstRefs.set(key, member ? { name, member: true, line: node.startPosition.row + 1, col: node.startPosition.column + 1 } : { name, line: node.startPosition.row + 1, col: node.startPosition.column + 1 });
  }

  refs(): ValueRefFact[] {
    return [...this.firstRefs.values()].sort((a, b) => a.line - b.line || a.col - b.col);
  }

  /** A public name of the file: every top-level name is visible to the other files of the package, the capitalised ones to importers. */
  row(name: string, kind: ExportRow["kind"], table: "class" | "function" | "const", part = false): void {
    const dir = posix.dirname(this.facts.path);
    this.facts.symbols!.push(part ? { name, qualified: `${dir}.${name}`, table, part: true } : { name, qualified: `${dir}.${name}`, table });

    if (this.facts.exports.has(name)) return;
    this.facts.exports.add(name);
    this.facts.exportRows.push({ name, kind, local: null });
  }
}

/** Collect the facts of a parsed file in passes: imports, top-level names, declarations, the names it uses, then file-level data. */
function extractTree(path: string, root: Node): FileFacts {
  const file = new GoFile(path);
  const { facts } = file;
  const items = root.namedChildren.filter((node) => node.type !== "comment");

  // Imports first: a qualified name resolves against every import of the file.
  for (const node of items) if (node.type === "import_declaration") for (const spec of specsOf(node, "import_spec")) importOf(spec, file);

  // The top-level names, before any body is read: a call of one is a call of the file's own declaration.
  for (const node of items) {
    if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text;

      if (name && name !== "init") file.declared.add(name);
    } else if (node.type === "type_declaration") {
      for (const spec of node.namedChildren) {
        const name = spec.childForFieldName("name")?.text;

        if (name) file.declared.add(name);
      }
    } else if (node.type === "const_declaration" || node.type === "var_declaration") {
      for (const spec of specsOf(node, node.type === "const_declaration" ? "const_spec" : "var_spec")) for (const name of spec.childrenForFieldName("name")) if (name) file.declared.add(name.text);
    }
  }

  for (const node of items) if (node.type === "type_declaration") for (const spec of node.namedChildren) structFields(spec, file);

  // The methods of each type, attached once every type of the file is known (a method may come before its type).
  const methods: { type: string; decl: DeclFact }[] = [];
  const parts = new Map<string, DeclFact>();

  for (const node of items) {
    switch (node.type) {
      case "function_declaration": {
        const name = node.childForFieldName("name")?.text;

        if (!name) break;

        // `init` runs when the package loads, and a file may hold several: its calls are the file's own.
        if (name === "init") {
          const body = node.childForFieldName("body");

          if (body) facts.moduleCalls.push(...bodyCalls(body, scopeOf(node, null, file), file));
          break;
        }

        facts.decls.push(fnDecl(node, name, null, file));
        file.row(name, "fn", "function");
        break;
      }

      case "method_declaration": {
        const name = node.childForFieldName("name")?.text;
        const receiver = receiverOf(node);

        if (!name || !receiver) {
          facts.unsupported.push(unsupportedAt(node, "a method whose receiver type archdiff cannot name"));
          break;
        }

        const decl = fnDecl(node, name, receiver, file);

        if (file.declared.has(receiver.type)) {
          methods.push({ type: receiver.type, decl });
          break;
        }

        // The type is declared in another file of the package: this file holds a part of it.
        let part = parts.get(receiver.type);

        if (!part) {
          const at = located(node);
          part = { kind: "class", name: receiver.type, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature: null, exported: isExported(receiver.type), calls: [], types: [], members: [] };
          parts.set(receiver.type, part);
          facts.decls.push(part);
          file.row(receiver.type, "class", "class", true);
        }

        part.members.push(decl);
        part.endLine = decl.endLine;
        part.endCol = decl.endCol;
        break;
      }

      case "type_declaration":
        for (const spec of node.namedChildren) {
          const decl = typeDecl(spec, node, file);

          if (!decl) continue;
          facts.decls.push(decl);
          file.row(decl.name, decl.kind === "class" ? "class" : "type", "class");
        }

        break;
      case "const_declaration":
      case "var_declaration":
        for (const spec of specsOf(node, node.type === "const_declaration" ? "const_spec" : "var_spec")) valuesOf(spec, file);
        // An initializer runs when the package loads.
        facts.moduleCalls.push(...bodyCalls(node, scopeOf(node, null, file), file));
        break;
    }
  }

  for (const { type, decl } of methods) facts.decls.find((owner) => owner.name === type && owner.kind !== "fn")?.members.push(decl);

  // Every name the file uses and does not declare: a declaration of an imported package, or of another file of its own.
  for (const node of items) if (node.type !== "import_declaration" && node.type !== "package_clause") references(node, scopeOf(node, receiverOf(node), file), file);

  facts.valueRefs = file.refs();
  const doc = packageDoc(root);

  if (doc !== undefined) facts.doc = doc;
  const values = valuesFingerprint(root.namedChildren, facts.decls);

  if (values !== undefined) facts.values = values;
  const end = located(root);
  facts.endLine = end.endLine;
  facts.endCol = end.endCol;

  if (root.hasError) {
    facts.completeness = "opaque";
    facts.parseError = { line: errorLine(root), reason: "syntax error" };
  }

  return facts;
}

/** The specs of a declaration, written alone or in a parenthesised list (`import (…)`, `var (…)`). */
function specsOf(node: Node, type: string): Node[] {
  return node.namedChildren.flatMap((child) => (child.type === type ? [child] : child.type === `${type}_list` ? child.namedChildren.filter((spec) => spec.type === type) : []));
}

/** A capitalised name is visible outside its package. */
function isExported(name: string): boolean {
  return /^\p{Lu}/u.test(name);
}

/**
 * The name a package is used by when the import gives none: the last element of its path, a major version
 * (`/v2`, `.v3`) and a `go-` or `-go` around it left out. The package clause may say otherwise, which only its
 * own files tell.
 */
function packageName(path: string): string {
  const segments = path.split("/");
  const last = /^v\d+$/.test(segments.at(-1)!) && segments.length > 1 ? segments.at(-2)! : segments.at(-1)!;

  return last.replace(/\.v\d+$/, "").replace(/^go-/, "").replace(/[-.]go$/, "").replace(/-/g, "_");
}

/** One import spec: the package under the name the file uses it by; a blank import (`_`) binds nothing, a dot import brings every name. */
function importOf(spec: Node, file: GoFile): void {
  const literal = spec.childForFieldName("path");
  const path = literal?.text.replace(/^["`]|["`]$/g, "");

  if (!path) return;
  const name = spec.childForFieldName("name");

  if (name?.type === "blank_identifier") {
    file.facts.imports.push(importAt(spec, `_ ${path}`, []));

    return;
  }

  if (name?.type === "dot") {
    file.facts.imports.push({ ...importAt(spec, path, []), glob: true });
    file.facts.unsupported.push(unsupportedAt(spec, `dot import of \`${path}\`: its names are used without the package's, so archdiff cannot tell them from the file's own package`));

    return;
  }

  const local = name?.text ?? packageName(path);
  file.packages.set(local, path);
  file.facts.imports.push(importAt(spec, path, [{ kind: "module", local, namespace: true }]));

  if (path === "C") file.facts.unsupported.push(unsupportedAt(spec, "cgo: calls into C are not followed"));
}

/** An import fact placed at `node`. */
function importAt(node: Node, source: string, bindings: ImportFact["bindings"]): ImportFact {
  const at = located(node);

  return { source, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: at.text.split("\n")[0]!, bindings, reexport: false };
}

/**
 * The one type a written type names, as a name of the file's scope: `Order`, `*Order`, `List[T]` (its base),
 * `store.Repo` (bound as `store::Repo`). Null for a type of the language, a type parameter, a slice, a map, a
 * function or an anonymous struct.
 */
function namedType(type: Node | null, file: GoFile, typeParams: ReadonlySet<string> = new Set()): string | null {
  if (!type) return null;

  switch (type.type) {
    case "type_identifier":
      return PREDECLARED_TYPES.has(type.text) || typeParams.has(type.text) ? null : type.text;
    case "pointer_type":
    case "parenthesized_type":
      return namedType(type.namedChildren[0] ?? null, file, typeParams);
    case "generic_type":
      return namedType(type.childForFieldName("type"), file, typeParams);
    case "qualified_type": {
      const pkg = type.childForFieldName("package")?.text;
      const name = type.childForFieldName("name")?.text;

      return pkg && name && file.packages.has(pkg) ? `${pkg}::${name}` : null;
    }

    default:
      return null;
  }
}

/** The fields of a struct of the file whose type names one type, for `o.repo.Save()` in its methods. */
function structFields(spec: Node, file: GoFile): void {
  const name = spec.childForFieldName("name")?.text;
  const type = spec.childForFieldName("type");

  if (!name || type?.type !== "struct_type") return;
  const typeParams = typeParamsOf(spec);
  const fields = new Map<string, string>();

  for (const field of type.namedChildren.flatMap((list) => list.namedChildren)) {
    if (field.type !== "field_declaration") continue;
    const named = namedType(field.childForFieldName("type"), file, typeParams);

    if (named) for (const fieldName of field.childrenForFieldName("name")) if (fieldName) fields.set(fieldName.text, named);
  }

  file.fields.set(name, fields);
}

/** The names of the type parameters a function or a type declares (`[T any, K comparable]`). */
function typeParamsOf(node: Node): Set<string> {
  const out = new Set<string>();

  for (const declaration of node.childForFieldName("type_parameters")?.namedChildren ?? []) for (const name of declaration.childrenForFieldName("name")) if (name) out.add(name.text);

  return out;
}

/** The receiver of a method: its name (none for `func (*Order) m()`) and the type it is declared on. */
function receiverOf(method: Node): { name: string; type: string } | null {
  if (method.type !== "method_declaration") return null;
  const parameter = method.childForFieldName("receiver")?.namedChildren.find((child) => child.type === "parameter_declaration");
  let type = parameter?.childForFieldName("type") ?? null;

  while (type && (type.type === "pointer_type" || type.type === "parenthesized_type")) type = type.namedChildren[0] ?? null;

  if (type?.type === "generic_type") type = type.childForFieldName("type");

  return type?.type === "type_identifier" ? { name: parameter?.childForFieldName("name")?.text ?? "", type: type.text } : null;
}

/** A type declaration: a struct or any other defined type is a class (it may have methods), an interface or an alias a type. */
function typeDecl(spec: Node, declaration: Node, file: GoFile): DeclFact | null {
  const name = spec.childForFieldName("name")?.text;
  const type = spec.childForFieldName("type");

  if (!name || !type || (spec.type !== "type_spec" && spec.type !== "type_alias")) return null;
  // A lone spec is documented above its `type` keyword; one of a group above itself.
  const alone = declaration.namedChildren.filter((child) => child.type !== "comment").length === 1;
  const at = located(alone ? declaration : spec);
  const doc = docOf(alone ? declaration : spec);
  const typeParams = typeParamsOf(spec);
  const decl: DeclFact = { kind: "class", name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature: null, exported: isExported(name), calls: [], types: [], members: [], ...fingerprintFacts(spec) };

  if (doc !== undefined) decl.doc = doc;

  if (spec.type === "type_alias") {
    // `type ID = store.ID`: a member of the alias is a member of what it names.
    decl.kind = "type";
    decl.signature = `= ${namedType(type, file, typeParams) ?? collapse(type.text)}`;
  } else if (type.type === "interface_type") {
    decl.kind = "type";
    const shape: TypeFieldFact[] = [];
    const embedded: string[] = [];

    for (const element of type.namedChildren) {
      if (element.type === "method_elem") {
        const method = element.childForFieldName("name")?.text;

        if (method) shape.push({ name: method, optional: false, type: `${collapse(element.childForFieldName("parameters")?.text ?? "()")} => ${collapse(element.childForFieldName("result")?.text ?? "void")}` });
      } else if (element.type === "type_elem" && element.namedChildren.length === 1) {
        // An embedded interface: this one extends it.
        const named = namedType(element.namedChildren[0]!, file, typeParams);

        if (named) embedded.push(named);
      }
    }

    if (shape.length > 0) decl.shape = shape;

    if (embedded.length > 0) decl.implements = embedded;
  } else if (type.type === "struct_type") {
    const fields: FieldFact[] = [];
    const embedded: string[] = [];

    for (const field of type.namedChildren.flatMap((list) => list.namedChildren)) {
      if (field.type !== "field_declaration") continue;
      const fieldType = field.childForFieldName("type");
      const names = field.childrenForFieldName("name").filter((each) => each !== null);
      const written = collapse(fieldType?.text ?? "");

      for (const fieldName of names) fields.push({ name: fieldName.text, class: written });

      // An embedded field: its methods are the struct's own, and it is a field named as its type.
      if (names.length === 0 && fieldType) {
        const named = namedType(fieldType, file, typeParams);

        if (named) embedded.push(named);
        fields.push({ name: written.replace(/^\*/, "").replace(/^.*\./, "").replace(/\[.*$/, ""), class: written });
      }
    }

    if (fields.length > 0) decl.fields = fields;

    // The first embedded type is the base (a member the struct lacks is looked up there, a package's base makes it the package's); the others give their methods as traits do.
    if (embedded.length > 0) decl.base = embedded[0]!;

    if (embedded.length > 1) decl.traits = embedded.slice(1);
  }

  return decl;
}

/** The constants and variables of one spec: public names of the file, and — a variable holding an instance — the class of its value. */
function valuesOf(spec: Node, file: GoFile): void {
  const names = spec.childrenForFieldName("name").filter((each) => each !== null);
  const declared = namedType(spec.childForFieldName("type"), file);
  const values = spec.childForFieldName("value")?.namedChildren ?? [];

  names.forEach((name, index) => {
    if (name.text === "_") return;
    file.row(name.text, "value", "const");

    if (spec.type !== "var_spec") return;
    // `var repo store.Repo`, `var repo = &Repo{}`, `var repo = store.NewRepo()`: a member called through the name is that class's.
    const value = values.length === names.length ? values[index]! : null;
    const made = declared ?? (value ? constructedType(value, file, NO_SCOPE) : null);
    const call = made === null && value?.type === "call_expression" ? callOf(value.childForFieldName("function"), NO_SCOPE, file) : null;

    if (made) (file.facts.instances ??= []).push({ name: name.text, class: made });
    else if (call && tracked(call.form)) (file.facts.instances ??= []).push({ name: name.text, of: { call: call.form } });
  });
}

/** Whether a call's result can be followed to a class: a call archdiff names, not one through a value. */
function tracked(form: CalleeForm): boolean {
  return form.kind === "name" || form.kind === "member" || form.kind === "own" || form.kind === "typed" || form.kind === "result";
}

/** The type a value is made of, where the expression writes it: `Order{…}`, `&Order{…}`, `new(Order)`, `x.(*Order)`. */
function constructedType(value: Node, file: GoFile, scope: FnScope): string | null {
  switch (value.type) {
    case "composite_literal":
    case "type_assertion_expression":
      return namedType(value.childForFieldName("type"), file, scope.typeParams);
    case "unary_expression": {
      const operand = value.childForFieldName("operand");

      return operand && value.text.startsWith("&") ? constructedType(operand, file, scope) : null;
    }

    case "parenthesized_expression":
      return value.namedChildren[0] ? constructedType(value.namedChildren[0], file, scope) : null;
    case "call_expression": {
      const fn = value.childForFieldName("function");
      const first = value.childForFieldName("arguments")?.namedChildren[0];

      // `new(Order)`: the argument is a type.
      return fn?.type === "identifier" && fn.text === "new" && !scope.locals.has("new") && first ? namedType(first, file, scope.typeParams) : null;
    }

    default:
      return null;
  }
}

/**
 * The names a function binds, nested function literals included — one scope for the whole function, as the other
 * frontends read it: its receiver, parameters and named results, `:=`, `var` and `const`, the variables of a `range`
 * and of a type switch, and the types it declares. A name declared twice keeps its type only when both say the same.
 */
function scopeOf(fn: Node, receiver: { name: string; type: string } | null, file: GoFile): FnScope {
  const cached = file.scopes.get(fn.id);

  if (cached) return cached;
  const locals = new Map<string, Local>();
  const typeParams = typeParamsOf(fn);

  // The parameters of a generic type are in scope in its declaration.
  if (fn.type === "type_declaration") for (const spec of fn.namedChildren) for (const name of typeParamsOf(spec)) typeParams.add(name);

  // A method of a generic type names the type's parameters in its receiver (`func (l *List[T]) …`).
  for (const argument of fn.childForFieldName("receiver")?.descendantsOfType("type_arguments") ?? []) for (const name of argument?.descendantsOfType("type_identifier") ?? []) if (name) typeParams.add(name.text);
  const partial: FnScope = { receiver: null, locals, typeParams };

  const bind = (name: Node | null, kind: Local["kind"], type: string | null, call: Node | null): void => {
    if (!name || name.type !== "identifier" || name.text === "_") return;
    const before = locals.get(name.text);
    const local: Local = { kind: before?.kind === "parameter" ? "parameter" : kind };

    // A second declaration of the name (a shadow in a nested block) keeps what both agree on.
    if (type && (!before || before.type === type)) local.type = type;

    if (call && !before) local.call = call;
    locals.set(name.text, local);
  };

  const parameters = (list: Node | null): void => {
    for (const parameter of list?.namedChildren ?? []) {
      if (parameter.type !== "parameter_declaration" && parameter.type !== "variadic_parameter_declaration") continue;
      // A variadic parameter is a slice of its type.
      const type = parameter.type === "parameter_declaration" ? namedType(parameter.childForFieldName("type"), file, typeParams) : null;

      for (const name of parameter.childrenForFieldName("name")) bind(name, "parameter", type, null);
    }
  };

  parameters(fn.childForFieldName("parameters"));
  const result = fn.childForFieldName("result");

  if (result?.type === "parameter_list") parameters(result);

  const walk = (node: Node): void => {
    switch (node.type) {
      case "short_var_declaration":
      case "range_clause":
      case "receive_statement": {
        const left = node.childForFieldName("left")?.namedChildren ?? [];
        const right = node.type === "short_var_declaration" ? (node.childForFieldName("right")?.namedChildren ?? []) : [];

        // `x := v` pairs each name with its value; `x, err := f()` binds `x` to the call's first result.
        left.forEach((name, index) => {
          const value = left.length === right.length ? right[index]! : index === 0 && right.length === 1 ? right[0]! : null;

          bind(name, "local", value ? constructedType(value, file, partial) : null, value?.type === "call_expression" && constructedType(value, file, partial) === null ? value : null);
        });
        break;
      }

      case "var_spec":
      case "const_spec": {
        const names = node.childrenForFieldName("name");
        const values = node.childForFieldName("value")?.namedChildren ?? [];
        const declared = namedType(node.childForFieldName("type"), file, typeParams);

        names.forEach((name, index) => {
          const value = values.length === names.length ? values[index]! : index === 0 && values.length === 1 ? values[0]! : null;
          const made = declared ?? (value ? constructedType(value, file, partial) : null);

          bind(name, "local", made, made === null && value?.type === "call_expression" ? value : null);
        });
        break;
      }

      case "type_switch_statement":
        for (const name of node.childForFieldName("alias")?.namedChildren ?? []) bind(name, "local", null, null);
        break;
      case "func_literal":
        parameters(node.childForFieldName("parameters"));

        if (node.childForFieldName("result")?.type === "parameter_list") parameters(node.childForFieldName("result"));
        break;
      case "type_spec":
      case "type_alias": {
        // A type declared in the body hides the package's of that name.
        const name = node.childForFieldName("name");

        if (name) locals.set(name.text, { kind: "local" });
        break;
      }
    }

    for (const child of node.namedChildren) walk(child);
  };

  // A function's body; of any other declaration (`var handler = func(w …) { … }`), the function literals in it.
  const bodies = fn.type === "function_declaration" || fn.type === "method_declaration" ? [fn.childForFieldName("body")] : fn.descendantsOfType("func_literal");

  for (const body of bodies) if (body) walk(body);
  const scope: FnScope = { receiver: receiver && receiver.name !== "" && receiver.name !== "_" ? receiver : null, locals, typeParams };
  file.scopes.set(fn.id, scope);

  return scope;
}

/** The declaration of a function or a method: signature, calls, branches, doc and the type of its first result. */
function fnDecl(node: Node, name: string, receiver: { name: string; type: string } | null, file: GoFile): DeclFact {
  const at = located(node);
  const params = node.childForFieldName("parameters");
  const result = node.childForFieldName("result");
  const signature = params ? `${collapse(params.text)}${result ? ` → ${collapse(result.text)}` : ""}` : null;
  const scope = scopeOf(node, receiver, file);
  const body = node.childForFieldName("body");
  const decl: DeclFact = { kind: "fn", name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature, exported: isExported(name), calls: body ? bodyCalls(body, scope, file) : [], types: [], members: [], ...fingerprintFacts(node) };
  const doc = docOf(node);

  if (doc !== undefined) decl.doc = doc;
  const branches = body ? countBranches(body, GO_CONTROL) : 0;

  if (branches > 0) decl.branches = branches;
  // `func open() (*Repo, error)`: a member called on the first result is a Repo's.
  const first = result?.type === "parameter_list" ? (result.namedChildren.find((child) => child.type === "parameter_declaration")?.childForFieldName("type") ?? null) : result;
  const made = namedType(first, file, scope.typeParams);

  if (made) decl.result = { class: made };

  return decl;
}

/** How many calls a receiver is followed through (`a().b().c()`, a local made by a call on a local made by a call). */
const MAX_CHAIN = 4;

/** A call fact before its position is known. */
type UnplacedCall = Omit<CallFact, "line" | "col" | "endLine" | "endCol">;

/** What a callee expression names: the callee as written, and its form. */
type Callee = Pick<CallFact, "callee" | "form">;

/** Every call in a body as a call fact, with the functions it is handed and the guards it sits under; function literals are walked too. */
function bodyCalls(body: Node, scope: FnScope, file: GoFile): CallFact[] {
  const out: CallFact[] = [];

  const walk = (node: Node): void => {
    if (node.type === "call_expression") {
      const fact = callOf(node.childForFieldName("function"), scope, file);

      if (fact) {
        const at = located(node);
        const passes = passesOf(node, scope, file);
        const unplaced: UnplacedCall = { ...fact };

        if (passes.length > 0) unplaced.passes = passes;
        const call: CallFact = Object.assign(unplaced, { line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol });
        const guards = guardsOf(node, body, GO_CONTROL);

        if (guards.length > 0) call.guards = guards;
        out.push(call);

        if (fact.callee.endsWith(".MethodByName")) file.facts.unsupported.push(unsupportedAt(node, "`MethodByName` reads a method chosen at run time"));
      }
    }

    for (const child of node.namedChildren) walk(child);
  };

  walk(body);

  return out;
}

/** Functions among the arguments: `http.HandleFunc("/orders", handle)`, `r.Get("/", s.list)`, `run(store.Save)`. A function literal is not one: its calls are the caller's own. */
function passesOf(call: Node, scope: FnScope, file: GoFile): PassFact[] {
  const out: PassFact[] = [];

  (call.childForFieldName("arguments")?.namedChildren ?? [])
    .filter((arg) => arg.type !== "comment")
    .forEach((arg, index) => {
      if (arg.type !== "identifier" && arg.type !== "selector_expression") return;

      if (arg.type === "identifier" && (PREDECLARED.has(arg.text) || scope.locals.has(arg.text) || arg.text === scope.receiver?.name)) return;
      const fact = callOf(arg, scope, file);

      // A method of what a call returned (`handler := NewHandler(); mux.HandleFunc("/", handler.Place)`) is a function the code names, too.
      if (!fact || !(passable(fact.form) || fact.form.kind === "result")) return;
      const at = located(arg);
      out.push({ arg: index, path: "", callee: fact.callee, form: fact.form, text: collapse(at.text), line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol });
    });

  return out;
}

/** Source text on one line, without spaces around the dots. */
function compact(text: string): string {
  return text.replace(/\s+/g, " ").replace(/ ?\. ?/g, ".");
}

/** A call archdiff cannot name, as written: a call through a value, a gap in the graph, never an edge. */
function throughValue(fn: Node): Callee {
  const callee = compact(fn.text);

  return { callee: callee.length > 80 ? `${callee.slice(0, 79)}…` : callee, form: /[.([]/.test(callee) ? { kind: "value" } : { kind: "bound", binding: "local" } };
}

/**
 * The type of an expression where the code writes it: the receiver's, a typed parameter's or local's, a field of
 * one of the file's structs (`o.repo`), a literal's (`Order{}`, `&Order{}`, `new(Order)`). Null for anything else.
 */
function typeOf(value: Node, scope: FnScope, file: GoFile): string | null {
  switch (value.type) {
    case "identifier":
      return value.text === scope.receiver?.name ? scope.receiver.type : (scope.locals.get(value.text)?.type ?? null);
    case "selector_expression": {
      const operand = value.childForFieldName("operand");
      const owner = operand ? typeOf(operand, scope, file) : null;

      return owner ? (file.fields.get(owner)?.get(value.childForFieldName("field")?.text ?? "") ?? null) : null;
    }

    case "parenthesized_expression":
      return value.namedChildren[0] ? typeOf(value.namedChildren[0], scope, file) : null;
    default:
      return constructedType(value, file, scope);
  }
}

/**
 * `f()` → a name of the package (the file's own, or another file's); `store.Save()` → the declaration `Save` of the
 * package `store`; `o.m()` on the receiver → the type's own member; `x.m()` → a member of the type the code writes
 * for `x` (a parameter, a `var`, a literal, a field of the receiver), of what the call that made `x` returns, or of
 * the value a package-level variable holds. A conversion to a type of the language and a function literal called
 * in place are no calls (null); any other callee is a call through a value.
 */
function callOf(fn: Node | null, scope: FnScope, file: GoFile, depth = 0): Callee | null {
  if (!fn) return null;

  switch (fn.type) {
    case "parenthesized_expression": {
      const inner = fn.namedChildren[0];

      return inner && (inner.type === "identifier" || inner.type === "selector_expression" || inner.type === "parenthesized_expression") ? callOf(inner, scope, file, depth) : throughValue(fn);
    }

    // A function literal called in place: its calls are the caller's own.
    case "func_literal":
      return null;
    case "index_expression": {
      // `Map[int](xs)`: a generic function with its type argument; `handlers[i]()`, `handlers["a"]()` an element of a value.
      const operand = fn.childForFieldName("operand");
      const index = fn.childForFieldName("index");
      const element = index?.type.endsWith("_literal") === true || (index?.type === "identifier" && scope.locals.has(index.text));

      return operand?.type === "identifier" && !element && !scope.locals.has(operand.text) && operand.text !== scope.receiver?.name ? callOf(operand, scope, file, depth) : throughValue(fn);
    }

    case "identifier": {
      const name = fn.text;
      const local = scope.locals.get(name);

      if (local || name === scope.receiver?.name) return { callee: name, form: { kind: "bound", binding: local?.kind ?? "parameter" } };

      if (PREDECLARED_TYPES.has(name)) return null;

      if (!PREDECLARED.has(name)) file.own(name, fn);

      return { callee: name, form: { kind: "name", name } };
    }

    case "selector_expression": {
      const operand = fn.childForFieldName("operand");
      const member = fn.childForFieldName("field")?.text;

      if (!operand || !member) return throughValue(fn);

      if (operand.type === "identifier") {
        const head = operand.text;

        if (head === scope.receiver?.name) return { callee: `this.${member}`, form: { kind: "own", member } };
        const local = scope.locals.get(head);

        if (local) {
          const callee = `${head}.${member}`;

          if (local.type) return { callee, form: { kind: "typed", type: local.type, member } };
          // The call that made the local, itself read as a call (a local made of itself, `x = x.next()`, ends the chain).
          const made = local.call && depth < MAX_CHAIN ? callOf(local.call.childForFieldName("function"), scope, file, depth + 1) : null;

          return { callee, form: made && tracked(made.form) ? { kind: "result", of: { call: made.form }, member } : { kind: "value" } };
        }

        if (file.packages.has(head)) return { callee: `${head}.${member}`, form: { kind: "name", name: file.qualified(head, member, fn) } };

        if (PREDECLARED.has(head)) return throughValue(fn);
        // A type (`Order.Total` as a function) or a variable of the package: the member of the class, or of the class of its value.
        file.own(head, operand);

        return { callee: `${head}.${member}`, form: { kind: "member", head, member } };
      }

      // `store.Default.Save()`: a member of the value a variable of another package holds.
      if (operand.type === "selector_expression") {
        const pkg = operand.childForFieldName("operand");
        const name = operand.childForFieldName("field")?.text;

        if (pkg?.type === "identifier" && name && file.packages.has(pkg.text) && !scope.locals.has(pkg.text) && pkg.text !== scope.receiver?.name) return { callee: `${pkg.text}.${name}.${member}`, form: { kind: "member", head: file.qualified(pkg.text, name, operand), member } };
      }

      // `store.NewRepo().Save()`: a member of what the call returns.
      if (operand.type === "call_expression") {
        const made = constructedType(operand, file, scope);

        if (made) return { callee: compact(fn.text), form: { kind: "typed", type: made, member } };
        const inner = depth < MAX_CHAIN ? callOf(operand.childForFieldName("function"), scope, file, depth + 1) : null;

        return inner && tracked(inner.form) ? { callee: `${inner.callee}().${member}`, form: { kind: "result", of: { call: inner.form }, member } } : throughValue(fn);
      }

      const type = typeOf(operand, scope, file);

      return type ? { callee: compact(fn.text), form: { kind: "typed", type, member } } : throughValue(fn);
    }

    default:
      return throughValue(fn);
  }
}

/**
 * Every name under `node` the file uses without declaring it: `store.Save` and `store.Repo` are imports of those
 * declarations, a bare name that nothing of the function binds is one of another file of the package. A function
 * so named and not called is read as a value, as is a method (`s.handle`).
 */
function references(node: Node, scope: FnScope, file: GoFile): void {
  const walk = (at: Node): void => {
    const parent = at.parent;

    switch (at.type) {
      case "qualified_type": {
        const pkg = at.childForFieldName("package")?.text;
        const name = at.childForFieldName("name")?.text;

        if (pkg && name && file.packages.has(pkg)) file.qualified(pkg, name, at);

        return;
      }

      case "type_identifier":
        if (!PREDECLARED_TYPES.has(at.text) && !scope.typeParams.has(at.text) && !scope.locals.has(at.text)) file.own(at.text, at);

        return;
      case "selector_expression": {
        const operand = at.childForFieldName("operand");
        const field = at.childForFieldName("field")?.text;
        const called = parent?.type === "call_expression" && parent.childForFieldName("function")?.id === at.id;

        if (operand?.type === "identifier" && field && !scope.locals.has(operand.text) && operand.text !== scope.receiver?.name && file.packages.has(operand.text)) {
          const local = file.qualified(operand.text, field, at);

          if (!called) file.ref(local, at, false);

          return;
        }

        if (field && !called) file.ref(field, at, true);
        break;
      }

      case "identifier": {
        const name = at.text;

        if (PREDECLARED.has(name) || scope.locals.has(name) || name === scope.receiver?.name || file.packages.has(name) || !parent) return;
        const is = (field: string): boolean => parent.childForFieldName(field)?.id === at.id;

        // A name being declared: a function, a constant or a variable of the package, a parameter of a function type.
        if (DECLARING.has(parent.type) && parent.childrenForFieldName("name").some((each) => each?.id === at.id)) return;

        // A field named in a literal (`Order{ID: 1}`); the key of a map literal is a value.
        if (parent.type === "literal_element" && parent.parent?.type === "keyed_element" && parent.parent.childForFieldName("key")?.id === parent.id && parent.parent.parent?.parent?.childForFieldName("type")?.type !== "map_type") return;
        file.own(name, at);
        const called = (parent.type === "call_expression" && is("function")) || (parent.type === "selector_expression" && is("operand")) || (parent.type === "index_expression" && is("operand"));

        if (!called) file.ref(name, at, false);

        return;
      }
    }

    for (const child of at.namedChildren) walk(child);
  };

  walk(node);
}

/** The documentation of a declaration: the comments right above it, with no blank line between, without the toolchain's directives. */
function docOf(node: Node): string | undefined {
  const comments: Node[] = [];
  let below = node.startPosition.row;

  for (let prev = node.previousNamedSibling; prev && prev.type === "comment" && prev.endPosition.row === below - 1; prev = prev.previousNamedSibling) {
    comments.unshift(prev);
    below = prev.startPosition.row;
  }

  const kept = comments.filter((comment) => !DIRECTIVE.test(comment.text));

  if (kept.length === 0) return undefined;
  const text = kept.map((comment) => (comment.text.startsWith("/*") ? blockCommentBody(comment.text.replace(/\r/g, "")) : lineCommentsBody([comment.text], /^\/\//))).join("\n");

  return isLicense(text) ? undefined : (nonEmpty(text) ?? undefined);
}

/** The package's documentation: the comment right above the `package` clause of this file. */
function packageDoc(root: Node): string | undefined {
  const clause = root.namedChildren.find((node) => node.type === "package_clause");

  return clause ? docOf(clause) : undefined;
}
