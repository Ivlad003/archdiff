// Go import path → file. A Go package is a directory, and an import names
// the package, never a file: so the frontend writes an import per
// declaration it uses, and the resolver finds the file of the package that
// declares the name, among the declarations of the analysed files
// (`FileFacts.symbols`). The package of an import path is found through the
// `go.mod` files of the repository: a module's path is its directory, the
// rest of the import path a directory under it (`replace x => ./dir` names
// another). A path of no module of the repository is the standard library
// when its first element has no dot (`fmt`, `net/http`), else a package:
// the module a `require` of the governing `go.mod` names, or the path's
// first three elements.
//
// Specifiers (`src/extract/go.ts`): a package `shop/store` (the import
// itself: the declarations used carry the dependencies, so it names no
// file); a blank import `_ shop/store` (the package's first file: it is
// imported for what it does when loaded); a declaration `shop/store.Save`;
// a declaration of the importing file's own package `.save`.
//
// Place in the pipeline: source → FileFacts → graph; the import resolver
// for Go (resolve.ts asks it for every import of a `.go` file). The
// `go.mod` files are read on every analysis. Entry point: `GoResolver`.

import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { FileFacts } from "./extract/facts.ts";
import type { Resolution, SourceResolver } from "./imports.ts";

/** One `go.mod` of the repository: where it is, the module it declares, what it requires and replaces. */
interface GoModule {
  /** The directory of the `go.mod`, POSIX, relative to the root ("." for the root). */
  dir: string;
  path: string;
  requires: string[];
  /** Module path → a directory of the repository (`replace x => ./lib`). */
  replaces: Map<string, string>;
}

/** A declaration of a package, in one of its files. */
interface Declared {
  file: string;
  /** The file holds only methods of the type (`QualifiedSymbol.part`): the type itself is declared elsewhere. */
  part: boolean;
}

/** Resolves Go specifiers against the packages of the repository's modules and the declarations of the analysed files. */
export class GoResolver implements SourceResolver {
  private readonly root: string;
  /** Package directory → declared name → the files that declare it, sorted. */
  private readonly packages = new Map<string, Map<string, Declared[]>>();
  /** Package directory → its files, sorted. */
  private readonly filesOf = new Map<string, string[]>();
  private readonly modules = new Map<string, GoModule | null>();
  /** Every module of the repository, found once. */
  private all: GoModule[] | null = null;
  /** Governing module and import path → the directory it names, or null. */
  private readonly dirs = new Map<string, string | null>();

  constructor(root: string, sources: ReadonlySet<string> = new Set(), files: readonly FileFacts[] = []) {
    this.root = root;

    for (const file of [...sources].filter((path) => path.endsWith(".go")).sort()) {
      const dir = posix.dirname(file);
      this.filesOf.set(dir, [...(this.filesOf.get(dir) ?? []), file]);
    }

    for (const facts of [...files].filter((each) => each.path.endsWith(".go")).sort((a, b) => (a.path < b.path ? -1 : 1))) {
      const dir = posix.dirname(facts.path);
      let names = this.packages.get(dir);

      if (!names) this.packages.set(dir, (names = new Map()));

      for (const symbol of facts.symbols ?? []) names.set(symbol.name, [...(names.get(symbol.name) ?? []), { file: facts.path, part: symbol.part === true }]);
    }
  }

  resolve(fromFile: string, spec: string): Resolution {
    // A name of the importing file's own package.
    if (spec.startsWith(".")) return this.declaration(posix.dirname(fromFile), spec.slice(1), fromFile);
    const blank = spec.startsWith("_ ");
    const { path, name } = splitSpecifier(blank ? spec.slice(2) : spec);
    const module = this.moduleOf(posix.dirname(fromFile));
    const dir = this.packageDir(path, module);

    if (dir === null) {
      if (!path.split("/")[0]!.includes(".")) return { kind: "stdlib" };
      const required = module?.requires.filter((each) => path === each || path.startsWith(`${each}/`)).sort((a, b) => b.length - a.length)[0];

      return { kind: "external", pkg: required ?? path.split("/").slice(0, 3).join("/") };
    }

    if (name !== null) return this.declaration(dir, name, fromFile);
    const sources = this.filesOf.get(dir);

    // A package of a module of the repository with no analysed file: generated, excluded, or not there.
    if (!sources) return { kind: "unresolved" };

    // The package itself binds no file: every declaration used is an import of its own. A blank import is for what the package does when it loads.
    if (!blank) return { kind: "local" };
    const first = sources.find((file) => !file.endsWith("_test.go")) ?? sources[0]!;

    return first === fromFile ? { kind: "local" } : { kind: "internal", file: first, whole: true };
  }

  /** The file of the package in `dir` that declares `name`: the declaration itself before a part of it, a test file last. */
  private declaration(dir: string, name: string, fromFile: string): Resolution {
    const declared = this.packages.get(dir)?.get(name);

    if (!declared) return { kind: "unresolved" };
    const rank = (each: Declared): number => (each.part ? 1 : 0) + (each.file.endsWith("_test.go") ? 2 : 0);
    const best = [...declared].sort((a, b) => rank(a) - rank(b) || (a.file < b.file ? -1 : 1))[0]!;

    return best.file === fromFile ? { kind: "local" } : { kind: "internal", file: best.file };
  }

  /** The directory of the repository an import path names, through the module governing the importing file and every other module found; null when no module of the repository holds it. */
  private packageDir(path: string, module: GoModule | null): string | null {
    const key = `${module?.dir ?? ""}\0${path}`;
    const cached = this.dirs.get(key);

    if (cached !== undefined) return cached;
    // The modules of the repository — the one above every package directory (a workspace has several) — and what the governing one replaces.
    this.all ??= [...new Map([...this.filesOf.keys()].map((dir) => this.moduleOf(dir)).filter((each) => each !== null).map((each) => [each.dir, each])).values()];
    const candidates = [...this.all.map((each) => ({ path: each.path, dir: each.dir })), ...[...(module?.replaces ?? [])].map(([replaced, dir]) => ({ path: replaced, dir }))];
    // The longest module path that is the import path or a prefix of it.
    const holder = candidates.filter((each) => path === each.path || path.startsWith(`${each.path}/`)).sort((a, b) => b.path.length - a.path.length)[0];
    const found = holder ? posix.normalize(posix.join(holder.dir, path.slice(holder.path.length + 1))) : null;
    this.dirs.set(key, found);

    return found;
  }

  /** The module governing a directory: the nearest `go.mod` at or above it. */
  private moduleOf(dir: string): GoModule | null {
    const cached = this.modules.get(dir);

    if (cached !== undefined) return cached;
    let found = this.readModule(dir);

    if (!found && dir !== ".") found = this.moduleOf(posix.dirname(dir));
    this.modules.set(dir, found);

    return found;
  }

  /** The `go.mod` of a directory, read as text: its `module`, `require` and `replace` lines. */
  private readModule(dir: string): GoModule | null {
    const file = join(this.root, dir, "go.mod");

    if (!existsSync(file)) return null;
    const text = readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
    const path = /^\s*module\s+"?([^\s"]+)"?/m.exec(text)?.[1];

    if (!path) return null;
    const requires: string[] = [];
    const replaces = new Map<string, string>();
    let block: "require" | "replace" | null = null;

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();

      if (line === ")") block = null;
      else if (/^(require|replace)\s*\($/.test(line)) block = line.startsWith("require") ? "require" : "replace";
      else {
        const entry = block ? `${block} ${line}` : line;
        const required = /^require\s+"?([^\s"]+)"?\s+\S+/.exec(entry);
        const replaced = /^replace\s+"?([^\s"]+)"?(?:\s+\S+)?\s+=>\s+"?(\.{1,2}\/[^\s"]*|\.{1,2})"?/.exec(entry);

        if (required) requires.push(required[1]!);
        else if (replaced) {
          const target = posix.normalize(posix.join(dir, replaced[2]!));

          if (!target.startsWith("..")) replaces.set(replaced[1]!, target);
        }
      }
    }

    return { dir, path, requires, replaces };
  }
}

/**
 * An import path, and the declaration named after it: `shop/store.Save` is `Save` of `shop/store`. A name used
 * across packages is capitalised and a path's last element never ends so, which tells `gopkg.in/yaml.v3` (a
 * package) from `gopkg.in/yaml.v3.Marshal`.
 */
function splitSpecifier(spec: string): { path: string; name: string | null } {
  const dot = spec.lastIndexOf(".");

  return dot > spec.lastIndexOf("/") && /^\p{Lu}[\p{L}\p{N}_]*$/u.test(spec.slice(dot + 1)) ? { path: spec.slice(0, dot), name: spec.slice(dot + 1) } : { path: spec, name: null };
}
