// Rust facts: items, `impl` members, `use` trees, calls. A `use` leaf is one
// import whose specifier is the full path (`crate::domain::order::place`);
// the resolver decides how much of it is a module. Calls through values,
// traits and macros are not guessed: they stay holes in coverage. Every call
// expression is an edge or a hole: a callee archdiff cannot name is a call
// through a value, never dropped.
//
// The Rust frontend of the code pipeline (source → FileFacts → graph):
// parses one file with tree-sitter and returns its `FileFacts`.
// Entry point: `extractRust`. Terms: decl (an item archdiff indexes), hole (an
// unsupported fact or an unresolved call), value ref (a fn read as a value,
// so something else may call it), pass (a fn path given as an argument).

import type { CallFact, DeclFact, ExportRow, FileFacts, ImportFact, PassFact, UnsupportedFact, ValueRefFact } from "./facts.ts";
import { blockCommentBody, isLicense, lineCommentsBody, nonEmpty } from "./doc-comments.ts";
import { errorLine, fingerprintFacts, located, valuesFingerprint, withTree, type Node } from "./treesitter.ts";

/** Macros of `std` and common logging: they expand to calls archdiff need not follow. */
const KNOWN_MACROS = new Set(
  "assert assert_eq assert_ne debug_assert debug_assert_eq debug_assert_ne cfg column compile_error concat dbg env eprint eprintln file format format_args include include_bytes include_str line matches module_path option_env panic print println stringify thread_local todo unimplemented unreachable vec write writeln trace debug info warn error anyhow bail ensure".split(" "),
);

/** Primitive types: `u64::from()` is the language's, not a module path. */
const PRIMITIVES = new Set("bool char str f32 f64 i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize".split(" "));

/** Type-like items and the declaration kind each becomes: data types are classes (they get `impl` members), traits and aliases are types. */
const TYPE_ITEMS = new Map<string, DeclFact["kind"]>([["struct_item", "class"], ["enum_item", "class"], ["union_item", "class"], ["trait_item", "type"], ["type_item", "type"]]);

/** Attributes of the language and its tools, and attribute macros that keep the fn and run its body when it is called by name. */
const KEEPING_ATTRIBUTES = new Set(
  "inline must_use allow deny warn forbid expect cfg cfg_attr doc deprecated track_caller cold no_mangle export_name link_section link_name repr non_exhaustive automatically_derived target_feature path macro_use macro_export proc_macro proc_macro_derive proc_macro_attribute global_allocator panic_handler used naked instruction_set optimize coverage no_implicit_prelude unsafe derive ignore should_panic tokio::main async_std::main actix_web::main actix_rt::main instrument tracing::instrument async_trait async_trait::async_trait".split(" "),
);

/** Traits of `std` whose methods operators, `for`, `?`, `.into()`, formatting, drop and auto-deref call without naming them. */
const IMPLICIT_TRAITS = new Set(
  "Drop Display Debug Write Iterator DoubleEndedIterator IntoIterator FromIterator Extend From TryFrom FromStr Deref DerefMut Index IndexMut PartialEq Eq PartialOrd Ord Hash Clone Default AsRef AsMut Borrow BorrowMut Future Fn FnMut FnOnce Error Add Sub Mul Div Rem Neg Not BitAnd BitOr BitXor Shl Shr AddAssign SubAssign MulAssign DivAssign RemAssign BitAndAssign BitOrAssign BitXorAssign ShlAssign ShrAssign".split(" "),
);

/** Nodes whose identifiers bind names instead of reading them. */
const PATTERN_NODES = new Set(["tuple_struct_pattern", "struct_pattern", "tuple_pattern", "slice_pattern", "ref_pattern", "mut_pattern", "or_pattern", "captured_pattern", "field_pattern", "match_pattern", "range_pattern", "reference_pattern"]);

/** The facts of one Rust file: imports, items with their calls, holes and value references. */
export function extractRust(path: string, src: string): Promise<FileFacts> {
  return withTree("rust", src, (tree) => extractTree(path, tree.rootNode));
}

/** Collect the facts of a parsed file in passes: imports, items, `impl` members, value references, then file-level data. */
function extractTree(path: string, root: Node): FileFacts {
  const facts: FileFacts = { path, endLine: 1, endCol: 1, imports: [], decls: [], exports: new Set(), reexportsAll: [], exportRows: [], unsupported: [], valueRefs: [], moduleCalls: [], completeness: "complete", parseError: null };
  const impls: { type: string; node: Node; members: { item: Node; decl: DeclFact }[] }[] = [];
  // `#![cfg(test)]` makes the whole file test code.
  const items = root.namedChildren.some((node) => node.type === "inner_attribute_item" && isTestAttribute(node)) ? [] : root.namedChildren.filter((node) => !isComment(node) && !testOnly(node));

  // Imports first: a call path resolves against every `use` of the file, wherever it is written.
  for (const node of items) {
    if (node.type === "use_declaration") {
      for (const leaf of useLeaves(node.childForFieldName("argument"), [])) facts.imports.push(useImport(node, leaf, exported(node), facts));
    } else if (node.type === "extern_crate_declaration") {
      const name = node.childForFieldName("name")?.text;

      if (name) facts.imports.push(importAt(node, name, [{ kind: "named", local: node.childForFieldName("alias")?.text ?? name, imported: name }], false));
    } else {
      // `use` in a fn body is a dependency of the module as much as one at the top.
      nestedUses(node, facts);
    }
  }

  // Item names a call path may start with; a `mod` name starts a path to that module's file.
  const names = new Set(items.filter((node) => node.type !== "mod_item" || node.childForFieldName("body") !== null).map((node) => node.childForFieldName("name")?.text).filter((name) => name !== undefined));

  for (const binding of facts.imports.flatMap((imp) => imp.bindings)) names.add(binding.local);

  const detached = (body: Node | null, owner: string | null, imports = true): void => {
    // Code archdiff indexes under no fn: what it calls escapes, as module-level code does.
    if (body) facts.moduleCalls.push(...bodyCalls(body, { owner, self: owner !== null, bound: new Map(), names, imports }, facts).map((c) => ({ ...c, closure: true as const })));
  };

  // Items: each top-level item becomes a declaration, an export row, a hole,
  // or code that runs outside any indexed fn (`detached`).
  for (const node of items) {
    const name = node.childForFieldName("name")?.text;

    switch (node.type) {
      case "function_item":
        if (!name) break;
        facts.decls.push(fnDecl(node, name, exported(node), null, names, facts));

        if (exported(node)) exportRow(facts, name, "fn");
        noteAttributes(node, name, false, facts);
        break;
      case "struct_item":
      case "enum_item":
      case "union_item":
      case "trait_item":
      case "type_item": {
        if (!name) break;
        const kind = TYPE_ITEMS.get(node.type)!;
        const at = located(node);
        const doc = itemDoc(node);
        const decl: DeclFact = { kind, name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature: null, exported: exported(node), calls: [], types: [], members: [], ...fingerprintFacts(node) };

        if (doc !== undefined) decl.doc = doc;
        facts.decls.push(decl);

        if (exported(node)) exportRow(facts, name, kind === "class" ? "class" : "type");

        // A trait's default methods are not indexed; any impl may run them.
        if (node.type === "trait_item") for (const item of members(node)) if (item.type === "function_item") detached(item.childForFieldName("body"), null);
        break;
      }

      case "const_item":
      case "static_item":
        if (name && exported(node)) exportRow(facts, name, "value");
        // `static DB: Lazy<Db> = Lazy::new(|| Db::open())` runs on first use, not in a fn archdiff indexes.
        detached(node.childForFieldName("value"), null);
        break;
      case "impl_item": {
        const type = baseType(node.childForFieldName("type"));

        if (!type) {
          facts.unsupported.push(unsupported(node, "`impl` for a type archdiff cannot name"));

          for (const item of members(node)) if (item.type === "function_item") detached(item.childForFieldName("body"), null);
          break;
        }

        const list: { item: Node; decl: DeclFact }[] = [];
        // `impl fmt::Display for Order`: `format!` calls `fmt`; `impl Drop`: the end of a scope calls `drop`.
        const trait = baseType(node.childForFieldName("trait"));
        const implicit = trait !== null && IMPLICIT_TRAITS.has(trait);

        // Only methods are indexed; associated consts and types are skipped.
        for (const item of members(node)) {
          const member = item.childForFieldName("name")?.text;

          if (item.type !== "function_item" || !member) continue;
          const decl = fnDecl(item, member, exported(item), type, names, facts);

          if (implicit) decl.implicit = true;
          list.push({ item, decl });
          noteAttributes(item, `${type}.${member}`, true, facts);
        }

        impls.push({ type, node, members: list });
        break;
      }

      case "mod_item":
        // `mod x;` names the file `x.rs`; the dependency is whatever code uses from it.
        if (node.childForFieldName("body")) {
          facts.unsupported.push(unsupported(node, `inline module \`${name ?? "?"}\` is not indexed`));
          detached(node.childForFieldName("body"), null, false);
        }

        break;
      case "macro_invocation":
        facts.unsupported.push(unsupported(node, `macro \`${macroName(node)}!\` at module level is not expanded`));
        break;
    }
  }

  // Attach `impl` methods to their type once every item is known (an impl
  // may come before its struct). A type of another file cannot hold them:
  // their calls escape as module-level code instead.
  for (const impl of impls) {
    const owner = facts.decls.find((d) => d.kind === "class" && d.name === impl.type);

    if (owner) owner.members.push(...impl.members.map((m) => m.decl));
    else {
      facts.unsupported.push(unsupported(impl.node, `\`impl ${impl.type}\` for a type declared in another file`));

      for (const { item } of impl.members) detached(item.childForFieldName("body"), impl.type);
    }
  }

  // File-level facts: value refs sorted by position (attribute refs were
  // noted earlier), the module doc, the value-code fingerprint, the end, and
  // a parse error that makes the file opaque.
  facts.valueRefs = [...facts.valueRefs, ...valueRefs(items, names, facts)].sort((a, b) => a.line - b.line || a.col - b.col);
  const doc = moduleDoc(root);

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

/** A line or block comment node. */
function isComment(node: Node): boolean {
  return node.type === "line_comment" || node.type === "block_comment";
}

/** `///` (not `////`) or `/** … *\/` (not `/**\/`): outer documentation of the item after it. */
function outerDoc(node: Node): boolean {
  return node.type === "line_comment" ? /^\/\/\/(?!\/)/.test(node.text) : node.type === "block_comment" && /^\/\*\*(?![*/])/.test(node.text);
}

/** `//!` or `/*! … *\/`: documentation of the module it is written in. */
function innerDoc(node: Node): boolean {
  return node.type === "line_comment" ? node.text.startsWith("//!") : node.type === "block_comment" && node.text.startsWith("/*!");
}

/** Text of doc comments in source order: line comments without `///`/`//!`, blocks without delimiters. */
function docText(comments: readonly Node[]): string | undefined {
  const text = comments.map((c) => (c.type === "line_comment" ? lineCommentsBody([c.text], /^\/\/[/!]/) : blockCommentBody(c.text))).join("\n");

  return isLicense(text) ? undefined : nonEmpty(text) ?? undefined;
}

/**
 * The item's documentation: its outer doc comments, attributes and plain
 * comments between them allowed. `#[doc = "…"]` is an attribute archdiff does
 * not read, so an item documented only by it has none.
 */
function itemDoc(node: Node): string | undefined {
  const docs: Node[] = [];

  // Walk back over the attributes and comments right above the item; an inner
  // doc belongs to the module and ends the item's run.
  for (let prev = node.previousNamedSibling; prev && (prev.type === "attribute_item" || isComment(prev)); prev = prev.previousNamedSibling) {
    if (innerDoc(prev)) break;

    if (outerDoc(prev)) docs.unshift(prev);
  }

  return docText(docs);
}

/** The module's documentation: the `//!` and `/*! … *\/` comments of the file (`mod.rs` for a directory). */
function moduleDoc(root: Node): string | undefined {
  return docText(root.namedChildren.filter(innerDoc));
}

/** The item has any `pub` visibility (`pub`, `pub(crate)`, …). */
function exported(node: Node): boolean {
  return node.namedChildren.some((c) => c.type === "visibility_modifier");
}

/** Items of an `impl` or a `trait` body, without test-only ones. */
function members(node: Node): Node[] {
  return (node.childForFieldName("body")?.namedChildren ?? []).filter((item) => !isComment(item) && !testOnly(item));
}

/** An item under `#[cfg(test)]` (or `cfg(all(test, …))`) or a `#[test]` fn: test code, kept out of the graph like test files. */
function testOnly(node: Node): boolean {
  // Any test attribute among those right above the item.
  for (let prev = node.previousNamedSibling; prev && (prev.type === "attribute_item" || isComment(prev)); prev = prev.previousNamedSibling) {
    if (prev.type === "attribute_item" && isTestAttribute(prev)) return true;
  }

  return false;
}

/**
 * An attribute macro archdiff does not know (`#[get("/")]`, `#[tauri::command]`)
 * may replace the fn: calls of the name may not reach the body (a hole of that
 * fn), and the macro holds the fn, so a framework may call it. A method of
 * an `impl` for a type of another file is not indexed: its hole has no symbol.
 */
function noteAttributes(node: Node, symbol: string, member: boolean, facts: FileFacts): void {
  for (let prev = node.previousNamedSibling; prev && (prev.type === "attribute_item" || isComment(prev)); prev = prev.previousNamedSibling) {
    if (prev.type !== "attribute_item") continue;
    // The attribute's path without arguments (`get` of `#[get("/")]`).
    const path = prev.namedChildren[0]?.namedChildren[0]?.text.replace(/\s+/g, "") ?? "";

    if (KEEPING_ATTRIBUTES.has(path) || /^(clippy|rustfmt|diagnostic)::/.test(path)) continue;
    // An unknown attribute: a hole for the fn, and a value ref, since the
    // macro holds the fn and a framework may call it.
    facts.unsupported.push({ ...unsupported(prev, `attribute \`${path}\` may replace \`${symbol}\``), symbol });
    const at = located(prev);
    facts.valueRefs.push(member ? { name: symbol.slice(symbol.lastIndexOf(".") + 1), member: true, line: at.line, col: at.col } : { name: symbol, line: at.line, col: at.col });
  }
}

/** `#[cfg(test)]`, `#[cfg(all(test, unix))]`, `#[test]`, `#[tokio::test]`, `#[bench]` (or `#![…]`). */
function isTestAttribute(node: Node): boolean {
  // The attribute's content without spaces, `#[`/`#![` and `]`.
  const text = node.text.replace(/\s+/g, "").replace(/^#!?\[/, "").replace(/\]$/, "");

  // `test`, `tokio::test`, `bench`, with or without arguments.
  if (/^((\w+::)*test|bench)(\(.*\))?$/.test(text)) return true;
  const cfg = /^cfg\((.*)\)$/.exec(text);

  return cfg !== null && requiresTest(cfg[1]!);
}

/** A `cfg` predicate that holds only in test builds: `test`, `all(…, test, …)`, `any` of such. */
function requiresTest(predicate: string): boolean {
  if (predicate === "test") return true;
  const call = /^(all|any)\((.*)\)$/.exec(predicate);

  if (!call) return false;
  const args = splitTopLevel(call[2]!);

  // `all` needs test if any part does; `any` only if every part does.
  return call[1] === "all" ? args.some(requiresTest) : args.length > 0 && args.every(requiresTest);
}

/** Split a `cfg` argument list at commas outside parentheses and string literals. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (c === '"' && text[i - 1] !== "\\") quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    else if (!quoted && depth === 0 && c === ",") {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }

  out.push(text.slice(start));

  return out.filter((arg) => arg !== "");
}

/** `use` declarations inside items (fn bodies, `impl` members), except inline modules, whose paths start elsewhere, and test code. */
function nestedUses(node: Node, facts: FileFacts): void {
  if (node.type === "mod_item" || node.type === "macro_definition" || node.type === "attribute_item") return;

  // Recurse through every nested node; a `use` found is an import of the
  // file but never a re-export.
  for (const child of node.namedChildren) {
    if (testOnly(child)) continue;

    if (child.type === "use_declaration") {
      for (const leaf of useLeaves(child.childForFieldName("argument"), [])) facts.imports.push(useImport(child, leaf, false, facts));
    } else nestedUses(child, facts);
  }
}

/** Record a public name of the file. */
function exportRow(facts: FileFacts, name: string, kind: ExportRow["kind"]): void {
  facts.exports.add(name);
  facts.exportRows.push({ name, kind, local: null });
}

/** `Gen<T>` → `Gen`, `crate::a::S` → `S`; null for references, tuples and the like. */
function baseType(node: Node | null): string | null {
  if (!node) return null;

  if (node.type === "type_identifier") return node.text;

  if (node.type === "generic_type") return baseType(node.childForFieldName("type"));

  if (node.type === "scoped_type_identifier") return node.childForFieldName("name")?.text ?? null;

  return null;
}

/** `&self`, `mut self`, `self: Box<Self>`: the fn is a method. */
function takesSelf(params: Node | null): boolean {
  return (params?.namedChildren ?? []).some((c) => c.type === "self_parameter" || (c.type === "parameter" && c.childForFieldName("pattern")?.type === "self"));
}

/** The declaration of a fn or method: signature, calls, doc, and whether it is an associated (static) fn. */
function fnDecl(node: Node, name: string, exported: boolean, owner: string | null, names: ReadonlySet<string>, facts: FileFacts): DeclFact {
  const at = located(node);
  const params = node.childForFieldName("parameters");
  const returns = node.childForFieldName("return_type");
  // Parameters and return type as written, whitespace collapsed.
  const signature = params ? `${params.text.replace(/\s+/g, " ")}${returns ? ` → ${returns.text.replace(/\s+/g, " ")}` : ""}` : null;
  const self = takesSelf(params);
  const body = node.childForFieldName("body");
  const calls = body ? bodyCalls(body, { owner, self, bound: boundNames(node), names, imports: true }, facts) : [];
  const doc = itemDoc(node);
  const decl: DeclFact = { kind: "fn", name, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, signature, exported, calls, types: [], members: [], ...fingerprintFacts(node) };

  if (doc !== undefined) decl.doc = doc;

  // An associated function without `self` is called on the type: `S::new()`.
  if (owner !== null && !self) decl.static = true;

  return decl;
}

/**
 * Names a function (or closure) binds: parameters, `let`, `for`, `if let` /
 * `while let`, `match` arm patterns and closure parameters. A call through
 * one of them is a call through a value. The whole function is one scope
 * here: a binding anywhere in it hides the module's item of that name.
 */
function boundNames(fn: Node): Map<string, "parameter" | "local"> {
  const out = new Map<string, "parameter" | "local">();

  const names = (pattern: Node | null, kind: "parameter" | "local"): void => {
    if (!pattern) return;

    // `Point { x, .. }` binds `x` through a shorthand field.
    if (pattern.type === "identifier" || pattern.type === "shorthand_field_identifier") {
      out.set(pattern.text, kind);

      return;
    }

    // `Some(x)`, `Point { x, .. }`: the constructor is not a binding. Nodes are fresh wrappers on every access: compare ids.
    const type = pattern.childForFieldName("type")?.id;

    for (const c of pattern.namedChildren) if (c.type !== "type_identifier" && c.type !== "scoped_identifier" && c.id !== type) names(c, kind);
  };

  // The fn's own parameters (a closure's are untyped patterns).
  const params = fn.childForFieldName("parameters");

  if (params?.type === "closure_parameters") for (const c of params.namedChildren) names(c, "parameter");
  else for (const p of params?.namedChildren ?? []) if (p.type === "parameter") names(p.childForFieldName("pattern"), "parameter");

  // Every binding form anywhere in the body, nested fns and closures included.
  const walk = (node: Node): void => {
    if (node.type === "let_declaration" || node.type === "let_condition" || node.type === "for_expression") names(node.childForFieldName("pattern"), "local");
    else if (node.type === "match_pattern") {
      // An arm binds its pattern; its guard (`if ready()`) is an expression.
      const guard = node.childForFieldName("condition")?.id;

      for (const c of node.namedChildren) if (c.id !== guard) names(c, "local");
    }

    if (node.type === "closure_parameters") for (const c of node.namedChildren) names(c, "parameter");

    // A fn declared in the body shadows the module item of its name, and its parameters bind in its body.
    if (node.type === "function_item") {
      const name = node.childForFieldName("name");

      if (name) out.set(name.text, "local");

      for (const p of node.childForFieldName("parameters")?.namedChildren ?? []) if (p.type === "parameter") names(p.childForFieldName("pattern"), "parameter");
    }

    for (const c of node.namedChildren) walk(c);
  };

  const body = fn.childForFieldName("body");

  if (body) walk(body);

  return out;
}

/** Where a call is written: the `impl` type, whether the fn takes `self`, its bound names, and the file's item and import names. */
interface CallScope {
  owner: string | null;
  self: boolean;
  bound: ReadonlyMap<string, "parameter" | "local">;
  names: ReadonlySet<string>;
  /** False in an inline `mod x { … }`: its paths start at that module, so they are not imports of the file. */
  imports: boolean;
}

/**
 * Where a call sits with respect to closures: null outside them; `stored`
 * under a nested `fn`, an `async` block or a closure some value holds
 * (`let g = |x| …`); otherwise the position of the outermost closure, every
 * closure between being an argument of a call (`items.iter().map(|x| self.m(x))`).
 */
type ClosureState = null | "stored" | { line: number; col: number };

/** A call fact before its position is known. */
type UnplacedCall = Omit<CallFact, "line" | "col" | "endLine" | "endCol">;

/** Every call in a body as a call fact (with closure state and fn arguments), and a hole for each unknown macro. */
function bodyCalls(body: Node, scope: CallScope, facts: FileFacts): CallFact[] {
  const out: CallFact[] = [];

  const walk = (node: Node, closure: ClosureState): void => {
    if (node.type === "call_expression") {
      const fact = callOf(node.childForFieldName("function"), scope, facts);

      if (fact) {
        const at = located(node);
        const passes = passesOf(node, scope, facts);
        const unplaced: UnplacedCall = { ...fact };

        if (passes.length > 0) unplaced.passes = passes;
        // Object.assign appends the position after `passes`, the key order of every call fact.
        const call: CallFact = Object.assign(unplaced, { line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol });

        if (closure) call.closure = true;

        if (closure && closure !== "stored") call.closureArg = closure;
        out.push(call);
      }
    } else if (node.type === "macro_invocation") {
      // Macro bodies are not parsed as code: a macro may hide calls.
      const name = macroName(node);
      // `serde_json::json!` comes from another crate; a macro of this crate (`ui_message!`, `crate::m!`) hides calls.
      const foreign = name.includes("::") && !/^(crate|self|super)::/.test(name);

      if (!KNOWN_MACROS.has(name) && !foreign) facts.unsupported.push(unsupported(node, `macro \`${name}!\` is not expanded`));
    }

    // A nested `fn` runs only when something calls it, like a closure.
    // The closure state for the children: an async block, a nested fn or a
    // closure stored in a value makes them "stored"; a closure passed
    // straight as an argument keeps the outermost such closure's position.
    let inner = closure;

    if (node.type === "async_block" || node.type === "function_item") inner = "stored";
    else if (node.type === "closure_expression") inner = closure === "stored" || node.parent?.type !== "arguments" ? "stored" : (closure ?? { line: located(node).line, col: located(node).col });

    for (const c of node.namedChildren) walk(c, inner);
  };

  walk(body, null);

  return out;
}

/**
 * Function paths among the arguments: `run(Self::m)`, `run(m)`,
 * `run(crate::util::helper)`, `.map(Order::total)`. A closure is not a pass:
 * its calls carry `closureArg`.
 */
function passesOf(call: Node, scope: CallScope, facts: FileFacts): PassFact[] {
  const args = call.childForFieldName("arguments");

  if (args?.type !== "arguments") return [];
  // Argument index counts only real arguments, not comments between them.
  const out: PassFact[] = [];
  args.namedChildren
    .filter((arg) => arg.type !== "line_comment" && arg.type !== "block_comment")
    .forEach((arg, index) => {
      if (arg.type !== "identifier" && arg.type !== "scoped_identifier") return;
      const fact = callOf(arg, scope, facts);

      // A local of unknown kind, a variant or a value archdiff cannot name resolves to nothing.
      if (!fact || fact.bound) return;
      const at = located(arg);
      out.push({ arg: index, path: "", callee: fact.callee, text: compact(at.text), line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol });
    });

  return out;
}

/** What a callee expression names: the dotted callee, and `bound` when it goes through a local or parameter. */
type Callee = Pick<CallFact, "callee" | "bound">;

/**
 * `f()` → `f`; `a::b::f()` → `a.b.f`; `Self::new()` → `<Type>.new`;
 * `self.m()` → `this.m`; `x.m()` → `x.m` (through a value). A path that
 * starts at `crate`, `super`, `self` or a lower-case name archdiff does not
 * know imports what it names: the call is an edge to that module's item.
 * A last segment in `CamelCase` (`Some(x)`, `Event::Progress(p)`) is an
 * enum variant or a tuple struct by the naming convention: no call, null.
 * Any other callee (`self.db.save()`, `Order::new().total()`, `(self.f)()`)
 * is a call through a value that archdiff cannot name.
 */
function callOf(fn: Node | null, scope: CallScope, facts: FileFacts): Callee | null {
  if (!fn) return null;
  const { owner, self, bound } = scope;

  switch (fn.type) {
    case "generic_function": {
      const inner = fn.childForFieldName("function");

      return inner ? callOf(inner, scope, facts) : throughValue(fn);
    }

    case "parenthesized_expression": {
      // `(f)()` calls the path `f`; `(self.handler)()` calls the value of a field.
      const inner = fn.namedChildren[0];

      return inner && (inner.type === "identifier" || inner.type === "scoped_identifier" || inner.type === "generic_function" || inner.type === "parenthesized_expression") ? callOf(inner, scope, facts) : throughValue(fn);
    }

    // A bare name: a variant/tuple struct by case, else a call of a local or an item.
    case "identifier": {
      if (/^[A-Z]/.test(fn.text)) return null;
      const kind = bound.get(fn.text);

      return kind ? { callee: fn.text, bound: kind } : { callee: fn.text };
    }

    // `self.m()` is a method of the impl; `x.m()` goes through the value `x`.
    case "field_expression": {
      const value = fn.childForFieldName("value");
      const field = fn.childForFieldName("field")?.text;

      if (!value || !field) return throughValue(fn);

      if (value.type === "self" && self && owner !== null) return { callee: `this.${field}` };

      if (value.type === "identifier") return { callee: `${value.text}.${field}`, bound: bound.get(value.text) ?? "local" };

      return throughValue(fn);
    }

    case "scoped_identifier":
      return pathCall(fn, scope, facts);
    default:
      return throughValue(fn);
  }
}

/** The callee of a path call or a path read as a value; null for a variant or tuple-struct constructor. */
function pathCall(fn: Node, scope: CallScope, facts: FileFacts): Callee | null {
  const { owner, bound, names } = scope;
  let segments = pathSegments(fn);

  if (!segments) {
    // `<T as Trait>::f()`: a trait method on a type archdiff does not resolve.
    const name = fn.childForFieldName("name")?.text;

    return name ? { callee: `${compact(fn.childForFieldName("path")?.text ?? "?")}.${name}`, bound: "local" } : throughValue(fn);
  }

  // A CamelCase last segment is a constructor, not a call.
  if (/^[A-Z]/.test(segments.at(-1)!)) return null;

  // `u64::from` and friends: the language's own, kept as written.
  if (PRIMITIVES.has(segments[0]!)) return { callee: segments.join(".") };

  if (segments[0] === "Self" && owner !== null) return { callee: [owner, ...segments.slice(1)].join(".") };

  if (segments[0] === "self" && segments.length === 2) return { callee: segments[1]! };
  // `order::Order::new()` or `sync::mpsc::channel()` through a `use` binding: the path of that `use`, then the rest.
  const via = segments.length > 2 ? facts.imports.find((imp) => imp.bindings.some((b) => b.kind === "named" && b.local === segments![0] && b.imported === imp.source.split("::").at(-1))) : undefined;

  if (via && !via.source.includes("*")) segments = [...via.source.split("::"), ...segments.slice(1)];
  const head = segments[0]!;

  // Inside an inline module paths are relative to it: not an import, a hole.
  if (!scope.imports) return { callee: segments.join("::"), bound: "local" };

  if (head === "crate" || head === "super" || head === "self" || via || (/^[a-z_]/.test(head) && !bound.has(head) && !names.has(head))) {
    // The path is its own import: the call site names the module, or a type in it (`a::Message::raw` → `Message.raw`).
    const type = segments.findIndex((segment, i) => i > 0 && /^[A-Z]/.test(segment));
    const path = type === -1 ? segments : segments.slice(0, type + 1);
    const source = path.join("::");

    // Add a synthetic import for the path once per file, so the resolver
    // turns it into a dependency like a `use`.
    if (!facts.imports.some((imp) => imp.source === source && imp.bindings.some((b) => b.local === source))) {
      const at = located(fn);
      facts.imports.push({ source, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: at.text, bindings: [{ kind: "named", local: source, imported: path.at(-1)! }], reexport: false });
    }

    return { callee: [source, ...segments.slice(path.length)].join(".") };
  }

  // A path starting at an item or binding of this file.
  return { callee: segments.join(".") };
}

/** A call archdiff cannot name, as written: a `dynamic-call` hole, never an edge. */
function throughValue(fn: Node): Callee {
  return { callee: compact(fn.text), bound: "local" };
}

/** Source text on one line, without spaces around `.` and `:`. */
function compact(text: string): string {
  return text.replace(/\s+/g, " ").replace(/ ?([.:]) ?/g, "$1");
}

/** `a::b::c` → `["a", "b", "c"]`; null when a segment is not a plain name (`<T as X>::f`). */
function pathSegments(node: Node): string[] | null {
  if (node.type === "identifier" || node.type === "crate" || node.type === "self" || node.type === "super" || node.type === "type_identifier") return [node.text];

  if (node.type !== "scoped_identifier" && node.type !== "scoped_type_identifier") return null;
  const name = node.childForFieldName("name");
  const path = node.childForFieldName("path");

  if (!name) return null;

  // `::f` (no path) is just the name; otherwise recurse into the prefix.
  if (!path) return [name.text];
  const head = pathSegments(path);

  return head ? [...head, name.text] : null;
}

/**
 * Functions read as values: `later(hit)`, `.map(Order::total)`,
 * `Handler { run: crate::a::go }`. Code holding the value may call it, so
 * such a fn escapes. Names bound in the enclosing fn are locals, not the item.
 * A `use m::*` may bind any name, so then every free name read is noted.
 */
function valueRefs(items: Node[], names: ReadonlySet<string>, facts: FileFacts): ValueRefFact[] {
  // With a glob import any free lower-case name may be an imported fn.
  const glob = facts.imports.some((imp) => imp.glob);
  const first = new Map<string, ValueRefFact>();

  // Keep only the first reference of each name (and of each member name).
  const note = (name: string, node: Node, member: boolean): void => {
    const key = `${member ? "." : ""}${name}`;

    if (!first.has(key)) first.set(key, member ? { name, member: true, line: node.startPosition.row + 1, col: node.startPosition.column + 1 } : { name, line: node.startPosition.row + 1, col: node.startPosition.column + 1 });
  };

  // Walk all items, widening the bound names at each fn or closure and
  // switching off imports inside inline modules; skip code that reads no values.
  const walk = (node: Node, scope: CallScope): void => {
    if (node.type === "use_declaration" || node.type === "attribute_item" || node.type === "macro_definition" || node.type === "lifetime" || node.type === "label" || testOnly(node)) return;

    if (node.type === "function_item" || node.type === "closure_expression") scope = { ...scope, bound: new Map([...scope.bound, ...boundNames(node)]) };

    if (node.type === "mod_item") scope = { ...scope, imports: false };

    if (node.type === "identifier" && !bindsOrCalls(node) && /^[a-z_]/.test(node.text) && !scope.bound.has(node.text) && (glob || names.has(node.text))) note(node.text, node, false);

    if (node.type === "scoped_identifier") {
      if (!calledPath(node)) {
        const callee = pathCall(node, scope, facts);

        if (callee && !callee.bound) {
          note(callee.callee, node, false);

          // `Order::total` as a value may be a method taking `self`.
          if (callee.callee.includes(".")) note(callee.callee.slice(callee.callee.lastIndexOf(".") + 1), node, true);
        }
      }

      return;
    }

    for (const child of node.namedChildren) walk(child, scope);
  };

  for (const item of items) walk(item, { owner: null, self: false, bound: new Map(), names, imports: true });

  return [...first.values()];
}

/** The path is the callee of a call, or a part of a longer path or a pattern: not a value read. */
function calledPath(node: Node): boolean {
  let at = node;

  // Look through `f::<T>` and `(f)` wrappers to the position that matters.
  while (at.parent?.type === "generic_function" || at.parent?.type === "parenthesized_expression") at = at.parent;
  const parent = at.parent;

  if (!parent) return true;

  if (parent.type === "call_expression" && parent.childForFieldName("function")?.id === at.id) return true;

  return parent.type === "scoped_identifier" || parent.type === "scoped_type_identifier" || parent.type === "macro_invocation" || PATTERN_NODES.has(parent.type) || parent.type === "struct_expression";
}

/** The identifier names what is declared, bound or called here, or is part of a path or pattern. */
function bindsOrCalls(node: Node): boolean {
  const parent = node.parent;

  if (!parent) return true;
  const is = (field: string): boolean => parent.childForFieldName(field)?.id === node.id;

  if (parent.type === "call_expression" && is("function")) return true;

  if ((parent.type === "generic_function" || parent.type === "parenthesized_expression") && calledPath(node)) return true;

  if (PATTERN_NODES.has(parent.type) || parent.type === "scoped_identifier" || parent.type === "scoped_type_identifier" || parent.type === "macro_invocation") return true;

  if (parent.type === "let_declaration" && is("pattern")) return true;

  if (parent.type === "parameter" && is("pattern")) return true;

  if (parent.type === "closure_parameters" || (parent.type === "for_expression" && is("pattern"))) return true;

  if (parent.type === "let_condition" && is("pattern")) return true;

  if ((parent.type === "function_item" || parent.type === "const_item" || parent.type === "static_item" || parent.type === "mod_item" || parent.type === "function_signature_item") && is("name")) return true;

  return false;
}

/** One imported path of a `use` tree, with its alias and whether it is a glob. */
interface UseLeaf {
  path: string[];
  alias: string | null;
  glob: boolean;
}

/** Flatten a `use` tree: `a::{b, c::d as e, f::*}` → `a::b`, `a::c::d` as `e`, `a::f::*`. */
function useLeaves(node: Node | null, prefix: string[]): UseLeaf[] {
  if (!node) return [];

  switch (node.type) {
    case "use_as_clause": {
      const path = node.childForFieldName("path");
      const segments = path ? pathSegments(path) : null;

      return segments ? [{ path: [...prefix, ...segments], alias: node.childForFieldName("alias")?.text ?? null, glob: false }] : [];
    }

    case "use_list":
      return node.namedChildren.flatMap((c) => useLeaves(c, prefix));
    case "scoped_use_list": {
      const path = node.childForFieldName("path");
      const segments = path ? pathSegments(path) : [];

      return segments ? useLeaves(node.childForFieldName("list"), [...prefix, ...segments]) : [];
    }

    case "use_wildcard": {
      const path = node.namedChildren[0];
      const segments = path ? pathSegments(path) : [];

      return segments ? [{ path: [...prefix, ...segments], alias: null, glob: true }] : [];
    }

    case "self":
      // `a::{self}` is the module `a`.
      return prefix.length > 0 ? [{ path: prefix, alias: null, glob: false }] : [];
    default: {
      const segments = pathSegments(node);

      if (!segments) return [];
      const path = [...prefix, ...segments];

      // `use a::b::self` (rare, but valid) is `a::b`.
      return [{ path: path.at(-1) === "self" ? path.slice(0, -1) : path, alias: null, glob: false }];
    }
  }
}

/** The import fact of one `use` leaf; a `pub use` also records the re-export. */
function useImport(node: Node, leaf: UseLeaf, exported: boolean, facts: FileFacts): ImportFact {
  const source = leaf.path.join("::");

  if (leaf.glob) {
    if (exported) facts.reexportsAll.push(source);

    return { ...importAt(node, source, [], exported), glob: true };
  }

  // `use x as _` imports only for traits: it binds no name.
  const imported = leaf.path.at(-1)!;
  const local = leaf.alias ?? imported;

  if (exported && local !== "_") exportRow(facts, local, "reexport");

  return importAt(node, source, local === "_" ? [] : [{ kind: "named", local, imported }], exported);
}

/** An import fact placed at `node`. */
function importAt(node: Node, source: string, bindings: ImportFact["bindings"], reexport: boolean): ImportFact {
  const at = located(node);

  return { source, line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: at.text, bindings, reexport };
}

/** The macro's path as written, without `!`. */
function macroName(node: Node): string {
  return node.childForFieldName("macro")?.text ?? node.namedChildren[0]?.text ?? "?";
}

/** A hole at `node`, its text cut to the first line. */
function unsupported(node: Node, reason: string): UnsupportedFact {
  const at = located(node);

  return { line: at.line, col: at.col, endLine: at.endLine, endCol: at.endCol, text: at.text.split("\n")[0]!, reason };
}
