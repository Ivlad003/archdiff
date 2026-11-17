// C# qualified name → file. A `using` names a namespace, and a namespace is
// as many files as declare into it, so the resolver looks a class up among
// the declarations of the analysed files (`FileFacts.symbols`), as Java's
// and PHP's do; no project file says where a class lies. The candidates of a
// simple name are tried in the order the frontend wrote them (the namespaces
// around the file's own, then its `using`s), and after them the namespaces
// the repository's `global using` directives name, which reach every file
// of their project. A namespace nobody declares is .NET's own when it is
// `System` or under it (`dotnet:System.Linq`), else a package: the
// `PackageReference` of the nearest `.csproj` above the file whose name the
// namespace starts with, or the namespace's first two elements.
//
// Specifiers (`src/extract/csharp.ts`): a namespace `Shop.Store.*` (the
// `using` itself: the classes used carry the dependencies, so it names no
// file); a class `Shop.Store.Repo` (an alias, a `using static`, a name
// written in full); the candidates of a simple name,
// `Shop.Orders.Order ?? Shop.Order ?? Order ?? Shop.Store.Order`.
//
// Place in the pipeline: source → FileFacts → graph; the import resolver for
// C# (resolve.ts asks it for every import of a `.cs` file). The `.csproj`
// files are read on every analysis. Entry point: `CSharpResolver`.

import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { FileFacts } from "./extract/facts.ts";
import type { Resolution, SourceResolver } from "./imports.ts";

/** A declaration of a class, in one file. */
interface Declared {
  file: string;
  /** One part of a `partial` class. */
  part: boolean;
}

/** Resolves C# specifiers against the declarations of the analysed files and the packages of the project files. */
export class CSharpResolver implements SourceResolver {
  private readonly root: string;
  /** Qualified name → the files that declare it, sorted. */
  private readonly declared = new Map<string, Declared[]>();
  /** The namespaces the analysed files declare classes in, with every namespace around them. */
  private readonly namespaces = new Set<string>();
  /** The namespaces the repository's `global using` directives name, in file order. */
  private readonly globals: string[] = [];
  /** Directory → the packages its nearest `.csproj` references. */
  private readonly packages = new Map<string, string[]>();

  constructor(root: string, _sources: ReadonlySet<string> = new Set(), files: readonly FileFacts[] = []) {
    this.root = root;

    for (const facts of [...files].filter((each) => each.path.endsWith(".cs")).sort((a, b) => (a.path < b.path ? -1 : 1))) {
      for (const symbol of facts.symbols ?? []) {
        this.declared.set(symbol.qualified, [...(this.declared.get(symbol.qualified) ?? []), { file: facts.path, part: symbol.part === true }]);
        const parts = symbol.qualified.split(".");

        for (let k = 1; k < parts.length; k++) this.namespaces.add(parts.slice(0, k).join("."));
      }

      for (const fact of facts.imports) if (fact.glob && /^global\s+using\b/.test(fact.text) && !this.globals.includes(fact.source.slice(0, -2))) this.globals.push(fact.source.slice(0, -2));
    }
  }

  resolve(fromFile: string, spec: string): Resolution {
    // `using Shop.Store;`: the namespace itself; one of the repository names no file.
    if (spec.endsWith(".*")) return this.namespaces.has(spec.slice(0, -2)) ? { kind: "local" } : this.outside(fromFile, spec.slice(0, -2));
    const candidates = spec.split(" ?? ");
    const simple = candidates.length > 1 ? candidates[0]!.slice(candidates[0]!.lastIndexOf(".") + 1) : null;

    for (const name of [...candidates, ...(simple === null ? [] : this.globals.map((ns) => `${ns}.${simple}`))]) {
      const files = this.declared.get(name);

      if (files) return files.some((each) => each.file === fromFile) ? { kind: "local" } : { kind: "internal", file: this.fileOf(name, files) };
    }

    // One name written in full that nothing declares: .NET's, a package's, or a class of the repository's own namespace that is not there.
    if (candidates.length > 1) return { kind: "unresolved" };
    const ns = spec.includes(".") ? spec.slice(0, spec.lastIndexOf(".")) : "";

    return ns === "" || this.namespaces.has(ns) ? { kind: "unresolved" } : this.outside(fromFile, ns);
  }

  /**
   * The file that stands for a class: its one declaration; of a `partial` class the part named after it
   * (`OrderService.cs`, not `OrderService.Find.cs`), else the first by path. The graph looks a member up in every part.
   */
  private fileOf(qualified: string, files: readonly Declared[]): string {
    const simple = qualified.slice(qualified.lastIndexOf(".") + 1);

    return (files.find((each) => posix.basename(each.file) === `${simple}.cs`) ?? files[0]!).file;
  }

  /** A namespace no file declares into: .NET's base library, else a package. */
  private outside(fromFile: string, ns: string): Resolution {
    if (ns === "System" || ns.startsWith("System.")) return { kind: "stdlib" };
    const referenced = this.packagesOf(posix.dirname(fromFile)).filter((name) => ns === name || ns.startsWith(`${name}.`)).sort((a, b) => b.length - a.length)[0];

    return { kind: "external", pkg: referenced ?? ns.split(".").slice(0, 2).join(".") };
  }

  /** The packages the nearest `.csproj` at or above a directory references (`<PackageReference Include="…">`), read as text. */
  private packagesOf(dir: string): string[] {
    const cached = this.packages.get(dir);

    if (cached) return cached;
    let found: string[] | null = null;

    try {
      const projects = readdirSync(join(this.root, dir)).filter((name) => name.endsWith(".csproj")).sort();

      if (projects.length > 0) found = projects.flatMap((name) => [...readFileSync(join(this.root, dir, name), "utf8").matchAll(/<PackageReference\s+[^>]*Include\s*=\s*"([^"]+)"/g)].map((match) => match[1]!));
    } catch {
      found = null;
    }

    const packages = found ?? (dir === "." ? [] : this.packagesOf(posix.dirname(dir)));
    this.packages.set(dir, packages);

    return packages;
  }
}
