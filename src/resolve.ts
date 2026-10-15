// Where an import points: a file of the repository, a package, a Node
// built-in, or nowhere archdiff can see. Relative specifiers are probed
// against the file list the way TypeScript and Node do (extensions, `.js`
// written for a `.ts` file, `index` files); bare specifiers go through the
// `paths` of the root tsconfig.json first, then are read as packages.
// Nothing here reads a file but the tsconfig; the file list is the input.
//
// Sits between extraction and the graph: ImportFact.source → Resolution.
// Entry points: `createResolver`, `packageName`, `readTsconfigPaths`.

import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join, posix } from "node:path";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";

/** What an import specifier names. */
export type Resolution = { kind: "file"; path: string } | { kind: "package"; name: string } | { kind: "builtin"; name: string } | { kind: "unresolved"; reason: string };

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
const REWRITES: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };

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

/** The `paths` of `<root>/tsconfig.json` (following one level of `extends` of a relative file), or null without any. */
export function readTsconfigPaths(root: string): TsconfigPaths | null {
  const read = (file: string, depth: number): TsconfigPaths | null => {
    if (!existsSync(file) || depth > 3) return null;
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

    if (isJsonString(parent) && parent.startsWith(".")) return read(posix.join(directory, parent.endsWith(".json") ? parent : `${parent}.json`), depth + 1);

    return null;
  };

  return read(join(root, "tsconfig.json").split("\\").join("/"), 0);
}

/**
 * A resolver over the repository's file list: `(from, specifier)` → where
 * it points. `from` and the files are POSIX paths relative to `root`.
 */
export function createResolver(root: string, files: Iterable<string>, tsconfig: TsconfigPaths | null = readTsconfigPaths(root)): (from: string, specifier: string) => Resolution {
  const known = new Set(files);
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
