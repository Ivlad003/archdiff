# Intent Specification

## Purpose

`ARCHITECTURE.md` is the contract: the intended architecture as one Mermaid flowchart that people and agents read and write, that archdiff draws against the code, adds the drawings to, and checks the code against.

## Requirements

### Requirement: The contract is one Mermaid flowchart in Markdown

The system SHALL read `ARCHITECTURE.md`: in its first ` ```mermaid ` block a subgraph is a layer (its label the name, then " — " and a description), a node is a module (its label the file path, then a line break or ": " and a description) or a function (`path#name`), an arrow is an import (between modules) or a call (between functions), with an optional label. The prose around the block SHALL be kept as written when the file is rewritten. HTML entities SHALL be decoded, and `&` SHALL split nodes only outside brackets and quotes.

#### Scenario: Reading a hand-written note

- **WHEN** a note holds `subgraph http["http — the edge"]`, `A["src/http/orders.ts<br>POST /orders"]` and `A -->|validated| S`
- **THEN** the intent has a layer `http` described "the edge", a module `src/http/orders.ts` described "POST /orders", and an import labelled "validated"

#### Scenario: Round trip

- **WHEN** an intent is written and read again
- **THEN** the layers, modules, functions and edges are the same, and the prose before and after the block is unchanged

### Requirement: The intent view draws the contract against the code

The system SHALL draw the `intent` view with the contract's layers as lanes, its modules and functions as shapes (plain when the code has them, `planned` dashed blue when not), the code's modules of those layers that the contract does not name in orange, and the lines likewise (planned when missing in the code, orange when the code has an import the contract does not).

#### Scenario: A fresh project

- **WHEN** `archdiff diagram intent` runs on a project with a contract and no code
- **THEN** every shape is planned and the reason says "N planned, not built yet"

### Requirement: check keeps the code to the contract

The system SHALL, with `archdiff check`, exit 1 when the code imports between two of the contract's layers in a direction no arrow of the contract allows, naming the file, line and layers; and list as news, exit 0, what is planned and not built, what is built beyond the contract, and the imports between modules the contract names that it draws no arrow for (the imports the intent does not name). Without `ARCHITECTURE.md` it SHALL say so and exit 0.

#### Scenario: An import against the contract

- **WHEN** `src/routes/health.ts` imports `src/db/store.ts` and the contract has no arrow from `routes` to `db`
- **THEN** `archdiff check` exits 1 and says "`src/routes/health.ts:2` imports `src/db/store.ts`: layer **routes** → **db** is not in the intent"

### Requirement: A baseline keeps the known violations from failing the check

The system SHALL, with `archdiff check --baseline [FILE]`, write the violations the check finds now — each as its rule, the module it is in and the module or package it imports, without a line, sorted, one per line — to `archdiff-baseline.json` at the root (the path `archdiff.json` names in `baseline`, or FILE), exit 0, and never write over a file that is not archdiff's. With that file present `archdiff check` SHALL exit 1 only when a violation is not listed in it, list the known violations apart with their count, and name the entries of the file that no longer occur; `--no-baseline` SHALL hold the code to no baseline. `--json` SHALL give every violation with its `rule` and `known`, the entries that no longer occur as `stale`, the baseline's file, and `ok`. A baseline that is not valid, or an entry of it without a rule and a module, SHALL exit 2 naming the file and the entry. The page's check and the contract check after an agent's run SHALL hold the code to the same baseline.

#### Scenario: An old repository adopts the contract

- **WHEN** the code has two imports against the contract and `archdiff check --baseline` runs
- **THEN** `archdiff-baseline.json` lists both as `{ "rule": "layers", "from": …, "to": … }`, and `archdiff check` exits 0 saying "the code follows the intent; 2 known violations in archdiff-baseline.json"

#### Scenario: A new violation beside the known ones

- **WHEN** a third import against the contract is written
- **THEN** `archdiff check` exits 1, lists it under "New violations (1)" and the other two under "Known violations (2)"

#### Scenario: The line of a known violation moves

- **WHEN** lines are added above a known import
- **THEN** it is still known: `archdiff check` exits 0

#### Scenario: The baseline shrinks

- **WHEN** one of the known imports is removed from the code
- **THEN** `archdiff check` exits 0 and names the entry under "Fixed since the baseline (1)", and `archdiff check --baseline` writes the file without it

### Requirement: The contract follows the drawing and the configuration follows the contract

The system SHALL fold a drawing's planned modules, functions, layers, arrows and removals into the contract (`archdiff intent --view <view>`, "code this" on the page), naming the ends of drawn arrows with the layers the code gives them, and write `archdiff.json` `layers` from the contract's layers (a directory as the glob, the files themselves where another layer lives below the directory; the contract's layers first).

#### Scenario: A module drawn in a lane

- **WHEN** a shape labelled `src/lib/refunds.ts` is drawn in the lib lane with an arrow from `orders.ts` and "code this" is pressed
- **THEN** `ARCHITECTURE.md` names `src/lib/refunds.ts` in `lib` with the arrow, and the task tells the agent to build it

### Requirement: A document becomes the contract

The system SHALL take, with `archdiff import <file>` or "from document" on the page, a Markdown document holding a flowchart as the contract, with or without an agent; a document in prose SHALL go through the agent, which answers with the flowchart, and without an agent SHALL be refused (400, "no agent") with nothing written. `archdiff import` SHALL keep an `ARCHITECTURE.md` that exists unless `--force`, as `intent --init` does.

#### Scenario: A design note with a flowchart

- **WHEN** `archdiff import note.md` runs
- **THEN** `ARCHITECTURE.md` holds the note's flowchart and `archdiff.json` the layers it implies

#### Scenario: From document without an agent

- **WHEN** a page whose server has no agent posts a note with a flowchart, then a note in prose
- **THEN** the first becomes `ARCHITECTURE.md` (source "document"), the second is refused with "no agent"

### Requirement: A project starts from its contract

The system SHALL, with `archdiff new <dir> --lang ts|js --template blank|lib|cli|api|web`, write `package.json`, `tsconfig.json` (TypeScript), `.gitignore`, `archdiff.json` with the template's layers, `ARCHITECTURE.md` with the template's intent, `README.md`, the layer directories, and make the first commit on `main`; a non-empty directory SHALL be refused.

#### Scenario: A new api project

- **WHEN** `archdiff new shop-api --lang ts --template api` runs
- **THEN** the directory has the files, one commit, four layers (routes, services, domain, db), and `archdiff check` lists four planned modules

### Requirement: The contract is seeded from the code

The system SHALL, with `archdiff intent --init`, write `ARCHITECTURE.md` from the code (its layers, the modules that stand for them, the imports between the layers) and refuse to overwrite one that exists unless `--force` says so; `--layers` SHALL write the layers with a few modules each (the most imported, which name what the layer offers), which a repository of more than 60 modules SHALL get by itself.

#### Scenario: A big repository

- **WHEN** `archdiff intent --init` runs on a repository of 200 modules without a contract
- **THEN** `ARCHITECTURE.md` holds every layer with a few modules each, and the arrows between the layers the code has
