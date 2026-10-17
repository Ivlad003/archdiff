# Review Specification

## Purpose

The architectural diff of a change, for reviewing pull requests: what a base and a head differ in, as counts, as a picture and as Markdown; branches compared; the drift commit by commit; all algorithmic and fast.

## Requirements

### Requirement: review compares two revisions

The system SHALL analyse the base (`--base`, default the merge-base with develop, main or master) and the head (`--head`, default the working tree), diff their graphs — modules, functions, imports, calls and layer couplings added, removed or changed — and write Markdown with a picture of the change; exit 1 SHALL mean a new dependency between layers.

#### Scenario: A route reads the store directly

- **WHEN** a change adds an import from a `routes` module to a `db` module
- **THEN** `archdiff review` exits 1 and names `+routes→db`

#### Scenario: Outside git

- **WHEN** `archdiff review` runs in a directory that is not a git repository
- **THEN** it exits 2 with "is not a git repository"

### Requirement: The marks lie over any view

The system SHALL lay the review's marks over any view (`--changes`), keep only the marked shapes and their neighbours with `--only-changes`, and walk the commits of a range one by one on the page.

#### Scenario: Changes over a layer

- **WHEN** `archdiff diagram layer:lib --changes --base HEAD` runs after `log.ts` changed
- **THEN** `src/lib/log.ts` carries the `changed` mark and the title ends with "changes since HEAD"

### Requirement: Branches are compared, several at once

The system SHALL list the branches with the default base, and compare any number of heads against one base in one picture, every module labelled with what each head did.

#### Scenario: Three heads

- **WHEN** `archdiff compare --heads a,b,WORKTREE` runs
- **THEN** one picture holds the union of the changes with a glyph per head on every changed module

### Requirement: History shows the drift

The system SHALL list, commit by commit between a base and a head, the modules, functions, imports, layer couplings and packages each commit added or removed, and draw it as the `timeline` view.

#### Scenario: A coupling appears

- **WHEN** a commit adds the first import from `routes` to `db`
- **THEN** that commit's row names `+routes→db` and its bar in the timeline is red

### Requirement: A GitHub Action posts the review

The system SHALL offer `action.yml` that runs the review of a pull request against its base and posts the Markdown as a comment, failing the check on a new dependency between layers.

#### Scenario: A pull request

- **WHEN** the action runs on a pull request
- **THEN** a comment holds the review's Markdown and the picture

### Requirement: A review knows the contract

The system SHALL, when the head has `ARCHITECTURE.md`, mark a new dependency between layers as against the contract only when the contract's arrows do not allow it, report an allowed one as news, and exit 1 only for the ones against; without a contract every new layer dependency SHALL be a finding, as before. `compare` SHALL do the same per head.

#### Scenario: Allowed and forbidden

- **WHEN** a change adds a db → lib import the contract allows and a routes → db import it forbids
- **THEN** the review lists "db → lib — allowed by ARCHITECTURE.md" and "⚠ routes → db — against ARCHITECTURE.md" and exits 1
