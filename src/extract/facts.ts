// Language-independent facts extracted from one source file: everything the
// graph and the views need — imports, declarations, calls, the constructs not
// turned into edges (`UnsupportedFact`), the control flow, states and
// messages — and nothing about layers or IDs yet. A fact nothing past this
// directory reads does not belong here: the frontends keep what they need
// for their own resolution in their own scope.
//
// The contract between the language frontends (`ts.ts`, `python.ts`,
// `rust.ts`, `php.ts`) and the graph: source → FileFacts → graph. Types,
// and `reviveFacts`, which gives back the one Set a JSON trip loses. Facts
// are cached on disk between runs (cache.ts) and cross worker threads
// (pool.ts). Entry points: `FileFacts`, `reviveFacts`.

/** Everything archdiff reads of one source file, before layers and IDs. */
export interface FileFacts {
  /** POSIX path relative to the repository root. */
  path: string;
  /** End of the file, 1-based; `endCol` is the column after the last character. */
  endLine: number;
  endCol: number;
  imports: ImportFact[];
  decls: DeclFact[];
  /** Names exported by the file (ESM `export`, CommonJS `module.exports`/`exports.x`). */
  exports: Set<string>;
  /** The fields read from what calls returned, in every body of the file (ReadFact): the contracts of API operations are read from these. */
  reads?: ReadFact[];
  /** `export * from "./x"` — the file re-exports everything from these sources. */
  reexportsAll: string[];
  /**
   * Constants of the file's top level that hold an instance: made with `new` (`export const store = new Store()`, the
   * class as written), a literal of the language (`["a", "b"]` is an `Array`, a string a `String`) or the result of a
   * call (`export const db = createDb()`, read as `CallFact.on` is). A member called through the name — here or where
   * it is imported — is the member of that class.
   */
  instances?: ({ name: string; class: string } | { name: string; of: ValueOfFact })[];
  /** Public names with their kinds. Empty only when the file exports nothing. */
  exportRows: ExportRow[];
  /** Constructs the extractor does not turn into edges, each with the source fragment. */
  unsupported: UnsupportedFact[];
  /**
   * Names read as values rather than called — `later(save)`, `{ save }`,
   * `obj.save` without a call, `class B extends A` — first position of each.
   * A function named so may be called by code that holds the value.
   */
  valueRefs: ValueRefFact[];
  /**
   * Calls outside every declaration body: module top level, object-literal
   * methods, function values wrapped in a call (`cache(() => …)`). They run
   * when the module loads, or when code holding that value calls it.
   */
  moduleCalls: CallFact[];
  /**
   * `complete`: the declaration list is exhaustive and may be empty.
   * `opaque`: a syntax error or an unparsed file; a missing name is not evidence it does not exist.
   */
  completeness: "complete" | "opaque";
  parseError: { line: number; reason: string } | null;
  /** The file's documentation comment (a header comment, a module docstring) without comment syntax; absent when it has none. */
  doc?: string;
  /**
   * SHA-256 of the file's top-level value code — constants, assignments,
   * object tables, top-level calls — without its declarations, imports,
   * comments and layout (`valuesFingerprint`): a change to a value no fn
   * reads still changes its module. Absent when the file has none.
   */
  values?: string;
  /**
   * Qualified names of the file's top-level declarations, for a language whose
   * imports name declarations rather than files (PHP: `use App\Domain\Order`
   * names the class `Order` of the namespace `App\Domain`, whatever file
   * declares it). The resolver finds a name's file by them.
   */
  symbols?: QualifiedSymbol[];
  /** States written and read as literals, for the implicit state machines (control.ts). Absent when the file has none. */
  states?: StateFact[];
  /** State machines a library declares (control.ts). Absent when the file has none. */
  machines?: MachineFact[];
}

/** A top-level declaration by its qualified name. */
export interface QualifiedSymbol {
  /** The name the file declares: `Order`. */
  name: string;
  /** With its namespace: `App\Domain\Order`. */
  qualified: string;
  /** PHP keeps classes (interfaces, traits and enums too), functions and constants in tables of their own. */
  table: "class" | "function" | "const";
}

/** One import, require or re-export statement, with the names it binds. */
export interface ImportFact {
  /** Module specifier as written: `./order`, `node:fs`, `@scope/pkg`. */
  source: string;
  /** 1-based start. `endCol` is the column after the fragment. */
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** Source text of the import or require. */
  text: string;
  /** How the import binds names in this file. */
  bindings: ImportBinding[];
  /** `export … from`: the import is re-exported. */
  reexport: boolean;
  /** `use a::*`, `from a import *`: every public name of the source is in scope in this file, with no binding of its own. */
  glob?: true;
  /**
   * TypeScript `import type …`, `export type … from`, `export type * from`: the statement names
   * types only and is erased from the code that runs, so its edge forms no cycle that runs.
   */
  typeOnly?: true;
  /**
   * TypeScript `import { type A, type B as C } from`, `export { type A } from`: every name in the
   * braces is `type` (at least one, with no default or namespace binding beside them). tsc and
   * esbuild erase the statement unless the tsconfig that governs the file sets
   * `verbatimModuleSyntax`, which keeps it as `import {} from`: a fact of the syntax, whose
   * `typeOnly` edge the graph decides with the tsconfig, so cached facts do not depend on it.
   */
  inlineTypeOnly?: true;
  /**
   * The specifier may name a module or another file: `new URL("./worker", import.meta.url)`
   * without an extension. An edge when it resolves to a source file, nothing otherwise.
   */
  optional?: true;
  /**
   * The module is named by a URL (`new URL("./w.ts", import.meta.url)`, `import.meta.resolve("./w.ts")`): a file
   * the module loads or runs — a worker, a child process, a hook it registers — rather than imports.
   */
  url?: true;
  /**
   * The name is written only in a docblock the language does not check (PHP `@var Foo` above a
   * property, `@param Foo $x`), never in the code: the edge's provenance is `docblock`.
   */
  docblock?: true;
}

/** How an import binds one local name. */
export type ImportBinding =
  /**
   * `import * as x from`, `const x = require()`, `import x = require()` — `x` is the whole module:
   * `x.m` is its export `m`. `namespace`: a module object that is no function and holds no default
   * value — an ESM namespace object (`import * as x`, `export * as x`, `await import()`), a Python
   * module (`import x`); without it the binding is the module's value (`module.exports` of
   * `require()`), which `x()` calls as its `default`.
   */
  | { kind: "module"; local: string; namespace?: true }
  /** `import x from` — `x` is the export `default` (for a CommonJS module without one, `module.exports`). */
  | { kind: "default"; local: string }
  /** `import { a as b } from` — `b` is the export `a`. */
  | { kind: "named"; local: string; imported: string };

/** The kinds of declaration the graph holds. */
export type DeclKind = "fn" | "class" | "type";

/** A declaration of the file (or a member of one), with what its body calls and mentions. */
export interface DeclFact {
  kind: DeclKind;
  name: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  /** `(a: A) → B` for functions and methods; `extends X` etc. for types. */
  signature: string | null;
  exported: boolean;
  /** Calls made from the body (functions, methods, and class-level for constructors). */
  calls: CallFact[];
  /** Type names mentioned by this declaration, not including its own name. */
  types: TypeRefFact[];
  /** Methods for classes. */
  members: DeclFact[];
  /** `fingerprint()` of the declaring node: changes with the body and signature, not with comments or layout. */
  fingerprint?: string;
  /**
   * Functions and methods: how many branching statements the body holds
   * (`if`, `switch`/`match`, a loop, `try`), nested functions included.
   * The `logic` view lists the functions with the most; absent when zero.
   */
  branches?: number;
  /** A function that returns (a part of) a call's result: which call and which part (ReturnFact). */
  returnsFrom?: ReturnFact;
  /**
   * Classes: SHA-256 of the class body's value code outside its members —
   * fields, constants, properties, static blocks (`valuesFingerprint`).
   * Absent when the body has none.
   */
  values?: string;
  /**
   * A getter, a setter, or both of one name (merged into one member: one name, one declaration of the class):
   * property access runs it without a call expression.
   */
  accessor?: "get" | "set" | "get/set";
  /** The language calls the member through syntax, not a call that names it: a Rust `Drop::drop`, `Display::fmt`, `Add::add`. */
  implicit?: true;
  /** A `static` class member. */
  static?: true;
  /** An ECMAScript private member (`#name`); `name` is written without `#`. */
  hash?: true;
  /** Classes: the `extends` expression as written (`Readable`, `React.Component`). */
  base?: string;
  /** Classes: the traits the class uses, as written (PHP `use Logs;`): their methods are the class's own. */
  traits?: string[];
  /**
   * Classes: the interfaces the class implements; interfaces: those it extends — as written
   * (PHP `implements A, B`, `interface I extends J`). A framework's interceptor on an
   * interface wraps the classes that implement it.
   */
  implements?: string[];
  /** The declaration's documentation comment without comment syntax, lines kept; absent when it has none. */
  doc?: string;
  /** PHP classes: the properties whose default value is a literal a framework reads (`protected $listen = [OrderPlaced::class => [...]]`). */
  properties?: PropertyFact[];
  /** Functions and methods: the class of the result as the declaration writes it (PHP `: Order`, `: static`, `@return Item[]`; TypeScript `: Order`, `: Promise<Order>`; Python `-> Order`). */
  result?: ResultTypeFact;
  /** PHP classes: the properties whose class the class body names (typed, from the constructor, or by `@var`): a subclass's `$this->x` reads them. */
  fields?: FieldFact[];
  /**
   * TypeScript types and classes: the declared shape, in source order — an
   * interface's or an object type literal's property and method signatures,
   * a class's public instance fields. A member without a type annotation and
   * an index signature are left out. Absent when the shape is unknown (an
   * enum, a union alias, another language); `planned type` fields are
   * compared with it.
   */
  shape?: TypeFieldFact[];
}

/** One member of a type's shape: `note?: string` is `{ name: "note", optional: true, type: "string" }`; a method's type is `(x: T) => R`. */
export interface TypeFieldFact {
  name: string;
  optional: boolean;
  /** The annotation as written, whitespace collapsed. */
  type: string;
}

/**
 * The class a function returns, or of the elements of the array it returns, as its
 * declaration writes it. A declared return type is a fact PHP checks; `@return` is a docblock
 * (`docblock`, the tag's position) and is read only where the declared type names no class.
 * TypeScript without a return annotation: the class of the `new X()` every `return` gives.
 */
export interface ResultTypeFact {
  /** PHP: the qualified class, without the leading `\`; TypeScript, Python: the name as written. Absent for `self` and `static`. */
  class?: string;
  /** `self`: the declaring class; `static` (and `$this`): the class of the value the method is called on. */
  self?: "self" | "static";
  /** The result is an array of `class` values (`Foo[]`, `array<Foo>`, `iterable<Foo>`, `list<Foo>`). */
  element?: true;
  /** TypeScript: a Promise of a `class` value (`: Promise<Foo>`, an `async` function's `new Foo()`): the value once awaited. */
  promise?: true;
  docblock?: { line: number; col: number };
}

/** PHP: a property and the qualified class of its value (`element`: an array of them). */
export interface FieldFact {
  name: string;
  class: string;
  element?: true;
  docblock?: { line: number; col: number };
}

/**
 * The callee of a call as the frontend read it: what the graph resolves,
 * one form per call and no order between the forms. The text as written
 * stays beside it (`CallFact.callee`) for the reports. A form the graph
 * cannot follow is a gap with the reason the form implies; a form it can
 * follow may still end in a gap of its own (`global`, `unknown-member`,
 * `interface`, `unresolved`, `external`).
 */
export type Callee =
  /** `f()`, `new X()`, PHP `A\f()`, Rust `crate::a::f()`: a name of the module's scope — a declaration, or an import binding followed to its export. */
  | { kind: "name"; name: string }
  /** `ns.f()`, `Cls.m()`, `store.save()` of a constant made with `new` or by a call: a member of a name of the module's scope. */
  | { kind: "member"; head: string; member: string }
  /** `this.m()`, Python `self.m()`, PHP `$this->m()` and `self::m()`: a member of the enclosing class (`#` of a private name stripped). */
  | { kind: "own"; member: string }
  /** `super.m()`, PHP `parent::m()`, Python `super().m()`: a member of the class the enclosing one extends. */
  | { kind: "super"; member: string }
  /** `this.repo.save()` with `repo: Repo`, `new Foo(1).run()`, PHP `(new B())->go()`, Rust `o.total()` with `o: &Order`: a member of a value whose class the syntax names. */
  | { kind: "typed"; type: string; member: string }
  /**
   * `const s = makeStore(); s.save()`, PHP `$this->repo()->save()`: a member of what another call returns, read from the
   * declared result type of that call's target. `inline` (PHP): the receiver is a call written in the same expression,
   * a link of a chain — one link archdiff cannot follow hides the rest (`dynamic`), where a variable's result it
   * cannot follow is a value of untracked type.
   */
  | { kind: "result"; of: ValueOfFact; member: string; inline?: true }
  /** `const { f } = await import("./x"); f()`, `const x = require("./x"); x.f()`: the export `name` of the module `source` names (`*`: the module itself). */
  | { kind: "loaded"; source: string; name: string }
  /** `x()` through a parameter or a local of the body: a parameter holds what the caller passes (a blind spot), a local function's calls are the caller's already. */
  | { kind: "bound"; binding: "parameter" | "local" }
  /** `list.map()`, `f().m()`, `a.b.c()`, `[a].map()`, `x.m()` through a value whose class the code does not name: a member of a value archdiff does not track. */
  | { kind: "value" }
  /** The `resolve` and `reject` a `new Promise` executor receives: the language's own functions. */
  | { kind: "language" }
  /** `f()()`, `(a || b)()`, PHP `$obj->$m()`: an expression archdiff does not name — never an edge, always a gap. */
  | { kind: "opaque" };

/** The forms of a callee that is a member of something: what an operation of an API is read from, what sends an object literal. */
export const MEMBER_FORMS: ReadonlySet<Callee["kind"]> = new Set<Callee["kind"]>(["value", "member", "typed"]);

/**
 * The form of a callee a frontend writes as a dotted name composed of the
 * parts it read — `f`, `ns.f`, `Cls.m`, `this.m`, `super.m`, `crate::a.f` —
 * or of a name read as a value: one part is a name of the module's scope,
 * `this.m` the enclosing class's member, `super.m` (Python's `super().m`)
 * the base's; two parts a member of a name; more parts, a literal head or a
 * call in it a member of a value.
 */
export function dottedForm(callee: string): Callee {
  const base = /^super\(\)\.([\w$]+)$/.exec(callee);

  if (base) return { kind: "super", member: base[1]! };

  if (callee.includes("(")) return { kind: "value" };
  const parts = callee.split(".");

  if (parts.length === 1) return { kind: "name", name: callee };

  if (parts.length > 2 || parts[0]!.startsWith("[") || parts[0]!.startsWith("{")) return { kind: "value" };
  const [head, member] = parts as [string, string];

  return head === "this" ? { kind: "own", member } : head === "super" ? { kind: "super", member } : { kind: "member", head, member };
}

/**
 * The form of a callee whose head a parameter or a local of the body binds, written as a dotted name: the name alone
 * is the binding's (Python's `super().m` the base's member); with a member or a call in it, a member of a value.
 */
export function boundForm(callee: string, binding: "parameter" | "local"): Callee {
  const base = /^super\(\)\.([\w$]+)$/.exec(callee);

  if (base) return { kind: "super", member: base[1]! };

  return callee.includes("(") || callee.includes(".") ? { kind: "value" } : { kind: "bound", binding };
}

/**
 * Whether a function value passed as an argument can be followed to a declaration: a name, a member of a name, of
 * the class, of its base, or of a value whose class the syntax names. A value of a binding, a loaded module's export
 * or a call's result is not (it would be read as a call only): no `ref` edge.
 */
export function passable(form: Callee): boolean {
  return form.kind === "name" || form.kind === "member" || form.kind === "own" || form.kind === "super" || form.kind === "typed";
}

/**
 * A value whose class the graph reads from another declaration — the result of a call
 * (its declared result type), with `element` an element of the array it returns (PHP), with
 * `awaited` what the Promise it returns gives (TypeScript `await`).
 */
export interface ValueOfFact {
  /** The call, as its callee was read. */
  call: Callee;
  /** PHP: the receiver's class of the call is written only in a docblock, at this position. */
  docblock?: { line: number; col: number };
  element?: true;
  awaited?: true;
}

/**
 * A value PHP code writes as a literal, as far as archdiff reads it:
 * a string without interpolation, `X::class` (`self::class` is the
 * enclosing class), a class constant `X::NAME`, `new X(…)`, an array of them,
 * a closure literal at its position; anything else is `other`. Class names are
 * qualified as PHP resolves them, without the leading `\`.
 */
export type LiteralFact =
  | { kind: "string"; value: string }
  | { kind: "class"; name: string }
  | { kind: "const"; class: string; name: string }
  | { kind: "new"; name: string }
  | { kind: "array"; items: { key: LiteralFact | null; value: LiteralFact }[] }
  | { kind: "closure"; line: number; col: number }
  | { kind: "other" };

/** A class property with a literal default value. */
export interface PropertyFact {
  name: string;
  value: LiteralFact;
  line: number;
  col: number;
}

/** One call written in the code, with its callee as written and as read, and its range. */
export interface CallFact {
  /**
   * The callee as written, for the reports: `f()` → `f`; `a.b()` → `a.b`;
   * `this.m()` → `this.m`; `new X()` → `X`; `new ns.X()` → `ns.X`;
   * `super()` → `super`; an expression archdiff does not name, its source
   * text (at most 80 characters); a member of a chain too long to keep
   * whole, its object cut short (`fetch(…….then`).
   */
  callee: string;
  /** The callee as read: what the graph resolves. */
  form: Callee;
  /**
   * PHP: the receiver is a property the constructor fills from its parameter `param` (`$this->x = $x`, a promoted
   * `private X $x`); `docblock`: the receiver's class is written in a docblock the language does not check (`@var Foo`
   * above the property, `@param Foo $x` of the constructor parameter), at this position. The PHP frontend's own
   * resolution reads both; the graph reads neither.
   */
  param?: string;
  docblock?: { line: number; col: number };
  /**
   * Function values the call passes: `analyze({ generate: worker.generate })`, `later(save)`,
   * and callable references — PHP `[$this, 'm']`, `'Cls::m'`, `\Closure::fromCallable(…)`,
   * `$this->m(...)`; TS `this.m.bind(this)`; Python `functools.partial(self.m)`; Rust `Self::m`.
   */
  passes?: PassFact[];
  /**
   * The first argument of a call a framework reads as a name (Magento
   * `$eventManager->dispatch('checkout_submit_all_after', …)`, `emit('x')`,
   * `on('x', f)`): `literal` is its value when it is a string literal without
   * interpolation, else null, and `text` is its source (at most 80 characters).
   * Recorded only for the members `NAME_ARG_MEMBERS` lists. For a message sent
   * with a `type` (`port.postMessage({ type: 'ping' })`, `sendMessage`, `send`),
   * the `type`'s value, with the message as the text.
   */
  nameArg?: { literal: string | null; text: string };
  /** The branches, loops and handlers the call sits in, outermost first (control.ts): a sequence draws calls under one guard as a fragment. */
  guards?: GuardFact[];
  /**
   * The object literal written as the first argument of a member call (`clients.shopperBaskets.addItemToBasket({ params:
   * { path: { basketId } }, body: items })`), key by key: what the call sends. The contract of an API operation is read
   * from these; a call through a name (`fetch(url, {…})`) or `this.m({…})` carries none.
   */
  shape?: ShapeFact;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

/**
 * What a field of an object literal holds, as written: a literal's kind, a name (with the type its binding declares,
 * `paymentInstrument: PaymentInstrument`), a nested object or array (its first element), a call, a spread, a function.
 */
export interface ShapeValue {
  kind: "string" | "number" | "boolean" | "null" | "name" | "object" | "array" | "call" | "spread" | "function" | "other";
  /** A literal's value, a name as written, a callee: for the examples a contract shows. */
  text?: string;
  /** The declared type of a name, when its parameter or `const` writes one. */
  type?: string;
  fields?: ShapeFact;
  items?: ShapeValue;
}

/** An object literal key by key, four levels deep (`CallFact.shape`): a spread is the key `...x`. */
export type ShapeFact = Record<string, ShapeValue>;

/**
 * A field read from what a call returned: `const { data: basket } = await clients.shopperBaskets.getBasket(…);
 * basket.currency` reads `data.currency` of that call's result. A local bound to the result, or to a part of it by a
 * destructuring pattern, carries the path; so does the parameter of a callback an array of it is iterated with
 * (`basket.productItems.map((item) => item.productId)` reads `productItems.productId`). A method called on the chain
 * is no field. One fact per callee and path in a body, at the first read.
 */
export interface ReadFact {
  /** The call whose result is read, as written (`CallFact.callee`) and as read. */
  callee: string;
  form: Callee;
  /** The fields from the result down: `["data", "currency"]`. */
  path: string[];
  /** The line of the call that made the value: the graph finds the call's edge or operation there. */
  callLine: number;
  line: number;
  col: number;
}

/**
 * What a function returns when it is (a part of) a call's result: `const { data } = await op(); return data` returns
 * `data` of `op`'s result; `return op()` the result itself. A read of this function's result reads that call's.
 */
export interface ReturnFact {
  callee: string;
  form: Callee;
  path: string[];
  callLine: number;
}

/**
 * A guard around a call: an `if` (or its `else`), a loop, a `case`, a
 * `try` or `catch` it sits in, or a ternary. `id` names the guarding
 * statement (its offset in the file), so calls under one guard share it;
 * `text` is the condition or the header, cut short.
 */
export interface GuardFact {
  kind: "if" | "else" | "loop" | "case" | "try" | "catch" | "ternary";
  text: string;
  id: number;
}

/**
 * A state written or read as a literal (control.ts): `order.status =
 * "paid"` (`assign`), `case "paid":` of a switch on the subject (`case`),
 * `order.status === "paid"` (`compare`). `subject` is the field or
 * variable (`status`, `this.state`), `within` the function the statement
 * sits in, `under` the values the enclosing `case` or `if` on the same
 * subject names (the states the assignment moves from). An `initial`
 * assignment is a declaration or a field initializer.
 */
export interface StateFact {
  subject: string;
  /**
   * Whose field the subject is, as the code tells it: the class its object is typed with or made by (`order: Order`,
   * `new Order()`), the enclosing class for `this.status`; else the object's name as written (`order`). Absent for a
   * plain variable. Two entities with a field of one name (`order.status`, `payment.status`) are two machines.
   */
  owner?: { class: string } | { name: string };
  kind: "assign" | "case" | "compare";
  value: string;
  within: string | null;
  under?: string[];
  initial?: true;
  line: number;
  col: number;
}

/** A state machine a library declares (control.ts): XState's `createMachine`, javascript-state-machine, Python's `transitions`. */
export interface MachineFact {
  name: string;
  library: string;
  initial?: string;
  states: string[];
  transitions: { from: string; to: string; event: string }[];
  line: number;
  col: number;
}

/**
 * A function value in the arguments of a call: argument index, property path
 * ("" for the argument itself). `callee` names it as a call would (`this.m`,
 * `Cls.m`, `save`) and `form` is how it was read (`passable` forms only);
 * `text` is the argument as written (`[$this, 'm']`), at the position. One
 * passed as the argument itself is a `callable-arg` edge of the enclosing fn
 * when it resolves.
 */
export interface PassFact {
  arg: number;
  path: string;
  callee: string;
  form: Callee;
  /** The receiver's class is written only in a docblock (PHP `[$this->store, 'm']` with `@var Store`), at this position. */
  docblock?: { line: number; col: number };
  text: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

/** A name read as a value rather than called (see `FileFacts.valueRefs`). */
export interface ValueRefFact {
  /** `save`, or `mod.save` for a module import; the member name for a property read. */
  name: string;
  /** A property read (`obj.save`, `const { save } = obj`): it can hold a method, not a module function. */
  member?: true;
  line: number;
  col: number;
}

/** A type name in type position. `text` is the source fragment. */
export interface TypeRefFact {
  name: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

/**
 * One public name of a file, compared with the `exports` rule and followed by
 * the graph to the symbol it stands for.
 */
export interface ExportRow {
  /**
   * Name visible to importers: `default` for `export default …`, `export =`
   * and `module.exports = …`; `*` for `export * from`.
   */
  name: string;
  /**
   * What the name is as far as the file shows (`fn`, `class`, `type`,
   * `value`). `alias`, `default` and `reexport` say how it is exported
   * instead; a frontend that sets `form` gives the kind here.
   */
  kind: "fn" | "value" | "class" | "type" | "alias" | "default" | "reexport";
  /**
   * The local declaration or binding the name stands for (`export { a as b }`
   * → `a`, `export default function main` → `main`, `export { a as b } from`
   * → `a` in that module); null when no name is written (`export default 3`,
   * `export * from`) or the frontend does not say.
   */
  local: string | null;
  /**
   * How the name is exported; absent for a declaration under its own name.
   * `alias`: `export { a as b }`; `default`: the default export;
   * `reexport`: a name of another module (`from`); `namespace`: a module
   * object (`export * as ns from`, `export namespace N {}`).
   */
  form?: "alias" | "default" | "reexport" | "namespace";
  /** Specifier of the module a re-export or an exported namespace comes from. */
  from?: string;
}

/** A construct the extractor read but does not turn into an edge (an unsupported fact): its source fragment and why. */
export interface UnsupportedFact {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
  reason: string;
  /**
   * The declaration the construct changes, as a dotted path in the file
   * (`place`, `Order.save`): a decorator that may replace a fn. Such a fact
   * is about how calls of that declaration behave; it adds no dependency.
   */
  symbol?: string;
}

/** Facts back from JSON (the fact cache) or a structured clone: `exports` is the one Set, written as an array. */
/**
 * Adds a class member to its list; the getter and the setter of one name (`get x()`, `set x(v)`; Python's
 * `@property` and `@x.setter`) become one member — they are one declaration of the class, and two of one name
 * would be one node of the graph, the second hiding the first — with the calls of both.
 */
export function addMember(members: DeclFact[], member: DeclFact): void {
  const twin = member.accessor ? members.find((other) => other.accessor && other.name === member.name && other.kind === member.kind) : undefined;

  if (!twin) {
    members.push(member);

    return;
  }

  twin.calls.push(...member.calls);
  twin.types.push(...member.types);

  if (twin.accessor !== member.accessor) twin.accessor = "get/set";
}

export function reviveFacts(facts: FileFacts): FileFacts {
  return facts.exports instanceof Set ? facts : { ...facts, exports: new Set(facts.exports as unknown as string[]) };
}
