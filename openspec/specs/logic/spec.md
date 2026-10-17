# Logic Specification

## Purpose

The business logic of a function as a picture: its body as a flowchart with the conditions as the code writes them, and every path from the start to an exit listed as a rule, so what the code decides can be read and checked.

## Requirements

### Requirement: Every function counts its branches

The system SHALL record on every function and method of a TypeScript, JavaScript or Python file how many branching statements its body holds (`if` and `elif`, a `switch` or `match` as one, a loop, a `try`), nested functions included, and carry the count on the graph node.

#### Scenario: A checkout with a loop, a branch and a try

- **WHEN** `src/checkout.ts` of the machines fixture is extracted
- **THEN** `checkout` carries 3 branches and `audit` 1

### Requirement: A function's body reads as a flowchart

The system SHALL draw, as `logic:<path>#<fn>`, the body read from its file on demand: a start, a decision per `if` (yes and no, an `else if` its own decision), per `switch` or `match` (an arrow per case with its value, `default` or `no match`, a case without `break` falling into the next), per `try` (`ok` into the body, `error` into each handler, everything through `finally`), a loop per `for` or `while` (`each` or `while` into the body, whose end comes back, `done` carrying on, `break` leaving, `continue` returning), a box per run of at most two plain statements with the callees they name, an exit per `return` or `throw` (a `throw` in orange) and an end for the paths that fall off the body; a body longer than 160 boxes SHALL be cut and say so. An unknown function SHALL exit 2; a function of another language SHALL say the body could not be read.

#### Scenario: The checkout's flowchart

- **WHEN** `archdiff diagram logic:src/checkout.ts#checkout` runs on the machines fixture
- **THEN** the Mermaid is a `flowchart TB` with a hexagon for the loop, diamonds for `rush` and `try`, arrows labelled `each`, `yes`, `no`, `done`, `ok` and `error`, the body's boxes coming back to the loop, and `return shipped` as the exit

#### Scenario: A switch and a match

- **WHEN** `logic:src/order.ts#pay` and `logic:src/door.py#Door.lock` are drawn
- **THEN** `pay` has one arrow per case from `switch order.status` with the default throwing (orange), and `Door.lock` one per pattern from `match self.state` with `no match` carrying on to the end

### Requirement: The paths are the rules

The system SHALL list in the Markdown every path from the start to an exit (at most 64, a loop walked once) as a table row: the conditions taken in order (`condition: branch`), the calls made on the way (an error being built is not one), and how the path ends (the return, the throw, or the end of the body).

#### Scenario: The rules of the checkout

- **WHEN** the Markdown of `logic:src/checkout.ts#checkout` is read
- **THEN** one row reads "`const order of orders: each` and `rush: yes` and `try: ok` | `pay`, `ship`, `audit` | **return shipped**" and another "`const order of orders: done` and `try: error` | `cancel` | **return shipped**"

### Requirement: The branching functions are listed

The system SHALL list every function with branches in `archdiff views` (`logic:<path>#<fn>`, with its count) and draw them as the `logic` view, the most branching first, one shape per function in its module's lane, a tap opening its flowchart.

#### Scenario: The list

- **WHEN** `archdiff diagram logic` runs on the machines fixture
- **THEN** the title is "Logic: 7 functions with branches" and `checkout` carries "3 branches"
