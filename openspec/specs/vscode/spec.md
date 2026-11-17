# VS Code Extension Specification

## Purpose

archdiff beside the editor: the page in a panel of VS Code, the picture of the file or the function being edited one command away, the code of what is picked on the picture opened in the editor, and the contract check as problems on the lines that break it. The extension (`vscode/`, a package of its own, built to a `.vsix`) draws and checks nothing itself: it runs the archdiff the workspace has, as a process, and reads what that prints and serves.

## Requirements

### Requirement: The extension runs the archdiff of the workspace

The system SHALL run, in this order, the command the setting `archdiff.command` names (a path, relative to the workspace folder or absolute, or a name on the PATH; one that is missing is a problem, not a reason to run another), the workspace's own `node_modules/.bin/archdiff`, the `archdiff` on the PATH, and last `npx --yes @ivlad003/archdiff`. On Windows, where a command npm installed is a batch file that Node does not start, it SHALL read the batch file for the script it hands to node — a package's shim, or npm's own `npx.cmd` — and start node with that script (the node beside the batch file, else the PATH's), and name what is missing when it cannot. The extension SHALL be off in a workspace that is not trusted.

#### Scenario: The workspace installed archdiff

- **WHEN** the workspace has `node_modules/.bin/archdiff` and the PATH has another archdiff
- **THEN** the workspace's own is the one run

#### Scenario: A shim on Windows

- **WHEN** `node_modules\.bin\archdiff.cmd` is npm's shim for `..\@ivlad003\archdiff\bin\archdiff.js`
- **THEN** `node.exe` is started with that script as its first argument, and no shell

#### Scenario: Nothing installed

- **WHEN** neither the workspace nor the PATH has archdiff, and npx is on the PATH
- **THEN** `npx --yes @ivlad003/archdiff` is run

### Requirement: Open shows the page in a panel beside the editor

The system SHALL, with *archdiff: Open*, start `archdiff web <folder> --port 0` once per workspace folder, read where it listens from the line it writes to stderr (`archdiff web: http://127.0.0.1:<port>/`), and show the page in one webview panel beside the editor, in a frame on that address with `?host=1` (and `&embed=1` when the setting `archdiff.embed` is on). It SHALL say what the process wrote when the server does not start, keep what the server writes in the *archdiff* output channel, and stop the server with every process it started when the window closes or the folder leaves the workspace.

#### Scenario: Open

- **WHEN** *archdiff: Open* runs in a folder
- **THEN** a panel "archdiff — <folder>" opens beside the editor and the page loads in it, hosted

#### Scenario: The window closes

- **WHEN** the window that started a server closes
- **THEN** nothing listens on the server's port any more

### Requirement: A file and a function have their views

The system SHALL, with *Show this file*, point the page at `module:<path>` for the active editor's file (or the file handed over by the explorer's menu), the path relative to the workspace folder with slashes; and, with *Show this function*, at the view of the function the cursor is in — `calls:<path>#<name>` unless the setting `archdiff.functionView` names `sequence`, `path`, `focus` or `logic` — the function being the innermost of archdiff's own functions of the file whose lines hold the cursor's line, read from `GET /api/diagram?view=inside:<path>`; outside every function, or in a file archdiff does not read, it SHALL show the file's view and say so. A view SHALL be shown by changing the hash of the page already in the panel, which is not loaded again, and the focus SHALL stay in the editor.

#### Scenario: The cursor in a method

- **WHEN** the cursor is on line 26 of `src/lib/orders.ts`, inside `OrderService.place` (lines 25 to 27) of the class `OrderService` (lines 23 to 31)
- **THEN** *Show this function* shows `calls:src/lib/orders.ts#OrderService.place`

#### Scenario: Between two functions

- **WHEN** the cursor is on a line no function holds
- **THEN** *Show this function* shows `module:<path>` and the status bar says there is no function at the cursor

### Requirement: A place picked on the page opens in the editor

The system SHALL open, in an editor column beside the panel, the file and line of every place the page tells its host of (`archdiff:open`), with the cursor on the line and the focus left in the panel; it SHALL accept the message only from the panel's frame on the server's origin, and open only a path inside the workspace folder — the working tree's file, also when the page shows another revision.

#### Scenario: A shape tapped

- **WHEN** the reader taps the shape of `src/db/store.ts` on the page in the panel
- **THEN** `src/db/store.ts` is shown in the editor beside the panel

#### Scenario: A message from elsewhere

- **WHEN** a window other than the panel's frame posts `archdiff:open`
- **THEN** nothing is opened

### Requirement: The contract check shows as problems

The system SHALL, when the window opens and about half a second after a save (unless the setting `archdiff.checkOnSave` is off), run `archdiff check <folder> --json` in a workspace folder that has an `ARCHITECTURE.md`, and show every violation of the report as an error on the line of its import in the importing file — its message the contract's reason ("imports src/db/store.ts: layer routes → db is not in ARCHITECTURE.md. Add the arrow there if it is wanted, else move the import.", or the violation's own `reason` when it carries one), its source `archdiff`, the contract as its related place — replacing the problems of the run before. A newer run SHALL take the place of one under way; an empty output (no contract, or one that names no layer) SHALL be no problem at all; a check nobody asked for SHALL run the archdiff that is installed and never fetch one with npx, which *archdiff: Check the contract* may.

#### Scenario: An import against the contract

- **WHEN** `src/routes/health.ts` imports `src/db/store.ts` on its line 2, the contract has no arrow from `routes` to `db`, and the file is saved
- **THEN** line 2 of `src/routes/health.ts` carries an error of `archdiff` that names both layers

#### Scenario: The import is moved

- **WHEN** the import is removed and the file saved
- **THEN** the error is gone

#### Scenario: A repository with prose in ARCHITECTURE.md and no archdiff

- **WHEN** a file is saved in a folder that has an `ARCHITECTURE.md` and no archdiff in its `node_modules` or on the PATH
- **THEN** nothing is downloaded and no check runs
