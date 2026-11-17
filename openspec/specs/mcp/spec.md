# MCP Specification

## Purpose

`archdiff mcp` serves the analysis to a coding agent over the Model Context Protocol, so that the agent asks an architecture question while it works instead of receiving pictures in its prompt: what can be drawn, a view, the check against the contract, one import asked about before it is written, who depends on a module or a function, the review of the work so far. The protocol is written by hand; the answers are what the CLI computes.

## Requirements

### Requirement: The server speaks MCP over stdio

The system SHALL offer `archdiff mcp [dir]`, which reads JSON-RPC 2.0 messages from stdin, one per line, and writes its answers to stdout, one per line, until stdin ends, then exits 0. It SHALL answer `initialize` with the protocol revision asked for when it is one of 2025-11-25, 2025-06-18, 2025-03-26 and 2024-11-05 and with the newest of them otherwise, the `tools` capability, the server's name (`archdiff`) and version, and instructions saying which tool answers which question; `ping` with an empty result; `tools/list` with the tools; `tools/call` with a tool's answer. A notification SHALL get no answer; `notifications/cancelled` SHALL drop the answer of the request it names while that request is being answered. A batch (an array of messages) SHALL be answered by one array. Requests SHALL be answered as they finish, each under its own id. Nothing but the protocol's messages SHALL be written to stdout; the notes of the analysis go to stderr. The system SHALL NOT serve the protocol over HTTP, and SHALL add no runtime dependency for it.

#### Scenario: The handshake

- **WHEN** a client sends `initialize` with `protocolVersion` "2025-06-18"
- **THEN** the result holds `protocolVersion` "2025-06-18", `capabilities` `{ "tools": {} }` and `serverInfo` `{ "name": "archdiff", "version": <the package's> }`

#### Scenario: A revision the server does not speak

- **WHEN** a client sends `initialize` with `protocolVersion` "1999-01-01"
- **THEN** the result holds `protocolVersion` "2025-11-25", and the client decides

#### Scenario: A client of the revision without a handshake

- **WHEN** a client sends `server/discover`
- **THEN** the answer is the JSON-RPC error -32601 `Method not found: server/discover`, on which that client falls back to `initialize`

#### Scenario: The input ends

- **WHEN** the client closes the server's stdin
- **THEN** every request already read is answered and the server exits 0

#### Scenario: A line that is no JSON

- **WHEN** the line `not json` arrives
- **THEN** the answer is the error -32700 with a null id, and the next request is answered

#### Scenario: A request given up

- **WHEN** a `tools/call` and `notifications/cancelled` naming its id arrive together
- **THEN** the call gets no answer, and the next request is answered

### Requirement: Six tools that only read, answered from the code as it is now

The system SHALL list six tools — `views`, `diagram`, `check`, `may_import`, `impact`, `review` — each with a title, a description saying what it answers and when to ask it, the JSON Schema of its arguments (no argument beyond those it names) and the hint that it only reads. A tool SHALL answer with one text. Every call SHALL read the analysis of the working tree again (calls that arrive while one is being made share it), so a file edited between two calls is in the second answer. No tool SHALL change the code, the contract or a drawing.

#### Scenario: The list

- **WHEN** a client sends `tools/list`
- **THEN** the tools are `views`, `diagram`, `check`, `may_import`, `impact` and `review`, each with `annotations.readOnlyHint` true

#### Scenario: An edit between two calls

- **WHEN** `check` answers that no import goes against the intent, a route is then edited to import the store, and `check` is called again
- **THEN** the second answer names the import `src/routes/checkout.tsx:1` → `src/db/store.ts` as against the intent

### Requirement: views and diagram answer as the commands do

The `views` tool SHALL answer with the list `archdiff views` prints, `key<TAB>title` per line; `kind` SHALL keep the views of one kind, and `changed` the views of the files changed since `base` (to `head`), headed by a line counting them — outside git every view, headed by why the changed files could not be told apart. The `diagram` tool SHALL draw the view `view` names as the Markdown `archdiff diagram` writes, taking every option of the picture by the name the API's query gives it (`depth`, `limit`, `weight`, `hubs`, `packages`, `expand`, `hide`, `overlay`, `changes`, `only`, `changed`, `mermaid`, `lanes`, `types`) with its schema written from the one table of options, and the revisions `base`, `head` and `heads`; `head` on a view that is no change SHALL draw the code at that revision.

#### Scenario: The list of views

- **WHEN** `views` is called on the sample
- **THEN** its text is what `archdiff views` prints

#### Scenario: A view with options

- **WHEN** `diagram` is called with `view` "module:src/db/store.ts", `depth` 0 and `packages` true
- **THEN** its text is what `archdiff diagram module:src/db/store.ts --depth 0 --packages` prints: the module and `node:fs`, without its importer

### Requirement: check and may_import ask the contract

The `check` tool SHALL answer with the report of `archdiff check` — the layers of the contract and the rules of `archdiff.json`, held against the repository's baseline, so a violation the baseline lists is named apart and fails nothing; without a rule and without an `ARCHITECTURE.md` that names a layer, with the sentence the command says instead. The `may_import` tool SHALL say whether the contract lets `from` import `to`, each a module's path (a declaration's ID stands for its module; a path the code does not have is placed in the layer archdiff.json gives it) or a layer's name: *Allowed* when both ends are in one layer or an arrow of the contract crosses their layers (the arrow named), *Not allowed* when both layers are the contract's and no arrow crosses them — with the layers the importer may import, and that an import of types only is never a violation — and *Not judged* when the contract does not name one of the layers, or there is no contract. Its verdict SHALL be the rule `check` holds the code to.

#### Scenario: Along an arrow

- **WHEN** the contract has `src/lib/orders.ts → src/db/store.ts` and `may_import` is asked from `src/lib/orders.ts` to `src/db/store.ts`
- **THEN** the answer starts with "Allowed:" and names that arrow

#### Scenario: Across two layers without an arrow

- **WHEN** `may_import` is asked from `src/routes/checkout.tsx` to `src/db/store.ts` and no arrow goes from routes to db
- **THEN** the answer starts with "Not allowed:", says `archdiff check` would report the import, and that **routes** may import **lib**

#### Scenario: A file still to be written

- **WHEN** `may_import` is asked from `src/db/new-table.ts`, which does not exist, to a routes module
- **THEN** the file is placed in the layer **db** by its path, and the answer is "Not allowed:"

#### Scenario: A layer the contract does not name

- **WHEN** `may_import` is asked from `tests/orders.test.ts` to a lib module, and the contract names no layer of the tests
- **THEN** the answer starts with "Not judged:" and names the layer the contract lacks

### Requirement: impact names who depends on a module or a function

The `impact` tool SHALL answer, for `target` — a module's path, a declaration's ID (`<path>#<name>`), or a view's key naming one — with what `archdiff impact` reports of it (the impact specification), from the one computation the command and the view read: the risk of a change, 0–100, with the parts of its score; the dependents — for a module, the modules that import it or call into it; for a function or a class, its callers (a class's: of its members too; a call at a module's top level is that module's) — breadth-first to `depth` steps (3 unless given), every dependent once at its shortest distance, with its layer, what it reaches the target through and the file and line that import or call is written at, what lies further counted; and every test that reaches the target, at any distance, however short the list. For a declaration, the other test files that import its module with no call archdiff follows SHALL be named apart. For a type, which nothing calls, the answer SHALL be of its module with the imports of types alone counted, and SHALL say so. The answer SHALL say that a call archdiff could not follow is in no list.

#### Scenario: A function's callers by distance

- **WHEN** `impact` is called with `target` "src/db/store.ts#saveOrder" on the sample
- **THEN** the answer opens with the risk and its parts, and `placeOrder` is 1 step away, `OrderService.place` 2 and the route's `action` 3, each with what it reaches the target through and the line of its call

#### Scenario: The depth cuts the list, not the tests

- **WHEN** a test file calls `placeOrder` in a test's body, and `impact` is called for `saveOrder` with `depth` 1
- **THEN** the list holds `placeOrder` alone and counts 2 more beyond 1 step, and the tests name that file, 2 steps away through `placeOrder`

#### Scenario: A test that only imports

- **WHEN** a test file imports the store's module whole and makes no call archdiff follows
- **THEN** the answer for `saveOrder` names it among the test files that import its module with no call archdiff follows, 1 step away

### Requirement: review answers with the architectural diff

The `review` tool SHALL answer with the Markdown `archdiff review` writes for the working tree (or `head`) against `base` (default: where the head left develop, main or master): the counts, the new dependencies between layers each marked against or allowed by the contract, the picture, every change by kind.

#### Scenario: The work so far

- **WHEN** a route was edited to import the store, which the contract forbids, and `review` is called with `base` "HEAD"
- **THEN** the answer has "## ⚠ New dependencies between layers" and "**routes → db** — against ARCHITECTURE.md"

### Requirement: A wrong call is an error in the CLI's words

A call that was wrong — a tool the server does not have, an argument the tool does not name, a view that does not exist, a subject the code does not have, an option's value the table refuses, a ref git does not know, a target that is no module or declaration — SHALL be answered with the JSON-RPC error -32602 whose message is the one the CLI gives for the same mistake (an option is named as the API's query names it), and the server SHALL answer the next request. A tool that ran and failed — git refusing outside a repository — SHALL be answered with a result marked `isError` whose text is the reason. A method the server does not have SHALL be the error -32601, a message that is no JSON-RPC 2.0 request -32600.

#### Scenario: An unknown view

- **WHEN** `diagram` is called with `view` "nope"
- **THEN** the answer is the error -32602 `diagram: unknown view "nope"`, as `archdiff diagram nope` says on stderr

#### Scenario: A subject the code does not have

- **WHEN** `diagram` is called with `view` "module:src/none.ts"
- **THEN** the answer is the error -32602 `diagram: no module "src/none.ts" (archdiff views lists them)`

#### Scenario: An argument the tool does not name

- **WHEN** `diagram` is called with `dpth` 2
- **THEN** the answer is the error -32602 `diagram: unknown argument "dpth" (…)`, listing the arguments it has

#### Scenario: Outside git

- **WHEN** `review` is called in a directory that is not a git repository
- **THEN** the answer is a result with `isError` true and the text "… is not a git repository"
