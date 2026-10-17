# archdiff

Live architecture diagrams of a TypeScript, JavaScript, Python, Rust or PHP repository, computed from the code without a model: the layers and the imports between them, every module and function with its calls, the map of what the analysis cannot see, the architectural diff of a change for reviewing pull requests, and a contract (`ARCHITECTURE.md`) the code is checked against. One npm package, `@ivlad003/archdiff`, with a CLI and a local web page.

## Tech stack

- Node 22+, TypeScript (strict, ESM, type stripping in development; compiled to `dist/` by `prepack`).
- tree-sitter grammars as WASM (`web-tree-sitter`) for parsing; worker threads for parallel extraction; a gzipped fact cache in `.archdiff/`.
- The page: one HTML file, Excalidraw as the canvas, `marked` + `DOMPurify` for Markdown, built with esbuild.
- Tests: `node:test` through the real CLI and HTTP API; Playwright with the system Chrome for the page.

## Conventions

- Pipelines with explicit contracts: source files → `FileFacts` → `Graph` → views → placed `Diagram` → Markdown, Mermaid, draw.io, Excalidraw, ArchiMate.
- Deterministic output: stable IDs, sorted order, relative POSIX paths; the same sources give the same picture.
- Side effects at the edges (git, the file system, the agent process); the core is pure.
- Every picture explains itself: a `reason` when it is cut, folded or empty; a `question` it answers; the commit it was drawn from.
- Nothing runs by itself: the agent starts from a button or a command, with the prompt as shown.

## Specs

- `analysis`: files to facts to graph, the cache, the gaps.
- `views`: which picture answers which question, and the steps after a view (hubs, fold, weight, expand, hidden lanes).
- `page`: the web page — the canvas, the taps, the tools, the panels, the options, the link.
- `intent`: `ARCHITECTURE.md` as the contract, the intent view, `check`, `import`, `new`.
- `agent`: handing a task to Claude Code or Cursor, the protocol, the questions, the Chat tab.
- `exports`: Markdown, Mermaid, draw.io, Excalidraw, ArchiMate, JSON.
- `review`: the architectural diff of a change, branches, history, the GitHub Action.
- `cli`: the commands, their flags, exit codes and output channels.
