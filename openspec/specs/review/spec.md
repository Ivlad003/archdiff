# Review Specification

## Purpose

The architectural diff of a change, for reviewing pull requests: what a base and a head differ in, as counts, as a picture and as Markdown; branches compared; the drift commit by commit; all algorithmic and fast.

## Requirements

### Requirement: review compares two revisions

The system SHALL analyse the base (`--base`, default the merge-base of the head — the checkout's, or the branch `--head` names — with develop, main or master) and the head (`--head`, default the working tree), diff their graphs — modules, functions, imports, calls and layer couplings added, removed or changed — and write Markdown with a picture of the change; exit 1 SHALL mean a new dependency between layers.

#### Scenario: A route reads the store directly

- **WHEN** a change adds an import from a `routes` module to a `db` module
- **THEN** `archdiff review` exits 1 and names `+routes→db`

#### Scenario: Another branch, from main

- **WHEN** main gained a module after `feature` left it, and `archdiff review --head feature` runs on main
- **THEN** the review starts where `feature` left main, and the module main gained is not in it

#### Scenario: Outside git

- **WHEN** `archdiff review` runs in a directory that is not a git repository
- **THEN** it exits 2 with "is not a git repository"

### Requirement: The marks lie over any view

The system SHALL lay the review's marks over any view (`--changes`), keep only the marked shapes and their neighbours with `--only-changes`, and walk the commits of a range one by one on the page.

#### Scenario: Changes over a layer

- **WHEN** `archdiff diagram layer:lib --changes --base HEAD` runs after `log.ts` changed
- **THEN** `src/lib/log.ts` carries the `changed` mark and the title ends with "changes since HEAD"

### Requirement: Branches are compared, several at once

The system SHALL list the branches with the default base, and compare any number of heads against one base in one picture, every module labelled with what each head did: each head from where it left the base (their merge-base, the base itself when they share no commit), as its pull request would show it, so what landed on the base since is not read as the head's doing; the table SHALL name that commit for every head. A head named twice SHALL be compared once, and a ref git does not know SHALL be refused by name. A module the heads touched in different ways SHALL be labelled head by head, "every head" only when they all did the same; each head's section SHALL list all it changed — modules, functions added, removed and changed, imports, calls, packages — or say it changed none of them; a module's page SHALL say what each head did to it (in a review, what the change did).

#### Scenario: Three heads

- **WHEN** `archdiff compare --heads a,b,WORKTREE` runs
- **THEN** one picture holds the union of the changes with a glyph per head on every changed module

#### Scenario: The base moved on

- **WHEN** develop gains a module after `a` left it, and `archdiff compare --heads a` runs
- **THEN** `a`'s row starts from the commit it left develop at, and the new module is not among what `a` removed

#### Scenario: Removed by one, changed by the other

- **WHEN** head `gone` removes `log.ts` and head `loud` changes its function
- **THEN** the shape of `log.ts` reads "− gone  ~ loud", not "every head", and its page lists the module removed under `gone` and the function changed under `loud`

### Requirement: History shows the drift

The system SHALL list, commit by commit between a base and a head, the modules, functions, imports, layer couplings and packages each commit added or removed, and draw it as the `timeline` view.

#### Scenario: A coupling appears

- **WHEN** a commit adds the first import from `routes` to `db`
- **THEN** that commit's row names `+routes→db` and its bar in the timeline is red

### Requirement: The branches and one commit are pictures

The system SHALL draw the branches as the `branches` view: a lane per branch with commits of its own, the base's lane on top (develop, main or master unless a base is named), its last commits from left to right; each branch SHALL leave the commit it forked from — on the base, or the newest commit of a branch it was started on — and its lane SHALL say how many commits it is ahead and behind the base; a branch with nothing of its own SHALL be named on the commit it points at. Every commit SHALL open `commit:<sha>`: the review of the commit against its first parent (the empty tree for a first commit), headed and stamped by the commit. A commit git does not know SHALL be refused by name.

#### Scenario: A branch started on another one

- **WHEN** `stacked` was branched from `feature-a`, which left main's first commit, and main moved on by one commit
- **THEN** the lanes read "main (base, checked out)", "feature-a — 1 ahead, 1 behind", "stacked — 2 ahead, 1 behind", and the line into stacked's one commit comes from feature-a's commit

#### Scenario: One commit's change

- **WHEN** a reader opens `commit:<sha>` of the commit that added `src/lib/extra.ts`
- **THEN** the Markdown starts with "# Architecture changes of commit <short>: <subject>" and lists the module added, and the export's stamp names that commit

### Requirement: A GitHub Action posts the review

The system SHALL offer `action.yml` that runs the review of a pull request against its base and posts the Markdown as a comment, failing the check on a new dependency between layers.

#### Scenario: A pull request

- **WHEN** the action runs on a pull request
- **THEN** a comment holds the review's Markdown and the picture

### Requirement: A review knows the contract

The system SHALL, when the head has `ARCHITECTURE.md` (a ref's own, as that revision has it, not the checkout's), mark a new dependency between layers as against the contract only when the contract's arrows do not allow it, report an allowed one as news, and exit 1 only for the ones against; without a contract every new layer dependency SHALL be a finding, as before. `compare` SHALL do the same per head.

#### Scenario: Allowed and forbidden

- **WHEN** a change adds a db → lib import the contract allows and a routes → db import it forbids
- **THEN** the review lists "db → lib — allowed by ARCHITECTURE.md" and "⚠ routes → db — against ARCHITECTURE.md" and exits 1
