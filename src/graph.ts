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
import type { CallFact, DeclFact, FileFacts } from "./extract/facts.ts";
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
export interface GraphNode {
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

/** The whole graph of one analysis. */
export interface Graph {
  layers: string[];
  modules: Map<string, Module>;
  nodes: Map<string, GraphNode>;
  deps: Dependency[];
  calls: CallEdge[];
  externals: Map<string, External>;
  gaps: Gap[];
  /** Imports that resolve to no file, package or built-in, with the reason. */
  unresolvedImports: { from: string; specifier: string; reason: string; line: number }[];
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

/** The exports of every module: exported name → node ID, following re-exports. */
class ExportTable {
  private readonly rows = new Map<string, Map<string, { local: string | null; from: string | null; form: string | undefined }>>();
  private readonly reexportsAll = new Map<string, string[]>();

  private readonly nodes: Map<string, GraphNode>;
  private readonly resolve: (from: string, specifier: string) => Resolution;

  constructor(facts: readonly FileFacts[], nodes: Map<string, GraphNode>, resolve: (from: string, specifier: string) => Resolution) {
    this.nodes = nodes;
    this.resolve = resolve;

    for (const file of facts) {
      this.rows.set(file.path, new Map(file.exportRows.map((row) => [row.name, { local: row.local, from: row.from ?? null, form: row.form }])));
      this.reexportsAll.set(file.path, file.reexportsAll);
    }
  }

  /** The node `name` exported by `module`, or null; `*` names the module itself. */
  find(module: string, name: string, depth = 0): string | null {
    if (name === "*" || depth > 8) return null;
    const row = this.rows.get(module)?.get(name);

    if (row) {
      if (row.from !== null) {
        // `export { x } from "./y"`: the row names the source and its name there.
        const target = this.resolve(module, row.from);

        return target.kind === "file" ? this.find(target.path, row.local ?? name, depth + 1) : null;
      }

      if (row.local !== null) {
        const id = nodeId(module, row.local);

        if (this.nodes.has(id)) return id;
      }

      return null;
    }

    // `export * from "./y"`: the name may come from any of them.
    for (const specifier of this.reexportsAll.get(module) ?? []) {
      const target = this.resolve(module, specifier);

      if (target.kind !== "file") continue;
      const found = this.find(target.path, name, depth + 1);

      if (found) return found;
    }

    return null;
  }
}

/** Builds the graph of the repository from the facts of every file. */
export function buildGraph(facts: readonly FileFacts[], config: Config, resolve: (from: string, specifier: string) => Resolution): Graph {
  const modules = new Map<string, Module>();
  const nodes = new Map<string, GraphNode>();
  const deps: Dependency[] = [];
  const calls: CallEdge[] = [];
  const externals = new Map<string, External>();
  const gaps: Gap[] = [];
  const unresolvedImports: Graph["unresolvedImports"] = [];
  const scopes = new Map<string, Scope>();
  const sorted = [...facts].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Pass 1: modules and nodes, so calls across files can find their targets.
  for (const file of sorted) {
    const locals = new Map<string, string>();
    const decls: string[] = [];

    const addDecl = (decl: DeclFact, parent?: string): void => {
      const id = nodeId(file.path, decl.name, parent);
      const node: GraphNode = { id, kind: decl.kind, name: decl.name, module: file.path, line: decl.line, endLine: decl.endLine, signature: decl.signature, exported: decl.exported };

      if (parent) node.parent = parent;

      if (decl.fingerprint) node.fingerprint = decl.fingerprint;

      if (decl.doc) node.doc = decl.doc;
      nodes.set(id, node);

      if (!parent) {
        decls.push(id);
        locals.set(decl.name, id);
      }

      for (const member of decl.members) addDecl(member, parent ? `${parent}.${decl.name}` : decl.name);
    };

    for (const decl of file.decls) addDecl(decl);
    const module: Module = { id: file.path, layer: layerOf(file.path, config), decls, lines: file.endLine, opaque: file.completeness === "opaque" };

    if (file.doc) module.doc = file.doc;
    modules.set(file.path, module);
    scopes.set(file.path, { locals, imports: new Map() });
  }

  // Pass 2: imports become dependencies and fill the scopes.
  for (const file of sorted) {
    const scope = scopes.get(file.path)!;

    for (const fact of file.imports) {
      const target = resolve(file.path, fact.source);

      for (const binding of fact.bindings) {
        scope.imports.set(binding.local, { target, imported: binding.kind === "named" ? binding.imported : binding.kind === "default" ? "default" : "*" });
      }

      if (target.kind === "file") {
        deps.push({ from: file.path, to: target.path, typeOnly: fact.typeOnly === true, reexport: fact.reexport, line: fact.line });
      } else if (target.kind === "package" || target.kind === "builtin") {
        const id = `${target.kind === "package" ? "pkg" : "node"}:${target.name}`;

        if (!externals.has(id)) externals.set(id, { id, kind: target.kind, name: target.name });
        deps.push({ from: file.path, to: id, typeOnly: fact.typeOnly === true, reexport: fact.reexport, line: fact.line });
      } else {
        unresolvedImports.push({ from: file.path, specifier: fact.source, reason: target.reason, line: fact.line });
      }
    }
  }

  const exports = new ExportTable(sorted, nodes, resolve);

  // The node a local name of `module` stands for: a declaration, or an import followed to its export.
  const nameTarget = (module: string, name: string): { id: string } | { gap: Gap["reason"] } => {
    const scope = scopes.get(module)!;
    const local = scope.locals.get(name);

    if (local) return { id: local };
    const imported = scope.imports.get(name);

    if (!imported) return { gap: "global" };

    if (imported.target.kind !== "file") return { gap: "external" };
    const found = exports.find(imported.target.path, imported.imported);

    return found ? { id: found } : { gap: "unknown-member" };
  };

  // The member `member` of class node `classId`, searching the class and the classes it extends.
  const memberOf = (classId: string, member: string, depth = 0): string | null => {
    const owner = nodes.get(classId);

    if (!owner || depth > 8) return null;

    // `type Alias = Repo`: the member of what the alias names.
    if (owner.kind === "type" && owner.signature?.startsWith("= ")) {
      const target = nameTarget(owner.module, owner.signature.slice(2).replace(/<.*$/, "").trim());

      return "id" in target ? memberOf(target.id, member, depth + 1) : null;
    }
    const direct = nodeId(owner.module, member, owner.parent ? `${owner.parent}.${owner.name}` : owner.name);

    if (nodes.has(direct)) return direct;
    // The base class: the extractor records it by name on the class declaration.
    const base = facts.find((file) => file.path === owner.module)?.decls.find((decl) => decl.name === owner.name)?.base;

    if (!base) return null;
    const baseTarget = nameTarget(owner.module, base);

    return "id" in baseTarget ? memberOf(baseTarget.id, member, depth + 1) : null;
  };

  // Pass 3: calls of every node (and the module's top level) resolved against the scopes.
  // The classes implementing or extending a type or class, by the names written on `implements`/`extends`, resolved in each class's own file.
  const implementerIndex = new Map<string, string[]>();

  for (const file of sorted) {
    const walkClasses = (decl: DeclFact, parent?: string): void => {
      if (decl.kind === "class") {
        const own = nodeId(file.path, decl.name, parent);

        for (const name of [...(decl.implements ?? []), ...(decl.base ? [decl.base] : [])]) {
          const target = nameTarget(file.path, name.replace(/<.*$/, ""));

          if ("id" in target) implementerIndex.set(target.id, [...(implementerIndex.get(target.id) ?? []), own]);
        }
      }

      for (const member of decl.members) walkClasses(member, parent ? `${parent}.${decl.name}` : decl.name);
    };

    for (const decl of file.decls) walkClasses(decl);
  }

  const implementers = (id: string): string[] => implementerIndex.get(id) ?? [];

  const resolveCall = (module: string, enclosingClass: string | null, call: CallFact): { id: string } | { ids: string[] } | { gap: Gap["reason"] } => {
    if (call.opaque) return { gap: "dynamic" };
    const callee = call.callee;

    if (callee.startsWith("new ")) {
      // `new X().m`: the member of X.
      const [head, ...rest] = callee.slice(4).replace(/\(\)/g, "").split(".");
      const target = nameTarget(module, head!);

      if (!("id" in target)) return target;

      if (rest.length === 0) return target;
      const member = memberOf(target.id, rest[rest.length - 1]!);

      return member ? { id: member } : { gap: "unknown-member" };
    }

    // The extractor names the receiver's type when it can see it: a local made with `new X()`, a parameter typed `X`,
    // a class field typed `X`. The member is then looked up on that class, interface or type.
    if (call.receiver && !callee.includes("(")) {
      const parts = callee.split(".");
      const member = parts[parts.length - 1]!;
      const owner = nameTarget(module, call.receiver);

      // A receiver typed with a package's class (`req: Request` of express) is a call out of the repository, not a blind spot.
      if (!("id" in owner)) return owner.gap === "global" ? { gap: "member-of-value" } : owner;
      const found = memberOf(owner.id, member);

      if (found) return { id: found };
      // An interface or abstract class: the member of every class of the repository that implements or extends it.
      const dispatched = implementers(owner.id).map((id) => memberOf(id, member)).filter((id): id is string => id !== null);

      if (dispatched.length > 0) return { ids: dispatched };

      return { gap: nodes.get(owner.id)?.kind === "type" ? "interface" : "unknown-member" };
    }

    // `expect(x).toBe`, `vi.mocked(f).mockReturnValue`: a method of a call's result, whose type is not tracked.
    if (callee.includes("(")) return { gap: "member-of-value" };
    const parts = callee.split(".");

    if (parts.length === 1) return nameTarget(module, callee);

    // `s.app.idle`, `this.state.records.at`, `[a].map`: a property of a property, or of a literal — a value whose type is not tracked.
    if (parts.length > 2 || parts[0]!.startsWith("[") || parts[0]!.startsWith("{")) return { gap: "member-of-value" };

    if (parts[0] === "this" || parts[0] === "super") {
      if (!enclosingClass) return { gap: "dynamic" };
      const member = memberOf(enclosingClass, parts[1]!);

      return member ? { id: member } : { gap: "unknown-member" };
    }

    const [head, member] = parts as [string, string];
    const scope = scopes.get(module)!;
    const imported = scope.imports.get(head);

    // `ns.f` of a namespace import: the export `f`.
    if (imported && imported.imported === "*") {
      if (imported.target.kind !== "file") return { gap: "external" };
      const found = exports.find(imported.target.path, member);

      return found ? { id: found } : { gap: "unknown-member" };
    }

    const owner = nameTarget(module, head);

    // `list.map`, `req.on`: the head is a value of the function, not a declaration or import.
    if (!("id" in owner)) return owner.gap === "global" ? { gap: "member-of-value" } : owner;
    const found = memberOf(owner.id, member);

    return found ? { id: found } : { gap: "unknown-member" };
  };

  for (const file of sorted) {
    const walk = (decl: DeclFact, parent: string | null, enclosingClass: string | null): void => {
      const id = nodeId(file.path, decl.name, parent ?? undefined);
      const ownClass = decl.kind === "class" ? id : enclosingClass;

      for (const call of decl.calls) {
        const target = resolveCall(file.path, ownClass, call);

        if ("id" in target) calls.push({ from: id, to: target.id, kind: "call", line: call.line });
        else if ("ids" in target) for (const to of target.ids) calls.push({ from: id, to, kind: "call", line: call.line });
        else gaps.push({ from: id, callee: call.callee, reason: target.gap, line: call.line });
      }

      for (const member of decl.members) walk(member, parent ? `${parent}.${decl.name}` : decl.name, ownClass);
    };

    for (const decl of file.decls) walk(decl, null, null);

    for (const call of file.moduleCalls) {
      const target = resolveCall(file.path, null, call);

      if ("id" in target) calls.push({ from: file.path, to: target.id, kind: "call", line: call.line });
      else if ("ids" in target) for (const to of target.ids) calls.push({ from: file.path, to, kind: "call", line: call.line });
      else gaps.push({ from: file.path, callee: call.callee, reason: target.gap, line: call.line });
    }

    // A function read as a value (`later(save)`, `{ save }`): it may be called by whoever holds it.
    for (const ref of file.valueRefs) {
      if (ref.member) continue;
      const target = nameTarget(file.path, ref.name);

      if ("id" in target && nodes.get(target.id)?.kind === "fn") calls.push({ from: file.path, to: target.id, kind: "ref", line: ref.line });
    }

    if (file.parseError) gaps.push({ from: file.path, callee: "", reason: "parse-error", line: file.parseError.line });
  }

  const layers = [...new Set([...modules.values()].map((module) => module.layer))].sort();

  return { layers, modules, nodes, deps, calls, externals, gaps, unresolvedImports };
}
