# Impact Specification

## Purpose

Where a change lands before it is read: everything that depends on a module or a function, step by step, the tests that would catch the change told apart from the code it could break, and a risk score whose parts are shown — from the graph archdiff already has, with no model.

## Requirements

### Requirement: A subject's dependents are walked backwards, step by step

The system SHALL find, for a module, every module that imports it or calls into it (a call through a re-exporting index reaches it in one step), and for a function, a method or a class, every function that calls it or passes it on as a value (a module itself for a call at its top level; a class is reached through any of its members) — transitively, each dependent with its distance by the nearest way, its layer and the dependent one step nearer through which it reaches the subject. Type-only imports SHALL count only with `--types`. A dependent written in a test file (the rule of the `tests` view) SHALL be told apart as a test. The dependents SHALL be listed to `--depth` (default 3) and counted at any distance. A subject the code does not have SHALL be a wrong call (exit 2) naming it.

#### Scenario: A store

- **WHEN** `archdiff impact src/db/store.ts --json` runs on the sample repository
- **THEN** its dependents are `src/lib/orders.ts` at 1 step (layer lib) and `src/routes/checkout.tsx` at 2 steps (layer routes, through `src/lib/orders.ts`)

#### Scenario: A function

- **WHEN** `archdiff impact src/db/store.ts#saveOrder --json` runs
- **THEN** its dependents are `placeOrder` at 1 step, `OrderService.place` at 2 and the route's `action` at 3

#### Scenario: A test reaches it through other code

- **WHEN** a test file imports `src/lib/orders.ts` and `archdiff impact src/db/store.ts --json` runs
- **THEN** the test file is a dependent at 2 steps marked as a test, counted among the tests and not among the dependents or their layers

### Requirement: The risk is a score whose parts are shown

The system SHALL give every subject a risk of 0–100 that is the sum of five parts, each with its points, its maximum and the fact of the code it stands for: the dependents at any distance, tests left out (30 points, full at 20 dependents); the layers they lie in besides the subject's own (20, full at 3); the tests (20 when no test reaches it, 10 when the nearest test reaches it through other code, 0 when a test imports or calls it or the subject is a test file); the instability I = Ce / (Ca + Ce) of its module (15 × I, when a module imports it); and its module's rank among the hotspots — the modules ordered by the calls into them from other modules, then by their lines (15 for the first, 0 for the last and for a module nothing calls into). The level SHALL be `low` under 34, `medium` under 67 and `high` from there. The score SHALL not change with `--depth`.

#### Scenario: The store's score

- **WHEN** `archdiff impact src/db/store.ts --json` runs on the sample repository
- **THEN** the parts are dependents 3 of 30, layers 13 of 20, tests 20 of 20 ("no test reaches it"), instability 0 of 15 and hotspot 11 of 15, and the risk is 47, medium

#### Scenario: A shallower list

- **WHEN** the same command runs with `--depth 1`
- **THEN** one dependent is listed, and the totals and the score are the same

### Requirement: The impact is a command, a view and data

The system SHALL offer `archdiff impact <path>[#<fn>]` and the view `impact:<path>[#<fn>]`, written as Markdown (the risk as a table of its parts, the dependents by distance each with its layer, what it reaches the subject through and the file and line that import or call is written at, the tests that reach it — every one of them, at any distance, whatever the depth — and, for a declaration, the other test files that import its module with no call archdiff follows to it, how many dependents lie beyond the depth), as data (`--json`: the depth and every subject with its dependents, its tests, totals, layers and risk) and as a picture in every export format (`--format`). The picture SHALL be placed by the view: the subject in the middle column, a column per step to its right, a column of the tests that reach it (and of what reaches it only through a test) on its left, each column a lane named by its distance; every line SHALL be the nearest way a dependent reaches a subject — the import, or the call where no import joins the two — with a route of its own between two neighbouring columns, through no shape. A subject no test reaches SHALL be marked as the `tests` view marks an untested module; a dependent SHALL be shaded the hotter the nearer it is. A column SHALL keep ten shapes and the picture `--limit` dependents, those that carry the change furthest first, the rest of a column folded into one shape whose members the Markdown lists.

#### Scenario: The picture of a module

- **WHEN** `archdiff diagram impact:src/db/store.ts --format json` runs with a test file importing `src/lib/orders.ts`
- **THEN** the lanes read "tests that reach it (1)", "the subject", "1 step away (1)", "2 steps away (1)" from left to right, and no line's route runs through a shape

#### Scenario: A missing subject

- **WHEN** `archdiff impact src/nowhere.ts` runs
- **THEN** it exits 2 with `impact: no module or function "src/nowhere.ts"`

### Requirement: The impact of a change has every changed file as a subject

The system SHALL take, with `archdiff impact --changed` and the view `impact` without a subject, every file changed since the base (`--base`, default the merge-base; `--head`, default the working tree) that is a module of the code as a subject: the subjects by risk as a table, each subject's own sections, and one picture with the changed files in the middle column and every dependent once, in the column of its nearest subject, with a line to each subject it reaches by a nearest way. A changed file that is no module (deleted) SHALL be counted in the reason. No change SHALL give an empty picture saying so; outside git the command SHALL exit 2. A subject given with `--changed` SHALL be a wrong call.

#### Scenario: Two changed files

- **WHEN** `src/lib/log.ts` and `src/db/store.ts` changed since the base and `archdiff impact --changed --json` runs
- **THEN** both are subjects, the riskier first, and `since` names the base

#### Scenario: Nothing changed

- **WHEN** `archdiff impact --changed` runs on a clean working tree
- **THEN** the page says "no source file changed since" the base

### Requirement: The computation is one function another reader can call

The system SHALL keep the computation in a pure module of the views layer (`src/impact.ts`) behind `impactOf(analysis, subject, { depth, types })`, which returns the subject's dependents, totals, layers and risk as data, or null for a subject the analysis does not have; the command, the view and the picture SHALL read it and nothing else.

#### Scenario: The same numbers everywhere

- **WHEN** `archdiff impact src/db/store.ts --json` and `archdiff diagram impact:src/db/store.ts --format json` run
- **THEN** the picture's `impact` holds the same subject, dependents and risk as the command printed
