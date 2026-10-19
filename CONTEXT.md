# archdiff

Architecture read from the code of a repository, without a model: what its parts are, how they depend on each other, how a change moves them, and whether the code keeps to the architecture it was meant to have.

## The code

**Module**:
A source file of the repository, in one layer.
_Avoid_: file (in prose about the architecture), component

**Layer**:
A named set of modules that depend on other layers in one direction.
_Avoid_: tier, package, group

**Declaration**:
A function, method, class or type a module declares, named by its module and its name.
_Avoid_: node, symbol, fn

**Import**:
A module's use of another module or of a package.
_Avoid_: dependency (for one import), edge

**Call**:
A declaration's use of another declaration that the analysis followed to its target.
_Avoid_: edge, invocation

**Gap**:
A call or an import the analysis could not follow, with the reason.
_Avoid_: hole (for the fact), unresolved edge

**Blind spot**:
A gap into the repository's own code — a computed callee, an unknown member, an interface — as opposed to a call into a package or the language.
_Avoid_: gap (when the distinction matters)

**Unsupported**:
A construct a frontend read but does not follow — an `eval`, a decorator that may replace a function, a computed include — kept with its source and the reason; the coverage report lists them.
_Avoid_: hole (for the fact)

**Hole**:
A gap drawn in a picture: a dashed diamond where a call leads nowhere archdiff could follow.
_Avoid_: gap (for the shape)

**Entry point**:
A declaration execution starts from: a route, a hook, a `main`, a listener of a browser event, an exported function nothing in the repository calls.
_Avoid_: entry, handler

**Storage**:
A module that holds data: a database client, a store, a cache, the file system.
_Avoid_: repository (overloaded), persistence

**Operation**: a call out of the repository that names an operation of an external API archdiff knows — SCAPI's `ShopperBaskets.getBasket` (apis.ts). Named, not blind: a shape of its own on a call tree, a message to its family's lifeline, a storage the path ends at, the `apis` view's unit. A family is the API's client (`ShopperBaskets`); an OCAPI hook of a cartridge modifies the resource a family serves.

**Contract as used**: of an operation — what the code sends (the first argument of the call, key by key: `CallFact.shape`) and what it reads of the result (`FileFacts.reads`, followed through the functions that return the result: `DeclFact.returnsFrom`), merged across the call sites (contracts.ts). Not the declared contract of the API (its types), which may say more; a Postman collection writes it as requests (postman.ts).

**Hub**:
A module most of a picture's modules import, drawn as a badge on its importers instead of as lines.
_Avoid_: utility, common module

## Pictures

**View**:
A question about the code, named by a kind and a subject (`module:src/x.ts`); the same view always gives the same picture of the same code. A kind is registered once, in the table of kinds (`src/view-keys.ts`), from which the page's list groups and overview picker, the chat's tags, the breadcrumbs, the export menu and the CLI's help derive.
_Avoid_: diagram (for the question), page, screen

**Picture**:
What a view gives for the code at hand: shapes, lines and lanes, placed, with the one question it answers.
_Avoid_: diagram (in prose), chart, graph

**Shape**:
One element of a picture standing for a module, a declaration, a layer or a value.
_Avoid_: node, box, element

**Line**:
One element of a picture joining two shapes: an import, a call, a message, a step of a flow.
_Avoid_: edge, arrow, link

**Lane**:
A band of a picture holding the shapes of one layer, one module, one cycle or one opened module.
_Avoid_: group, swimlane, column

**Fold**:
The tail of a big picture drawn as one shape per directory, so the picture stays readable.
_Avoid_: collapse, cluster

**Mix**:
A module opened in place in a picture of modules: it becomes a lane of its declarations.
_Avoid_: expand, drill-down

**Overlay**:
A fact laid over any picture: the untested modules, the storages, the calls into each shape, the instability, a change's marks.
_Avoid_: layer (taken), filter

**Focus**:
The view of everything joined to one shape — its callers, its callees, its importers — across every module.
_Avoid_: dim

**Dim**:
The tool that fades everything in a picture but a shape and its neighbours.
_Avoid_: focus

**Peek**:
The lines of one shape alone, lit, while Alt and the button are held on it; everything comes back when either is released.
_Avoid_: dim (a dim stays), highlight

**Beyond**:
A shape's neighbours its picture leaves out past the depth drawn: what imports or calls it from outside the picture (before it) and what it imports or calls there (after it), counted under the shape.
_Avoid_: outside, hidden (a hidden lane is the reader's choice)

**Chain**:
The lines leading on from a line, or the shortest run of lines between two shapes.
_Avoid_: path

**Layout**:
Where the shapes of a picture sit and how its lines run.
_Avoid_: drawing, arrangement

**Drawing**:
What a reader drew over a picture and saved: moved shapes, strokes, notes, and the mocks of a flow.
_Avoid_: layout, sketch, scene

**Project map**:
The whole repository as dots and lines, laid out by forces, showing where a picture sits in it.
_Avoid_: graph, minimap

**Minimap**:
The current picture in miniature, with the visible part marked.
_Avoid_: map, overview

**Link**:
The address of what the page shows: the view, the picture's options and the revisions.
_Avoid_: state, URL

## The contract

**Contract**:
The architecture the code is meant to have, written as one flowchart in `ARCHITECTURE.md`: layers, the modules that stand for them, the imports allowed between them.
_Avoid_: rules, config, architecture (for the file)

**Intent**:
The contract as the analysis reads it, set against the code: what is planned and not built, what is built beyond it.
_Avoid_: plan, spec

**Violation**:
An import between two layers that no arrow of the contract allows.
_Avoid_: error, breach

**Usage**:
Who uses each export of a module.
_Avoid_: contract (taken)

## Change

**Review**:
The architectural difference between a base revision and a head (a revision or the working tree).
_Avoid_: diff (for the whole), PR check

**Comparison**:
Several heads against one base, side by side.
_Avoid_: multi-review, merge preview

**Mark**:
What a change did to a shape or a line: added, removed, changed; or what the contract says of it: planned, beyond the intent.
_Avoid_: status, colour

**Finding**:
A new dependency between layers that the contract does not allow (any, without a contract): what makes a review fail.
_Avoid_: issue, violation (in a review)

**Messages**:
What the parts of a program say to each other, as a sequence: every message sent with a type, from its sender's module to the module of the function that handles it.
_Avoid_: events (for the typed messages), calls

**Timeline**:
How the dependencies between layers moved, commit by commit.
_Avoid_: history graph

**Branches**:
The picture of the branches against the base: where each left it, its own commits, how far it is ahead and behind.
_Avoid_: git graph, history graph

## Flows and runs

**Calls view**:
The tree of calls from an entry point.
_Avoid_: flow, call graph

**Flow**:
What data an entry point's calls carry, step by step, with the parameters and returns, and the mocks attached.
_Avoid_: calls view, trace

**Mock**:
A value given to a flow in place of real data: the input of the entry, the content of a storage.
_Avoid_: stub, fixture

**Run**:
An entry point executed for real, with its storages answering from the mocks, every function entered recorded.
_Avoid_: simulation, trace (for the whole)

## Machines and logic

**Machine**:
A field or a variable that moves between named states, or a machine a library declares.
_Avoid_: workflow, state chart

**State**:
One of a machine's values.
_Avoid_: status (unless the code says so)

**Logic**:
A function's body as a flowchart of its branches, loops and exits.
_Avoid_: control flow graph (in prose)

**Rule**:
One way through a function: the conditions taken, the calls made, how it ends.
_Avoid_: path, case

## The agent

**Plan**:
What a drawing asks of the code: modules and declarations to add, imports and calls to connect, removals, notes.
_Avoid_: task (for the reading), diff

**Task**:
What the agent is handed: a plan or a question in words, with the context of the pictures it names.
_Avoid_: prompt, job

**Agent run**:
One process of the coding agent on one task, with its events.
_Avoid_: run (taken), session (the agent's own)

**Turn**:
One task of a conversation with the agent and its answer.
_Avoid_: message, exchange

**Question**:
A choice the agent leaves to the reader, with its options.
_Avoid_: prompt, clarification

**Check**:
The contract and the commands of the repository, run after an agent run and on request.
_Avoid_: test (for the whole), gate
