# What can go wrong in production

An analysis of archdiff 0.1 on real repositories (keylang, 480 files; storefront-next-template, 2335 files) and in CI, with what was changed because of it and what remains a known limit. Each item names the symptom, the cause, and the state now.

## Correctness of the picture

**Edges or calls missing.** A diagram is only as complete as the resolver. Followed: a callee declared in the file, an import of a repository file (re-exports and `export *` followed), a member of a class the file declares or imports (base classes followed), `this.m` in a class. Not followed, and reported: a method of a local value (`service.place()` where `service = new OrderService()`), a method of a call's result, a computed callee. The coverage report counts the blind ones (`dynamic`, `unknown-member`) against the followed ones so a reader knows the ratio: 65% on keylang, 81% on the storefront. *State:* known limit; local-variable types are the next step of the resolver.

**Routes and hooks as entry points depend on conventions.** React Router entries are the exports of files under a `routes/` directory; SFCC hooks come from `cartridges/*/hooks.json`. A project with routes elsewhere lists its files in `entries` of `archdiff.json`. *State:* documented.

**Imports through `paths` of a tsconfig that `extends` a package** (`@tsconfig/node20`) or sits in a sub-package of a monorepo are read as packages, not files. Only the root `tsconfig.json` and one level of relative `extends` are read. *State:* known limit, documented; a per-directory tsconfig walk is a later step.

**Files tree-sitter cannot parse** (97 test files of the storefront, over `importOriginal<typeof import('…')>()`) keep the declarations recovered around the error and are listed under syntax errors. *State:* reported, not hidden.

**Dot-directories are skipped** (`.github`, `.storybook`, `.agents`): a project that keeps sources there sees them missing. *State:* documented; `layers` globs cannot bring them back yet.

## Review in CI

**Shallow clones.** `actions/checkout` fetches depth 1: there is no merge-base, and `git show <base>:<file>` fails. Before, archdiff fell back to HEAD silently and reported "no change". *Now:* `review` throws a message naming the fix (`fetch-depth: 0` or `--base origin/main` after a fetch), exit 2.

**Base was the tip of main, not the merge-base.** Commits that landed on main after the branch point were read as removed by the change. *Now:* the merge-base commit is the base; a test covers it.

**Cold start.** CI has no fact cache: 6 s for 480 files, 8.5 s for 2335 on 8 threads (16 s and 23 s on one). *Now:* worker threads with a fallback to one thread when threads cannot start. Persisting `.archdiff/` between runs (a cache action keyed by the lockfile) makes the next run sub-second.

**Exit code 1 means a new layer dependency only**, not every change: a CI gate on it blocks coupling, not refactoring. *State:* by design, documented.

## Size and resources

**Fact cache size.** The facts of every file as JSON were 15 MB for keylang and 32 MB for the storefront; a 20 000-file repository would write a quarter gigabyte on each run. *Now:* the cache is gzipped (`.archdiff/facts.json.gz`, level 4); loading 2335 entries takes about 0.3 s and 120 MB of heap. A repository far larger than that needs a per-file cache, a later step.

**Vendored bundles and generated files.** A 5 MB minified file costs seconds in WASM and may exhaust its heap. *Now:* files over 1.5 MB are skipped and named in the coverage report under "Files not analysed".

**Memory of the whole graph.** Every analysis holds every file's facts and the graph in memory, twice for `review` (base and head). At 2335 files this is a few hundred megabytes; at ten times that, a laptop may swap. *State:* known limit of the single-process design.

**The cache directory in the repository.** `.archdiff/` is written beside the sources and must be ignored by git; `init`-style automation is not part of archdiff. *State:* documented in the README; a run prints nothing about it.

**Worker threads in sandboxes** (some CI runners, `--max-old-space-size` limits) may refuse to start. *Now:* a failure to start or finish the pool is logged to stderr and the run continues on one thread.

**Two runs at once** (an editor plugin and a CLI) write the cache concurrently. *State:* each writes a temporary file and renames it, so the file is never half-written; the last writer wins and the other run's new entries are parsed again next time.

## The web server

**Reading the sources from another website.** The page serves the analysed files over HTTP on localhost with no token; a web page the developer opens elsewhere can send requests to `127.0.0.1:7080`. Without CORS headers the browser hides the response, but DNS rebinding (a hostname that resolves to 127.0.0.1) gets around that. *Now:* every request's `Host` header must be `localhost`, `127.0.0.1`, `::1` or the `--host` given; anything else is refused with 421.

**Binding to all interfaces.** `--host 0.0.0.0` exposes the sources to the network, by the developer's explicit choice. *State:* the default stays loopback; the README should say when to use `--host`.

**Path traversal.** `/api/file` serves only paths the analysis lists (it answers 404 for anything else), and static files are served from `dist/web` by basename only. *State:* covered by the design; a test should pin it.

**Every request re-analyses.** The fact cache makes it 0.3–0.5 s, and requests within 300 ms share one analysis; a very large repository would make every click slow. *Now:* the server watches the sources (`fs.watch`, recursive) and tells the page to reload after a change, debounced; `--no-watch` turns it off, and a platform without recursive watching logs it and goes on. An agent run or a watch event drops the shared analysis, so the next request is fresh.

**History walks analyse every commit.** `history` and the commit bar analyse one revision per commit through overrides (no checkout); each is cheap with a warm cache but a hundred-commit range is a hundred analyses. *State:* fine for a branch; a release range needs patience.

**Stale page after an update** of archdiff: the browser caches nothing (`no-store`), so a restart is enough. *State:* fine.

## The page and its drawings

**Bundle size.** Excalidraw with React is about 2.4 MB of JavaScript, loaded once; locales load on demand, fonts (0.5 MB, the CJK family left out) on demand. The package grows from 4 MB to about 10 MB unpacked. *State:* accepted for one canvas that reads and draws; a CDN is deliberately not used, so the page works offline.

**Drawings in the repository.** `.archdiff/layouts/<view>.json` holds the whole scene, including pencil strokes; a view drawn heavily is a few hundred kilobytes. Committing it shares the drawing; `POST /api/layout` accepts up to 8 MB and refuses anything that is not a list of elements. A drawing is matched to its view by the exact view key, so a renamed module leaves an orphan file. *State:* known; a `layouts prune` command is a later step.

**Stale drawings.** The live diagram follows the saved places of shapes that still exist; shapes the code no longer has are dropped at the next re-layout, new ones are placed by the algorithm beside the kept ones (possibly overlapping a stroke). *State:* by design; re-layout is one click.

**Mocks are not execution.** The Flow tab carries values by name only. A reader may take a carried value for a proven one. *State:* the panel and the Markdown say so in their first line; real execution with substituted modules is a separate, optional, later step.

**Tapping in view mode** is read from pointer events; a drag over 6 scene pixels is a pan, not a tap. On a touch screen the second tap must land within half a second. *State:* works with a mouse; untested on touch.

## The agent

**An agent edits the repository from a web page.** The server runs `claude -p` or `cursor-agent -p` in the repository with the prompt the page sends. *State:* the feature is off unless `--agent` or `archdiff.json` names an agent; the server is loopback-only with a Host check, so only a page on this computer can ask; every run starts from a button with the prompt visible and is kept in `.archdiff/tasks/`. Claude Code runs with `acceptEdits` (file edits allowed, shell commands follow its own rules); Cursor's CLI in print mode has every tool, as its own help says. A reviewer should read the task before running it, and `review` after.

**Cost and time.** A run is an agent session: minutes and tokens, outside archdiff's control. *State:* `stop` kills the process; the task file survives.

**Stream formats drift.** The events are read with a tolerant parser: known shapes become text, tool and result events, anything else is shown raw. *State:* verified against Claude Code 2.1 and Cursor's CLI; a change in their stream-json shows as raw lines, not as a failure.

**The plan is a guess from geometry.** A drawn function goes into the nearest module shape; a module into the lane it sits in. *State:* the task says why each place was chosen ("drawn next to …") so the reader can correct it before running.

## Writing files

**`--out` overwrote any file.** A path typo could replace a hand-written document. *Now:* `--out` writes a new file or one that carries archdiff's marker (`<!-- archdiff:generated -->`, `%% archdiff:generated`, `host="archdiff"`, `"generator": "archdiff"`); any other existing file is refused with exit 2 and left intact. Every format carries such a marker.

## Platform

**Windows.** Paths from git are POSIX and are joined with `node:path` for reading; the worker URL and the WASM directory come from `import.meta.url`. *State:* untested on Windows; nothing known to break.

**Node versions.** The published package is plain JavaScript with `worker_threads`, `zlib` and `web-tree-sitter`; `engines` says Node 22.18 because the checkout runs TypeScript directly. *State:* fine.

**Install.** One runtime dependency, no native build, 4 MB unpacked (three WASM grammars make most of it). *State:* fine.

## Not yet covered

- A repository without git and with symlinked directories: the walk does not follow symlinks (`readdirSync` with `withFileTypes` reports them as neither file nor directory), so those files are silently absent.
- Non-UTF-8 sources read with replacement characters: positions stay right, string contents may not.
- Monorepos with several packages and tsconfigs (see above).
- A watch mode and a per-file cache for repositories beyond ~10 000 files.
