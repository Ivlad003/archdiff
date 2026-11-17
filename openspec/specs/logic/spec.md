# Logic Specification

## Purpose

The business logic of a function as a picture: its body as a flowchart with the conditions as the code writes them, and every path from the start to an exit listed as a rule, so what the code decides can be read and checked.

## Requirements

### Requirement: Every function counts its branches

The system SHALL record on every function and method of a TypeScript, JavaScript, Python, Go, Java or C# file how many branching statements its body holds (`if` and `elif`, a `switch` or `match` as one, a loop, a `try`), nested functions included, and carry the count on the graph node.

#### Scenario: A checkout with a loop, a branch and a try

- **WHEN** `src/checkout.ts` of the machines fixture is extracted
- **THEN** `checkout` carries 3 branches and `audit` 1

### Requirement: A function's body reads as a flowchart

The system SHALL draw, as `logic:<path>#<fn>`, the body read from its file on demand: a start, a decision per `if` (yes and no, an `else if` or a Python `elif` its own decision, its `no` leading on to the next clause and the `else`), per `switch` or `match` (an arrow per case with its value, `default` or `no match`, a case without `break` falling into the next), per `try` (`ok` into the body, `error` into each handler, everything through `finally`: the paths that go on after it, and a `return`, `throw`, `break` or `continue` inside it, the `finally` drawn after the exit, on the way to the end), a loop per `for` or `while` (`each` or `while` into the body, whose end comes back, `done` carrying on, `break` leaving, `continue` returning; `break outer` and `continue outer` to the loop labelled `outer`), a box per run of at most two plain statements with the callees they name, an exit per `return` or `throw` (a `throw` in orange) and an end for the paths that fall off the body; a body longer than 160 boxes SHALL be cut and say so. An unknown function SHALL exit 2; a function of another language SHALL say the body could not be read.

#### Scenario: The checkout's flowchart

- **WHEN** `archdiff diagram logic:src/checkout.ts#checkout` runs on the machines fixture
- **THEN** the Mermaid is a `flowchart TB` with a hexagon for the loop, diamonds for `rush` and `try`, arrows labelled `each`, `yes`, `no`, `done`, `ok` and `error`, the body's boxes coming back to the loop, and `return shipped` as the exit

#### Scenario: A switch and a match

- **WHEN** `logic:src/order.ts#pay` and `logic:src/door.py#Door.lock` are drawn
- **THEN** `pay` has one arrow per case from `switch order.status` with the default throwing (orange), and `Door.lock` one per pattern from `match self.state` with `no match` carrying on to the end

### Requirement: The paths are the rules

The system SHALL list in the Markdown every path from the start to an exit (at most 64, a loop walked once: its body, then on out of it and out of every loop around it it leads back into) as a table row: the conditions taken in order (`condition: branch`, the branch leading back into a loop as well), the calls made on the way (an error being built is not one), and how the path ends (the return, the throw — the one a `finally` ran after — or the end of the body).

#### Scenario: The rules of the checkout

- **WHEN** the Markdown of `logic:src/checkout.ts#checkout` is read
- **THEN** one row reads "`const order of orders: each` and `rush: yes` and `try: ok` | `pay`, `ship`, `audit` | **return shipped**" and another "`const order of orders: done` and `try: error` | `cancel` | **return shipped**"

#### Scenario: A loop in a loop, and a finally

- **WHEN** `for (const row of rows) for (const cell of row) if (cell > 0) work(cell); return 1` and `acquire(); try { if (n > 0) return work(n); return 0 } finally { release() }` are drawn
- **THEN** a rule reads "`const row of rows: each` and `const cell of row: each` and `cell > 0: no` | | **return 1**", and the first path of the other "`try: ok` and `n > 0: yes` | `acquire`, `work`, `release` | **return work(n)**"

### Requirement: The branching functions are listed

The system SHALL list every function with branches in `archdiff views` (`logic:<path>#<fn>`, with its count) and draw the 60 most branching as the `logic` view, the most branching first, one shape per function in its module's lane, a tap opening its flowchart; when more have branches, the reason SHALL say how many more the views list holds.

#### Scenario: The list

- **WHEN** `archdiff diagram logic` runs on the machines fixture
- **THEN** the title is "Logic: 7 functions with branches" and `checkout` carries "3 branches"

### Requirement: A function's logic is held against the base

The system SHALL, for `logic:<path>#<fn>` with `changes` (`--changes`, the page's *changes since base*), read the function's body at the base of the change — the link's base, else where the head left the main line — and at the head, each from its own revision's file, and hold the two flowcharts against each other statement by statement in the order the code writes them: a condition, an exit, or one line of an action is a statement; a statement gone and a statement come of one kind between two that both have, more than half of whose words agree, are one statement rewritten. A step none of whose statements was there SHALL be marked added, a step with some statements new or some of the base's gone from it changed, and a step of the base of which nothing is left SHALL be drawn as removed with the arrows that hung on it; an arrow SHALL be new or gone only between statements that were, and are, in different steps, so that a statement added to a box marks that box and none after it. The page SHALL list, above the rules, the steps that came, went and changed — a changed one with the statements new to it and the ones gone from it — and the rules that came and went; the title SHALL end with "— changes since <base>" and the reason SHALL count them. A function that was not there at the base SHALL be all added; one whose steps and rules are as they were SHALL say so. The review's own marks SHALL not be laid over a function's logic.

#### Scenario: A guard added

- **WHEN** `placeOrder` gains `if (readOrder(id)) throw new Error("placed twice")` and `archdiff diagram logic:src/lib/orders.ts#placeOrder --changes --base HEAD` runs
- **THEN** the page reads "Steps +2 −0 ~0; rules +2 −1.", lists "+ decision `readOrder(id)` — line 10" and "+ throw", the two steps are marked added in the picture, and the arrow that led straight on is drawn as removed

#### Scenario: A condition rewritten

- **WHEN** `validate` tests `order.total <= 0` where it tested `order.total < 0`
- **THEN** the page lists "~ decision at line 17: + `order.total <= 0`; − `order.total < 0`" and no step is added or removed

#### Scenario: A statement added to a box

- **WHEN** one statement is added before four that two boxes held
- **THEN** the one box that holds the new statement is changed, with that statement as what came, and no arrow is new or gone

#### Scenario: A function the change left alone

- **WHEN** the logic of `findOrder`, which the change did not touch, is drawn with `--changes`
- **THEN** the page says every step and every rule is as it was
