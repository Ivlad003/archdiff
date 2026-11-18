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

The system SHALL lay the review's marks over any view (`--changes`), keep only the marked shapes and their neighbours with `--only-changes`, keep the shapes of the files changed since the base alone with `--changed` (`changed=1` on the page: a module by its id, a function by its file, a layer by the files in it, a folded tail by the files it stands for, a shape of no file when a line joins it to one kept, and the view's own subject whatever changed; the marks laid over without `--changes`, before the hubs and the fold, so a changed hub stays a shape; a grid, a flowchart, a timeline or a comparison stays whole and its reason says the cut does not apply there; outside git the picture and the lists stay whole and say the changed files could not be told apart, the CLI's `views --changed` on stderr with exit 0) and list only the views of those files (`archdiff views --changed`, the page's views and tree), and walk the commits of a range one by one on the page.

#### Scenario: The changed files alone

- **WHEN** `archdiff diagram layer:lib --changed --base HEAD` and `archdiff views --changed --base HEAD` run after `log.ts` changed
- **THEN** the picture holds `src/lib/log.ts` marked changed and nothing else, its reason says `only the 1 shape of the 1 file changed since HEAD; 3 others left out` (its importer and the modules of the other lanes went), and the views are the overviews, `layer:lib`, `dir:src/lib` and `module:src/lib/log.ts`, without `layer:db` or the entry points of other files

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

The system SHALL list, commit by commit between a base and a head, the modules, functions (added, removed and changed, each counted), imports, layer couplings and packages (`+redis`, `−node:fs`) each commit added or removed, and draw it as the `timeline` view; a second run over the same range SHALL read the commits' files from the cache of revisions, not parse them again.

#### Scenario: A coupling appears

- **WHEN** a commit adds the first import from `routes` to `db`
- **THEN** that commit's row names `+routes→db` and its bar in the timeline is red

### Requirement: The timeline is drawn at any commit of its range

The system SHALL draw the `timeline` view, with `--at SHA` (`at=` in the API and the page's link), as the code at that commit: every module in its layer with every import, in the whole map's order whatever the commit changed, the modules the commit added and those with a declaration it added, removed or changed marked, the imports it added marked, and the modules and imports it removed drawn where they were; titled by the commit and its place in the range, its Markdown the commit's own change with a flowchart of the map, its stamp the commit's. A module's page and file there SHALL be the commit's. No saved drawing SHALL be laid over it. A commit git does not know SHALL be refused by name. The commit's own change SHALL be kept per commit and configuration, so that a commit asked for again, and the parent of the next one, are not analysed again.

#### Scenario: The second commit of four

- **WHEN** `archdiff diagram timeline --at <sha>` runs for the commit that made `log.ts` import `step1.ts`
- **THEN** the title ends "— commit 2 of 4", `log.ts` and `step1.ts` carry the changed mark, the import between them is added, and an import a later commit made is not in the picture

### Requirement: The branches and one commit are pictures

The system SHALL draw the branches as the `branches` view: a lane per branch with commits of its own, the base's lane on top (develop, main or master unless a base is named), its last commits from left to right; each branch SHALL leave the commit it forked from — on the base, or the newest commit of a branch it was started on — and its lane SHALL say how many commits it is ahead and behind the base; a branch with nothing of its own SHALL be named on the commit it points at. Every commit SHALL open `commit:<sha>`: the review of the commit against its first parent (the empty tree for a first commit), headed and stamped by the commit. A commit git does not know SHALL be refused by name.

#### Scenario: A branch started on another one

- **WHEN** `stacked` was branched from `feature-a`, which left main's first commit, and main moved on by one commit
- **THEN** the lanes read "main (base, checked out)", "feature-a — 1 ahead, 1 behind", "stacked — 2 ahead, 1 behind", and the line into stacked's one commit comes from feature-a's commit

#### Scenario: One commit's change

- **WHEN** a reader opens `commit:<sha>` of the commit that added `src/lib/extra.ts`
- **THEN** the Markdown starts with "# Architecture changes of commit <short>: <subject>" and lists the module added, and the export's stamp names that commit

### Requirement: The uncommitted changes are a board

The system SHALL draw, as the `changes` view, what the working tree changes against the last commit (against the empty tree before the first commit; outside git it SHALL be refused with git's words): every module the change added, removed or edited — one whose declarations it did not touch too — in the group of its layer and its directory, each group a lane labelled with the modules, functions, imports and calls the change added, removed and changed in it, the imports it added and removed marked, and the modules at their other ends drawn unmarked for context. The groups SHALL be in reading order: by how many imports or calls their nearest module is from an entry point (the head's; the base's for a module the change removed), then the layers with the importers first, then the directory. `changes:<layer>:<dir>` SHALL draw one group: a lane per changed module holding the module and the declarations the change added, changed and removed in it, the imports and calls added and removed with an end in the group (a call to or from a module outside it landing on that module, labelled with the function), and the unchanged calls among the declarations drawn; its Markdown SHALL say where the group stands in the walk, list its changes by kind and end with the diff of its files as text (a file not tracked yet as all of its lines added, a long diff cut with the count of the lines left out). The board's Markdown SHALL list the walk and the files changed that are no source. A group the working tree does not change SHALL be an empty picture that says so, not an error. The API's picture SHALL carry `board`, the groups in order with their modules.

#### Scenario: A route and the library it calls

- **WHEN** the working tree adds a `loader` to `src/routes/checkout.tsx` and a module `src/lib/audit.ts` that `src/lib/orders.ts` now calls
- **THEN** `archdiff diagram changes` lists the walk as "1. routes · src/routes/" then "2. lib · src/lib/", draws a lane per group with `checkout.tsx` and `orders.ts` changed and `audit.ts` added, and `archdiff diagram changes:lib:src/lib` draws `placeOrder` calling `audit` in green and ends with the diff of both files

#### Scenario: Before the first commit

- **WHEN** `archdiff diagram changes` runs in a repository with no commit
- **THEN** the page is headed "Uncommitted changes against an empty repository" and every module is added

#### Scenario: Nothing changed

- **WHEN** the working tree is as the last commit has it
- **THEN** the picture is empty and says "the working tree is as the last commit (<short>) has it: nothing to walk"

### Requirement: A GitHub Action posts the review

The system SHALL offer `action.yml`, a composite action with the inputs `base` (default: the pull request's base ref), `fail-on-check` (default true), `comment` (default true) and `working-directory`, that runs the review of a pull request's head against where it left the base (their merge-base) and `check` against the contract, writes both to the job summary and, when `comment` is true, keeps them as one comment on the pull request — found by its hidden first line (`<!-- archdiff:pull-request-comment -->`) and rewritten, or created when there is none — and fails the job when the check fails and `fail-on-check` is true. A base that is not in the clone SHALL fail the job naming `fetch-depth: 0`; a comment that cannot be posted (a read-only token) SHALL be a warning, the job summary written all the same.

#### Scenario: A pull request

- **WHEN** the action runs on a pull request that adds a module and an import
- **THEN** a comment starts with the hidden marker and holds the review's counts, the verdict of the check, the picture and the lists of the changes, folded, and the job summary holds the same

#### Scenario: On archdiff's own repository

- **WHEN** the action runs in a directory whose `package.json` names the package `@ivlad003/archdiff`
- **THEN** it runs the published archdiff from outside that directory, on that directory, and the review is written as on any other repository

#### Scenario: A second push

- **WHEN** the pull request gets another commit and the action runs again
- **THEN** the comment of the first run is rewritten, and the pull request still has one

#### Scenario: A failing check

- **WHEN** the head has an import from `db` to `routes` that ARCHITECTURE.md does not allow
- **THEN** the body says "✘ 1 import goes against ARCHITECTURE.md" and lists the import with its line and its two layers, and the job fails; with `fail-on-check: false` the body is the same and the job passes

#### Scenario: A shallow clone

- **WHEN** the job checked out with the default depth, so the base of the pull request is not in the clone
- **THEN** the job fails with "the base of the pull request (main) is not in this clone: give actions/checkout fetch-depth: 0" and posts nothing

### Requirement: The comment's body fits a comment

The system SHALL build the body from the two outputs and nothing else (`scripts/pr-comment.ts`: the review's Markdown, the check's JSON), so it is tested without GitHub: the review's title and counts, the verdict of the check with the violations that fail it — an import between layers, or what breaks a rule of `archdiff.json` in the check's own words with the rule's name — and a count of the ones the baseline lists, which fail nothing (a check from a CLI without the baseline reads as it did), the dependencies between layers that appeared and went, the Mermaid picture, and every change by kind, folded. A pull request that changed no module, function, import or call SHALL say so in one line instead of an empty picture, and without a contract the body SHALL say there is nothing to check against. The body SHALL be at most 65 536 characters, GitHub's limit for a comment: past it the picture stays and the lists are cut, each to the same number of its first items, with a count of what was left out; then the violations; a picture longer than the limit by itself gives way to a line.

#### Scenario: A check with a baseline and rules

- **WHEN** the check's JSON lists one violation the baseline knows and two it does not, one of them of the rule `no-cycles`
- **THEN** the verdict counts 2 violations of ARCHITECTURE.md and the rules of archdiff.json, lists those two, and says 1 known violation in the baseline does not fail the check

#### Scenario: No architectural change

- **WHEN** the pull request changes two source files in their comments only
- **THEN** the body says "No architectural change since" the base in one line, with the 2 source files as changed in what the diff does not show, and has no picture

#### Scenario: A report over the limit

- **WHEN** the review lists 1800 changes in more than 100 000 characters
- **THEN** the body is at most 65 536 characters, the picture is whole, each list holds the same number of its first items and says how many more it has, and a line counts what was left out

#### Scenario: No contract

- **WHEN** the repository has no ARCHITECTURE.md, so `check` prints no report
- **THEN** the body says "No ARCHITECTURE.md that names layers: nothing to check the code against" above the review, and the job passes

### Requirement: A review knows the contract

The system SHALL, when the head has `ARCHITECTURE.md` (a ref's own, as that revision has it, not the checkout's), mark a new dependency between layers as against the contract only when the contract's arrows do not allow it, report an allowed one as news, and exit 1 only for the ones against; without a contract every new layer dependency SHALL be a finding, as before. A contract that names no layer (prose only, or an empty flowchart) SHALL count as none, and `check` SHALL say it has nothing to check against. `compare` SHALL do the same per head. A review of a directory inside the repository SHALL read that directory's files from git.

#### Scenario: Allowed and forbidden

- **WHEN** a change adds a db → lib import the contract allows and a routes → db import it forbids
- **THEN** the review lists "db → lib — allowed by ARCHITECTURE.md" and "⚠ routes → db — against ARCHITECTURE.md" and exits 1

### Requirement: A review reads down to the logic and the lines

On a picture of a change — a review, a commit's view, the commit the timeline is at, the board of the uncommitted changes, or `changes` laid over another picture — the system SHALL end the page of a module with a line for each of its functions the change added or whose body it changed (the first twelve in the order of the file): the function and what the change did to its logic in numbers, the steps added, removed and changed and the rules that came and went; and SHALL put on the page of such a function the list of those steps and rules. In a review and under `changes` the function SHALL be named by the key of its logic view, which opens its flowchart with the change laid over it. `GET /api/diff?path=<file>` with the picture's query SHALL give the change's lines on the file as its head has it — for each stretch the head's lines that are new and the base's lines that are gone, with the line they stood before — and `since: null` with no stretch for a picture of no change; a path out of the repository SHALL be refused with 404.

#### Scenario: A module's functions in a review

- **WHEN** the review of the working tree is open and the page of `src/lib/orders.ts`, whose `placeOrder` and `validate` changed, is asked for
- **THEN** it ends with "`logic:src/lib/orders.ts#placeOrder` — steps +2 −0 ~0, rules +2 −1" and "`logic:src/lib/orders.ts#validate` — steps +0 −0 ~1, rules +2 −2"

#### Scenario: The lines of a file

- **WHEN** `/api/diff?view=review&path=src/lib/orders.ts` is asked for after line 10 was added and line 17 rewritten
- **THEN** it answers two stretches: line 10 new with nothing gone, and line 17 new with the line it replaced

#### Scenario: A picture of no change

- **WHEN** `/api/diff?view=layers&path=src/lib/orders.ts` is asked for
- **THEN** the answer is `since: null` and no stretch
