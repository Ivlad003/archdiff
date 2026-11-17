// Java qualified name → file. A Java import names a class, not a file:
// `shop.store.Repo` is the class `Repo` of the package `shop.store` wherever
// its file lies (a Maven or Gradle source root is not read: the declarations
// are), so the resolver looks names up among the declarations of the
// analysed files (`FileFacts.symbols`), as PHP's does. A name no file
// declares is the JDK's when its package is (`java.`, `javax.`, `jdk.`…),
// unresolved when a file of the repository declares that package (a class
// generated at build time, a file left out), else a package: named by the
// first three elements of the Java package (`org.springframework.web`),
// since nothing in the source says which artifact holds a class.
//
// Specifiers (`src/extract/java.ts`): a class `shop.store.Repo` (a nested
// one `shop.Order.Line`); the candidates of a simple name in the order Java
// tries them, `shop.orders.Order ?? shop.store.Order` (the file's own
// package, then each package imported with `.*`); a package `shop.store.*`
// (the `.*` import itself: the classes used carry the dependencies, so it
// names no file).
//
// Place in the pipeline: source → FileFacts → graph; the import resolver for
// Java (resolve.ts asks it for every import of a `.java` file). Entry
// points: `JavaResolver`, `javaPackage`.

import type { FileFacts } from "./extract/facts.ts";
import type { Resolution, SourceResolver } from "./imports.ts";

/** The packages of the JDK: a class of one is the language's own library. */
const JDK = /^(java|javax|jdk|sun|com\.sun|org\.w3c|org\.xml|org\.ietf)\./;

/** The package of a qualified name or of a specifier: its elements up to the first capitalised one (`java.util` of `java.util.Map.Entry`, of `java.util.*`). */
export function javaPackage(qualified: string): string {
  const parts = qualified.replace(/\.\*$/, "").split(".");
  const end = parts.findIndex((part) => /^[A-Z]/.test(part));

  return (end === -1 ? parts : parts.slice(0, end)).join(".");
}

/** Resolves Java specifiers against the declarations of the analysed files. */
export class JavaResolver implements SourceResolver {
  /** Qualified name → the files that declare it, sorted (a class of main and of test sources, of two modules). */
  private readonly declared = new Map<string, string[]>();
  /** The packages the analysed files declare classes in. */
  private readonly packages = new Set<string>();

  constructor(_root: string, _sources: ReadonlySet<string> = new Set(), files: readonly FileFacts[] = []) {
    for (const facts of [...files].filter((each) => each.path.endsWith(".java")).sort((a, b) => (a.path < b.path ? -1 : 1))) {
      for (const symbol of facts.symbols ?? []) {
        this.declared.set(symbol.qualified, [...(this.declared.get(symbol.qualified) ?? []), facts.path]);
        this.packages.add(javaPackage(symbol.qualified));
      }
    }
  }

  resolve(fromFile: string, spec: string): Resolution {
    // `import shop.store.*`: the package itself; a package of the repository names no file.
    if (spec.endsWith(".*")) return this.packages.has(spec.slice(0, -2)) ? { kind: "local" } : this.outside(spec);
    const candidates = spec.split(" ?? ");

    for (const name of candidates) {
      // The class itself, else the class it is written in (`shop.Order.Line.Tax` of a file that says `Order.Line`), while what is left names a class.
      for (let qualified = name; ; ) {
        const files = this.declared.get(qualified);

        if (files) return this.fileOf(files, fromFile);
        const outer = qualified.slice(0, Math.max(0, qualified.lastIndexOf(".")));

        if (!/^[A-Z]/.test(outer.slice(outer.lastIndexOf(".") + 1))) break;
        qualified = outer;
      }
    }

    // One name written in full that nothing declares: the JDK's, a package's, or a class of the repository's own package that is not there.
    return candidates.length === 1 ? this.outside(spec) : { kind: "unresolved" };
  }

  /** The declaring file a class of `fromFile` means when several declare the name: the one of its own source set (`src/main`, `src/test`), then of its own module, else the first by path. */
  private fileOf(files: readonly string[], fromFile: string): Resolution {
    const at = /^((?:.*\/)?)src\/(main|test)\//.exec(fromFile);
    const near = at ? (files.find((file) => file.startsWith(`${at[1]}src/${at[2]}/`)) ?? files.find((file) => file.startsWith(`${at[1]}src/`))) : undefined;
    const best = files.find((file) => file === fromFile) ?? near ?? files[0]!;

    return best === fromFile ? { kind: "local" } : { kind: "internal", file: best };
  }

  /** A name no file declares, by its package. */
  private outside(spec: string): Resolution {
    const pkg = javaPackage(spec);

    if (JDK.test(`${pkg}.`)) return { kind: "stdlib" };

    if (pkg === "" || this.packages.has(pkg)) return { kind: "unresolved" };

    return { kind: "external", pkg: pkg.split(".").slice(0, 3).join(".") };
  }
}
