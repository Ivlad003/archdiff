# CLI Specification

## Purpose

`archdiff` is one command with subcommands; `bin/archdiff.js` is a thin entry, `src/cli.ts` parses the arguments and calls the modules; the exit code and the output channels are a contract.

## Requirements

### Requirement: The commands

The system SHALL offer `analyze`, `views`, `diagram`, `metrics`, `run`, `layouts`, `flow`, `plan`, `new`, `import`, `intent`, `check`, `spec`, `coverage`, `review`, `branches`, `compare`, `history`, `web` and `--version`, as one table of commands from which `--help` is printed (each with its usage, help and flags); an unknown command, an unknown flag (with "did you mean" when a known flag is near), a missing required argument or an extra positional argument SHALL exit 2 with one plain line.

#### Scenario: An extra argument

- **WHEN** `archdiff views . extra` runs
- **THEN** it exits 2 with `views: unexpected argument "extra" (archdiff --help)`

#### Scenario: A misspelt flag

- **WHEN** `archdiff diagram layers --dept 2` runs
- **THEN** it exits 2 with `diagram: unknown flag --dept (did you mean --depth?)`

### Requirement: Exit codes mean one thing

The system SHALL exit 0 on success, 1 when a check found something (a new layer dependency in `review`, an import against the contract in `check`), and 2 on a wrong call or an I/O error.

#### Scenario: A clean check

- **WHEN** `archdiff check` runs on code that follows its contract
- **THEN** it exits 0 and stderr says "the code follows the intent"

### Requirement: Output channels stay clean

The system SHALL write the result of a command (Markdown, JSON, an export) to stdout or to `--out`, and every message, summary and progress line to stderr, so `--json` and `--format` output can be piped; `--out` SHALL refuse a directory and a file outside archdiff's own formats.

#### Scenario: JSON to a pipe

- **WHEN** `archdiff analyze --json` runs
- **THEN** stdout holds only JSON and the timing line goes to stderr

### Requirement: Validation names the field

The system SHALL validate flags (`--depth` a whole number, `--limit` and `--weight` above 0, `--port` a port, `--format` and `--mermaid` from their lists, `--overlay` from its names, `--template` and `--lang` from theirs) and answer with the rule when one is wrong.

#### Scenario: A bad overlay

- **WHEN** `archdiff diagram layers --overlay nope` runs
- **THEN** it exits 2 naming the overlays allowed

### Requirement: The options of a picture are one table

The system SHALL describe the options of a picture once (`src/options.ts`: depth, limit, weight, hubs, packages, expand, hide-lanes, overlay, changes, only-changes, mermaid, lanes, types) and derive from it the CLI's flags, the API's query and the page's link, `--help`'s lines and the validation message that names a wrong option; the three readers SHALL give the same options for the same values.

#### Scenario: A round trip

- **WHEN** the flags `--depth 2 --no-hubs --overlay tests,heat --lanes columns` are read, written as a query and read again
- **THEN** both readings are equal and the query is `depth=2&hubs=0&overlay=tests%2Cheat&lanes=columns`
