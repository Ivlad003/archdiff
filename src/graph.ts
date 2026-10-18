// Facts → graph: every file is a module in a layer, every declaration a
// node, every import a dependency, every call archdiff can follow a call
// edge. A call it cannot follow (a dynamic callee, a method on a value of
// unknown class) is a gap, counted and listed, never a guessed edge.
//
// A call is resolved by the form of its callee as the frontend read it
// (`Callee`, facts.ts), one way per form: a name → a declaration of the
// same file, else an import binding → the export of the file it names
// (re-exports and globs followed); `X.m` → a static or instance member of
// a class `X`, an export `m` of a namespace `X`, or a member of the class
// of a constant `X` made with `new` or by a call; `this.m` → a member of
// the enclosing class, `super.m` of the one it extends; a member of a
// value whose class the syntax names (`const s = new X(); s.m()`, a
// parameter or field typed `X`, `new X().m()`) → the member of `X` (a
// class, interface or type the file declares or imports, bases and traits
// followed; through an interface, every class implementing it); a member
// of what another call returns (`const s = makeStore(); s.m()`) → the
// member of the class the call's target declares as its result; a name a
// `require` or an `import()` of the function binds → that module's
// export. A callee bound in the body, a member of an untracked value, the
// language's own functions and an expression archdiff cannot name are
// gaps by their form.
//
// Pipeline: FileFacts[] + Config + resolver → Graph. Entry points:
// `buildGraph`, `nodeId`, `moduleOf`, and the types.

import type { Config } from "./config.ts";
import { layerOf } from "./config.ts";
import { dottedForm, type Callee, type CallFact, type DeclFact, type FileFacts, type GuardFact, type ValueOfFact } from "./extract/facts.ts";
import type { Resolution } from "./resolve.ts";

/** A file of the repository. */
export interface Module {
  /** The path, which is the ID. */
  id: string;
  layer: string;
  /** IDs of the top-level declarations, in source order. */
  decls: string[];
  doc?: string;
  lines: number;
  /** A syntax error or an unparsed file: its declaration list may be short. */
  opaque: boolean;
}

/** A declaration: a function, a class (with its members as further nodes) or a type. */
export interface Declaration {
  /** `<path>#<name>` or `<path>#<Class>.<member>`. */
  id: string;
  kind: "fn" | "class" | "type";
  name: string;
  module: string;
  /** The class of a member. */
  parent?: string;
  line: number;
  endLine: number;
  signature: string | null;
  exported: boolean;
  /** SHA-256 of the body without layout and comments: changes when the code does. */
  fingerprint?: string;
  doc?: string;
  /** A function: how many branching statements its body holds (`if`, `switch`, a loop, `try`); absent when none. */
  branches?: number;
}

/** An import of one module by another, or of a package or built-in. */
export interface Dependency {
  from: string;
  /** A module ID, or `pkg:<name>` / `node:<name>` for an external. */
  to: string;
  /** Only types cross: no runtime dependency. */
  typeOnly: boolean;
  reexport: boolean;
  line: number;
}

/** A resolved call (`call`) or a function passed as a value (`ref`), from a node (or a module's top level) to a node. */
export interface CallEdge {
  /** A node ID, or a module ID for a call at the module's top level. */
  from: string;
  to: string;
  kind: "call" | "ref";
  line: number;
  /** The branches, loops and handlers the call sits under, outermost first (a sequence draws them as fragments). */
  guards?: GuardFact[];
}

/** A call archdiff could not follow. */
export interface Gap {
  from: string;
  callee: string;
  /** Why, one of `GAP_REASONS`; a call through a parameter is `dynamic`: what it holds is the caller's. */
  reason: GapReason;
  line: number;
}

/**
 * Every reason a call is not followed, in one place: whether it is a blind
 * spot — a call into the repository's own code the diagrams count against
 * the calls they follow, as opposed to a call into a package or the
 * language, or a syntax error — and what the coverage report says of it.
 */
export const GAP_REASONS = {
  dynamic: { blind: true, text: "a callee archdiff cannot name (a computed or passed value): a blind spot" },
  "unknown-member": { blind: true, text: "a member of a class, module or value of the repository archdiff cannot find (a member the class lacks, an object literal's function): a blind spot" },
  interface: { blind: true, text: "a call through an interface or type no class of the repository implements (an object literal's function, a value injected from outside): a blind spot" },
  unresolved: { blind: true, text: "a name an import binds that resolves to no file (the import is listed below): a blind spot" },
  "member-of-value": { blind: false, text: "a method of a local value whose type is not tracked (list.map, req.on): mostly built-ins" },
  global: { blind: false, text: "a bare name the file neither declares nor imports (setTimeout, JSON.parse): a global" },
  local: { blind: false, text: "a function of the caller's own body (a nested function, a local arrow): its calls are the caller's already" },
  external: { blind: false, text: "a package or a Node built-in" },
  "parse-error": { blind: false, text: "a syntax error in the file" },
} as const satisfies Record<string, { blind: boolean; text: string }>;

export type GapReason = keyof typeof GAP_REASONS;

/** A package or built-in the code imports. */
export interface External {
  id: string;
  kind: "package" | "builtin";
  name: string;
}

/** The whole graph of one analysis: built once by `buildGraph`, read everywhere, changed nowhere (a view that needs more makes its own structures). */
export interface Graph {
  readonly layers: readonly string[];
  readonly modules: ReadonlyMap<string, Module>;
  readonly nodes: ReadonlyMap<string, Declaration>;
  readonly deps: readonly Dependency[];
  readonly calls: readonly CallEdge[];
  readonly externals: ReadonlyMap<string, External>;
  readonly gaps: readonly Gap[];
  /** Imports that resolve to no file, package or built-in, with the reason. */
  readonly unresolvedImports: readonly { from: string; specifier: string; reason: string; line: number }[];
  /** Per module, every exported name → the node it stands for, re-exports followed (`module.exports = require("./x")`, `export * from`). */
  readonly resolvedExports: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/** The reasons of a blind spot, as `GAP_REASONS` marks them. */
export const BLIND_SPOT_REASONS: ReadonlySet<GapReason> = new Set((Object.keys(GAP_REASONS) as GapReason[]).filter((reason) => GAP_REASONS[reason].blind));

/** A blind spot: a gap the diagrams count against the calls they follow (not a call into a package, not a syntax error). */
export function isBlindSpot(gap: Gap): boolean {
  return BLIND_SPOT_REASONS.has(gap.reason);
}

export function nodeId(module: string, name: string, parent?: string): string {
  return parent ? `${module}#${parent}.${name}` : `${module}#${name}`;
}

/** The module part of a node ID (or the ID itself for a module). */
export function moduleOf(id: string): string {
  const at = id.indexOf("#");

  return at === -1 ? id : id.slice(0, at);
}

/** What a file's local names stand for: its declarations and its imports. */
interface Scope {
  /** Local name → node ID of a top-level declaration. */
  locals: Map<string, string>;
  /** Local name → where it was imported from, and the name there (`*` for a namespace, `default` for the default). */
  /** `optional`: the specifier names a module only when it resolves to one (`new URL("./x", import.meta.url)`, a PHP class used by name). */
  imports: Map<string, { target: Resolution; imported: string; optional?: true }>;
  /** The modules whose every public name is in scope with no binding of its own (`from m import *`, `use m::*`). */
  globs: string[];
}

/** How many re-exports, `extends` or aliases a lookup follows before it gives up: a cycle, or a chain no code writes. */
const MAX_HOPS = 8;

/** The exports of every module: exported name → node ID, following re-exports. */
class ExportTable {
  private readonly rows = new Map<string, Map<string, { local: string | null; from: string | null; form: string | undefined }>>();
  private readonly reexportsAll = new Map<string, string[]>();
  /** Local name → the import that binds it, per module: an exported name that is an import is a re-export. */
  private readonly importsOf = new Map<string, Map<string, { source: string; imported: string }>>();
  /** Imports binding no name, per module (`module.exports = require("./x")`, a bare `require`). */
  private readonly bareImports = new Map<string, string[]>();
  /** Local name → the source of the namespace it binds (`import * as ns from "./x"`), per module. */
  private readonly namespaces = new Map<string, Map<string, string>>();

  private readonly nodes: Map<string, Declaration>;
  private readonly resolve: (from: string, specifier: string) => Resolution;

  constructor(facts: readonly FileFacts[], nodes: Map<string, Declaration>, resolve: (from: string, specifier: string) => Resolution) {
    this.nodes = nodes;
    this.resolve = resolve;

    for (const file of facts) {
      this.rows.set(file.path, new Map(file.exportRows.map((row) => [row.name, { local: row.local, from: row.from ?? null, form: row.form }])));
      this.reexportsAll.set(file.path, file.reexportsAll);
      const bindings = new Map<string, { source: string; imported: string }>();

      const spaces = new Map<string, string>();

      for (const fact of file.imports) {
        for (const binding of fact.bindings) {
          if (binding.kind === "named") bindings.set(binding.local, { source: fact.source, imported: binding.imported });
          else if (binding.kind === "module") spaces.set(binding.local, fact.source);
        }
      }

      this.importsOf.set(file.path, bindings);
      this.namespaces.set(file.path, spaces);
      this.bareImports.set(
        file.path,
        file.imports.filter((fact) => fact.bindings.length === 0 && (fact.source.startsWith(".") || fact.source.startsWith("/"))).map((fact) => fact.source),
      );
    }
  }

  /** The node `name` exported by `module`, or null; `*` names the module itself. */
  find(module: string, name: string, depth = 0): string | null {
    if (name === "*" || depth > MAX_HOPS) return null;
    const row = this.rows.get(module)?.get(name);

    if (row) {
      if (row.from !== null) {
        // `export { x } from "./y"`: the row names the source and its name there.
        const target = this.resolve(module, row.from);

        return target.kind === "file" ? this.find(target.path, row.local ?? name, depth + 1) : null;
      }

      // A row without a local name (Python, Rust, PHP) exports the name as declared.
      const local = row.local ?? name;
      const id = nodeId(module, local);

      if (this.nodes.has(id)) return id;
      // An exported name the file imported (`from .m import x` at the top of a package, `export { x }` after an import): one hop on.
      const bound = this.importsOf.get(module)?.get(local);

      if (bound) {
        const target = this.resolve(module, bound.source);

        if (target.kind === "file" && target.path !== module) return this.find(target.path, bound.imported, depth + 1);
      }

      return this.throughBareImport(module, name, depth);
    }

    // `export * from "./y"`: the name may come from any of them.
    for (const specifier of this.reexportsAll.get(module) ?? []) {
      const target = this.resolve(module, specifier);

      if (target.kind !== "file") continue;
      const found = this.find(target.path, name, depth + 1);

      if (found) return found;
    }

    return this.throughBareImport(module, name, depth);
  }

  /**
   * The module a name of `module` stands for when it is a namespace: `export * as ns from "./x"`, or an
   * `import * as ns` it exports (`export { ns }`), followed through re-exports; null for any other name.
   */
  namespaceOf(module: string, name: string, depth = 0): string | null {
    if (depth > MAX_HOPS) return null;
    const row = this.rows.get(module)?.get(name);

    if (!row) return null;

    if (row.form === "namespace" && row.from !== null) {
      const target = this.resolve(module, row.from);

      return target.kind === "file" ? target.path : null;
    }

    if (row.from !== null) {
      const target = this.resolve(module, row.from);

      return target.kind === "file" ? this.namespaceOf(target.path, row.local ?? name, depth + 1) : null;
    }

    const local = this.namespaces.get(module)?.get(row.local ?? name);

    if (local === undefined) return null;
    const target = this.resolve(module, local);

    return target.kind === "file" ? target.path : null;
  }

  /** Every exported name of `module` with its node: its own rows, then what `export *` and a bare re-export bring, depth-limited. */
  allOf(module: string, depth = 0): Map<string, string> {
    const out = new Map<string, string>();

    if (depth > MAX_HOPS) return out;

    for (const name of this.rows.get(module)?.keys() ?? []) {
      const found = this.find(module, name);

      if (found) out.set(name, found);
    }

    for (const specifier of [...(this.reexportsAll.get(module) ?? []), ...(this.bareImports.get(module) ?? [])]) {
      const target = this.resolve(module, specifier);

      if (target.kind !== "file" || target.path === module) continue;

      for (const [name, id] of this.allOf(target.path, depth + 1)) if (!out.has(name)) out.set(name, id);
    }

    return out;
  }

  /** `module.exports = require("./lib/x")`: every export of the file is the other file's; the import binds no name of its own. */
  private throughBareImport(module: string, name: string, depth: number): string | null {
    for (const specifier of this.bareImports.get(module) ?? []) {
      const target = this.resolve(module, specifier);

      if (target.kind !== "file" || target.path === module) continue;
      const found = this.find(target.path, name, depth + 1);

      if (found) return found;
    }

    return null;
  }
}

/** The graph while it is built, shared by the passes: the tables being filled and the scopes of every file. */
interface Building {
  /** The facts in path order, so every table is filled in a stable order. */
  facts: readonly FileFacts[];
  config: Config;
  resolve: (from: string, specifier: string) => Resolution;
  /** Whether a file's compiler keeps an import of type-only names (`import { type A } from`) as a runtime import. */
  keepsTypeImports: (file: string) => boolean;
  modules: Map<string, Module>;
  nodes: Map<string, Declaration>;
  deps: Dependency[];
  calls: CallEdge[];
  externals: Map<string, External>;
  gaps: Gap[];
  unresolvedImports: { from: string; specifier: string; reason: string; line: number }[];
  scopes: Map<string, Scope>;
}

/** Pass 1: every file is a module, every declaration (and member) a node, so calls across files can find their targets. */
function declareModules(b: Building): void {
  for (const file of b.facts) {
    const locals = new Map<string, string>();
    const decls: string[] = [];

    const addDecl = (decl: DeclFact, parent?: string): void => {
      const id = nodeId(file.path, decl.name, parent);
      const node: Declaration = { id, kind: decl.kind, name: decl.name, module: file.path, line: decl.line, endLine: decl.endLine, signature: decl.signature, exported: decl.exported };

      if (parent) node.parent = parent;

      if (decl.fingerprint) node.fingerprint = decl.fingerprint;

      if (decl.branches) node.branches = decl.branches;

      if (decl.doc) node.doc = decl.doc;
      b.nodes.set(id, node);

      if (!parent) {
        decls.push(id);
        locals.set(decl.name, id);
      }

      for (const member of decl.members) addDecl(member, parent ? `${parent}.${decl.name}` : decl.name);
    };

    for (const decl of file.decls) addDecl(decl);
    // The lines of the file as `wc -l` counts them: a file that ends with a newline ends at the start of a line no one wrote.
    const module: Module = { id: file.path, layer: layerOf(file.path, b.config), decls, lines: file.endCol === 1 ? file.endLine - 1 : file.endLine, opaque: file.completeness === "opaque" };

    if (file.doc) module.doc = file.doc;
    b.modules.set(file.path, module);
    b.scopes.set(file.path, { locals, imports: new Map(), globs: [] });
  }
}

/** Pass 2: imports become dependencies (on a module, a package or a built-in) and fill the scopes; an import of nothing known is recorded as unresolved. */
function bindImports(b: Building): void {
  for (const file of b.facts) {
    const scope = b.scopes.get(file.path)!;

    for (const fact of file.imports) {
      const target = b.resolve(file.path, fact.source);

      // A name that binds a module itself (Python's `from . import core`, Rust's `use crate::util`) is a namespace.
      const whole = target.kind === "file" && target.whole === true;

      for (const binding of fact.bindings) {
        const imported = binding.kind === "named" && !whole ? binding.imported : binding.kind === "default" ? "default" : "*";

        scope.imports.set(binding.local, fact.optional ? { target, imported, optional: true } : { target, imported });
      }

      if (fact.glob && target.kind === "file") scope.globs.push(target.path);

      // The file itself, or a file that is no source (JSON, a stylesheet): no module to draw, nothing missing.
      if (target.kind === "self" || target.kind === "asset") continue;
      // `import type`, or `import { type A }` that the compiler erases (it keeps it under `verbatimModuleSyntax`).
      const typeOnly = fact.typeOnly === true || (fact.inlineTypeOnly === true && !b.keepsTypeImports(file.path));

      if (target.kind === "file") {
        b.deps.push({ from: file.path, to: target.path, typeOnly, reexport: fact.reexport, line: fact.line });
      } else if (target.kind === "package" || target.kind === "builtin") {
        // A package by its name; a language's own library by the language: `node:fs`, `py:os`, `rust:std`, `php:strlen`.
        const id = `${target.kind === "package" ? "pkg" : target.runtime === undefined ? "node" : target.runtime === "python" ? "py" : target.runtime}:${target.name}`;

        if (!b.externals.has(id)) b.externals.set(id, { id, kind: target.kind, name: target.name });
        b.deps.push({ from: file.path, to: id, typeOnly, reexport: fact.reexport, line: fact.line });
      } else if (!fact.optional) {
        // An optional specifier (`new URL("./assets", import.meta.url)`) names a module only when it resolves to one.
        b.unresolvedImports.push({ from: file.path, specifier: fact.source, reason: target.reason, line: fact.line });
      }
    }
  }
}

/** Where a call lands: one node, several (a call through an interface, dispatched to every class implementing it), or a gap with its reason. */
type CallTarget = { id: string } | { ids: string[] } | { gap: Gap["reason"] };

/**
 * The resolver of calls: what a local name of a module stands for (a
 * declaration, or an import followed to its export), the member of a
 * class up its `extends` chain, the classes implementing a type, and
 * `resolve` itself, one method per form of callee.
 */
class CallResolver {
  private readonly b: Building;
  private readonly exports: ExportTable;
  /** The classes implementing or extending a type or class, by the names written on `implements`/`extends`, resolved in each class's own file. */
  private readonly implementers = new Map<string, string[]>();
  /** The facts of each file, by its path. */
  private readonly files = new Map<string, FileFacts>();

  constructor(b: Building, exports: ExportTable) {
    this.b = b;
    this.exports = exports;

    for (const file of b.facts) {
      this.files.set(file.path, file);
      // A class's `implements` and `extends`, and an interface's `extends` (`Store extends Repo`): who stands for whom.
      const walkClasses = (decl: DeclFact, parent?: string): void => {
        if (decl.kind === "class" || (decl.kind === "type" && decl.implements)) {
          const own = nodeId(file.path, decl.name, parent);

          for (const name of [...(decl.implements ?? []), ...(decl.base ? [decl.base] : [])]) {
            const target = this.nameTarget(file.path, name.replace(/<.*$/, ""));

            if ("id" in target) this.implementers.set(target.id, [...(this.implementers.get(target.id) ?? []), own]);
          }
        }

        for (const member of decl.members) walkClasses(member, parent ? `${parent}.${decl.name}` : decl.name);
      };

      for (const decl of file.decls) walkClasses(decl);
    }
  }

  /** The node a local name of `module` stands for: a declaration, or an import followed to its export. */
  nameTarget(module: string, name: string): { id: string } | { gap: Gap["reason"] } {
    const scope = this.b.scopes.get(module)!;
    const local = scope.locals.get(name);

    if (local) return { id: local };
    const imported = scope.imports.get(name);

    if (!imported) {
      // A name a glob import brings (`from .core import *`, `use crate::util::*`), else the language's or a value's.
      for (const glob of scope.globs) {
        const found = this.exports.find(glob, name);

        if (found) return { id: found };
      }

      return { gap: "global" };
    }

    // An import of the repository that resolves to no file hides what it calls; an optional specifier may name a package.
    if (imported.target.kind === "unresolved" && !imported.optional) return { gap: "unresolved" };

    if (imported.target.kind !== "file") return { gap: "external" };
    // `const express = require("..")` then `express()`: the module binding stands for the module's default.
    const found = this.exports.find(imported.target.path, imported.imported === "*" ? "default" : imported.imported);

    return found ? { id: found } : { gap: "unknown-member" };
  }

  /** Where a call lands, one way per form of its callee (`Callee`): a node, several, or a gap with its reason. */
  resolve(module: string, enclosingClass: string | null, form: Callee): CallTarget {
    switch (form.kind) {
      case "name":
        return this.nameTarget(module, form.name);
      case "member":
        return this.memberTarget(module, form.head, form.member);
      case "own":
        return this.ownMemberTarget(enclosingClass, form.member);
      case "super":
        return this.superMemberTarget(enclosingClass, form.member);
      // The member is looked up on the class, interface or type the syntax names for the receiver.
      case "typed":
        return this.receiverTarget(module, form.type, form.member);
      // `const s = makeStore(); s.save()`, PHP's `$this->repo()->save()`: a member of the class the other call's target
      // declares as its result.
      case "result": {
        const made = this.resultType(module, enclosingClass, form.of);

        return "id" in made ? this.typedMemberTarget(made.id, form.member) : made;
      }
      // `const { f } = await import("./x"); f()`, `const x = require("./x"); x.f()`: the export of the module the function loads.
      case "loaded":
        return this.loadedTarget(module, form);
      // A name bound between the call and the module — a parameter, a local, a nested function, a caught error — is not
      // the module's declaration of that name, though it is spelled so: never an edge to it. A parameter holds what the
      // caller passes (a blind spot); a local function's own calls are the enclosing function's already.
      case "bound":
        return { gap: form.binding === "parameter" ? "dynamic" : "local" };
      // `expect(x).toBe`, `list.map`, `this.state.records.at`: a method of a value whose type is not tracked.
      case "value":
        return { gap: "member-of-value" };
      // The `resolve` and `reject` a `new Promise` executor receives: the language's own functions.
      case "language":
        return { gap: "external" };
      case "opaque":
        return { gap: "dynamic" };
    }
  }

  /** The export `name` (`*`: the module itself, its default) of the module a function loads with `require` or `import()`. */
  private loadedTarget(module: string, imported: { source: string; name: string }): CallTarget {
    const resolution = this.b.resolve(module, imported.source);

    // A module archdiff could not find (the unresolved import names it) hides what it calls; a package's is the package's.
    if (resolution.kind === "unresolved") return { gap: "unresolved" };

    if (resolution.kind !== "file") return { gap: "external" };
    const found = this.exports.find(resolution.path, imported.name === "*" ? "default" : imported.name);

    return found ? { id: found } : { gap: "unknown-member" };
  }

  /** `super.m()`, PHP's `parent::m()`: the member of the class the enclosing class extends, up its chain — not the method that overrides it. */
  private superMemberTarget(enclosingClass: string | null, member: string): CallTarget {
    const owner = enclosingClass ? this.b.nodes.get(enclosingClass) : undefined;

    if (!owner) return { gap: "dynamic" };
    const base = this.declarationOf(owner, "class")?.base;

    if (!base) return { gap: "unknown-member" };
    const parent = this.nameTarget(owner.module, base.replace(/<.*$/, ""));

    // A base of a package's (`extends Component`): its member is the package's.
    if (!("id" in parent)) return parent.gap === "global" ? { gap: "unknown-member" } : parent;
    const found = this.memberOf(parent.id, member);

    if (found) return { id: found };

    return this.externalAncestor(parent.id) ? { gap: "external" } : { gap: "unknown-member" };
  }

  /**
   * A member of a receiver whose type the extractor saw: found on the type, else dispatched to every class of the
   * repository implementing or extending it (an interface, an abstract class), else a package's or a blind spot.
   */
  private receiverTarget(module: string, receiver: string, member: string): CallTarget {
    const owner = this.nameTarget(module, receiver);

    // A receiver typed with a package's class (`req: Request` of express) is a call out of the repository, not a blind spot.
    if (!("id" in owner)) return owner.gap === "global" ? { gap: "member-of-value" } : owner;

    // Python's `repo = make_repo()` names a function: the value is what it returns.
    if (this.b.nodes.get(owner.id)?.kind === "fn") {
      const made = this.declaredResult(owner.id, { call: { kind: "name", name: receiver } }, module);

      return made === null ? { gap: "member-of-value" } : this.typedMemberTarget(made, member);
    }

    return this.typedMemberTarget(owner.id, member);
  }

  /**
   * A member of a value of a class or type: found on it (its bases and traits followed), else dispatched to every
   * class of the repository implementing or extending it (an interface, an abstract class), else a package's or a
   * blind spot.
   */
  private typedMemberTarget(typeId: string, member: string): CallTarget {
    const found = this.memberOf(typeId, member);

    if (found) return { id: found };
    const dispatched = [...new Set(this.implementersOf(typeId).map((id) => this.memberOf(id, member)).filter((id): id is string => id !== null))];

    if (dispatched.length > 0) return { ids: dispatched };

    if (this.externalAncestor(typeId)) return { gap: "external" };

    return { gap: this.b.nodes.get(typeId)?.kind === "type" ? "interface" : "unknown-member" };
  }

  /**
   * The class or type of what a call returns, as its target declares the result (`: Store`, `: Promise<Store>`
   * awaited, PHP's `: Svc`, `self`, `@return Item[]` iterated). A call into a package gives a package's value; a call
   * not followed, or a target that declares no class, a value whose type is not tracked.
   */
  private resultType(module: string, enclosingClass: string | null, value: ValueOfFact): { id: string } | { gap: Gap["reason"] } {
    const { call } = value;
    // The call itself is resolved as any call is; nesting is bounded by the expression it is written in.
    const target = this.resolve(module, enclosingClass, call);

    // A link of a chain written inline (PHP `$a()->b()->c()`) that is not followed hides the rest of the chain.
    if ("gap" in target) return target.gap === "external" ? target : { gap: call.kind === "result" && call.inline ? "dynamic" : "member-of-value" };
    const targets = "id" in target ? [target.id] : target.ids;
    // A call dispatched to several implementers: their results must agree on one class.
    const made = new Set(targets.map((id) => this.declaredResult(id, value, module)));

    return made.size === 1 && !made.has(null) ? { id: [...made][0]! } : { gap: "member-of-value" };
  }

  /**
   * The class a call of the declaration `id` gives, as the declaration writes its result: null when it names none, or
   * the value is something else (a Promise not awaited, an array not iterated, an element of no array). Calling a
   * class (Python's `Repo()`) gives an instance of it.
   */
  private declaredResult(id: string, value: ValueOfFact, module: string): string | null {
    const node = this.b.nodes.get(id);

    if (node?.kind === "class") return value.element ? null : id;
    const result = node?.kind === "fn" ? this.factOf(node)?.result : undefined;

    if (!node || !result || Boolean(result.element) !== Boolean(value.element) || (result.promise && !value.awaited)) return null;

    // `self` is the declaring class; `static` the class the call names (`Order::query()`), else the declaring one.
    if (result.self) {
      const named = result.self === "static" ? this.staticClass(module, value.call) : null;

      return named ?? classOf(this.b, id);
    }

    return result.class ? this.typeNamed(node.module, result.class) : null;
  }

  /** The class a static call names (`Order.query` of `Order::query()`); null for a call through a value, `this` or a plain function. */
  private staticClass(module: string, call: Callee): string | null {
    const target = call.kind === "member" ? this.nameTarget(module, call.head) : null;

    return target && "id" in target && this.b.nodes.get(target.id)?.kind === "class" ? target.id : null;
  }

  /** The class or type `name` stands for in `module`: as written (TypeScript, Python), or qualified (PHP's `App\Models\Order`, through the resolver). */
  private typeNamed(module: string, name: string): string | null {
    const short = name.slice(name.lastIndexOf("\\") + 1);
    const resolution = name.includes("\\") ? this.b.resolve(module, name) : null;
    const found = resolution?.kind === "file" ? this.exports.find(resolution.path, short) : null;
    const target = found ? { id: found } : this.nameTarget(module, short);
    const kind = "id" in target ? this.b.nodes.get(target.id)?.kind : undefined;

    return "id" in target && (kind === "class" || kind === "type") ? target.id : null;
  }

  /** The declaration fact of a node, a member's (`Class.method`) too. */
  private factOf(node: Declaration): DeclFact | undefined {
    let decls = this.files.get(node.module)?.decls;
    let found: DeclFact | undefined;

    for (const name of [...(node.parent ? node.parent.split(".") : []), node.name]) {
      found = decls?.find((decl) => decl.name === name);
      decls = found?.members;
    }

    return found;
  }

  /** The classes that implement or extend a type or class — directly, or through an interface that extends it. */
  private implementersOf(id: string, seen = new Set<string>([id])): string[] {
    const classes: string[] = [];

    for (const each of this.implementers.get(id) ?? []) {
      if (seen.has(each)) continue;
      seen.add(each);

      if (this.b.nodes.get(each)?.kind === "class") classes.push(each);
      classes.push(...this.implementersOf(each, seen));
    }

    return classes;
  }

  /** `this.m()`: the member of the enclosing class, up its `extends` chain. */
  private ownMemberTarget(enclosingClass: string | null, member: string): CallTarget {
    if (!enclosingClass) return { gap: "dynamic" };
    const found = this.memberOf(enclosingClass, member);

    if (found) return { id: found };

    // `$this->assertSame()` in a test extending PHPUnit's TestCase, `this.setState()` in a React component: the package's member.
    return this.externalAncestor(enclosingClass) ? { gap: "external" } : { gap: "unknown-member" };
  }

  /** `ns.f` of a namespace import (the export `f`), or `x.m` of a declaration or an import (its member). */
  private memberTarget(module: string, head: string, member: string): CallTarget {
    const imported = this.b.scopes.get(module)!.imports.get(head);
    // A namespace by its name: `import * as ns`, or a name the source exports as one (`export * as ns from "./x"`).
    const space = !imported || imported.target.kind !== "file" ? null : imported.imported === "*" ? imported.target.path : this.exports.namespaceOf(imported.target.path, imported.imported);

    if (imported && (imported.imported === "*" || space !== null)) {
      if (space === null) return { gap: imported.target.kind === "unresolved" && !imported.optional ? "unresolved" : "external" };
      const found = this.exports.find(space, member);

      return found ? { id: found } : { gap: "unknown-member" };
    }

    const owner = this.nameTarget(module, head);

    if (!("id" in owner)) {
      // `store.save()` of `const store = new Store()` (or `= createStore()`), here or imported: the member of its class.
      const made = this.instanceClass(module, head);

      if (made !== null) return "id" in made ? this.typedMemberTarget(made.id, member) : made;

      // `list.map`, `req.on`: the head is a value of the function, not a declaration or import.
      return owner.gap === "global" ? { gap: "member-of-value" } : owner;
    }

    const found = this.memberOf(owner.id, member);

    if (found) return { id: found };

    return this.externalAncestor(owner.id) ? { gap: "external" } : { gap: "unknown-member" };
  }

  /**
   * The class of a constant holding an instance that `name` stands for in `module` — its own, or one it imports: the
   * class `new` names, or the result of the call that made it (a gap when that call says no class). Null when `name`
   * is no such constant.
   */
  private instanceClass(module: string, name: string, depth = 0): { id: string } | { gap: Gap["reason"] } | null {
    if (depth > MAX_HOPS) return null;
    const own = this.files.get(module)?.instances?.find((instance) => instance.name === name);

    if (own && "of" in own) return this.resultType(module, null, own.of);

    if (own) {
      const made = this.nameTarget(module, own.class);

      // A value of the language's (`new Map()`, an array) or of a package's class: its members are theirs.
      if (!("id" in made)) return made.gap === "global" ? { gap: "member-of-value" } : made.gap === "external" ? made : null;

      return this.b.nodes.get(made.id)?.kind === "class" ? made : null;
    }

    const imported = this.b.scopes.get(module)?.imports.get(name);

    return imported && imported.target.kind === "file" && imported.imported !== "*" ? this.instanceClass(imported.target.path, imported.imported, depth + 1) : null;
  }

  /** The member `member` of class node `classId`, searching the class and the classes it extends (and what a type alias names). */
  private memberOf(classId: string, member: string, depth = 0): string | null {
    const owner = this.b.nodes.get(classId);

    if (!owner || depth > MAX_HOPS) return null;

    // `type Alias = Repo`: the member of what the alias names.
    if (owner.kind === "type" && owner.signature?.startsWith("= ")) {
      const target = this.nameTarget(owner.module, owner.signature.slice(2).replace(/<.*$/, "").trim());

      return "id" in target ? this.memberOf(target.id, member, depth + 1) : null;
    }

    const direct = nodeId(owner.module, member, owner.parent ? `${owner.parent}.${owner.name}` : owner.name);

    if (this.b.nodes.has(direct)) return direct;
    const fact = this.declarationOf(owner);

    // PHP: a trait the class uses (`use Logs;`) — its methods are the class's own, found before the base's.
    for (const name of fact?.traits ?? []) {
      const trait = this.nameTarget(owner.module, name);
      const found = "id" in trait ? this.memberOf(trait.id, member, depth + 1) : null;

      if (found) return found;
    }

    // The base class: the extractor records it by name on the class declaration.
    const base = fact?.base;

    if (!base) return null;
    const baseTarget = this.nameTarget(owner.module, base);

    return "id" in baseTarget ? this.memberOf(baseTarget.id, member, depth + 1) : null;
  }

  /** Whether a class (or a class up its `extends` chain) extends something outside the repository: a member not found on it is the package's. */
  private externalAncestor(classId: string, depth = 0): boolean {
    const owner = this.b.nodes.get(classId);

    if (!owner || depth > MAX_HOPS) return false;
    const base = this.declarationOf(owner, "class")?.base;

    if (!base) return false;
    const target = this.nameTarget(owner.module, base.replace(/<.*$/, ""));

    return "id" in target ? this.externalAncestor(target.id, depth + 1) : target.gap === "external";
  }

  /** The top-level declaration fact of a node, by its module and name (of a kind, when given). */
  private declarationOf(node: Declaration, kind?: DeclFact["kind"]): DeclFact | undefined {
    return this.files.get(node.module)?.decls.find((decl) => decl.name === node.name && (kind === undefined || decl.kind === kind));
  }

  /** A function read as a value (`save`, `mod.save`) is looked up as a callee written so; a dispatched call stands for its first target. */
  valueTarget(module: string, name: string): { id: string } | { gap: Gap["reason"] } {
    const target = this.resolve(module, null, dottedForm(name));

    return "id" in target ? target : "ids" in target ? { id: target.ids[0]! } : target;
  }
}

/** Pass 3: the calls of every node (and of the module's top level) resolved against the scopes; a call not followed is a gap, a function read as a value a `ref`. */
function resolveCalls(b: Building, resolver: CallResolver): void {
  for (const file of b.facts) {
    const record = (from: string, call: CallFact): void => {
      const target = resolver.resolve(file.path, from.includes("#") ? classOf(b, from) : null, call.form);
      const edge = (to: string): CallEdge => (call.guards ? { from, to, kind: "call", line: call.line, guards: call.guards } : { from, to, kind: "call", line: call.line });

      if ("id" in target) b.calls.push(edge(target.id));
      else if ("ids" in target) for (const to of target.ids) b.calls.push(edge(to));
      else b.gaps.push({ from, callee: call.callee, reason: target.gap, line: call.line });

      // A function the call is handed (`list.forEach(save)`, `setTimeout(this.tick)`, `{ onDone: finish }`): whoever
      // holds it may call it — a `ref` of the function passing it, as a function read at the top level is the module's.
      for (const pass of call.passes ?? []) {
        const passed = resolver.resolve(file.path, from.includes("#") ? classOf(b, from) : null, pass.form);

        if ("id" in passed && b.nodes.get(passed.id)?.kind === "fn" && passed.id !== from) b.calls.push({ from, to: passed.id, kind: "ref", line: pass.line });
      }
    };

    const walk = (decl: DeclFact, parent: string | null): void => {
      const id = nodeId(file.path, decl.name, parent ?? undefined);

      for (const call of decl.calls) record(id, call);

      for (const member of decl.members) walk(member, parent ? `${parent}.${decl.name}` : decl.name);
    };

    for (const decl of file.decls) walk(decl, null);

    for (const call of file.moduleCalls) record(file.path, call);

    // A function read as a value (`later(save)`, `{ save }`): it may be called by whoever holds it.
    for (const ref of file.valueRefs) {
      if (ref.member) continue;
      const target = resolver.valueTarget(file.path, ref.name);

      if ("id" in target && b.nodes.get(target.id)?.kind === "fn") b.calls.push({ from: file.path, to: target.id, kind: "ref", line: ref.line });
    }

    if (file.parseError) b.gaps.push({ from: file.path, callee: "", reason: "parse-error", line: file.parseError.line });
  }
}

/** The class a node sits in (`path#Class.method` → `path#Class`, a class itself → itself); null for a plain function. */
function classOf(b: Building, id: string): string | null {
  const node = b.nodes.get(id);

  if (!node) return null;

  if (node.kind === "class") return id;

  if (!node.parent) return null;
  const owner = nodeId(node.module, node.parent.includes(".") ? node.parent.slice(node.parent.lastIndexOf(".") + 1) : node.parent, node.parent.includes(".") ? node.parent.slice(0, node.parent.lastIndexOf(".")) : undefined);

  return b.nodes.get(owner)?.kind === "class" ? owner : classOf(b, owner);
}

/** Builds the graph of the repository from the facts of every file: three passes over the files in path order. */
export function buildGraph(facts: readonly FileFacts[], config: Config, resolve: (from: string, specifier: string) => Resolution, keepsTypeImports: (file: string) => boolean = () => false): Graph {
  const b: Building = { facts: [...facts].sort((a, c) => (a.path < c.path ? -1 : a.path > c.path ? 1 : 0)), config, resolve, keepsTypeImports, modules: new Map(), nodes: new Map(), deps: [], calls: [], externals: new Map(), gaps: [], unresolvedImports: [], scopes: new Map() };
  declareModules(b);
  bindImports(b);
  const exports = new ExportTable(b.facts, b.nodes, resolve);
  const resolvedExports = new Map<string, Map<string, string>>();

  for (const file of b.facts) resolvedExports.set(file.path, exports.allOf(file.path));
  resolveCalls(b, new CallResolver(b, exports));
  const layers = [...new Set([...b.modules.values()].map((module) => module.layer))].sort();

  return { layers, modules: b.modules, nodes: b.nodes, deps: b.deps, calls: b.calls, externals: b.externals, gaps: b.gaps, unresolvedImports: b.unresolvedImports, resolvedExports };
}
