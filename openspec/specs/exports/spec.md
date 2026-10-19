# Exports Specification

## Purpose

Every placed picture can leave as text other tools open: Markdown with Mermaid, Mermaid alone, draw.io, Excalidraw, ArchiMate Open Exchange, or the diagram's own JSON; byte-stable for the same diagram.

## Requirements

### Requirement: Every format is stable and complete

The system SHALL write `md`, `mermaid`, `json`, `drawio`, `excalidraw` and `archimate` for any placed diagram, with stable IDs derived from archdiff's IDs, the lanes as containers, every mark (added, removed, changed, warning, planned) as a colour and style, the routes of the lines as given, and the commit and date the picture was drawn from (`stamp`) where the format has a place for it.

#### Scenario: Four formats parse

- **WHEN** a view is exported to drawio, archimate, excalidraw and json
- **THEN** the two XML files parse as XML, the two JSON files as JSON, every Excalidraw ID and every ArchiMate identifier is unique (two lines between one pair of shapes by their index) and every bound text refers to an element that exists

#### Scenario: The stamp

- **WHEN** a diagram is exported from a git repository
- **THEN** the Mermaid holds `%% commit <sha> (<date>)` and the draw.io file `agent="archdiff commit <sha>"`

### Requirement: The Mermaid type fits the view

The system SHALL write a `sequenceDiagram` for a sequence view, a `classDiagram` for a class view, a `stateDiagram-v2` for a machine, a `quadrantChart` for the metrics, a `gitGraph` for the timeline and the branches, and a `flowchart` otherwise (top down, with diamonds, for a function's logic); `--mermaid flowchart|c4|quadrant|pie|gitgraph|mindmap|state` SHALL pick another type, `flowchart` for any picture (a sequence as its modules and numbered messages); a type that draws some kinds of view only (a gitGraph the timeline and the branches, a state diagram a machine, a quadrant the hotspots and the metrics) SHALL leave another picture in its own type, with a comment saying why, never empty; marks SHALL be `classDef` classes for shapes and `linkStyle` for lines. Every block SHALL parse in Mermaid 11: an empty label is a space, an axis's words are quoted, a mindmap's texts are quoted.

#### Scenario: A gitGraph of a module

- **WHEN** `archdiff diagram module:src/lib/orders.ts --format mermaid --mermaid gitgraph` runs
- **THEN** the output is the module's flowchart, with `%% --mermaid gitgraph: gitgraph draws the commits of the timeline or of the branches, so the picture is written as its own type`

#### Scenario: A sequence in Mermaid

- **WHEN** `archdiff diagram sequence:src/routes/checkout.tsx#action --format mermaid` runs
- **THEN** the output starts with `sequenceDiagram`, one `participant` per module and one numbered message per call

### Requirement: The Markdown page of a picture

The system SHALL write for every picture a Markdown page with its title, the question it answers, its reason, its counts, the Mermaid block, and the shapes by lane with their `file:line` and what the overlays found; a matrix as a table, a sequence as a numbered list, classes box by box.

#### Scenario: Overlays in the list

- **WHEN** `layer:lib` is written with the tests, storages and heat overlays
- **THEN** a line reads "- **src/db/store.ts** — no tests · ⛁ the file system · 2 calls in — src/db/store.ts:1"

### Requirement: The operations the code calls export as a Postman collection

The system SHALL write, with `archdiff postman` and from the page's export menu on an `apis` picture, a Postman collection (schema v2.1) of the SCAPI operations the code calls: a folder per family, a request per operation with the method and the path the storefront-next runtime declares (read from the runtime in `node_modules` when it is there, else from the table archdiff ships, the source named in the collection's description), the path parameters as `{{variables}}` listed among the collection's variables, `siteId` and the query parameters the code sends as query, a JSON body built from what the code sends (a literal's value, a name as its `{{variable}}`), and in the request's description who calls it, what it sends and what it reads of the result; an operation the runtime does not declare gets a placeholder path that says so.

#### Scenario: A cart action's basket operations

- **WHEN** the code calls `clients.shopperBasketsV2.addItemToBasket({ parameters: { basketId }, body: [{ productId, quantity: 1 }] })`
- **THEN** the collection's `ShopperBasketsV2` folder has a `POST` request at `{{baseUrl}}/checkout/shopper-baskets/v2/organizations/{{organizationId}}/baskets/{{basketId}}/items?siteId={{siteId}}` with the body `[{ "productId": "{{productId}}", "quantity": 1 }]`, `basketId` among the variables, and a description naming the calling module
