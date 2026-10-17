# Changelog

## 0.1.0 — 2026-10-17

The first release.

- Analysis of TypeScript, JavaScript, Python, Rust and PHP repositories with tree-sitter: modules in layers, functions, imports (resolved per language), calls followed through declarations, imports, receiver types, interfaces and re-exports; gaps kept explicit.
- Views: `layers`, `layer:<name>`, `dir:<path>`, `module:<path>`, `calls:<path>#<fn>`, `coverage`; big views fold by directory.
- `review` — the architectural diff between two revisions without a checkout; `history` — commit by commit; a GitHub Action that posts the review on a pull request.
- The page: one Excalidraw canvas for reading (tap for the code and Markdown, tap again to open) and drawing (pencil, notes, PNG/SVG), drawings saved to `.archdiff/layouts/`, breadcrumbs, dark theme, live reload.
- `flow` — the data flow from an entry point with mock values carried by name, without running code.
- `plan` and the Chat tab — the task drawn on a view handed to Claude Code or Cursor's CLI, every run from a button.
- Exports: Mermaid, draw.io, Excalidraw, ArchiMate Open Exchange (Archi).
- A fact cache keyed by content (gzipped), parallel parsing in worker threads.
