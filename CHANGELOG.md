# Changelog

## 0.2.0 — 2026-10-17

- Ten views that each answer one architectural question: `cycles`/`cycle:`, `matrix`, `type:`, `path:`, `contract:`, `events`, `tests`, `hotspots`, `packages`, `timeline`.
- Branches: a branch bar with the base (develop, main or master by default) and any number of heads; `compare` draws several heads against one base, every module labelled with what each head did; `archdiff branches` and `archdiff compare --heads a,b,WORKTREE` in the terminal.
- Flow: mocks generated from the types or by the agent from a description; ▶ play lights the steps on the diagram.
- Chat: `@module:` / `@fn:` / `@layer:` / `@dir:` / `@flow:` / `@type:` tags with suggestions, expanded into context for the agent; the shapes of files the agent touches light up while it works.
- The extractor records the event name of listeners (`on`, `subscribe`, `addEventListener`…) beside emitters.

## 0.1.1 — 2026-10-17

- Two views: `inside:<module>` (its functions and the calls among them, modules as lanes) and `sequence:<fn>` (the calls from a function as a sequence diagram, Mermaid `sequenceDiagram` in the Markdown); a second tap on a module opens its inside; a select beside the title switches between the pictures of one subject.
- Arrows: ports spread along a shape's sides, channels spread across a wider gap, no overlapping ends; generated arrows keep their routes.
- The canvas fits the scene itself (Excalidraw's fit zoomed a small scene out to a speck).
- A module's declarations fold open in the Markdown panel to their calls and their code.
- Published as `@ivlad003/archdiff`; `prepack` no longer asks for provenance outside CI.

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
