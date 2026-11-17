# What-if Specification

## Purpose

The architecture as it would be after a change that has not been made: a module moved, a module deleted, functions split off into a new module — recomputed on the graph of the code without touching a file, and reported as a review reports a change that was made, with what it would break said first.

## Requirements

### Requirement: A change is supposed on the graph, and no file is touched

The system SHALL suppose one of three changes on the analysis's graph and build the graph after it. A move (`move:<path>><to>`) SHALL put the module at the new path — a path that is no source file, or ends in `/`, is a directory, and the file keeps its name — with the layer `archdiff.json` gives that path, its functions, imports and calls renamed with it. A deletion (`delete:<path>`) SHALL take away the module, its functions, its imports and the calls from it, and a package only it imported. A split (`split:<path>#<fn>,<fn>><new path>`) SHALL put the named top-level declarations (a class with its members) in a new module in the layer of its path, and let the imports follow the code that uses them: an importer of the old module imports the new one where its import binds a moved name or it calls a moved declaration, and keeps the old one where it binds anything else; an import of the old module goes with the moved declarations that use the names it binds (callees, types, values), stays where the rest uses them or nothing tells; the two halves import each other where one calls the other, by types only where one only names a type of the other. No file SHALL be read for writing or changed.

#### Scenario: A move into another layer

- **WHEN** `archdiff whatif move src/db/store.ts src/routes --json` runs on the sample repository
- **THEN** the change lands at `src/routes/store.ts`, its layer goes from db to routes, and `src/db/store.ts` is on disk as it was

#### Scenario: A split's imports follow the code

- **WHEN** `archdiff whatif split src/lib/orders.ts placeOrder,validate src/lib/place.ts --json` runs
- **THEN** the imports added are `src/lib/orders.ts → src/lib/place.ts`, `src/lib/place.ts → src/db/store.ts` and `src/lib/place.ts → src/lib/log.ts`, and the import removed is `src/lib/orders.ts → src/lib/log.ts`

#### Scenario: A class leaves with its methods

- **WHEN** `archdiff whatif split src/lib/orders.ts OrderService src/lib/service.ts --json` runs
- **THEN** the route that binds `OrderService` imports `src/lib/service.ts` and no longer `src/lib/orders.ts`

### Requirement: A what-if is reported as a review, with what it would break

The system SHALL report the code as it would be against the code as it is as the architectural diff of a review — the modules, functions, imports, calls and packages added and removed, the dependencies between layers that would appear or go — and beside it: the imports and calls a deletion would leave without their target; the imports that would go against the contract (ARCHITECTURE.md) and do not now, and those that do now and would not, by the contract's check on both graphs (without a contract that names a layer the report SHALL say there is nothing to hold the change against); and the circles of modules importing each other and of layers that would close, break or change. The findings — a broken import or call, an import against the contract, a circle of modules that would close or grow, a circle of layers that would close — SHALL be named one line each.

#### Scenario: A deletion breaks an import

- **WHEN** `archdiff whatif delete src/lib/log.ts` runs
- **THEN** the Markdown has "⚠ Broken by it" with `src/lib/orders.ts:3` importing it and `placeOrder` calling `log`, and the command exits 1

#### Scenario: A move against the contract

- **WHEN** the contract allows routes → lib → db and `archdiff whatif move src/db/store.ts src/routes` runs
- **THEN** the report says `src/lib/orders.ts:2` would go against it (lib → routes) and that a circle of layers lib ⇄ routes would close

#### Scenario: A split that closes a cycle

- **WHEN** `archdiff whatif split src/lib/orders.ts placeOrder src/lib/place.ts` runs
- **THEN** the report says it would close a circle of modules `src/lib/orders.ts ⇄ src/lib/place.ts`, and the command exits 1

#### Scenario: A deletion that takes a violation away

- **WHEN** a routes module imports the store against the contract and `archdiff whatif delete` of that module runs
- **THEN** the report says the import would no longer go against the contract, and the command exits 0

### Requirement: The what-if is a command, a view and data

The system SHALL offer `archdiff whatif move <module> <to>`, `whatif delete <module>` and `whatif split <module> <fn,fn…> <new module>`, and the view `whatif:<change>` (the forms above), written as Markdown (what was supposed, the counts, what breaks, the contract, the cycles, the picture, every change by kind), as data (`--json`: the change as understood, the layer before and after, the diff, the violations, the cycles, what breaks, the findings) and as the picture in every export format. The picture SHALL be the review's picture of the diff, with a module whose import would break marked and an import that would go against the contract labelled on its line. The command SHALL exit 1 when there is a finding and 0 otherwise. A change that cannot be supposed — a module the code does not have, a move to where the module is or to a path that holds a module, a split of a name the module does not declare at its top level, of every declaration (that is a move), into a module that exists or a path that is no source file, a change that is none of the three, an argument too few or too many — SHALL be a wrong call (exit 2) that names what is wrong.

#### Scenario: A clean change

- **WHEN** `archdiff whatif delete src/routes/checkout.tsx` runs
- **THEN** it exits 0, and the report says no import would start or stop going against the contract and no circle would close or break

#### Scenario: A name the module does not declare

- **WHEN** `archdiff whatif split src/lib/orders.ts nope src/lib/x.ts` runs
- **THEN** it exits 2 with `whatif: src/lib/orders.ts declares no "nope" at its top level (it declares Order, placeOrder, validate, findOrder, OrderService)`

### Requirement: The page supposes a change from a shape's menu

The system SHALL offer, in the menu of a right click, on a module *What if it were deleted* and *What if it moved…* (the page asks for the path or the directory), and on a function of a module's top level *What if it were split off…* (the page asks for the new module, offering one named after the function beside the old); each SHALL open the what-if as a picture, as a review opens: the title names the change and what it would break (or that nothing would), the Markdown panel holds the report, a module's page says what the change would do to it, and nothing is drawn on the picture.

#### Scenario: A module supposed deleted

- **WHEN** `log.ts` is right-clicked on `layer:lib` and "What if it were deleted" is chosen
- **THEN** the link holds `whatif:delete:src/lib/log.ts`, the title starts "What if: delete src/lib/log.ts — ⚠ 1 import would break", `log.ts` is marked removed and `orders.ts` marked for its broken import, and the edit button is off
