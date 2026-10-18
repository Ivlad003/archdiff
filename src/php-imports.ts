// PHP qualified name → file. A PHP import names a declaration, not a file:
// `App\Domain\Order` is the class `Order` of the namespace `App\Domain`
// wherever it is declared, so the resolver looks names up among the
// declarations of the analysed files (`FileFacts.symbols`), the way
// composer's class map does, without reading `autoload` at all. A name no file
// declares belongs to a composer package when a package's `autoload`
// (`psr-4`, `psr-0`) in `composer.lock` — or, without one, in
// `vendor/composer/installed.json` — claims its namespace. A global name (no
// namespace) nobody declares is PHP's own: a built-in class or function, or a
// global function a package defines, and so the standard library. A
// namespace written in a `use` (`use App\Domain;`) is no declaration: it binds
// nothing and adds no edge. Names compare without ASCII case, as PHP compares
// them: `App\ORDER` is `App\Order`, `App\äpfel` is not `App\Äpfel`.
//
// Specifiers (`src/extract/php.ts`): a class `App\Domain\Order`; a function
// `function App\f`, or `function App\f ?? f` for an unqualified call (the
// global function when the namespace declares none); a constant
// `const App\X`; a file `include <path>`.
//
// Place in the pipeline: source → FileFacts → graph; the import resolver for
// PHP that turns an extractor's specifier into a resolution (local,
// internal file, external package, stdlib, generated or unresolved).
// Entry points: `PhpResolver`, `packagePrefixes`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileFacts } from "./extract/facts.ts";
import type { Resolution, SourceResolver } from "./imports.ts";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";
import { asciiLowerCase } from "./languages.ts";

/** Lock files that say which namespaces each installed package holds, in the order they are read. */
const LOCKS = ["composer.lock", "vendor/composer/installed.json"];

/** Namespaces of PHP itself (`Random\Randomizer`, `Dom\HTMLDocument`). */
const PHP_NAMESPACES = ["random\\", "dom\\", "ffi\\", "pdo\\", "uri\\"];

/** Resolves PHP specifiers against the declarations of the analysed files and the packages of the composer lock. */
export class PhpResolver implements SourceResolver {
  private readonly root: string;
  private readonly sources: ReadonlySet<string>;
  /** Table → qualified name in ASCII lower case → files that declare it, sorted. */
  private readonly declared = { class: new Map<string, string[]>(), function: new Map<string, string[]>(), const: new Map<string, string[]>() };
  /** Namespaces the declarations are in, with every prefix, in ASCII lower case. */
  private readonly namespaces = new Set<string>();
  /** Namespace prefixes of packages in ASCII lower case (`symfony\component\httpfoundation\`), longest first. */
  private readonly packages: { prefix: string; name: string }[] = [];
  constructor(root: string, sources: ReadonlySet<string> = new Set(), files: readonly FileFacts[] = []) {
    this.root = root;
    this.sources = sources;

    // Index every declaration by its lower-cased qualified name, per table
    // (class, function, const), and record every enclosing namespace so a
    // bare namespace can be told from an unknown class.
    for (const facts of files) {
      for (const symbol of facts.symbols ?? []) {
        const key = asciiLowerCase(symbol.qualified);
        const table = this.declared[symbol.table];
        table.set(key, [...(table.get(key) ?? []), facts.path].sort());
        const parts = key.split("\\");

        for (let k = 1; k < parts.length; k++) this.namespaces.add(parts.slice(0, k).join("\\"));
      }
    }

    // Read the first lock file that exists; the other is only a fallback.
    for (const lock of LOCKS) {
      const text = readText(join(root, lock));

      if (text === null) continue;
      this.packages.push(...packagePrefixes(text));
      break;
    }

    // Longest prefix first, so a nested package namespace wins over its
    // parent's; ties by prefix so the order is stable.
    this.packages.sort((a, b) => b.prefix.length - a.prefix.length || (a.prefix < b.prefix ? -1 : a.prefix > b.prefix ? 1 : 0));
  }

  resolve(fromFile: string, spec: string): Resolution {
    // Decode the specifier: its table (class, function, const) and the names
    // to try in order (`App\f ?? f` tries the namespaced function first).
    if (spec.startsWith("include ")) return this.include(fromFile, spec.slice("include ".length));
    const kind = spec.startsWith("function ") ? "function" : spec.startsWith("const ") ? "const" : "class";
    const names = (kind === "class" ? spec : spec.slice(kind.length + 1)).split(" ?? ").map((name) => name.replace(/^\\/, ""));

    for (const name of names) {
      const files = this.declared[kind].get(asciiLowerCase(name));

      // A name declared twice (a polyfill, a conditional declaration) is the first file's, by path.
      if (files) return files[0] === fromFile ? { kind: "local" } : { kind: "internal", file: files[0]! };
    }

    const name = names[names.length - 1]!;
    const lower = asciiLowerCase(name);

    // Not declared anywhere: a class name that is itself a namespace (a
    // `use App\Domain;`) binds nothing; then a package prefix claims it.
    if (kind === "class" && this.namespaces.has(lower)) return { kind: "generated" };
    const pkg = this.packages.find((p) => lower.startsWith(p.prefix));

    if (pkg) return { kind: "external", pkg: pkg.name };

    // A global name nobody declares, or one of PHP's own namespaces: PHP itself (or a package's global function).
    if (!lower.includes("\\") || PHP_NAMESPACES.some((ns) => lower.startsWith(ns))) return { kind: "stdlib" };

    return { kind: "unresolved" };
  }

  /** `include <path>`: an analysed file, a file on disk archdiff does not index, or nothing; composer's own files are generated. */
  private include(fromFile: string, path: string): Resolution {
    // Absolute paths and paths that climb out of the root are not followed.
    if (path.startsWith("/") || path.startsWith("../") || path === "..") return { kind: "unresolved" };

    if (path === "vendor" || path.startsWith("vendor/")) return { kind: "generated" };

    if (path === fromFile) return { kind: "local" };

    if (this.sources.has(path) || existsSync(join(this.root, path))) return { kind: "internal", file: path };

    return { kind: "unresolved" };
  }
}

/** Namespace prefixes of each package a composer lock or `installed.json` lists; none when it is no such JSON. */
export function packagePrefixes(text: string): { prefix: string; name: string }[] {
  let value: JsonValue;

  try {
    value = parseJson(text);
  } catch {
    // A broken lock names no package: their imports stay unresolved, and so visible.
    return [];
  }

  // `composer.lock` and Composer 2's `installed.json` hold `packages`; Composer 1's `installed.json` is the list itself.
  const lists = Array.isArray(value) ? [value] : isJsonObject(value) ? [value.packages, value["packages-dev"]] : [];
  const out: { prefix: string; name: string }[] = [];

  for (const list of lists) {
    if (!Array.isArray(list)) continue;

    for (const pkg of list) {
      if (!isJsonObject(pkg) || !isJsonString(pkg.name) || !isJsonObject(pkg.autoload)) continue;

      for (const field of ["psr-4", "psr-0"]) {
        const map = pkg.autoload[field];

        if (!isJsonObject(map)) continue;

        // An empty prefix claims every name: no namespace can be told to be this package's.
        for (const prefix of Object.keys(map)) if (prefix !== "") out.push({ prefix: asciiLowerCase(prefix), name: pkg.name });
      }
    }
  }

  return out;
}

/** The file's text, or null when it does not exist or cannot be read. */
function readText(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}
