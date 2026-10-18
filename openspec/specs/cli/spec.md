# CLI Specification

## Purpose

`archdiff` is one command with subcommands; `bin/archdiff.js` is a thin entry, `src/cli.ts` parses the arguments and calls the modules; the exit code and the output channels are a contract.

## Requirements

### Requirement: The commands

The system SHALL offer `analyze`, `views`, `diagram`, `metrics`, `run`, `drawings` (also called `layouts`, its old name), `flow`, `plan`, `new` (`--no-git`: no repository and no first commit), `import`, `intent`, `check`, `spec` (`--tests [DIR]`: a test skeleton per Gherkin scenario, into `tests/` or `DIR`), `coverage`, `review`, `branches`, `compare`, `history`, `web` and `--version`, as one table of commands from which `--help` is printed (each with its usage, its other names, help and flags); an unknown command, an unknown flag (with "did you mean" when a known flag is near), a missing required argument or an extra positional argument SHALL exit 2 with one plain line.

#### Scenario: An extra argument

- **WHEN** `archdiff views . extra` runs
- **THEN** it exits 2 with `views: unexpected argument "extra" (archdiff --help)`

#### Scenario: A misspelt flag

- **WHEN** `archdiff diagram layers --dept 2` runs
- **THEN** it exits 2 with `diagram: unknown flag --dept (did you mean --depth?)`

#### Scenario: The old name of a command

- **WHEN** `archdiff layouts` runs
- **THEN** it lists the saved drawings as `archdiff drawings` does

### Requirement: A picture can be of another revision

The system SHALL draw `diagram <view> --head REF`, for a view that is no change, from the code at REF (a branch, a tag, a commit) without a checkout, stamped with REF's commit; a REF git does not know SHALL exit 2 naming it.

#### Scenario: A branch's map from main

- **WHEN** `archdiff diagram modules --head gone` runs on main, where branch `gone` removed `log.ts`
- **THEN** the map has no `log.ts`, and the stamp names `gone`'s commit

### Requirement: Exit codes mean one thing

The system SHALL exit 0 on success, 1 when a check found something (a new layer dependency in `review` or `compare`, an import against the contract in `check`, a run that threw in `run`), and 2 on a wrong call or an I/O error — a view of a subject the code does not have, an entry `run` cannot run (unknown, a method, another language, not exported), a repository that is not one when git is needed.

#### Scenario: A clean check

- **WHEN** `archdiff check` runs on code that follows its contract
- **THEN** it exits 0 and stderr says "the code follows the intent"

#### Scenario: An entry that cannot run

- **WHEN** `archdiff run calls:src/lib/orders.ts#nope` runs
- **THEN** it exits 2 with `run: no function "src/lib/orders.ts#nope" (archdiff views lists the entry points)` and writes nothing to stdout

### Requirement: Output channels stay clean

The system SHALL write the result of a command (Markdown, JSON, an export) to stdout or to `--out`, and every message, summary and progress line to stderr, so `--json` and `--format` output can be piped; every command that writes a report SHALL take `--out FILE` and write a new file or one archdiff wrote before (its first line says so), refusing a directory and any other file.

#### Scenario: JSON to a pipe

- **WHEN** `archdiff analyze --json` runs
- **THEN** stdout holds only JSON and the timing line goes to stderr

#### Scenario: --out names a directory

- **WHEN** `archdiff diagram layers --out /tmp` runs
- **THEN** it exits 2 with `--out /tmp: a directory; name a file` and writes nothing

### Requirement: Validation names the field

The system SHALL validate flags (`--depth` a whole number of 0 or more, `--limit` and `--weight` above 0, `--port` a port, `--format` and `--mermaid` from their lists, `--overlay` from its names, `--template` and `--lang` from theirs) and a query's values (a boolean `1` or `0`, `true`/`false`, `yes`/`no`), and answer with the rule when one is wrong. A depth SHALL have no ceiling: on a view the depth changes, past 12 the picture SHALL be drawn with a warning that it may be big, first in its reason and on stderr.

#### Scenario: A bad overlay

- **WHEN** `archdiff diagram layers --overlay nope` runs
- **THEN** it exits 2 naming the overlays allowed

#### Scenario: A deep call tree

- **WHEN** `archdiff diagram calls:src/routes/checkout.tsx#action --depth 20` runs
- **THEN** it exits 0, stderr says `⚠ depth 20 is deeper than 12: the picture may be big and slow to draw (the fold keeps it readable)` and the reason starts with the same warning; on `layers`, which goes no depth, nothing is said

### Requirement: The options of a picture are one table

The system SHALL describe the options of a picture once (`src/options.ts`: depth, limit, weight, hubs, packages, expand, hide-lanes, overlay, changes, only-changes, mermaid, lanes, types) and derive from it the CLI's flags, the API's query and the page's link, `--help`'s lines and the validation message that names a wrong option; the three readers SHALL give the same options for the same values.

#### Scenario: A round trip

- **WHEN** the flags `--depth 2 --no-hubs --overlay tests,heat --lanes columns` are read, written as a query and read again
- **THEN** both readings are equal and the query is `depth=2&hubs=0&overlay=tests%2Cheat&lanes=columns`
