// Language-independent facts extracted from one source file: everything the
// graph needs — imports, declarations, calls, the constructs not turned
// into edges (`UnsupportedFact`), the control flow, the facts the framework
// adapters read — and nothing about layers or IDs yet.
//
// The contract between the language frontends (`ts.ts`, `python.ts`,
// `rust.ts`, `php.ts`) and the graph: source → FileFacts → graph. Types,
// and `reviveFacts`, which gives back the one Set a JSON trip loses. Facts
// are cached on disk between runs (cache.ts) and cross worker threads
// (pool.ts). Entry points: `FileFacts`, `reviveFacts`.

/** A decorator of a declaration as the code writes it: `@Get("/x")` → `Get` with its arguments. */
export interface CodeDecorator {
  name: string;
  args: DecoratorArg[];
  param?: { index: number; name: string | null; type: string | null };
  line: number;
  col: number;
}

/**
 * A decorator argument: a string literal (a template without substitutions
 * too), a number, a name (`ORDER_REPO`, `CronExpression.EVERY_HOUR`), an
 * object or an array literal of those, a function (`() => String`), else
 * `other` with the text.
 */
export type DecoratorArg =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "name"; name: string }
  | { kind: "object"; props: { key: string; value: DecoratorArg; line: number; col: number }[] }
  | { kind: "array"; items: (DecoratorArg & { line: number; col: number })[] }
  | { kind: "function" }
  | { kind: "other"; text: string };

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
  /** `export * from "./x"` — the file re-exports everything from these sources. */
  reexportsAll: string[];
  /**
   * Constants of the file's top level that hold an instance: made with `new` (`export const store = new Store()`, the
   * class as written) or the result of a call (`export const db = createDb()`, read as `CallFact.on` is). A member
   * called through the name — here or where it is imported — is the member of that class.
   */
  instances?: ({ name: string; class: string } | { name: string; of: ValueOfFact })[];
  /** Public names with their kinds. Empty only when the file exports nothing. */
  exportRows: ExportRow[];
  /**
   * Why `exportRows` may miss a public name, when it may: a Python module
   * without `__all__` whose module level binds names archdiff does not list
   * (`for x in`, `with … as x`, `a, b = …`). A glob import of the file may
   * then bring any name. Absent when the list is exhaustive.
   */
  exportsIncomplete?: string;
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
  /**
   * Places where execution starts, as the code writes them: a handler
   * registered on a literal path, a script block that calls a fn. Read by
   * no view yet: the entry points come from frameworks.ts and the names.
   */
  entries?: EntryFact[];
  /**
   * Python: the decorators of the file's declarations archdiff does not know
   * to keep the function, with their literal arguments. A framework adapter
   * reads a registration in them (`@router.get("/x")`, `@shared_task`,
   * `@receiver(post_save, sender=Order)`); the extractor still records each
   * as an unsupported fact of the declaration, which the adapter lifts for a decorator it
   * recognises.
   */
  decorators?: DecoratorFact[];
  /**
   * Python: module-level statements whose value has a call in it, with the
   * value as written: `urlpatterns = [path("x/", views.f)]`,
   * `router = APIRouter(prefix="/x")`, `post_save.connect(h, sender=M)`,
   * `app.conf.beat_schedule = {…}`. What a framework executes as its config.
   */
  statements?: StatementFact[];
  /**
   * Python: calls written in a declaration's parameter list (a default or an
   * annotation): `db = Depends(get_db)`, `Annotated[S, Depends(get_s)]`.
   */
  paramCalls?: ParamCallFact[];
  /**
   * TypeScript/JavaScript: what the web adapters (Express, Fastify, Next.js)
   * read of the file: route registrations with their arguments, the router
   * values the top level creates, `'use server'` directives and an exported
   * `config`. Absent when the file has none of them.
   */
  web?: WebFacts;
  /** States written and read as literals, for the implicit state machines (control.ts). Absent when the file has none. */
  states?: StateFact[];
  /** State machines a library declares (control.ts). Absent when the file has none. */
  machines?: MachineFact[];
}

/** See `FileFacts.web`. */
export interface WebFacts {
  /** `const r = express.Router()`, `const app = fastify()` at the top level: the name and the callee of the call (or `new`) it holds. */
  values: { name: string; callee: string; line: number; col: number }[];
  /** Registrations: `r.get('/x', a, h)`, `app.use('/api', r)`, `f.register(p, { prefix })`, `f.route({…})`, `r.route('/x').get(h)`. */
  calls: WebCallFact[];
  /** `'use server'` in the directive prologue of the file. */
  useServer?: true;
  /** Functions whose body starts with `'use server'`: their name (a declaration's or a declarator's), and whether that is a top-level declaration of the file. */
  actions?: { name: string | null; top: boolean; line: number; col: number }[];
  /** `export const config = {…}`: its value (Next.js `middleware.ts` `matcher`). */
  config?: DecoratorArg;
}

/** A registration call on a receiver written as a name (`app`, `router`, `fastify`). */
export interface WebCallFact {
  receiver: string;
  /** `get`, `post`, `use`, `register`, `route`, … as written. */
  method: string;
  /** `router.route('/x').get(h)`: the path `route` names. */
  route?: DecoratorArg;
  args: (DecoratorArg & { line: number; col: number })[];
  /**
   * The nearest enclosing function whose first parameter is the receiver (a
   * Fastify plugin `async (fastify) => {…}`): its name (the declaration's,
   * the declarator's, `default` for an anonymous default export; null for a
   * function written in place) and position. Absent when the receiver is no
   * such parameter: then it is a name of the file's top level or an import.
   */
  within?: { name: string | null; line: number; col: number };
  line: number;
  col: number;
}

/**
 * A value as the code writes it, for an adapter to read: literals, dotted
 * names and calls with their arguments; anything else is `other` with its
 * text. Containers keep their items in order.
 */
export type LiteralValue =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  /** A name or a dotted path: `views.detail`, `Order`, `True`. */
  | { kind: "name"; value: string }
  | { kind: "call"; callee: string; args: LiteralValue[]; kwargs: Kwarg[]; line: number; col: number }
  /** A list, a tuple or a set. */
  | { kind: "list"; items: LiteralValue[] }
  | { kind: "dict"; entries: { key: LiteralValue; value: LiteralValue }[] }
  | { kind: "other"; text: string };

/** A keyword argument of a call: `prefix="/x"`. */
export interface Kwarg {
  name: string;
  value: LiteralValue;
}

/** A decorator of a declaration: `@x.get("/a", tags=["t"])` → `x.get` with its arguments; `call` null for `@x`. */
export interface DecoratorFact {
  name: string;
  call: { args: LiteralValue[]; kwargs: Kwarg[] } | null;
  /** The declaration as a dotted path in the file: `place`, `Order.save`. */
  target: string;
  line: number;
  col: number;
}

/**
 * A module-level statement: `target = value`, `target += value` (`augmented`),
 * or a call standing alone (`target` null, `value` the call).
 */
export interface StatementFact {
  /** The assigned name or dotted path (`urlpatterns`, `app.conf.beat_schedule`); null for a call statement. */
  target: string | null;
  augmented?: true;
  value: LiteralValue;
  line: number;
  col: number;
}

/** A call in a parameter of a declaration: `symbol`'s parameter `param` is `Depends(get_db)`. */
export interface ParamCallFact {
  symbol: string;
  param: string;
  value: Extract<LiteralValue, { kind: "call" }>;
}

/**
 * A language-level entry point written in the code, before resolution.
 * `route`: `app.get('/x', h)` with a literal path and a named handler —
 * `label` is `GET /x`, `callee` is `h` as written. `main`: a Python
 * `if __name__ == "__main__":` block — `callee` is the fn it calls, or null
 * when it names none directly (the module's top level is the entry then).
 * `sfra`: `server.get('Show', …, h)` in an SFRA controller — `callee` is the
 * last argument when it is a name, null for a handler written in place.
 * `page`: an element `{ path: '/cart', component: Cart }` of an array in a
 * `routes.{js,jsx,ts,tsx}` file (React Router, PWA Kit) — `label` is the
 * path, `callee` the component's name, `source` the module a lazy component
 * loads (`const Cart = loadable(() => import('./pages/cart'))`).
 */
export interface EntryFact {
  kind: "route" | "main" | "sfra" | "page";
  /** `sfra`: the action name, `Show`; the SFCC adapter adds the controller's. */
  label: string;
  /** `sfra`: the `server` method that registers it (`get`, `post`, `use`, `append`, `prepend`, `replace`). */
  method?: string;
  callee: string | null;
  /** `page`: the specifier the component's `import()` names, when it is loaded lazily. */
  source?: string;
  line: number;
  col: number;
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
  /**
   * Names the declaration reads as values that an import binds whose syntax
   * does not tell whether its target is in the repository (Python
   * `from app.limits import MAX`, PHP `use App\Limits`): the graph marks the
   * fingerprint as reading an imported value when such an import resolves to
   * a file of the repository. Absent when there are none.
   */
  readsImports?: string[];
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
   * Classes: the conflict rules of the PHP `use` block, traits as written: `T::m insteadof U, V`
   * (`insteadof`: U's and V's `m` are not the class's) and `T::m as alias` / `m as alias` (`alias`;
   * `trait` null when not named).
   */
  traitRules?: { trait: string | null; method: string; insteadof?: string[]; alias?: string }[];
  /**
   * Classes: the interfaces the class implements; interfaces: those it extends — as written
   * (PHP `implements A, B`, `interface I extends J`). A framework's interceptor on an
   * interface wraps the classes that implement it.
   */
  implements?: string[];
  /** The declaration's documentation comment without comment syntax, lines kept; absent when it has none. */
  doc?: string;
  /**
   * TypeScript decorators of a class or a member, in source order (`@Controller('orders')`,
   * `@Get(':id')`), and on a constructor those of its parameters (`@Inject(TOKEN)`, with
   * `param`). A framework adapter reads them as its configuration; absent without any.
   */
  decorators?: CodeDecorator[];
  /** PHP: the attributes written on the class or the method (`#[Route('/x', methods: ['POST'])]`), in order. A framework adapter reads them. */
  attributes?: AttributeFact[];
  /** PHP classes: the properties whose default value is a literal a framework reads (`protected $listen = [OrderPlaced::class => [...]]`). */
  properties?: PropertyFact[];
  /** PHP functions and methods: the parameters, when at least one is typed with a single class (`handle(OrderPlaced $event)`). */
  params?: ParamFact[];
  /** PHP functions and methods: the literal a body of one `return <literal>;` gives (`getSubscribedEvents`, `getFacadeAccessor`). */
  returns?: LiteralFact;
  /** Functions and methods: the class of the result as the declaration writes it (PHP `: Order`, `: static`, `@return Item[]`; TypeScript `: Order`, `: Promise<Order>`; Python `-> Order`). */
  result?: ResultTypeFact;
  /** PHP interfaces: their methods' result types (an interface's methods are no nodes). */
  methods?: MethodSigFact[];
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

/** PHP: one method of an interface (or of an `outside` class): its name and result type. */
export interface MethodSigFact {
  name: string;
  static?: true;
  result?: ResultTypeFact;
}

/** PHP: a property and the qualified class of its value (`element`: an array of them). */
export interface FieldFact {
  name: string;
  class: string;
  element?: true;
  docblock?: { line: number; col: number };
}


/**
 * A value whose class the graph reads from another declaration — the result of a call
 * (its declared result type), with `element` an element of the array it returns (PHP), with
 * `awaited` what the Promise it returns gives (TypeScript `await`).
 */
export interface ValueOfFact {
  call: ResultCallFact;
  element?: true;
  awaited?: true;
}

/** The call whose result a `ValueOfFact` is, written as `CallFact` writes a call. */
export interface ResultCallFact {
  callee: string;
  /** The member called: what the graph looks up in the receiver's class. */
  member: string;
  bound?: "parameter" | "local";
  receiver?: string;
  docblock?: { line: number; col: number };
  /** The receiver is itself the result of a call. */
  on?: ValueOfFact;
  opaque?: true;
  /** The arguments as literals, as `CallFact.args`: a framework's service locator reads the class the first one names (`get(X::class)`). */
  args?: ArgFact[];
}

/**
 * A value PHP code writes as a literal, as far as a framework adapter reads it
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

/** One argument of a call or an attribute: named (`methods: ['POST']`) or positional. */
export interface ArgFact {
  name?: string;
  value: LiteralFact;
}

/** `#[Name(args)]` on a declaration; `name` qualified as PHP resolves it. */
export interface AttributeFact {
  name: string;
  args: ArgFact[];
  line: number;
  col: number;
}

/** A class property with a literal default value. */
export interface PropertyFact {
  name: string;
  value: LiteralFact;
  line: number;
  col: number;
}

/** A parameter of a function; `type` is the qualified class when the parameter is typed with one. */
export interface ParamFact {
  name: string;
  type?: string;
}

/** One call of a chain `Route::prefix('admin')->name('a.')->group(…)`, root first; the root names its class when it is a static call. */
export interface ChainLinkFact {
  name: string;
  class?: string;
  args: ArgFact[];
}

/** One call written in the code, with its callee as written and its range. */
export interface CallFact {
  /**
   * `f()` → `f`; `a.b()` → `a.b`; `this.m()` → `this.m`; `new X()` → `X`;
   * `new ns.X()` → `ns.X`; `super()` → `super`. For an `opaque` call, the
   * callee's source text (at most 80 characters).
   */
  callee: string;
  /**
   * The callee is an expression archdiff does not name (`f()()`, `(a || b)()`,
   * `new (load())()`, a chain too long to read): never an edge, always a
   * `dynamic` gap. Every call in the code is an edge or a gap.
   */
  opaque?: true;
  /** The head of the callee is bound in a scope between the call and the module; for `this.m`, `this` is not the class. */
  bound?: "parameter" | "local";
  /**
   * Class of the receiver when the syntax names it: `this.decoder.feed()` with a
   * field `decoder: InputDecoder` or `= new InputDecoder()`, `worker.generate()`
   * with `const worker = new SnapshotWorker()` or a parameter `worker: SnapshotWorker`.
   */
  receiver?: string;
  /**
   * The receiver is a property the constructor fills from its parameter `param` (PHP
   * `$this->x = $x`, a promoted `private X $x`): a framework's config may set that argument.
   */
  param?: string;
  /**
   * The receiver's class is written in a docblock the language does not check (PHP `@var Foo`
   * above the property, `@param Foo $x` of the constructor parameter assigned to it), at this
   * position: the edge's provenance is `docblock`, not `syntactic`.
   */
  docblock?: { line: number; col: number };
  /** The callee is a hook with a default: `const generate = request.generate ?? generateMap; generate()`. */
  hook?: HookFact;
  /**
   * The callee is a local that a `require` or an `import()` in the function binds: the export `name` of the module
   * `source` names (`const { f } = await import("./x"); f()` is `f`; `const x = require("./x"); x.f()` is `f`;
   * `x()` is the module itself, `*`).
   */
  imported?: { source: string; name: string };
  /**
   * Function values the call passes: `analyze({ generate: worker.generate })`, `later(save)`,
   * and callable references — PHP `[$this, 'm']`, `'Cls::m'`, `\Closure::fromCallable(…)`,
   * `$this->m(...)`; TS `this.m.bind(this)`; Python `functools.partial(self.m)`; Rust `Self::m`.
   */
  passes?: PassFact[];
  /**
   * The first argument of a call a framework reads as a name (Magento
   * `$eventManager->dispatch('checkout_submit_all_after', …)`): `literal` is its
   * value when it is a string literal without interpolation, else null, and
   * `text` is its source (at most 80 characters). Recorded only for the members
   * `NAME_ARG_MEMBERS` lists.
   */
  nameArg?: { literal: string | null; text: string };
  /** The call sits in a function nested in the declaration: it runs when that value is called. */
  closure?: true;
  /**
   * Every function the call is nested in is a closure literal written as an argument of a call
   * (`run(() => hit())`, `items.map(fn($x) => $this->m($x))`): the enclosing call's callee holds
   * them, so the call is a possible route from the declaration. Position of the outermost such
   * closure. Absent when some enclosing closure is stored in a value (`const f = () => hit()`).
   */
  closureArg?: { line: number; col: number };
  /** PHP: every closure literal the call is nested in as an argument, outermost first, when there are two or more (`closureArg` is the first). */
  closures?: { line: number; col: number }[];
  /** PHP: the arguments as literals, when at least one is a literal a framework reads (a string, `X::class`, `new X`, an array, a closure). */
  args?: ArgFact[];
  /** PHP: a call on the result of other calls (`Route::prefix('admin')->group(…)`): the calls of the chain, root first, this one last. */
  chain?: ChainLinkFact[];
  /**
   * `setGlobalPrefix('api')`: the first argument of a call of a member named `setGlobalPrefix`
   * when it is a string literal; null when it is another expression. The NestJS adapter reads it
   * (the global route prefix).
   */
  literal?: string | null;
  /**
   * The receiver is a value whose class the code does not write here — the result of another
   * call (PHP `$this->repo()->save()`, `$x = $this->repo->get(); $x->save()`; TypeScript
   * `const s = makeStore(); s.save()`, `const s = await load()`), or an element of the array it
   * returns (PHP `foreach ($order->getItems() as $item)`). The graph reads the class from the
   * declared result type of that call's target.
   */
  on?: ValueOfFact;
  /** With `on`: the member called (an opaque `callee` does not end in it). */
  member?: string;
  /** The branches, loops and handlers the call sits in, outermost first (control.ts): a sequence draws calls under one guard as a fragment. */
  guards?: GuardFact[];
  line: number;
  col: number;
  endLine: number;
  endCol: number;
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
 * A callable chosen at run time with a default written next to it. `param` and
 * `path` say where a caller injects the value: `analyze({ generate })` is
 * parameter 0, path `generate`; `function f(run = defaultRun)` is parameter 0, path "".
 */
export interface HookFact {
  /** Local, parameter or field the call goes through. */
  name: string;
  /** Callee text of the default: `generateMap`, `this.run`. */
  fallback: string;
  /** Parameter index of the function that receives the injected value; null when it is not a parameter. */
  param: number | null;
  path: string;
  /** `self`: a parameter of the declaration itself; `constructor`: a field set from a constructor parameter. */
  owner: "self" | "constructor";
}

/**
 * A function value in the arguments of a call: argument index, property path
 * ("" for the argument itself). `callee` names it as a call would (`this.m`,
 * `Cls.m`, `save`); `text` is the argument as written (`[$this, 'm']`), at the
 * position. One passed as the argument itself is a `callable-arg` edge of the
 * enclosing fn when it resolves.
 */
export interface PassFact {
  arg: number;
  path: string;
  callee: string;
  bound?: "parameter" | "local";
  receiver?: string;
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
