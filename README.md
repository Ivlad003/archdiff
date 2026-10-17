# archdiff

Live diagrams of a TypeScript, JavaScript, Python, Rust or PHP repository, computed from the code: the layers and the imports between them, every module with what it imports and what imports it, the call tree from every entry point, the map of what the analysis cannot see, and the architectural diff of a change for reviewing pull requests. Algorithmic (tree-sitter and graph algorithms, no model), fast (a fact cache keyed by file content, parallel parsing), one npm package.

```bash
npx @ivlad003/archdiff web      # the diagrams of the current repository in a browser
npx @ivlad003/archdiff review   # the architectural diff against the main branch, as Markdown + Mermaid
```

The package is `@ivlad003/archdiff` on npm (npm refused the bare name as too close to `arr-diff`); the command it installs is `archdiff`, so after `npm i -g @ivlad003/archdiff` every example below reads as written.

## Commands

| Command | What it does | Exit |
| --- | --- | --- |
| `archdiff analyze [dir] [--json] [--no-cache]` | Parse the repository and print its size: files, functions, imports, calls followed and gaps | 0 |
| `archdiff views [dir]` | List every view: `layers`, `layer:<name>`, `dir:<path>`, `module:<path>`, `calls:<path>#<fn>`, `coverage` | 0 |
| `archdiff diagram <view> [dir] [--format F] [--depth N] [--out FILE]` | Draw one view as `md` (Markdown with Mermaid, default), `mermaid`, `json`, `drawio`, `excalidraw` or `archimate` | 0 |
| `archdiff coverage [dir] [--json]` | The map of what the diagrams cannot show: blind calls, unresolved imports, syntax errors, by module | 0 |
| `archdiff flow <calls:view> [dir] [--depth N] [--json]` | The data flow from an entry point without running it: the steps in call order with parameter and return types, the storages on the way, the saved mock values carried by name | 0 |
| `archdiff review [dir] [--base REF] [--head REF] [--format F]` | Modules, functions, imports and calls added, removed or changed between the base (default: the merge-base with main) and the head (default: the working tree); `1` when a new dependency between layers appeared | 0 / 1 |
| `archdiff history [dir] [--base REF] [--head REF] [--json]` | The drift commit by commit: modules, functions, imports, layer couplings and packages each commit added or removed | 0 |
| `archdiff layouts [dir] [--prune]` | The saved drawings; `--prune` deletes those whose view the code no longer has | 0 |
| `archdiff plan <view> [dir] [--json] [--out FILE]` | The task drawn on the saved drawing of a view: new shapes as modules or functions, arrows as imports or calls, deleted shapes as removals, notes — Markdown for an agent | 0 |
| `archdiff web [dir] [--port N] [--base REF] [--agent claude\|cursor]` | The page: views on the left, one Excalidraw canvas (reading, and drawing on demand), and the Markdown, code, coverage and data flow of what is picked | 0 |

Exit code `2` is a wrong invocation or an I/O error.

## Views and detail

- **layers** — one shape per layer with its module count, one line per import direction with the count.
- **layer:name** — the modules of a layer; `--depth 1` (default) adds the modules of other layers they import or are imported by.
- **dir:path** — the modules of a directory (and below) with their neighbours: the rung between a layer and a module.
- **module:path** — what the module imports (files and packages) and what imports it; `--depth 2` goes one step further.
- **inside:path** — the functions, classes and methods of a module and the calls among them, each module a lane; `--depth 1` (default) adds the functions of other modules they call. What a file does, as a map.
- **sequence:path#fn** — the calls from a function as a sequence diagram: the modules on the way across the top (at most 12 lifelines; the rest share one), every call a numbered message in the order the code makes them, a call repeated in a row as one message "×N" (Mermaid `sequenceDiagram` in the Markdown).
- **path:path#fn** — from an entry point to the storages only: every branch that leads to no store, database or cache is pruned.
- **type:path#Type** — where a type flows: the functions that produce it, consume it or transform it, storages marked.
- **contract:path** — the exports of a module and who uses each from outside; an export nothing uses says so.
- **classes**, **classes:path**, **classes:dir** — the class diagram: every class, interface and object type as a box with its fields (`+`, `-`, `#`) and methods, `extends` and `implements` as lines, modules as lanes; Mermaid `classDiagram` in the Markdown. A box's second tap opens the module's inside.
- **cycles** / **cycle:path** — modules importing each other, one lane per strongly connected component.
- **matrix**, **matrix:dir** — the dependency structure matrix of the layers, or of a directory's modules: rows import columns, counts in the cells, imports against the order in red. A matrix scales where a graph of the same size tangles.
- **events** — emitters → event names → listeners (`emit`/`publish`/`dispatch` and `on`/`subscribe`/`addEventListener` with a literal name).
- **tests** — which modules the test files import; a module no test imports is marked.
- **hotspots** — every module as a box sized by its lines and shaded by the calls into it from other modules.
- **packages** — the package.json files of a monorepo as a system: declared dependencies, imports between packages, and imports no package.json admits.
- **timeline** — the drift of the architecture commit by commit as bars (`--base`, `--head`), red when a commit coupled two layers.
- **calls:path#fn** — the call tree from a function, `--depth 3` by default; a hexagon is a call archdiff could not follow, with the reason. Double-click a function on the page to open its own tree.
- **coverage** — the modules with blind spots, biggest first.

Entry points come from the code and the frameworks: exported functions under `bin/`, functions named `main`, React Router route modules (the `loader`, `action`, `clientLoader`, `clientAction`, `default` and `ErrorBoundary` exports of files under a `routes/` directory), SFCC cartridge hooks (`cartridges/*/hooks.json`), the files named by `entries` in `archdiff.json`, and exported functions nothing in the repository calls.

## The page

One canvas, Excalidraw, in its hand-drawn style. Reading: tap a shape for its code and Markdown (a module's declarations fold open to their calls and code), tap a line to light it with its two ends and read where it leads — the imports and calls behind it, each with its `file:line`; where several lines run together the panel lists them all to pick from, and *follow* (or Shift+tap) lights the whole chain the arrows lead on to; the line under the pointer lights as you hover — tap a shape again to open its own view (a layer → its modules, a module → inside it, a function → its calls); the select beside the title switches between the pictures of one subject (dependencies or inside; call tree or sequence), drag to pan, wheel to zoom, `0` fits, Backspace goes back. Big views fold their tail by directory into "… N in src/x/" shapes (a tap opens that directory) so the picture stays readable — above 40 shapes by default, since a picture reads best well under that; the Markdown lists everything. A module most of a picture imports (a logger, the shared types) is drawn as a badge "+ log.ts" on its importers rather than as a fan of lines across everything (`--no-hubs` or the *hubs as badges* box draws it); *lines of weight ≥ N* leaves out lines standing for fewer than N imports or calls. Every picture carries the one question it answers (the title's tooltip, the first line of its Markdown) and the commit it was drawn from (in every export). Arrows leave a shape on the right, run in the gap before the next column and enter on the left; a backward arrow goes around below. Breadcrumbs in the title (layers › layer › directory › module › function) walk back up; the zoom and position of every view are remembered in the browser; the page reloads when a source file changes (`--no-watch` turns that off); ◐ switches the dark theme.

**⚙ options** (or `o`) holds what the terminal flags hold: the depth, the fold limit, the weight of the lines, hubs as badges, the packages, the overlays and the Mermaid type of the Markdown and the export; a *preset* sets them for a reader at once — *reviewer* (changes since base, untested modules), *newcomer* (depth 1, fold above 30), *architect* (heat, lines of weight 2 and more, fold above 60). Overlays lay one more fact over any view, in any mix — *changes since base* (the review's marks, `--changes`), *untested modules* (what no test file imports, in orange), *storages* (⛁ with what they hold), *heat* (every shape shaded by the calls into it, the count in its label); `--overlay tests,storages,heat` in the terminal. Every option travels in the link, so a link shared in a pull request opens the same picture; *remember as defaults* keeps the current options in this browser for every link that names none, *reset* forgets them.

Drawing (`✎ edit`, or `e`): move shapes, draw with the pencil, write notes, take a PNG or SVG of the drawing or of the selected shapes. `save` writes `.archdiff/layouts/<view>.json`; the live diagram and every export then follow the saved places, and `re-layout` merges a fresh picture of the code into the drawing — shapes that still exist keep their place, your strokes stay, stale shapes go. Commit the layouts to share them in a pull request, or ignore `.archdiff/` to keep them local.

The Markdown panel renders (a `raw` toggle shows the text to copy); `file:line` in it opens the code. The Flow tab, on a call-flow view, lists the steps in call order with their parameter and return types and the storages on the way (modules named `db`, `store`, `repository`, `cache`…, or importing `pg`, `prisma`, `redis`, `mongoose`…). Attach a mock input to the entry and mock contents to the storages — typed by hand, or *generate mocks* from the types, or from a description of the scenario when an agent is configured — and values are carried to parameters and properties of the same name, so the flow reads with data in it. *▶ play* lights the steps on the diagram one after another, like a run. Nothing is run; what reaches a step by another route is not claimed.

In the Chat tab, `@` names what the diagrams know — `@module:src/lib/orders.ts`, `@fn:src/lib/orders.ts#placeOrder`, `@layer:db`, `@dir:src/lib`, `@flow:src/routes/checkout.tsx#action`, `@type:src/lib/orders.ts#Order` — with suggestions as you type; each tag is sent to the agent with its context (the shape's Markdown: declarations, calls, callers, code). While the agent works, the shapes of the files it reads or edits light up on the diagram.

## Reviewing branches

`review` on the page opens the branch bar: a base (develop, main or master by default, or any branch) and the heads — the working tree, the current branch, any other local or remote branch. One head is the review; tick two or more and `compare` draws every module any head touched, labelled with what each head did to it (`+ feature-a  ~ feature-b`, or "every head"), the imports each head added or removed labelled with the head, and a table per head with the layer couplings it introduced. A bar below lists the commits of the range; pick one, or step with ‹ ›, to see that commit's own change against the one before it. A tap on a shape in a review shows the commits that touched its file. In the terminal: `archdiff branches`, `archdiff compare --base develop --heads feature-a,feature-b,WORKTREE`, `archdiff history`; [docs/ci.md](docs/ci.md) shows the GitHub Action that posts the review on every pull request.

## From a drawing to code: the Chat tab

Draw the change on a view in `✎ edit`: a shape with a name is a new module (`src/lib/refunds.ts`) or a new function (`refund`, placed in the nearest module, or `path#name`), an arrow between shapes is an import or a call, a deleted shape is a removal, free text is a note. Save, open **Chat**, and *read the task*: archdiff diffs the drawing against the code graph and writes a Markdown task with the files and lines it touches, the layers it crosses (a new dependency between layers is flagged) and the rules to keep. Edit the task, then *run* it: the agent runs in this repository and its output streams into the tab; a follow-up message continues the same session. When it finishes the diagram reloads, and `review` shows what the agent changed against what was drawn.

The agent comes from `archdiff web --agent claude` (Claude Code, `claude -p … --permission-mode acceptEdits`) or `--agent cursor` (Cursor's CLI, `cursor-agent -p --trust …`), or from `"agent"` in `archdiff.json`: `"claude"`, `"cursor"`, or `{ "command": ["…"], "resume": "--resume" }` for any CLI that prints stream-json. Without it the tab only writes the task (`archdiff plan` does the same from the terminal). Nothing runs by itself: every run starts from the button with the prompt as shown, and every prompt is kept in `.archdiff/tasks/`.

## Layers

Without configuration a module's layer is its top directory, or `src/<dir>` under `src/`. `archdiff.json` at the root names them explicitly:

```json
{
  "layers": { "routes": ["src/routes/**"], "lib": ["src/lib/**"], "db": ["src/db/**"] },
  "exclude": ["**/*.stories.tsx"],
  "entries": ["src/jobs/**"]
}
```

Imports resolve per language: TypeScript/JavaScript like the compiler (relative paths with or without extensions, `.js` written for a `.ts` file, `index` files, the `paths` of the nearest `tsconfig.json`, `extends` into node_modules), Python by dotted path from the repository root or `src/` (the standard library known by name), Rust by `crate::`/`self::`/`super::` paths over the targets of each `Cargo.toml` (workspace members and dependencies known), PHP by qualified name against the declarations of the repository and the namespaces of the composer lock. Everything else is a package or a built-in. One repository may mix them; the layers and the diagrams are the same.

## What the diagrams cannot show

A call is followed when its callee is a declaration of the same file, an import of a repository file, a member of a class the file declares or imports, or `this.m` inside a class. Everything else is a gap with a reason: `dynamic` (a computed callee) and `unknown-member` (a known class without that member) are blind spots inside the repository; `member-of-value` (`list.map`, `req.on`, `expect(x).toBe`), `global` and `external` are calls out of it. `archdiff coverage` and the Coverage tab of the page list them by module, so an empty diagram is never read as proof.

## Which Mermaid type where

Every view exports as a Mermaid flowchart; some views read better as another Mermaid type, chosen with `--mermaid` (or the export menu on the page):

| View | Mermaid type | Why |
| --- | --- | --- |
| `calls:`, `sequence:` | `sequenceDiagram` (automatic for `sequence:`) | the order of calls across modules |
| `classes` | `classDiagram` (automatic) | fields, methods, inheritance in UML's own notation |
| `layers`, `packages` | `C4Context` (`--mermaid c4`) | boundaries and containers, the architect's vocabulary |
| `hotspots` | `quadrantChart` (`--mermaid quadrant`) | size against calls in, the big and central modules top right |
| `layers`, any lanes | `pie` (`--mermaid pie`) | the share of modules per layer |
| `timeline` | `gitGraph` (automatic) | commits in order, tagged where a coupling appeared |
| `dir:`, `layer:` | `mindmap` (`--mermaid mindmap`) | a tree of what lives where |
| `matrix` | a Markdown table | a matrix is a table |

Not used, and why: a state diagram needs states the code does not declare; an ER diagram needs a schema (a later step with Prisma or SQL files); Gantt, Kanban, journey, Sankey, XY and the rest describe work or data, not code.

## Exports

Every view (and the review) exports to draw.io / diagrams.net (`.drawio`, uncompressed, each cell carrying the archdiff ID and the code position), Excalidraw (`.excalidraw`, shapes with bound text and arrows), Archi (ArchiMate Open Exchange XML: components, functions, relationships and one view at the laid-out places) and Mermaid.

## Speed, cache and CI

Facts are cached by file content in `.archdiff/facts.json.gz` (add `.archdiff/` to `.gitignore`); a second run parses only what changed. Cold start parses in worker threads: about 6 s for 500 files, 9 s for 2300. In CI, persist `.archdiff/` between runs and fetch enough history for the merge-base (`fetch-depth: 0`), or pass `--base origin/main`. Files over 1.5 MB are skipped and listed by `coverage`. `--out` only writes a new file or one archdiff wrote before. `web` binds to localhost and refuses requests whose Host header is not its own; `--host 0.0.0.0` exposes the sources to the network. The analysis of what can go wrong on real repositories is in [docs/production.md](docs/production.md); the test pass over eight kinds of user and four real repositories (requests, ripgrep, Slim, express) is in [docs/qa-2026-10-16.md](docs/qa-2026-10-16.md).

## Development

```bash
npm install
npm run typecheck
npm test          # the CLI and the HTTP API, through the real binary
npm run test:web  # the page in headless Chrome (playwright-core; skipped without Chrome)
node bin/archdiff.js web .
```

`npm pack` compiles `src/` to `dist/`, copies the tree-sitter grammars to `dist/wasm` and bundles the page (Excalidraw, React, marked) to `dist/web`, about 6 MB with the fonts. The published package has one runtime dependency, `web-tree-sitter`; no native code is compiled on install.

## License

Apache-2.0. The extractor and the layout come from [keylang](https://github.com/Ivlad003/keylang).
