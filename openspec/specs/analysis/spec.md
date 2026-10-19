# Analysis Specification

## Purpose

Turn the source files of a repository into a graph of modules, functions, classes, types, imports and calls, deterministically and fast, and say plainly what could not be followed.

## Requirements

### Requirement: Source files are parsed into facts

The system SHALL parse every TypeScript, JavaScript, Python, Rust and PHP source file git lists (or the directory holds, without git) with tree-sitter and record per file its declarations with line ranges, its imports, its exports, its calls and the calls it could not name, as `FileFacts`. A file over 1.5 MB SHALL be skipped but kept as an opaque module so imports of it resolve.

#### Scenario: A repository with five languages

- **WHEN** `archdiff analyze` runs on a repository holding `.ts`, `.js`, `.py`, `.rs` and `.php` files
- **THEN** every file is listed with its functions, classes and types, and the output names the count of files, modules, layers, functions, classes and types

#### Scenario: A file too large to parse

- **WHEN** a source file is over the size limit
- **THEN** it is listed under "files not analysed" with the reason, and an import of it still resolves to a module

#### Scenario: A bare ampersand in JSX text

- **WHEN** a `.tsx` or `.jsx` file holds `<h3>Cart & Checkout</h3>`, which the compiler accepts and the tree-sitter grammar does not
- **THEN** the file is no syntax error: its declarations and calls are read whole, and it is not listed under syntax errors

### Requirement: Imports resolve per language

The system SHALL resolve relative and aliased imports to files (TypeScript `paths`, `baseUrl` and `rootDirs` from the nearest `tsconfig.json` or `jsconfig.json` with its `extends` merged as the compiler merges them, the pattern with the longest prefix taken; `.js` to `.ts`, index files; a package of a monorepo imported by its name to its source; Python packages, from the repository's root, `src/` and a project directory with a pyproject.toml, setup.py, setup.cfg or manage.py; Rust modules and facade re-exports; PHP namespaces) and name packages and built-ins as externals. An import that resolves to nothing SHALL be listed as unresolved with its reason, never guessed: an alias whose file is missing is no package. A file of the repository that is no source (JSON, a stylesheet) SHALL be neither a module nor unresolved, nor an optional specifier that names no source. `import { type A }` SHALL be of types only unless the tsconfig sets `verbatimModuleSyntax`, and so SHALL a Python import under `if TYPE_CHECKING:`; a line of types only is drawn dashed.

#### Scenario: A tsconfig path alias

- **WHEN** a file imports `@/db/store` and the nearest tsconfig maps `@/*` to `src/*`
- **THEN** the import resolves to `src/db/store.ts`

#### Scenario: An import nothing matches

- **WHEN** a file imports a module that is neither a file, a package nor a built-in
- **THEN** the analysis lists it under unresolved imports with the file, the specifier and the reason

#### Scenario: An alias or a path of an asset

- **WHEN** a file imports `@/locales/en/translations.json` or `@/theme/index.css?url` through a tsconfig alias, `/images/logo.svg` that `public/` holds, or `../.storybook/test-wrapper` under a hidden directory
- **THEN** the import is an asset: no module is drawn for it and it is not listed under unresolved imports

#### Scenario: A relative import under tsconfig rootDirs

- **WHEN** `src/routes/home.tsx` imports `./+types/home` and the tsconfig has `rootDirs: [".", "./.react-router/types"]`
- **THEN** the import resolves to `.react-router/types/src/routes/+types/home.ts` when that file exists, and is otherwise listed as unresolved with a reason naming that twin path "of the tsconfig rootDirs"

### Requirement: Calls resolve through declarations, exports and types

The system SHALL resolve a call to the function it names through the file's local declarations, its import bindings (including re-exports, `export *`, `export * as ns`, CommonJS `module.exports`, a module bound whole, a glob import, a `require` or an awaited `import()` in the function), receiver types, interface implementers (through the interfaces that extend one too), class ancestors and PHP traits. A receiver's type SHALL be the one the code writes: a parameter, a local or a field typed with a class or made with `new`, a constant of the module made with `new` or by a call, a Python attribute the class's methods fill with one class, a Rust struct's field, or the result type the target of the call a value comes from declares (a Promise of a class is that class once awaited). A function passed as a value inside a function SHALL be a `ref` line of that function. A call it cannot name SHALL be a gap with one of the reasons `dynamic`, `global`, `member-of-value`, `unknown-member`, `interface`, `unresolved` (a name an import binds that resolves to no file), `external`, `local`, `parse-error`; a member of a chain too long to keep whole SHALL keep its reason (a member of a value, not `dynamic`), and the `resolve` and `reject` of a `new Promise` executor SHALL be `external`. A callee bound between the call and the module — a parameter, a local, a nested function, a caught error — SHALL never be read as the module's declaration of the same name: through a parameter it is `dynamic` (a blind spot: what the caller passes), a function of the caller's own body is `local` (its calls are the caller's already). `super.m()` (PHP `parent::m()`, Python `super().m()`) SHALL resolve to the member of the class the enclosing class extends.

#### Scenario: A call through an interface

- **WHEN** `repo.save()` is called where `repo` is typed as an interface with one implementer
- **THEN** the call resolves to the implementer's `save`

#### Scenario: A method of a factory's result

- **WHEN** `const s = await load()` where `load(): Promise<Store>`, then `s.save()`
- **THEN** the call resolves to `Store.save`; without the `await` it is a gap with the reason `member-of-value`

#### Scenario: An interface an object literal implements

- **WHEN** `r.map()` is called where `r` is the result of `repo(): Repo`, `Repo` an interface no class implements
- **THEN** the call is a gap with the reason `interface`, a blind spot

#### Scenario: A dynamic call

- **WHEN** code calls `handlers[name]()`
- **THEN** the call is a gap with the reason `dynamic`, and the coverage report counts it

#### Scenario: A CommonJS export with a flag

- **WHEN** a file declares `function f` and has `exports.f = f` and `exports.f.public = true`
- **THEN** `f` is an exported function of the module (an entry `run` accepts) and `public` is no export of it

### Requirement: The analysis is cached by content

The system SHALL cache the facts of every file in `.archdiff/facts.json.gz` keyed by the file's content hash and the extractor version, so a second run parses only what changed; a cache of another version SHALL be ignored and rewritten. The files of other revisions (a review's base, a history's commits, a comparison's heads) SHALL be cached apart, many versions of a file at once, the most recently read kept, in `.archdiff/revisions.json.gz`, read only when a revision is analysed.

#### Scenario: A second run

- **WHEN** `archdiff analyze` runs twice on an unchanged repository
- **THEN** the second run reports cache hits for every file and finishes faster than the first

### Requirement: Layers come from the configuration or the directories

The system SHALL place every module in a layer: with `layers` in `archdiff.json` (or, without them, the layers of `ARCHITECTURE.md`), the first layer whose glob matches, else the layer `other` names (`other` by default); without layers, the top directory (`src/<dir>` under `src/`, `(root)` for a file at the root). A wrong `archdiff.json` SHALL fail naming the file and the field, and one that is not JSON naming the file.

#### Scenario: Layers from archdiff.json

- **WHEN** `archdiff.json` names `routes: ["src/routes/**"]` and `lib: ["src/lib/**"]`
- **THEN** `src/routes/checkout.tsx` is in `routes` and `src/lib/orders.ts` in `lib`

#### Scenario: A broken archdiff.json

- **WHEN** `archdiff.json` has an empty layer name
- **THEN** the command exits 2 with a message naming `archdiff.json` and `layers`

### Requirement: Entry points are known from the code and the frameworks

The system SHALL treat as entry points exported functions under `bin/`, the functions a browser extension's scripts hand to a browser event's `addListener` (`chrome.runtime.onConnect`, a port's `onMessage`), labelled with the role `manifest.json` gives the script (background, content script, side panel, popup, options, devtools), functions named `main`, React Router route exports, SFCC cartridge hooks, the files a `package.json` names, the files `archdiff.json` `entries` names, exported functions nothing in the repository calls, and the public methods of a class in a module a framework calls into (a controller, handler, command, job, listener, middleware, route or resolver, by its path) that nothing in the repository calls and that call something themselves.

#### Scenario: A React Router route module

- **WHEN** `src/routes/checkout.tsx` exports `action`
- **THEN** `archdiff views` lists `calls:src/routes/checkout.tsx#action` labelled "route checkout.tsx: action"

### Requirement: The coverage report names the blind spots

The system SHALL report, by module, the calls it could not follow with their reasons, the unresolved imports and the syntax errors, and list the constructs a frontend read but does not follow (an `eval`, a computed import, a decorator that may replace a function), as the map of what the diagrams cannot show.

#### Scenario: Coverage of a repository

- **WHEN** `archdiff coverage` runs
- **THEN** the report lists the modules with gaps, biggest first, each gap with its line and reason

### Requirement: The files found are the repository's

The system SHALL list the sources as git lists them, or by a walk that follows a symbolic link to a file or a directory inside the root once, under its own path, and never back up the tree; Rust files under `tests/`, `benches/` and `examples/` SHALL be crate roots of their own, so `mod util;` finds `tests/util.rs` and `use <crate>::` the library.

#### Scenario: A linked directory

- **WHEN** `src/linked` is a link to `src/real` and `src/loop` a link to the root
- **THEN** `src/real/a.ts` is a module, `src/linked/a.ts` and `src/loop/…` are not

### Requirement: The cache follows the extractors

The system SHALL version the fact cache by a hash of the extractors' own source files, so a change to any extractor makes every cached entry stale without anyone bumping a number.

#### Scenario: An extractor changes

- **WHEN** a file of `src/extract/` changes between two runs
- **THEN** the second run reports every file as a cache miss

### Requirement: Storages are known by what the code does

The system SHALL call a module a storage by `archdiff.json`'s `storages` globs and `storagePackages`, by the storage packages it imports, by the calls it makes (the file system, `fetch`, the browser's stores, a database client's `query`, Python's `open` and `connect`, Rust's `std::fs`, PHP's `PDO` and `file_put_contents`), or by its name, in that order.

#### Scenario: A module that calls fetch

- **WHEN** a module named like nothing in particular calls `fetch`
- **THEN** the storages overlay labels it "⛁ HTTP (fetch)"
