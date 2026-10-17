# Run Specification

## Purpose

A real run of an entry point with the storages mocked, so what the data-flow view predicts can be checked against what the code does: the functions entered in order, the calls the storages took, the result or the error.

## Requirements

### Requirement: An entry runs in a child process with its storages mocked

The system SHALL run `archdiff run <calls:view>` (and `POST /api/flow/run`, the Flow tab's ▶ run) by starting a child Node process in the repository under the permission model (reading allowed anywhere, no file writes, no child processes), registering module hooks that trace every function of the modules the entry can reach (a call at the start of each body, types stripped), resolve the project's imports as archdiff resolved them, and replace the storage packages (the table of flow.ts, `fs`, the config's `storagePackages`) by recorders that answer from the mocks; `fetch` SHALL answer from a `fetch` mock and refuse the network otherwise. Only an exported top-level TypeScript or JavaScript function SHALL run; a method, a nested function or another language SHALL be refused with a reason.

#### Scenario: An order is placed

- **WHEN** `archdiff run calls:src/lib/orders.ts#placeOrder --input '{"id":"o1","total":5}'` runs on the sample repository
- **THEN** the steps are placeOrder, validate, saveOrder and log, in that order, the result is `{"id":"o1","total":5}`, and nothing was written to disk

### Requirement: The mocks come from the flags or the page

The system SHALL take the entry's arguments from `--input` (by parameter name; a destructured parameter takes the keys it names) or from the mock input saved with the view's drawing, and each storage's content from `--storages` (by package, or by the module importing it) or from the storage mocks saved with the drawing.

#### Scenario: A mocked file system

- **WHEN** `archdiff run calls:src/lib/orders.ts#findOrder --input '{"id":"o1"}' --storages '{"node:fs": {"readFileSync": "nothing"}}' --json` runs
- **THEN** the storage calls hold `node:fs` `readFileSync("/dev/null")` and no error

### Requirement: The run is set against the prediction

The system SHALL report the steps entered in order, the storage calls, the result (or the error, exit 1), the time, the steps the data flow predicted that were not entered and those entered it did not predict; the Flow tab SHALL light the functions entered green and dim the predicted ones not reached.

#### Scenario: A thrown error

- **WHEN** the entry throws
- **THEN** the report holds "**Error:** Error: negative" and the command exits 1
