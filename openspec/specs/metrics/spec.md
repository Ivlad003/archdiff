# Metrics Specification

## Purpose

Coupling and cohesion as numbers from the graph alone, so the pictures that show structure are backed by figures a review can quote: Martin's afferent and efferent coupling, instability, abstractness and the distance from the main sequence per module and per layer, and a cohesion of each module's functions.

## Requirements

### Requirement: Every module and layer has its metrics

The system SHALL compute, for every module, Ca (the repository modules importing it), Ce (the repository modules it imports), I = Ce / (Ca + Ce) (0 when both are 0), A (the share of types and interfaces among its top-level declarations), D = |A + I − 1| and a cohesion between 0 and 1 (1 − (groups − 1) / (functions − 1), the groups joined by a call between two functions, a callee they share or a type of the repository they both name; 1 for one function or none); and for every layer Ca and Ce as modules outside it, A over its declarations and D. Type-only imports SHALL count only with `--types`.

#### Scenario: A store

- **WHEN** `archdiff metrics --json` runs on the sample repository
- **THEN** `src/db/store.ts` has Ca 1, Ce 0 and I 0, and `src/routes/checkout.tsx` has I 1 and D 0

### Requirement: The metrics are a command, a view and an overlay

The system SHALL print the metrics as Markdown tables (`archdiff metrics`, the modules farthest from the main sequence first, `--layer` keeping one layer, `--json` the data), draw them as the `metrics` view (a placed table whose Mermaid is a quadrant chart of I against A; `metrics:<layer>` one layer; `--limit` the rows shown), and shade any picture by I with `--overlay instability`, marking a module unstable and depended upon (I ≥ 0.7, Ca ≥ 3).

#### Scenario: The overlay

- **WHEN** `archdiff diagram layer:lib --overlay instability` runs
- **THEN** every module shape carries "I 0.xx · Ca N" in its label and the reason says "shade: instability"

### Requirement: Far from the main sequence is marked only when it matters

The system SHALL mark a module with ⚠ when D ≥ 0.7 and Ca + Ce ≥ 2; an isolated module (Ca = Ce = 0) has D = 1 and no mark.

#### Scenario: An isolated script

- **WHEN** a module imports nothing of the repository and nothing imports it
- **THEN** its row shows D 1.00 without ⚠
