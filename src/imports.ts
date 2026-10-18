// The contract between a language's import resolver and the graph, as the
// resolvers ported from keylang (python-imports.ts, rust-imports.ts,
// php-imports.ts) implement it: a specifier of an import, as the
// extractor wrote it, becomes a `Resolution`. resolve.ts turns these into
// archdiff's own `Resolution` (file, package, builtin, unresolved) for the
// graph, beside its TypeScript resolver.
//
// Entry points: `Resolution`, `SourceResolver`.

/** What a specifier names, as the language resolvers say it. */
export type Resolution =
  /** `whole`: the specifier names the module itself; `nested`: the path goes on into a module declared inside the file. */
  | { kind: "internal"; file: string; workspace?: string; whole?: true; nested?: true }
  /** The specifier names the importing file itself (Rust `use self::X`): no dependency. */
  | { kind: "local" }
  | { kind: "external"; pkg: string }
  | { kind: "builtin" }
  /** A module of the language's standard library that is no package (Python `typing`). */
  | { kind: "stdlib" }
  | { kind: "generated" }
  | { kind: "unresolved" };

/** The per-language resolver: specifier → `Resolution`. */
export interface SourceResolver {
  resolve(fromFile: string, spec: string): Resolution;
  /** The source paths the specifier would name, whether or not they exist, in the order resolution tries them. */
  wouldName?(fromFile: string, spec: string): string[];
  verbatimModuleSyntax?(file: string): boolean;
}
