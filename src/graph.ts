// Facts → graph: every file is a module in a layer, every declaration a
// node, every import a dependency, every call archdiff can follow a call
// edge. A call it cannot follow (a dynamic callee, a method on a value of
// unknown class) is a gap, counted and listed, never a guessed edge.
//
// Call resolution, in order: a call whose receiver type the extractor
// saw (`const s = new X(); s.m()`, a parameter or field typed `X`) → the
// member `m` of `X` (a class, interface or type the file declares or
// imports, base classes followed); `name` → a declaration of the same
// file, else an import binding → the export of the file it names
// (re-exports followed); `this.m` → a member of the enclosing class;
// `X.m` → a static or instance member of a class `X`, or an export `m` of
// a namespace import `X`; `new X().m` → a member of `X`.
//
// Pipeline: FileFacts[] + Config + resolver → Graph. Entry points:
// `buildGraph`, `nodeId`, `moduleOf`, and the types.

import type { Config } from "./config.ts";
import { layerOf } from "./config.ts";
import type { CallFact, DeclFact, FileFacts, GuardFact } from "./extract/facts.ts";
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
  /**
   * `dynamic`: a callee archdiff cannot name; `global`: a bare name the file neither
   * declares nor imports (`setTimeout`, `JSON.parse`); `member-of-value`: a member of a
   * local value whose type archdiff does not track (`list.map`, `req.on`);
   * `unknown-member`: a known class without that member; `interface`: a call through
   * an interface or type no class of the repository implements; `external`: a package
   * or built-in; `parse-error`: the file did not parse.
   */
  reason: "dynamic" | "global" | "member-of-value" | "unknown-member" | "interface" | "external" | "parse-error";
  line: number;
}

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

/** The reasons of a blind spot: a call into the repository archdiff could not follow — a computed callee, an unknown member, an interface. */
export const BLIND_SPOT_REASONS: ReadonlySet<Gap["reason"]> = new Set(["dynamic", "unknown-member", "interface"]);

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
  imports: Map<string, { target: Resolution; imported: string }>;
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

  private readonly nodes: Map<string, Declaration>;
  private readonly resolve: (from: string, specifier: string) => Resolution;

  constructor(facts: readonly FileFacts[], nodes: Map<string, Declaration>, resolve: (from: string, specifier: string) => Resolution) {
    this.nodes = nodes;
    this.resolve = resolve;

    for (const file of facts) {
      this.rows.set(file.path, new Map(file.exportRows.map((row) => [row.name, { local: row.local, from: row.from ?? null, form: row.form }])));
      this.reexportsAll.set(file.path, file.reexportsAll);
      const bindings = new Map<string, { source: string; imported: string }>();

      for (const fact of file.imports) for (const binding of fact.bindings) if (binding.kind === "named") bindings.set(binding.local, { source: fact.source, imported: binding.imported });
      this.importsOf.set(file.path, bindings);
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
    const module: Module = { id: file.path, layer: layerOf(file.path, b.config), decls, lines: file.endLine, opaque: file.completeness === "opaque" };

    if (file.doc) module.doc = file.doc;
    b.modules.set(file.path, module);
    b.scopes.set(file.path, { locals, imports: new Map() });
  }
}

/** Pass 2: imports become dependencies (on a module, a package or a built-in) and fill the scopes; an import of nothing known is recorded as unresolved. */
function bindImports(b: Building): void {
  for (const file of b.facts) {
    const scope = b.scopes.get(file.path)!;

    for (const fact of file.imports) {
      const target = b.resolve(file.path, fact.source);

      for (const binding of fact.bindings) {
        scope.imports.set(binding.local, { target, imported: binding.kind === "named" ? binding.imported : binding.kind === "default" ? "default" : "*" });
      }

      if (target.kind === "self") continue;

      if (target.kind === "file") {
        b.deps.push({ from: file.path, to: target.path, typeOnly: fact.typeOnly === true, reexport: fact.reexport, line: fact.line });
      } else if (target.kind === "package" || target.kind === "builtin") {
        const id = `${target.kind === "package" ? "pkg" : "node"}:${target.name}`;

        if (!b.externals.has(id)) b.externals.set(id, { id, kind: target.kind, name: target.name });
        b.deps.push({ from: file.path, to: id, typeOnly: fact.typeOnly === true, reexport: fact.reexport, line: fact.line });
      } else {
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

  constructor(b: Building, exports: ExportTable) {
    this.b = b;
    this.exports = exports;

    for (const file of b.facts) {
      const walkClasses = (decl: DeclFact, parent?: string): void => {
        if (decl.kind === "class") {
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

    if (!imported) return { gap: "global" };

    if (imported.target.kind !== "file") return { gap: "external" };
    // `const express = require("..")` then `express()`: the module binding stands for the module's default.
    const found = this.exports.find(imported.target.path, imported.imported === "*" ? "default" : imported.imported);

    return found ? { id: found } : { gap: "unknown-member" };
  }

  /** Where a call lands, by the form of its callee: `new X().m`, a member of a typed receiver, a plain name, `this.m`, `ns.f` or `x.m`. */
  resolve(module: string, enclosingClass: string | null, call: CallFact): CallTarget {
    if (call.opaque) return { gap: "dynamic" };
    const callee = call.callee;

    if (callee.startsWith("new ")) return this.constructedTarget(module, callee.slice(4));

    // The extractor names the receiver's type when it can see it: a local made with `new X()`, a parameter typed `X`,
    // a class field typed `X`. The member is then looked up on that class, interface or type.
    if (call.receiver && !callee.includes("(")) return this.receiverTarget(module, call.receiver, callee.slice(callee.lastIndexOf(".") + 1));

    // `expect(x).toBe`, `vi.mocked(f).mockReturnValue`: a method of a call's result, whose type is not tracked.
    if (callee.includes("(")) return { gap: "member-of-value" };
    const parts = callee.split(".");

    if (parts.length === 1) return this.nameTarget(module, callee);

    // `s.app.idle`, `this.state.records.at`, `[a].map`: a property of a property, or of a literal — a value whose type is not tracked.
    if (parts.length > 2 || parts[0]!.startsWith("[") || parts[0]!.startsWith("{")) return { gap: "member-of-value" };
    const [head, member] = parts as [string, string];

    return head === "this" || head === "super" ? this.ownMemberTarget(enclosingClass, member) : this.memberTarget(module, head, member);
  }

  /** `new X()` lands on X; `new X().m` on the member of X. */
  private constructedTarget(module: string, constructed: string): CallTarget {
    const [head, ...rest] = constructed.replace(/\(\)/g, "").split(".");
    const target = this.nameTarget(module, head!);

    if (!("id" in target) || rest.length === 0) return target;
    const member = this.memberOf(target.id, rest[rest.length - 1]!);

    return member ? { id: member } : { gap: "unknown-member" };
  }

  /**
   * A member of a receiver whose type the extractor saw: found on the type, else dispatched to every class of the
   * repository implementing or extending it (an interface, an abstract class), else a package's or a blind spot.
   */
  private receiverTarget(module: string, receiver: string, member: string): CallTarget {
    const owner = this.nameTarget(module, receiver);

    // A receiver typed with a package's class (`req: Request` of express) is a call out of the repository, not a blind spot.
    if (!("id" in owner)) return owner.gap === "global" ? { gap: "member-of-value" } : owner;
    const found = this.memberOf(owner.id, member);

    if (found) return { id: found };
    const dispatched = (this.implementers.get(owner.id) ?? []).map((id) => this.memberOf(id, member)).filter((id): id is string => id !== null);

    if (dispatched.length > 0) return { ids: dispatched };

    if (this.externalAncestor(owner.id)) return { gap: "external" };

    return { gap: this.b.nodes.get(owner.id)?.kind === "type" ? "interface" : "unknown-member" };
  }

  /** `this.m()` or `super.m()`: the member of the enclosing class, up its `extends` chain. */
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

    if (imported && imported.imported === "*") {
      if (imported.target.kind !== "file") return { gap: "external" };
      const found = this.exports.find(imported.target.path, member);

      return found ? { id: found } : { gap: "unknown-member" };
    }

    const owner = this.nameTarget(module, head);

    // `list.map`, `req.on`: the head is a value of the function, not a declaration or import.
    if (!("id" in owner)) return owner.gap === "global" ? { gap: "member-of-value" } : owner;
    const found = this.memberOf(owner.id, member);

    if (found) return { id: found };

    return this.externalAncestor(owner.id) ? { gap: "external" } : { gap: "unknown-member" };
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
    // The base class: the extractor records it by name on the class declaration.
    const base = this.declarationOf(owner)?.base;

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
    return this.b.facts.find((file) => file.path === node.module)?.decls.find((decl) => decl.name === node.name && (kind === undefined || decl.kind === kind));
  }

  /** A function read as a value is looked up like the head of a call, with no member; a dispatched call stands for its first target. */
  valueTarget(module: string, name: string): { id: string } | { gap: Gap["reason"] } {
    const target = this.resolve(module, null, { callee: name, line: 0, col: 0, endLine: 0, endCol: 0 });

    return "id" in target ? target : "ids" in target ? { id: target.ids[0]! } : target;
  }
}

/** Pass 3: the calls of every node (and of the module's top level) resolved against the scopes; a call not followed is a gap, a function read as a value a `ref`. */
function resolveCalls(b: Building, resolver: CallResolver): void {
  for (const file of b.facts) {
    const record = (from: string, call: CallFact): void => {
      const target = resolver.resolve(file.path, from.includes("#") ? classOf(b, from) : null, call);
      const edge = (to: string): CallEdge => (call.guards ? { from, to, kind: "call", line: call.line, guards: call.guards } : { from, to, kind: "call", line: call.line });

      if ("id" in target) b.calls.push(edge(target.id));
      else if ("ids" in target) for (const to of target.ids) b.calls.push(edge(to));
      else b.gaps.push({ from, callee: call.callee, reason: target.gap, line: call.line });
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
export function buildGraph(facts: readonly FileFacts[], config: Config, resolve: (from: string, specifier: string) => Resolution): Graph {
  const b: Building = { facts: [...facts].sort((a, c) => (a.path < c.path ? -1 : a.path > c.path ? 1 : 0)), config, resolve, modules: new Map(), nodes: new Map(), deps: [], calls: [], externals: new Map(), gaps: [], unresolvedImports: [], scopes: new Map() };
  declareModules(b);
  bindImports(b);
  const exports = new ExportTable(b.facts, b.nodes, resolve);
  const resolvedExports = new Map<string, Map<string, string>>();

  for (const file of b.facts) resolvedExports.set(file.path, exports.allOf(file.path));
  resolveCalls(b, new CallResolver(b, exports));
  const layers = [...new Set([...b.modules.values()].map((module) => module.layer))].sort();

  return { layers, modules: b.modules, nodes: b.nodes, deps: b.deps, calls: b.calls, externals: b.externals, gaps: b.gaps, unresolvedImports: b.unresolvedImports, resolvedExports };
}
