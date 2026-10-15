# archdiff

Live diagrams of a TypeScript/JavaScript repository, computed from the code: the layers and the imports between them, every module with what it imports and what imports it, the call tree from every entry point, the map of what the analysis cannot see, and the architectural diff of a change for reviewing pull requests. Algorithmic (tree-sitter and graph algorithms, no model), fast (a fact cache keyed by file content, parallel parsing), one npm package.

```bash
npx archdiff web            # the diagrams of the current repository in a browser
npx archdiff review         # the architectural diff against the main branch, as Markdown + Mermaid
```

## Commands

| Command | What it does | Exit |
| --- | --- | --- |
| `archdiff analyze [dir] [--json] [--no-cache]` | Parse the repository and print its size: files, functions, imports, calls followed and gaps | 0 |
| `archdiff views [dir]` | List every view: `layers`, `layer:<name>`, `module:<path>`, `calls:<path>#<fn>`, `coverage` | 0 |
| `archdiff diagram <view> [dir] [--format F] [--depth N] [--out FILE]` | Draw one view as `md` (Markdown with Mermaid, default), `mermaid`, `json`, `drawio`, `excalidraw` or `archimate` | 0 |
| `archdiff coverage [dir] [--json]` | The map of what the diagrams cannot show: blind calls, unresolved imports, syntax errors, by module | 0 |
| `archdiff review [dir] [--base REF] [--format F]` | Modules, functions, imports and calls added, removed or changed since REF (default: the merge-base with main); `1` when a new dependency between layers appeared | 0 / 1 |
| `archdiff web [dir] [--port N] [--base REF]` | The page: views on the left, the canvas, and the Markdown, code and coverage of what is picked | 0 |

Exit code `2` is a wrong invocation or an I/O error.

## Views and detail

- **layers** — one shape per layer with its module count, one line per import direction with the count.
- **layer:name** — the modules of a layer; `--depth 1` (default) adds the modules of other layers they import or are imported by.
- **module:path** — what the module imports (files and packages) and what imports it; `--depth 2` goes one step further.
- **calls:path#fn** — the call tree from a function, `--depth 3` by default; a hexagon is a call archdiff could not follow, with the reason. Double-click a function on the page to open its own tree.
- **coverage** — the modules with blind spots, biggest first.

Entry points come from the code and the frameworks: exported functions under `bin/`, functions named `main`, React Router route modules (the `loader`, `action`, `clientLoader`, `clientAction`, `default` and `ErrorBoundary` exports of files under a `routes/` directory), SFCC cartridge hooks (`cartridges/*/hooks.json`), the files named by `entries` in `archdiff.json`, and exported functions nothing in the repository calls.

## Layers

Without configuration a module's layer is its top directory, or `src/<dir>` under `src/`. `archdiff.json` at the root names them explicitly:

```json
{
  "layers": { "routes": ["src/routes/**"], "lib": ["src/lib/**"], "db": ["src/db/**"] },
  "exclude": ["**/*.stories.tsx"],
  "entries": ["src/jobs/**"]
}
```

Imports resolve like TypeScript: relative paths with or without extensions, `.js` written for a `.ts` file, `index` files, and the `paths` of the root `tsconfig.json`. Everything else is a package or a Node built-in.

## What the diagrams cannot show

A call is followed when its callee is a declaration of the same file, an import of a repository file, a member of a class the file declares or imports, or `this.m` inside a class. Everything else is a gap with a reason: `dynamic` (a computed callee) and `unknown-member` (a known class without that member) are blind spots inside the repository; `member-of-value` (`list.map`, `req.on`, `expect(x).toBe`), `global` and `external` are calls out of it. `archdiff coverage` and the Coverage tab of the page list them by module, so an empty diagram is never read as proof.

## Exports

Every view (and the review) exports to draw.io / diagrams.net (`.drawio`, uncompressed, each cell carrying the archdiff ID and the code position), Excalidraw (`.excalidraw`, shapes with bound text and arrows), Archi (ArchiMate Open Exchange XML: components, functions, relationships and one view at the laid-out places) and Mermaid.

## Speed, cache and CI

Facts are cached by file content in `.archdiff/facts.json.gz` (add `.archdiff/` to `.gitignore`); a second run parses only what changed. Cold start parses in worker threads: about 6 s for 500 files, 9 s for 2300. In CI, persist `.archdiff/` between runs and fetch enough history for the merge-base (`fetch-depth: 0`), or pass `--base origin/main`. Files over 1.5 MB are skipped and listed by `coverage`. `--out` only writes a new file or one archdiff wrote before. `web` binds to localhost and refuses requests whose Host header is not its own; `--host 0.0.0.0` exposes the sources to the network. The analysis of what can go wrong on real repositories is in [docs/production.md](docs/production.md).

## Development

```bash
npm install
npm run typecheck
npm test
node bin/archdiff.js web .
```

`npm pack` compiles `src/` to `dist/`, copies the tree-sitter grammars to `dist/wasm` and bundles the page to `dist/web`. The published package has one runtime dependency, `web-tree-sitter`; no native code is compiled on install.

## License

Apache-2.0. The extractor and the layout come from [keylang](https://github.com/Ivlad003/keylang).
