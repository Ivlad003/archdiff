// Where an import points: a file of the repository, a package, a Node
// built-in, or nowhere archdiff can see. Relative specifiers are probed
// against the file list the way TypeScript and Node do (extensions, `.js`
// written for a `.ts` file, `index` files); bare specifiers go through the
// `paths` of the nearest tsconfig.json (a monorepo package has its own;
// `extends` followed, into node_modules too) first, then are read as
// packages. Nothing here reads a file but the tsconfigs; the file list is
// the input.
//
// Sits between extraction and the graph: ImportFact.source → Resolution.
// Entry points: `createResolver`, `packageName`, `readTsconfigPaths`,
// `tsconfigResolver`.

import { existsSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import type { FileFacts } from "./extract/facts.ts";
import type { Resolution as LanguageResolution, SourceResolver } from "./imports.ts";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";
import { languageOf } from "./languages.ts";
import { PhpResolver } from "./php-imports.ts";
import { PythonResolver } from "./python-imports.ts";
import { RustResolver } from "./rust-imports.ts";

/** What an import specifier names. */
export type Resolution =
  /** `whole`: the import binds the module itself (Python's `from . import core`, Rust's `use crate::util`): a namespace of its names. */
  | { kind: "file"; path: string; whole?: true }
  | { kind: "package"; name: string }
  /** The language's own library: Node's (`runtime` absent), Python's standard library, Rust's `std`, PHP's functions. */
  | { kind: "builtin"; name: string; runtime?: "python" | "rust" | "php" }
  /** The importing file itself (Rust `use self::Kind::*`, a Python relative import of the package's own module): no dependency, nothing unresolved. */
  | { kind: "self" }
  /** A file of the repository that is no source (JSON, a stylesheet, an image): no module to draw, nothing unresolved. */
  | { kind: "asset"; path: string }
  | { kind: "unresolved"; reason: string };

/** A package of the repository that an import may name (a workspace): its name, its directory and its entry file. */
export interface Workspace {
  name: string;
  dir: string;
  entry: string | null;
}

/** What archdiff reads of a tsconfig (or a jsconfig), its `extends` followed: the module options that name files. */
export interface TsconfigPaths {
  /** Where `paths` targets resolve from: `baseUrl` when set, else the directory of the config that declares `paths`. */
  baseDir: string;
  /** `@/*` → [`src/*`]; a pattern without `*` maps exactly. */
  paths: { pattern: string; targets: string[] }[];
  /** `baseUrl`, as a path: a bare specifier is a file under it too (after `paths`, before the packages). */
  baseUrl: string | null;
  /** `verbatimModuleSyntax`: `import { type A } from` stays in the code as `import {} from`, a runtime import; else it is erased. */
  verbatimModuleSyntax: boolean;
}

const BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** The extensions tried after a specifier without one, in TypeScript's order. */
const EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];

/** A `.js` import of a TypeScript file: the extensions a written one may stand for. */
const REWRITES: Record<string, string[]> = { ".js": [".ts", ".tsx", ".d.ts"], ".jsx": [".tsx"], ".mjs": [".mts", ".d.mts"], ".cjs": [".cts", ".d.cts"] };

/** The package of a bare specifier: `@scope/name/deep` → `@scope/name`, `lodash/fp` → `lodash`. */
export function packageName(specifier: string): string {
  const parts = specifier.split("/");

  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

/** Strips comments and trailing commas: tsconfig is JSON with those. Strings are kept whole, so a glob written with slashes and stars is no comment. */
function parseJsonc(text: string): JsonValue {
  let out = "";

  for (let i = 0; i < text.length; ) {
    const char = text[i]!;

    if (char === '"') {
      // A string, with its escapes, copied as is.
      let j = i + 1;

      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      i++;
    }
  }

  return parseJson(out.replace(/,(\s*[}\]])/g, "$1"));
}

/**
 * A tsconfig's module options, its `extends` chain followed (a relative file, or a package's config under
 * node_modules; `root` holds the node_modules of the latter), as TypeScript merges them: the nearest config that
 * sets an option wins, `baseUrl` is relative to the config that sets it, and `paths` without a `baseUrl` to the
 * config that declares them. Null when the file is missing or no JSON.
 */
export function readTsconfigPaths(root: string, file = join(root, "tsconfig.json")): TsconfigPaths | null {
  // The chain from the config itself to its farthest parent.
  const chain: { directory: string; options: Record<string, JsonValue> }[] = [];
  const read = (file: string, depth: number): void => {
    if (!existsSync(file) || depth > 5) return;
    let config: JsonValue;

    try {
      config = parseJsonc(readFileSync(file, "utf8"));
    } catch {
      return;
    }

    if (!isJsonObject(config)) return;
    const options = config["compilerOptions"];
    const directory = posix.dirname(file.split("\\").join("/"));
    chain.push({ directory, options: isJsonObject(options) ? options : {} });
    const parent = config["extends"];

    if (!isJsonString(parent)) return;

    if (parent.startsWith(".")) return read(posix.join(directory, parent.endsWith(".json") ? parent : `${parent}.json`), depth + 1);
    // `extends: "@tsconfig/node20/tsconfig.json"` or a package name: its config under node_modules, from the config's directory up to the root.
    const candidates = [posix.join(directory, "node_modules", parent), posix.join(root.split("\\").join("/"), "node_modules", parent)];

    for (const candidate of candidates) {
      for (const resolved of [candidate, `${candidate}.json`, posix.join(candidate, "tsconfig.json")]) if (existsSync(resolved)) return read(resolved, depth + 1);
    }
  };

  read(file.split("\\").join("/"), 0);

  if (chain.length === 0) return null;
  // The nearest config that sets an option.
  const nearest = (name: string): { directory: string; value: JsonValue } | null => {
    for (const link of chain) if (link.options[name] !== undefined) return { directory: link.directory, value: link.options[name]! };

    return null;
  };
  const baseUrlSet = nearest("baseUrl");
  const baseUrl = baseUrlSet && isJsonString(baseUrlSet.value) ? posix.join(baseUrlSet.directory, baseUrlSet.value) : null;
  const pathsSet = nearest("paths");
  const paths: TsconfigPaths["paths"] = [];

  if (pathsSet && isJsonObject(pathsSet.value)) {
    for (const [pattern, targets] of Object.entries(pathsSet.value)) if (Array.isArray(targets)) paths.push({ pattern, targets: targets.filter(isJsonString) });
  }

  const verbatim = nearest("verbatimModuleSyntax");

  return { baseDir: baseUrl ?? pathsSet?.directory ?? chain[0]!.directory, paths, baseUrl, verbatimModuleSyntax: verbatim?.value === true };
}

/**
 * The `paths` pattern TypeScript takes for a specifier: one written without `*` that equals it, else, of those
 * whose prefix and suffix fit around it, the one with the longest prefix; and what the `*` stands for.
 */
function bestPattern(paths: TsconfigPaths["paths"], specifier: string): { pattern: string; targets: string[]; matched: string } | null {
  let best: { pattern: string; targets: string[]; matched: string } | null = null;

  for (const { pattern, targets } of paths) {
    const star = pattern.indexOf("*");

    if (star === -1) {
      if (pattern === specifier) return { pattern, targets, matched: "" };
      continue;
    }

    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);

    if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;

    if (!best || prefix.length > best.pattern.indexOf("*")) best = { pattern, targets, matched: specifier.slice(prefix.length, specifier.length - suffix.length) };
  }

  return best;
}

/** Whether a repository-relative path is a file on disk (an asset a module imports). */
function isFileIn(root: string, path: string): boolean {
  try {
    return statSync(posix.join(root, path)).isFile();
  } catch {
    return false;
  }
}

/** A name npm would take for a package (`react`, `@scope/name`): an alias like `@/lib`, `~/x` or `$lib` is none. */
function packageLike(name: string): boolean {
  return /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i.test(name);
}

/**
 * The tsconfig that governs a file: the nearest `tsconfig.json` in its
 * directory or above (a monorepo package has its own), read once per
 * directory. Falls back to the root's.
 */
export function tsconfigResolver(root: string, _files: Iterable<string>): (from: string) => TsconfigPaths | null {
  // A directory's config: its tsconfig.json, else its jsconfig.json (a JavaScript project's, the same options).
  const present = new Map<string, string | null>();
  const configIn = (directory: string): string | null => {
    let known = present.get(directory);

    if (known === undefined) {
      known = ["tsconfig.json", "jsconfig.json"].find((name) => existsSync(join(root, directory, name))) ?? null;
      present.set(directory, known);
    }

    return known;
  };
  const has = (directory: string): boolean => configIn(directory) !== null;

  const ownerOf = new Map<string, string | null>();
  const configs = new Map<string, TsconfigPaths | null>();

  return (from) => {
    let directory = posix.dirname(from);
    const walked: string[] = [];
    let owner: string | null = null;

    // Up from the file's directory to the first tsconfig.json; every directory walked remembers the answer.
    while (true) {
      const cached = ownerOf.get(directory);

      if (cached !== undefined) {
        owner = cached;
        break;
      }

      walked.push(directory);

      if (has(directory)) {
        owner = directory;
        break;
      }

      if (directory === ".") break;
      directory = posix.dirname(directory);
    }

    for (const step of walked) ownerOf.set(step, owner);

    if (owner === null) return null;

    if (!configs.has(owner)) configs.set(owner, readTsconfigPaths(root, join(root, owner, configIn(owner)!)));

    return configs.get(owner)!;
  };
}

/** A language resolver's answer as the graph's. */
function fromLanguage(resolution: LanguageResolution, specifier: string, runtime: "python" | "rust" | "php"): Resolution {
  switch (resolution.kind) {
    case "internal":
      // `from . import core`, `use crate::util::{self}`: the import binds the module itself, a namespace of its names.
      return resolution.whole ? { kind: "file", path: resolution.file, whole: true } : { kind: "file", path: resolution.file };
    case "external":
      return { kind: "package", name: resolution.pkg };
    case "builtin":
    case "stdlib": {
      // Named as the language names it: Python's module (`os` of `os.path`), Rust's crate (`std` of `std::fs`), and
      // PHP's function itself (`strlen` of `App\strlen`: an unqualified call in a namespace falls back to the global one).
      const written = specifier.replace(/^(class|function|const|include) /, "");
      const name = runtime === "php" ? (written.split("\\").pop() ?? written) : (written.split(runtime === "rust" ? "::" : ".")[0] ?? written);

      return { kind: "builtin", name, runtime };
    }
    case "local":
      return { kind: "self" };
    case "generated":
      return { kind: "unresolved", reason: `generated: ${specifier}` };
    case "unresolved":
      return { kind: "unresolved", reason: `no such module: ${specifier}` };
  }
}

/**
 * A resolver over the repository's file list: `(from, specifier)` → where
 * it points, by the language of `from`: TypeScript/JavaScript here, Python,
 * Rust and PHP through the resolvers ported from keylang (PHP needs the
 * facts: its imports name declarations). `from` and the files are POSIX
 * paths relative to `root`.
 */
export function createResolver(root: string, files: Iterable<string>, facts: readonly FileFacts[] = [], tsconfigOf: (from: string) => TsconfigPaths | null = tsconfigResolver(root, files), workspaces: readonly Workspace[] = []): (from: string, specifier: string) => Resolution {
  const known = new Set(files);
  const factsByPath = new Map(facts.map((file) => [file.path, file]));
  const ecmascript = createEcmascriptResolver(root, known, tsconfigOf, new Map(workspaces.map((workspace) => [workspace.name, workspace])));
  let python: SourceResolver | null = null;
  let rust: SourceResolver | null = null;
  let php: SourceResolver | null = null;

  return (from, specifier) => {
    switch (languageOf(from)) {
      case "python":
        python ??= new PythonResolver(root, known);

        return fromLanguage(python.resolve(from, specifier), specifier, "python");
      case "rust": {
        rust ??= new RustResolver(root, known);
        const direct = rust.resolve(from, specifier);

        if (direct.kind !== "unresolved") return fromLanguage(direct, specifier, "rust");

        // `use self::Kind::*`, `use self::Kind`: a declaration of the file itself, not a module.
        if (specifier.startsWith("self::")) {
          const head = specifier.split("::")[1]!;

          if (factsByPath.get(from)?.decls.some((decl) => decl.name === head)) return { kind: "self" };
        }

        // A facade crate: `grep::printer::X` where grep's lib.rs says `pub use grep_printer as printer`. The longest prefix
        // that is a file names the facade; the next segment is looked up among that file's own imports and followed.
        const segments = specifier.split("::");

        for (let n = segments.length - 1; n >= 1; n--) {
          const prefix = rust.resolve(from, segments.slice(0, n).join("::"));

          if (prefix.kind !== "internal") continue;
          const facade = factsByPath.get(prefix.file);
          const next = segments[n]!;
          const rest = segments.slice(n + 1);
          const through = facade?.imports.find((fact) => fact.bindings.some((binding) => binding.local === next));

          // The prefix names a file but the next segment is no import of it: a shorter prefix may be the facade.
          if (!through) continue;
          const binding = through.bindings.find((candidate) => candidate.local === next)!;
          const target = binding.kind === "named" ? binding.imported : through.source.split("::").pop()!;
          const base = through.source.endsWith(`::${target}`) || through.source === target ? through.source : `${through.source}::${target}`;
          const hop = rust.resolve(prefix.file, rest.length === 0 ? base : `${base}::${rest.join("::")}`);

          if (hop.kind !== "unresolved") return fromLanguage(hop, specifier, "rust");
          break;
        }

        return fromLanguage(direct, specifier, "rust");
      }
      case "php":
        php ??= new PhpResolver(root, known, facts);

        return fromLanguage(php.resolve(from, specifier), specifier, "php");
      default:
        return ecmascript(from, specifier);
    }
  };
}

/** The TypeScript/JavaScript resolver: relative paths, `.js` for `.ts`, index files, tsconfig `paths`, packages, built-ins. */
function createEcmascriptResolver(root: string, known: ReadonlySet<string>, tsconfigOf: (from: string) => TsconfigPaths | null, workspaces: ReadonlyMap<string, Workspace>): (from: string, specifier: string) => Resolution {
  const rootPosix = root.split("\\").join("/");

  // A repository-relative candidate, as written or with an extension or index file added.
  const probe = (candidate: string): string | null => {
    if (known.has(candidate)) return candidate;
    const extension = posix.extname(candidate);

    for (const rewritten of REWRITES[extension] ?? []) {
      const swapped = candidate.slice(0, -extension.length) + rewritten;

      if (known.has(swapped)) return swapped;
    }

    for (const added of EXTENSIONS) if (known.has(candidate + added)) return candidate + added;

    for (const added of EXTENSIONS) if (known.has(posix.join(candidate, `index${added}`))) return posix.join(candidate, `index${added}`);

    return null;
  };

  // A tsconfig `paths` target directory, relative to the root.
  const relativeToRoot = (absolute: string): string => {
    const relative = posix.relative(rootPosix, absolute);

    return relative === "" ? "." : relative;
  };

  return (from, specifier) => {
    // Strip a query or hash (`./worker.js?worker`), which bundlers allow.
    const clean = specifier.replace(/[?#].*$/, "");

    if (clean.startsWith(".") || clean.startsWith("/")) {
      const candidate = clean.startsWith("/") ? clean.slice(1) : posix.normalize(posix.join(posix.dirname(from), clean));

      if (candidate.startsWith("..")) return { kind: "unresolved", reason: `outside the repository: ${specifier}` };
      const found = probe(candidate);

      if (found) return { kind: "file", path: found };

      // A file of the repository that is no source — JSON, a stylesheet, an image a bundler imports: nothing to draw, nothing missing.
      return isFileIn(rootPosix, candidate) ? { kind: "asset", path: candidate } : { kind: "unresolved", reason: `no such file: ${specifier}` };
    }

    if (BUILTINS.has(clean)) return { kind: "builtin", name: clean.replace(/^node:/, "") };
    const tsconfig = tsconfigOf(from);

    if (tsconfig) {
      // `paths`: the pattern TypeScript takes (an exact one, else the longest prefix), its targets in order.
      const best = bestPattern(tsconfig.paths, clean);

      for (const target of best?.targets ?? []) {
        const found = probe(posix.normalize(relativeToRoot(posix.join(tsconfig.baseDir, target.replace("*", best!.matched)))));

        if (found) return { kind: "file", path: found };
      }

      // `baseUrl`: a bare specifier names a file under it too (`lib/util` → `src/lib/util.ts` with `baseUrl: "src"`).
      if (tsconfig.baseUrl !== null) {
        const found = probe(posix.normalize(relativeToRoot(posix.join(tsconfig.baseUrl, clean))));

        if (found) return { kind: "file", path: found };
      }

      // An alias of the repository whose file is not there: no package is named `@/lib` or `~/x`.
      if (best && best.pattern !== "*" && !packageLike(packageName(clean))) return { kind: "unresolved", reason: `no file for the tsconfig path ${best.pattern}: ${specifier}` };
    }

    if (clean === "") return { kind: "unresolved", reason: "empty specifier" };

    // A package of the repository (a workspace of a monorepo), by its name: its source, not a package from outside.
    const workspace = workspaces.get(packageName(clean));

    if (workspace) {
      const rest = clean.slice(workspace.name.length + 1);
      const found = rest === "" ? workspace.entry : (probe(posix.join(workspace.dir, rest)) ?? probe(posix.join(workspace.dir, "src", rest)));

      return found ? { kind: "file", path: found } : { kind: "unresolved", reason: `no source of the repository's package ${workspace.name} for ${specifier}` };
    }

    return { kind: "package", name: packageName(clean) };
  };
}
