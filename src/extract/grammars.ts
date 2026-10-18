// The tree-sitter grammars archdiff parses with. One list for the runtime
// (`treesitter.ts` loads them) and for packaging (`scripts/copy-wasm.mjs`
// copies each into dist/wasm), so a grammar cannot be left out of the
// published package.
//
// Entry points: `GRAMMARS`, `Grammar`, `wasmFile`.

/** Every grammar archdiff ships. */
export const GRAMMARS = ["typescript", "tsx", "javascript", "rust", "python", "php"] as const;

/** The name of one shipped grammar. */
export type Grammar = (typeof GRAMMARS)[number];

/** The grammar's file name in @vscode/tree-sitter-wasm and in dist/wasm. */
export function wasmFile(g: Grammar): string {
  return `tree-sitter-${g}.wasm`;
}
