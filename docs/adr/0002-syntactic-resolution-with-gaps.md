# Calls are resolved from the syntax, and a call not followed is a gap

The graph is built from tree-sitter facts by archdiff's own resolver: imports through the language's rules (tsconfig paths, Python packages, Rust crates, PHP composer), calls through the names a file binds, the classes it declares or imports and the types the syntax names. A call the resolver cannot follow — a computed callee, a member of a value whose type is not written, an interface — is recorded as a gap with its reason and never guessed into an edge; the coverage report counts the gaps against the calls followed, so every picture says how much it does not show.

## Considered options

- The TypeScript compiler's program (or a language server per language): precise types, but seconds to minutes per run, one toolchain per language, native builds for some, and a different answer per tsconfig mode; archdiff reads five languages in one process with no native code and caches facts per file.
- Heuristic matching of callee names across the repository: more edges, but edges a reader cannot trust; a wrong line on an architecture picture costs more than a missing one that the picture admits to.
