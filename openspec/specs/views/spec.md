# Views Specification

## Purpose

Each view is one picture that answers one architectural question, computed from the graph as an unplaced diagram, then shaped (hubs, hidden lanes, expansion, fold, weight) and laid out deterministically.

## Requirements

### Requirement: Every view answers one question

The system SHALL offer these views, each with a one-sentence question it answers: `layers`, `modules`, `layer:<name>`, `dir:<path>`, `module:<path>`, `inside:<path>`, `contract:<path>`, `calls:<path>#<fn>`, `sequence:<path>#<fn>`, `path:<path>#<fn>`, `type:<path>#<Type>`, `cycles`, `cycle:<path>`, `classes`, `classes:<scope>`, `matrix`, `matrix:<dir>`, `events`, `tests`, `hotspots`, `packages`, `timeline`, `coverage`, `intent`. A view with a subject that does not exist SHALL be empty with a reason naming the subject.

#### Scenario: A module view

- **WHEN** `archdiff diagram module:src/lib/orders.ts` runs
- **THEN** the picture shows the module, what it imports and what imports it, one lane per layer, and its question is "what the module imports and what imports it"

#### Scenario: A missing subject

- **WHEN** `archdiff diagram layer:nope` runs
- **THEN** the command exits 2 with `no layer "nope"`

### Requirement: Big pictures fold by directory

The system SHALL fold a picture with more shapes than the limit (40 by default, `--limit`) by directory into "… N in dir/" shapes, merging the lines into each folded shape with a count, and say so in the reason; the Markdown SHALL list everything.

#### Scenario: A directory with hundreds of modules

- **WHEN** a `dir:` view would hold 300 modules
- **THEN** the picture holds at most the limit plus the folded shapes, the reason says how many were folded, and a tap on a folded shape opens that directory

### Requirement: Hubs become badges

The system SHALL take out of a module-level picture any module imported by at least a quarter of the picture's modules (at least 6, at most 40 importers) and write its name as a badge "+ name" on each importer, naming the hubs in the reason; the view's own subject is never a hub; `--no-hubs` draws them.

#### Scenario: A logger everyone imports

- **WHEN** 7 of 9 modules of a picture import `log.ts`
- **THEN** `log.ts` is not drawn, its 7 importers carry "+ log.ts", and the reason says "hubs as badges, not drawn: log.ts (imported by 7 of 9)"

### Requirement: Light lines can be left out

The system SHALL leave out, with `--weight N`, lines standing for fewer than N imports or calls, after the fold, and say how many in the reason.

#### Scenario: Weight on the layers

- **WHEN** `archdiff diagram layers --weight 5` runs on a repository whose layer lines carry at most 2 imports
- **THEN** the picture has no lines and the reason says "2 lines lighter than 5 left out"

### Requirement: A module can be opened in place

The system SHALL, with `--expand <module>`, replace a module shape by a lane of its functions and classes with the calls among them; a line into the module lands on the functions its source calls (the rest on a "rest of the module" shape), a line out leaves from the functions that call.

#### Scenario: Expanding a module in a layer view

- **WHEN** `archdiff diagram layer:lib --expand src/lib/orders.ts` runs
- **THEN** a lane `inside:src/lib/orders.ts` holds `placeOrder` and `findOrder`, the import from `checkout.tsx` lands on `OrderService.place`, and the reason says "opened in place: src/lib/orders.ts"

### Requirement: Lanes can be hidden

The system SHALL leave out, with `--hide-lanes a,b`, the named lanes with their shapes and every line touching them.

#### Scenario: Hiding a layer

- **WHEN** `archdiff diagram layer:lib --hide-lanes routes` runs
- **THEN** the picture has no `routes` lane and no shape of it

### Requirement: Overlays lay one more fact over any picture

The system SHALL apply, with `--overlay tests,storages,heat` in any mix, these marks: modules no test imports (orange, "no tests"), storages ("⛁ what it holds"), and a shade by the calls into each shape with the count in its label; with `--changes`, the review's marks (added, removed, changed) over the same picture; `--only-changes` keeps the marked shapes and their neighbours.

#### Scenario: Three overlays at once

- **WHEN** `archdiff diagram layer:lib --overlay tests,storages,heat` runs
- **THEN** `src/db/store.ts` is labelled "no tests", "⛁ the file system" and "2 calls in", carries the `warning` mark and a heat value, and the reason names all three overlays

### Requirement: The layout is deterministic and lines never cross a shape

The system SHALL rank shapes by their longest path, order each rank by the barycentre of its neighbours, place them in lanes, and route every line orthogonally: out of the right of its source, along a channel in the gap before the target's column, into the target's left; a line over several columns takes a corridor between rows when a shape is in its way; a backward line goes through the gaps beside the columns. The same diagram SHALL give the same places and routes.

#### Scenario: No line through a shape

- **WHEN** any view of the sample fixture is laid out and routed
- **THEN** no segment of any line overlaps a shape that is not the line's own source or target

### Requirement: A sequence stays readable

The system SHALL draw at most 12 lifelines in a `sequence:` view, the rest sharing one "… N more" lifeline, and collapse a call repeated in a row into one message "×N".

#### Scenario: Thirteen modules on the way

- **WHEN** a function's calls cross 13 modules
- **THEN** the sequence shows 11 of them and one "… 2 more" lifeline, and the reason says so
