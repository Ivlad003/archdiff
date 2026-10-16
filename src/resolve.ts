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

import { existsSync, readFileSync } from "node:fs";
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
  | { kind: "file"; path: string }
  | { kind: "package"; name: string }
  | { kind: "builtin"; name: string }
  /** The importing file itself (Rust `use self::Kind::*`, a Python relative import of the package's own module): no dependency, nothing unresolved. */
  | { kind: "self" }
  | { kind: "unresolved"; reason: string };

/** The `paths` of a tsconfig, patterns to candidate prefixes, resolved against `baseUrl` (or the config's directory). */
export interface TsconfigPaths {
  baseDir: string;
  /** `@/*` → [`src/*`]; a pattern without `*` maps exactly. */
  paths: { pattern: string; targets: string[] }[];
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
 * The `paths` of a tsconfig (following `extends`: a relative file, or a
 * package's config under node_modules), or null without any. `root` is
 * the directory holding node_modules for a package `extends`.
 */
export function readTsconfigPaths(root: string, file = join(root, "tsconfig.json")): TsconfigPaths | null {
  const read = (file: string, depth: number): TsconfigPaths | null => {
    if (!existsSync(file) || depth > 5) return null;
    let config: JsonValue;

    try {
      config = parseJsonc(readFileSync(file, "utf8"));
    } catch {
      return null;
    }

    if (!isJsonObject(config)) return null;
    const options = config["compilerOptions"];
    const own = isJsonObject(options) ? options : {};
    const directory = posix.dirname(file.split("\\").join("/"));
    const baseUrl = isJsonString(own["baseUrl"]) ? posix.join(directory, own["baseUrl"]) : directory;
    const paths = own["paths"];

    if (isJsonObject(paths)) {
      const entries: TsconfigPaths["paths"] = [];

      for (const [pattern, targets] of Object.entries(paths)) {
        if (Array.isArray(targets)) entries.push({ pattern, targets: targets.filter(isJsonString) });
      }

      return { baseDir: baseUrl, paths: entries };
    }

    const parent = config["extends"];

    if (isJsonString(parent)) {
      if (parent.startsWith(".")) return read(posix.join(directory, parent.endsWith(".json") ? parent : `${parent}.json`), depth + 1);
      // `extends: "@tsconfig/node20/tsconfig.json"` or a package name: its config under node_modules, from the config's directory up to the root.
      const candidates = [posix.join(directory, "node_modules", parent), posix.join(root.split("\\").join("/"), "node_modules", parent)];

      for (const candidate of candidates) {
        for (const resolved of [candidate, `${candidate}.json`, posix.join(candidate, "tsconfig.json")]) if (existsSync(resolved)) return read(resolved, depth + 1);
      }
    }

    return null;
  };

  return read(file.split("\\").join("/"), 0);
}

/**
 * The tsconfig that governs a file: the nearest `tsconfig.json` in its
 * directory or above (a monorepo package has its own), read once per
 * directory. Falls back to the root's.
 */
export function tsconfigResolver(root: string, _files: Iterable<string>): (from: string) => TsconfigPaths | null {
  const present = new Map<string, boolean>();
  const has = (directory: string): boolean => {
    let known = present.get(directory);

    if (known === undefined) {
      known = existsSync(join(root, directory, "tsconfig.json"));
      present.set(directory, known);
    }

    return known;
  };

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

    if (!configs.has(owner)) configs.set(owner, readTsconfigPaths(root, join(root, owner, "tsconfig.json")));

    return configs.get(owner)!;
  };
}

/** A language resolver's answer as the graph's. */
function fromLanguage(resolution: LanguageResolution, specifier: string): Resolution {
  switch (resolution.kind) {
    case "internal":
      return { kind: "file", path: resolution.file };
    case "external":
      return { kind: "package", name: resolution.pkg };
    case "builtin":
    case "stdlib":
      return { kind: "builtin", name: specifier.replace(/^(class|function|const|include) /, "").split(/[.:\\]/)[0] ?? specifier };
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
export function createResolver(root: string, files: Iterable<string>, facts: readonly FileFacts[] = [], tsconfigOf: (from: string) => TsconfigPaths | null = tsconfigResolver(root, files)): (from: string, specifier: string) => Resolution {
  const known = new Set(files);
  const factsByPath = new Map(facts.map((file) => [file.path, file]));
  const ecmascript = createEcmascriptResolver(root, known, tsconfigOf);
  let python: SourceResolver | null = null;
  let rust: SourceResolver | null = null;
  let php: SourceResolver | null = null;

  return (from, specifier) => {
    switch (languageOf(from)) {
      case "python":
        python ??= new PythonResolver(root, known);

        return fromLanguage(python.resolve(from, specifier), specifier);
      case "rust": {
        rust ??= new RustResolver(root, known);
        const direct = rust.resolve(from, specifier);

        if (direct.kind !== "unresolved") return fromLanguage(direct, specifier);

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

          if (hop.kind !== "unresolved") return fromLanguage(hop, specifier);
          break;
        }

        return fromLanguage(direct, specifier);
      }
      case "php":
        php ??= new PhpResolver(root, known, facts);

        return fromLanguage(php.resolve(from, specifier), specifier);
      default:
        return ecmascript(from, specifier);
    }
  };
}

/** The TypeScript/JavaScript resolver: relative paths, `.js` for `.ts`, index files, tsconfig `paths`, packages, built-ins. */
function createEcmascriptResolver(root: string, known: ReadonlySet<string>, tsconfigOf: (from: string) => TsconfigPaths | null): (from: string, specifier: string) => Resolution {
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

      return found ? { kind: "file", path: found } : { kind: "unresolved", reason: `no such file: ${specifier}` };
    }

    if (BUILTINS.has(clean)) return { kind: "builtin", name: clean.replace(/^node:/, "") };
    const tsconfig = tsconfigOf(from);

    if (tsconfig) {
      for (const { pattern, targets } of tsconfig.paths) {
        const star = pattern.indexOf("*");
        const matched = star === -1 ? (clean === pattern ? "" : null) : clean.startsWith(pattern.slice(0, star)) && clean.endsWith(pattern.slice(star + 1)) ? clean.slice(star, clean.length - (pattern.length - star - 1)) : null;

        if (matched === null) continue;

        for (const target of targets) {
          const filled = target.replace("*", matched);
          const found = probe(posix.normalize(posix.join(relativeToRoot(posix.join(tsconfig.baseDir, filled)))));

          if (found) return { kind: "file", path: found };
        }
      }
    }

    if (clean === "") return { kind: "unresolved", reason: "empty specifier" };

    return { kind: "package", name: packageName(clean) };
  };
}
