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

### Requirement: Imports resolve per language

The system SHALL resolve relative and aliased imports to files (TypeScript `paths` from the nearest `tsconfig.json`, `.js` to `.ts`, index files; Python packages; Rust modules and facade re-exports; PHP namespaces) and name packages and built-ins as externals. An import that resolves to nothing SHALL be listed as unresolved with its reason, never guessed.

#### Scenario: A tsconfig path alias

- **WHEN** a file imports `@/db/store` and the nearest tsconfig maps `@/*` to `src/*`
- **THEN** the import resolves to `src/db/store.ts`

#### Scenario: An import nothing matches

- **WHEN** a file imports a module that is neither a file, a package nor a built-in
- **THEN** the analysis lists it under unresolved imports with the file, the specifier and the reason

### Requirement: Calls resolve through declarations, exports and types

The system SHALL resolve a call to the function it names through the file's local declarations, its import bindings (including re-exports, `export *`, CommonJS `module.exports`), receiver types, interface implementers and class ancestors. A call it cannot name SHALL be a gap with one of the reasons `dynamic`, `global`, `member-of-value`, `unknown-member`, `interface`, `external`, `parse-error`.

#### Scenario: A call through an interface

- **WHEN** `repo.save()` is called where `repo` is typed as an interface with one implementer
- **THEN** the call resolves to the implementer's `save`

#### Scenario: A dynamic call

- **WHEN** code calls `handlers[name]()`
- **THEN** the call is a gap with the reason `dynamic`, and the coverage report counts it

### Requirement: The analysis is cached by content

The system SHALL cache the facts of every file in `.archdiff/facts.json.gz` keyed by the file's content hash and the extractor version, so a second run parses only what changed; a cache of another version SHALL be ignored and rewritten.

#### Scenario: A second run

- **WHEN** `archdiff analyze` runs twice on an unchanged repository
- **THEN** the second run reports cache hits for every file and finishes faster than the first

### Requirement: Layers come from the configuration or the directories

The system SHALL place every module in a layer: the first glob of `archdiff.json` `layers` that matches, else the top directory (`src/<dir>` under `src/`), else the configured `otherLayer`. A wrong `archdiff.json` SHALL fail naming the file and the field.

#### Scenario: Layers from archdiff.json

- **WHEN** `archdiff.json` names `routes: ["src/routes/**"]` and `lib: ["src/lib/**"]`
- **THEN** `src/routes/checkout.tsx` is in `routes` and `src/lib/orders.ts` in `lib`

#### Scenario: A broken archdiff.json

- **WHEN** `archdiff.json` has an empty layer name
- **THEN** the command exits 2 with a message naming `archdiff.json` and `layers`

### Requirement: Entry points are known from the code and the frameworks

The system SHALL treat as entry points exported functions under `bin/`, functions named `main`, React Router route exports, SFCC cartridge hooks, the files a `package.json` names, the files `archdiff.json` `entries` names, and exported functions nothing in the repository calls.

#### Scenario: A React Router route module

- **WHEN** `src/routes/checkout.tsx` exports `action`
- **THEN** `archdiff views` lists `calls:src/routes/checkout.tsx#action` labelled "route checkout.tsx: action"

### Requirement: The coverage report names the blind spots

The system SHALL report, by module, the calls it could not follow with their reasons, the unresolved imports and the syntax errors, as the map of what the diagrams cannot show.

#### Scenario: Coverage of a repository

- **WHEN** `archdiff coverage` runs
- **THEN** the report lists the modules with gaps, biggest first, each gap with its line and reason
