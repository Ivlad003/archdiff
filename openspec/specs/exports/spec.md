# Exports Specification

## Purpose

Every placed picture can leave as text other tools open: Markdown with Mermaid, Mermaid alone, draw.io, Excalidraw, ArchiMate Open Exchange, or the diagram's own JSON; byte-stable for the same diagram.

## Requirements

### Requirement: Every format is stable and complete

The system SHALL write `md`, `mermaid`, `json`, `drawio`, `excalidraw` and `archimate` for any placed diagram, with stable IDs derived from archdiff's IDs, the lanes as containers, every mark (added, removed, changed, warning, planned) as a colour and style, the routes of the lines as given, and the commit and date the picture was drawn from (`stamp`) where the format has a place for it.

#### Scenario: Four formats parse

- **WHEN** a view is exported to drawio, archimate, excalidraw and json
- **THEN** the two XML files parse as XML, the two JSON files as JSON, every Excalidraw ID is unique and every bound text refers to an element that exists

#### Scenario: The stamp

- **WHEN** a diagram is exported from a git repository
- **THEN** the Mermaid holds `%% commit <sha> (<date>)` and the draw.io file `agent="archdiff commit <sha>"`

### Requirement: The Mermaid type fits the view

The system SHALL write a `sequenceDiagram` for a sequence view, a `classDiagram` for a class view, a `gitGraph` for the timeline, and a `flowchart` otherwise; `--mermaid c4|quadrant|pie|gitgraph|mindmap` SHALL pick another type where it fits; marks SHALL be `classDef` classes.

#### Scenario: A sequence in Mermaid

- **WHEN** `archdiff diagram sequence:src/routes/checkout.tsx#action --format mermaid` runs
- **THEN** the output starts with `sequenceDiagram`, one `participant` per module and one numbered message per call

### Requirement: The Markdown page of a picture

The system SHALL write for every picture a Markdown page with its title, the question it answers, its reason, its counts, the Mermaid block, and the shapes by lane with their `file:line` and what the overlays found; a matrix as a table, a sequence as a numbered list, classes box by box.

#### Scenario: Overlays in the list

- **WHEN** `layer:lib` is written with the tests, storages and heat overlays
- **THEN** a line reads "- **src/db/store.ts** — no tests · ⛁ the file system · 2 calls in — src/db/store.ts:1"
