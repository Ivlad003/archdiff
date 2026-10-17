# Changelog

## Unreleased

- The canvas toolbar: a picture select (this subject's pictures, then the overviews), detail presets minimal / normal / full and depth −/+, **mix** (a tapped module opens in place as a lane of its functions, the lines landing on the functions they concern; `--expand` in the terminal) and **focus** (everything but a tapped shape and its neighbours dims).

## 0.3.0 — 2026-10-17

(0.2.0 was committed but never published; its changes are here.)

- `web` without `--port` takes 7080 or the next free port above it, and says so; a named port that is taken is an error, as before.
- Eleven views that each answer one architectural question: `classes` (the class diagram, Mermaid classDiagram), `cycles`/`cycle:`, `matrix`, `type:`, `path:`, `contract:`, `events`, `tests`, `hotspots`, `packages`, `timeline`.
- Branches: a branch bar with the base (develop, main or master by default) and any number of heads; `compare` draws several heads against one base, every module labelled with what each head did; `archdiff branches` and `archdiff compare --heads a,b,WORKTREE` in the terminal.
- Flow: mocks generated from the types or by the agent from a description; ▶ play lights the steps on the diagram.
- Chat: `@module:` / `@fn:` / `@layer:` / `@dir:` / `@flow:` / `@type:` tags with suggestions, expanded into context for the agent; the shapes of files the agent touches light up while it works.
- The extractor records the event name of listeners (`on`, `subscribe`, `addEventListener`…) beside emitters.
- `--changes` (and the "changes" box on the page) lays the review's marks over any view: structure and change in one picture.
- `--mermaid c4|quadrant|pie|gitgraph|mindmap` writes the Mermaid type that fits a view; `classes` and `sequence:` have their own; the README says which fits where.
- Readability, after the research note (docs/research/readable-diagrams.md): views fold above 40 shapes (was 80); a module most of a picture imports becomes a badge "+ log.ts" on its importers (`--no-hubs` draws it); `--weight N` leaves out lines lighter than N; `matrix:<dir>` is the dependency structure matrix of a directory; a sequence keeps at most 12 lifelines and collapses a call repeated in a row into "×N"; the layout sweeps the ranks back and forth (barycentre) before placing; every picture names the question it answers and the commit it was drawn from; the page has reader presets (reviewer, newcomer, architect) and names the direction of the lines in its legend; a test keeps the crossings of the fixture's views at their baseline.
- A tap on a line lights it with its two ends and shows what it joins: the imports and calls behind it with their `file:line` (`/api/edge`). Several lines under one tap are listed to pick from; *follow* (Shift+tap) lights the chain onward and lists what it reaches; the line under the pointer lights on hover.
- Arrows never run through a shape: a route over several columns takes a corridor between the rows of the columns in between, a backward route runs through the gaps beside the columns, and a test keeps the invariant on every view of the fixture and on grids that force each case.
- Overlays over any view, in any mix: `--overlay tests,storages,heat` marks the modules no test imports, labels the storages and shades every shape by the calls into it; with `--changes` the review's marks lie over the same picture.
- The page's ⚙ options panel (`o`) sets the depth, the fold limit, the packages, the overlays and the Mermaid type; every option travels in the link, "remember as defaults" keeps them in the browser, "reset" forgets them.
- docs/media: screenshots of every view and a walkthrough video.

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
