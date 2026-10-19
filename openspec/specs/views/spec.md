# Views Specification

## Purpose

Each view is one picture that answers one architectural question, computed from the graph as an unplaced diagram, then shaped (hubs, hidden lanes, expansion, fold, weight) and laid out deterministically.

## Requirements

### Requirement: Every view answers one question

The system SHALL offer these views, each with a one-sentence question it answers: `layers`, `modules`, `layer:<name>`, `dir:<path>`, `module:<path>`, `inside:<path>`, `usage:<path>` (also read as `contract:<path>`, its old name), `calls:<path>#<fn>`, `sequence:<path>#<fn>`, `path:<path>#<fn>`, `type:<path>#<Type>`, `cycles`, `cycles:fns`, `cycle:<path>`, `cycle:<path>#<fn>`, `classes`, `classes:<scope>`, `matrix`, `matrix:<dir>`, `metrics`, `metrics:<layer>`, `messages`, `messages:<path>`, `machines`, `machine:<path>#<name>`, `focus:<path>`, `focus:<path>#<fn>`, `logic`, `logic:<path>#<fn>`, `events`, `tests`, `hotspots`, `packages`, `timeline`, `branches`, `coverage`, `intent`, `review`, `compare` (the revisions of the link: a base, a head, the heads) and `commit:<sha>`. A view with a subject that does not exist SHALL be empty with a reason naming the subject. A picture of its subject alone SHALL say why: a module no module of the repository imports and that imports none of them (with the packages `--packages` would draw), a function that calls no function of the repository. The inside of a module that declares no function or class (a script) SHALL draw its top level, where its calls come from the module itself, and the functions it calls; a script whose top level calls none archdiff followed SHALL be empty with a reason saying so. Every shape SHALL say what a second tap on it opens — its kind's own view, or the view it names (`opens`: a folded directory, a package, a machine, a header of a matrix) — the same for the page and every export.

#### Scenario: A module view

- **WHEN** `archdiff diagram module:src/lib/orders.ts` runs
- **THEN** the picture shows the module, what it imports and what imports it, one lane per layer, and its question is "what the module imports and what imports it"

#### Scenario: A script's inside

- **WHEN** `archdiff diagram inside:src/lib/seed.ts` runs on a script that only imports `placeOrder` and calls it
- **THEN** the picture holds the script's top level (`src/lib/seed.ts (top level)`) calling `placeOrder`, and its reason says the module declares no function or class

#### Scenario: A missing subject

- **WHEN** `archdiff diagram layer:nope` runs
- **THEN** the command exits 2 with `no layer "nope"`

### Requirement: A picture that goes a depth says what lies beyond it

The system SHALL tell each module and function of a picture that goes a depth its neighbours of the repository the picture leaves out (`beyond`): before it, what imports or calls it from beyond the picture; after it, what it imports or calls there — by the imports a depth grows along (type-only ones not) and the calls (a module's top level among the callers), counted on the picture as its view drew it, before a fold or a hidden lane, the first twenty of each named. The Excalidraw scene SHALL count them under the shape's corners (◂ N on the left, N ▸ on the right), the picture's Markdown beside the shape, and the shape's page SHALL list them under "Beyond this picture". A view that goes no depth (the layers, the whole map) SHALL have none.

#### Scenario: The next step of depth

- **WHEN** `archdiff diagram module:src/lib/log.ts` runs, then with `--depth 2`
- **THEN** `orders.ts` has `checkout.tsx` before it and `store.ts` after it beyond the picture, then nothing beyond, as depth 2 draws them

### Requirement: A focus view joins everything to one shape

The system SHALL draw, as `focus:<path>#<fn>`, the function with the functions that call it and the ones it calls (`--depth` steps each way, calls and references alike), and as `focus:<path>` the module's functions with their callers and callees in other modules and the modules joined to it by an import alone (then the module itself as a shape, with dependency lines); each module SHALL be a lane, the subject's first.

#### Scenario: A function's focus

- **WHEN** `archdiff diagram focus:src/lib/orders.ts#placeOrder` runs
- **THEN** the picture holds `placeOrder` with `OrderService.place` calling it and `validate`, `saveOrder` and `log` called by it, in the lanes of their modules, and the reason counts the calls in and out

### Requirement: Messages sent with a type are events

The system SHALL draw, in `events`, a message sent with a `type` — `postMessage`, `sendMessage` or `send` of an object literal whose `type` is a string — as an event of that type from the sender (the function, or the module for a call at its top level), handled by every function of the repository that compares or switches on a `type` with that value; a value no message is sent with SHALL be no event.

#### Scenario: A side panel, its service worker and a content script

- **WHEN** the panel's top level runs `port.postMessage({ type: 'ping' })`, the service worker's `fromPanel` has `if (msg.type === 'ping') port.postMessage({ type: 'pong' })` and `chrome.tabs.sendMessage(tabId, { type: 'highlight' })`, and the content script's `onMessage` has `if (msg.type === 'highlight')`
- **THEN** the picture has `panel.js → ping → fromPanel`, `fromPanel → pong → panel.js#onMessage` and `fromPanel → highlight → content.js#onMessage`, and no event for a type nothing sends

### Requirement: The messages between the parts read as a sequence

The system SHALL draw, as `messages` (`messages:<path>` for the messages one module sends or handles), the modules as the participants of a sequence diagram and every message sent with a `type` as an arrow from the sender's module to the module of each function that handles that type — one arrow per sender, handler and type, in the order the senders' code sends them, counted when sent from several places; a type no function handles SHALL be named in the reason; the Mermaid SHALL be a `sequenceDiagram` whose messages carry the type without `()`.

#### Scenario: The panel, the service worker and the content script

- **WHEN** the panel's top level posts `ping`, the service worker's `fromPanel` handles it and posts `pong` and sends the content script `highlight`, which it handles
- **THEN** the sequence has `background.js → panel.js: pong`, `background.js → content.js: highlight` and `panel.js → background.js: ping`, and `messages:panel.js` keeps `pong` and `ping` only

### Requirement: The class diagram joins its boxes

The system SHALL draw, as `classes` (`classes:<module|dir>` for a scope), every class, interface and object type as a box with its fields and methods, and the lines between the boxes: `extends` and `implements` as written; `has` from a box to the class or interface a field of it is typed with; `uses` from a box to another whose members or constructor its methods call, counted, left out where the pair is joined by inheritance or a field already. A box an `extends`, `implements` or `has` names outside the scope SHALL be brought in from the modules the scope imports; `uses` SHALL stay among the boxes drawn. The Mermaid SHALL be a `classDiagram` with `<|--`, `<|..`, `--> : has` and `..> : uses`.

#### Scenario: A service with a repository field

- **WHEN** `class Service extends Base implements Repo` holds `private readonly repo: Repo` and its `save` calls `this.repo.save(o)`, and `class Memory implements Repo` exists
- **THEN** the picture has the lines `Service extends Base`, `Service implements Repo`, `Service has Repo` and `Service uses Memory`, and `classes:src/service.ts` brings `Repo` in from `src/repo.ts` and draws no `uses`

### Requirement: Big pictures fold by directory

The system SHALL fold a picture with more shapes than the limit (40 by default, 200 for the whole map `modules`, `--limit`) by directory into "… N in dir/" shapes, merging the lines into each folded shape with a count, and say so in the reason; the Markdown SHALL list everything.

#### Scenario: A directory with hundreds of modules

- **WHEN** a `dir:` view would hold 300 modules
- **THEN** the picture holds at most the limit plus the folded shapes, the reason says how many were folded, and a tap on a folded shape opens that directory

#### Scenario: The whole map of fifty modules

- **WHEN** `archdiff diagram modules` runs on a repository of fifty modules
- **THEN** the picture holds every module, none folded, and `--limit 40` folds it

### Requirement: Hubs become badges

The system SHALL take out of a module-level picture of eight modules or more any module imported by at least a quarter of the picture's modules (at least 6, at most 40 importers; `archdiff.json` `hubs` sets the `min`, the `share` and the `max`) and write its name as a badge "+ name" on each importer, naming the hubs in the reason; the view's own subject is never a hub, nor a module a review marked; `--no-hubs` draws them.

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

The system SHALL rank shapes by their longest path, order each rank by the barycentre of its neighbours, place them in lanes, and route every line orthogonally: out of the right of its source, along a channel in the gap before the target's column, into the target's left; a line over several columns takes a corridor between rows when a shape is in its way; a backward line goes through the gaps beside the columns. The same diagram SHALL give the same places and routes. A line's label SHALL sit on its line — on the segment with room for it, the longest first — off the other labels, and off the shapes wherever the line leaves room (a label wider than the gap it crosses covers the least it can).

#### Scenario: No line through a shape

- **WHEN** any view of the sample fixture is laid out and routed
- **THEN** no segment of any line overlaps a shape that is not the line's own source or target

### Requirement: A sequence stays readable

The system SHALL draw at most 12 lifelines in a `sequence:` view, the rest sharing one "… N more" lifeline, and collapse a call repeated in a row into one message "×N".

#### Scenario: Thirteen modules on the way

- **WHEN** a function's calls cross 13 modules
- **THEN** the sequence shows 11 of them and one "… 2 more" lifeline, and the reason says so

### Requirement: Cycles say where to cut

The system SHALL draw every strongly connected component of two or more modules (or, in `cycles:fns`, of functions across modules) as a lane and mark the fewest, then lightest, lines whose removal breaks it (exact up to 14 lines, a greedy order beyond), red and dashed with "cut: N imports"; layers importing each other SHALL get a lane of their own; `--types` SHALL count type-only imports too (dashed) in `cycles`, `cycle:` and `matrix`.

#### Scenario: A type-only circle

- **WHEN** `archdiff diagram cycles --types --format mermaid` runs on the sample
- **THEN** the line from `src/db/store.ts` to `src/lib/orders.ts` is dashed and labelled "cut: 1 import", and the reason names "layers in a circle: db ⇄ lib"

### Requirement: The steps after a view are data

The system SHALL apply, after a view, the steps of one list in order — hidden lanes, modules opened in place, hubs as badges, the question, the fold, the light lines, the review's marks, only the changed, the overlays, the lane mode, and the warning of a depth past 12, put first — each a pure function of the picture that adds to its reason; the CLI, the server and the page SHALL run the same list with the same table of options. The changes laid over a picture (`changes`) SHALL be left out, with a note in the reason, when git cannot give them (outside a repository, a bad ref); the picture SHALL still be drawn.

#### Scenario: The same picture everywhere

- **WHEN** a picture is asked for with the same options from the CLI and from the API
- **THEN** the shapes, lines, lanes and reason are the same

### Requirement: Lanes lie as rows or as columns

The system SHALL lay the lanes as bands down the picture (rows) or as blocks across it in the order the lines flow (columns, `--lanes columns`), and SHALL choose columns by itself for a map of more than six lanes (`modules`, `layer:`, `dir:`); every shape SHALL sit inside its lane either way.

#### Scenario: Columns on request

- **WHEN** `archdiff diagram modules --lanes columns --format json` runs on the sample
- **THEN** the lanes' x-ranges do not overlap and the routes lane sits left of the lib lane

### Requirement: Shapes placed by hand keep the lines off them

The system SHALL, when a saved drawing moved shapes out of the layout's columns, route the lines on a grid of the shapes' sides so that no line runs through a shape but its own ends, orthogonally; a computed shape SHALL never sit on a shape placed by hand.

#### Scenario: Random placements

- **WHEN** 150 random placements of 6–22 shapes with random lines are routed
- **THEN** no segment crosses a shape and every segment is horizontal or vertical

### Requirement: The operations of an external API are shapes

The system SHALL draw, as `apis`, the families of an external API the code calls (SCAPI: a call `clients.shopper<Family>.<operation>()`, a destructured `shopper<Family>.<operation>()`, or a call on a value typed `Shopper<Family>`) in the API's lane with their operations and calls counted, the modules calling them in their layers' lanes (one lane for the API, its families as boxes), and the cartridge hooks of `hooks.json` joined — by the resource their name holds, said on the line — to the families serving it that the code calls, a hook on a resource the code calls nothing of named in the reason and no family drawn for it; as `apis:<Family>` the family's operations with the functions calling each and the hooks on the operations of the resource and method they name, said to be by resource; as `apis:<path>` the operations a module calls. The same operations SHALL be external shapes on `calls:` trees, storages of `path:` and `flow`, messages to the family's lifeline in `sequence:`, and the reason `api` in the coverage report, never a blind spot.

#### Scenario: A cart action over SCAPI

- **WHEN** `addToCart` calls `clients.shopperBasketsV2.getBasket()` and `clients.shopperProducts.getProduct()`, and a cartridge's hooks.json names `dw.ocapi.shop.basket.modifyGETResponse`
- **THEN** `apis` draws `ShopperBasketsV2` and `ShopperProducts` with the module calling them and the hook joined to `ShopperBasketsV2` with the label `modify GET response basket`; `apis:ShopperBasketsV2` draws `getBasket` with `addToCart` calling it and the hook on `getBasket`; `calls:` of `addToCart` ends at `ShopperBasketsV2.getBasket`; the coverage report counts the calls under `api` and not as blind

### Requirement: A sequence frames alternatives and stops at hubs

The system SHALL frame, in a sequence, the messages under an `if` and its `else`, under the cases of a `switch`, or under a `try` and its `catch` as one `alt` fragment whose later arms are named (`else`, the case, `catch (e)`), the messages under a loop as `loop`, and under a lone branch as `opt`, nested up to three deep, as the Markdown lists and Mermaid's `alt … else … end` writes them; and SHALL draw a call into a hub module (imported by at least the "hubs" threshold of the repository's modules, unless its functions reach an operation of an API within three calls) as a message without following its calls, naming the hubs in the reason, unless hubs are drawn (`--no-hubs`); over the message limit it SHALL keep the operations of an API and the calls leading to them and drop the deepest of the rest first, and over the lifeline limit fold modules before the families of an API.

#### Scenario: A basket read with an else, a loop and a catch

- **WHEN** `addToCart` reads the basket, logs under `if (!basket)` and adds an item in the `else`, reads each product in a loop, and updates the basket in a `try` whose `catch` logs
- **THEN** the sequence has `alt [!basket]` with an `else` arm, a `loop`, and `alt [try]` with a `catch (error)` arm, and the Mermaid reads `alt !basket … else … end`

### Requirement: A Postman collection is drawn against the code

The system SHALL read every `*.postman_collection.json` the repository lists and the files `archdiff.json`'s `postman` names (schema v2.0 or v2.1, folders nested) and draw, as `postman` (`postman:<file>` for one), each request in its folder's lane joined to the modules calling the operation it names: a request and an operation are one route when their methods agree and their paths have as many segments, each equal or a variable on either side (`{{x}}`, `:x`, `{x}`), the route agreeing on the most segments taken; a request the code never calls SHALL be marked removed, an operation the code calls that the collection lacks marked added in the API's lane, and the reason SHALL count both.

#### Scenario: A cart collection of four requests

- **WHEN** the collection has `GET …/baskets/{{basketId}}`, `POST …/baskets/:basketId/items`, `DELETE …/baskets/{{basketId}}` and `GET …/custom/loyalty/v1/organizations/{{organizationId}}/points`, and the code calls `getBasket`, `addItemToBasket`, `updateBasket`, `getProduct` and `getOrder`
- **THEN** the first two requests are joined to the calling module, the other two are marked removed, and `updateBasket`, `getProduct` and `getOrder` are marked added, the title reading `2 of 4 requests called, 3 operations not in it`

#### Scenario: The collection archdiff wrote

- **WHEN** `archdiff postman` wrote the collection and it is read back as `postman:<file>`
- **THEN** every request is called and no operation is missing

### Requirement: The hotspots fit the canvas

The system SHALL lay the hotspots' boxes in rows as wide as makes the whole a 16:10 picture (laid out twice, as each lane's own rows and heading add height), never under 1100 px, and SHALL shrink the boxes when even that is more than a canvas shows at the page's smallest zoom (9000 × 5600 px of scene), so a repository of thousands of modules is seen whole; a small repository keeps its 1100 px rows and its sizes.

#### Scenario: Four hundred modules

- **WHEN** a repository has 400 modules
- **THEN** the hotspots picture is wider than tall, within 9000 × 5600

### Requirement: A configured collection is checked when the configuration is read

The system SHALL, when `archdiff.json`'s `postman` names a file that is not there, not valid JSON, or no Postman collection, fail with an error naming the field and the file (`archdiff.json: "postman" names a file that is not there: postman/nope.json`), as any wrong field of the configuration does; a collection the repository lists by its name alone is read and, when it is no collection, left out without an error.

#### Scenario: A path to no file

- **WHEN** archdiff.json has `"postman": ["postman/nope.json"]` and no such file
- **THEN** every command exits 2 with `archdiff.json: "postman" names a file that is not there: postman/nope.json`
