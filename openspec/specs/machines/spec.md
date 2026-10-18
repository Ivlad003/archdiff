# Machines Specification

## Purpose

State machines found in the code, explicit (declared with a library) or implicit (written with literal states), drawn as states and transitions with the function or event that makes each; and the control flow every call sits under, so a sequence shows its branches and loops.

## Requirements

### Requirement: Calls record their guards

The system SHALL record on every call of a TypeScript, JavaScript or Python function the branches, loops and handlers it sits under, outermost first — `if`, `else`, a loop, `case`, `try`, `catch`, a ternary — each with the condition's text cut short and an id shared by the calls under the same statement.

#### Scenario: A call in a loop and a branch

- **WHEN** `for (const o of orders) { if (rush) ship(o); }` is extracted
- **THEN** the call `ship` carries the guards `loop: const o of orders` then `if: rush`

### Requirement: A sequence frames the calls under a guard

The system SHALL draw, in a `sequence:` view, consecutive messages under the same guard as one fragment — `loop` for a loop, `opt` for a branch, a case, a try or a catch, labelled with the condition — nested up to three deep, as `opt`/`loop` blocks in Mermaid, dashed frames on the canvas, and named lines in the Markdown.

#### Scenario: Nested fragments

- **WHEN** `archdiff diagram sequence:src/checkout.ts#checkout` runs on the machines fixture
- **THEN** the Mermaid holds `loop const order of orders` around `pay()` with `opt rush` and `opt not rush` inside it, then `opt try` and `opt catch`

### Requirement: Implicit machines come from literal states

The system SHALL treat a field or variable as a state machine when it is set to two or more literal states (strings, numbers, enum members) somewhere other than its declaration, read as one (compared or switched on), and either set under a `case` or an `if` on the same field or declared by a union type with the field set in two or more places. Its states SHALL be the literals seen and those of a union type of the module named like the field (or holding most of the values); its transitions SHALL be the assignments under a `case` or `if` on the field (from each value the guard names to the value assigned, by the enclosing function), an assignment under no such guard a transition from any state; its initial state the one of a `let`/`var` declaration, a class field initializer or Python's `__init__`. Two entities with a field of one name SHALL be two machines, `<Entity>.<field>`: by the class the code names (a parameter or local typed with it or made by it, the class `this` or `self` is in), a field reached by an object's name joining the class named like it or else the machine it shares a state with, else its own by the object's name; a field of one entity keeps the field's name. A guard SHALL be of the same entity as the assignment it guards.

#### Scenario: The order's status

- **WHEN** `archdiff diagram machine:src/order.ts#status` runs on the machines fixture
- **THEN** the states are new, paid, shipped, cancelled and refunded (declared by the type, never set, dashed), the transitions new → paid by `pay`, paid → shipped by `ship`, new and paid → cancelled by `cancel`, and any state → new by `reset`

#### Scenario: Two entities with a status

- **WHEN** a file sets `order.status` (`order: Order`) and `payment.status` (`payment: Payment`, and `p: Payment`)
- **THEN** `views` lists `machine:src/flows.ts#Order.status` and `machine:src/flows.ts#Payment.status`, the second with the states pending, settled and failed only

### Requirement: Explicit machines come from libraries

The system SHALL read XState's `createMachine` / `Machine` (the `id`, `initial`, `states` with their `on` events, `after` delays, `always` and `invoke` outcomes, targets as strings, objects or lists), javascript-state-machine's `new StateMachine` (`init`, `transitions` with `from` as a value, a list or `*`), and Python's `transitions.Machine` (`states`, `transitions` as dicts or lists, `initial`, `add_transition` calls), each as a machine named by its id or variable.

#### Scenario: A traffic light

- **WHEN** `archdiff diagram machine:src/light.ts#light` runs on the machines fixture
- **THEN** the initial state is green and the transitions include yellow → red on TIMER, red → green after 5000 and red → red on PANIC

### Requirement: Machines are listed and drawn

The system SHALL list every machine in `archdiff views` (`machine:<path>#<name>`) and in the `machines` view (one shape per machine in its module's lane), and draw one as `machine:<path>#<name>`: a start mark to the initial state, every state, every transition labelled with its event or function; the Mermaid is a `stateDiagram-v2`, the Markdown lists the states and a table of transitions with `file:line`; an unknown machine exits 2.

#### Scenario: The list

- **WHEN** `archdiff diagram machines` runs on the machines fixture
- **THEN** the title is "State machines (3)" and the reason says "1 declared by a library, 2 written with literals"
