# archdiff for VS Code

[archdiff](https://github.com/Ivlad003/archdiff) beside the editor: its page in a panel, the picture of the file or the function you are in, the code of what you pick on the picture opened in the editor, and the contract check as problems on the lines that break it.

The extension draws nothing itself. It runs the `archdiff` of your repository — the pictures, the page and the check are that archdiff's, the same as on the command line and in the browser.

## Install

The extension is not on the Marketplace: it is installed from its package, a `.vsix` file.

Build the package in a checkout of archdiff (Node 22.18 or newer):

```bash
cd vscode
npm install
npx @vscode/vsce package
```

That writes `archdiff-vscode-0.1.0.vsix` into `vscode/`. Install it into VS Code:

```bash
code --install-extension archdiff-vscode-0.1.0.vsix
```

or in VS Code: the Extensions view, its `…` menu, *Install from VSIX…*, and pick the file. To remove it: `code --uninstall-extension ivlad003.archdiff-vscode`.

Then give the repository an archdiff, so the extension does not fetch one each time:

```bash
npm install --save-dev @ivlad003/archdiff
```

Which archdiff runs, in order: the one the setting `archdiff.command` names; the workspace's own (`node_modules/.bin/archdiff`); the one on the `PATH`; and last `npx --yes @ivlad003/archdiff`, which downloads it on first use (*Open* then takes a while the first time). archdiff needs Node 22.18 or newer on the `PATH`.

## What it does

| Command | What happens |
|---|---|
| **archdiff: Open** | Starts `archdiff web` on the workspace folder, on a free port, and shows its page in a panel beside the editor. The server stops when the window closes. |
| **archdiff: Show this file** | Points the page at the view of the active editor's file (`module:<path>`): what the module imports and what imports it. Also in the editor's and the explorer's right-click menus. |
| **archdiff: Show this function** | Points the page at the view of the function the cursor is in (`calls:<path>#<name>`): what it calls, step by step. Outside every function, the file's view. |
| **archdiff: Check the contract** | Runs `archdiff check --json` now and says what it found. |

**From the picture to the code.** A tap on a shape, or a click on a `file:line` in a page, opens that place in the editor beside the panel; the panel keeps the focus, so the next tap is one tap away. (In a browser the same click shows the code on the page's Code tab.) When the page shows another revision than the working tree — a branch picked in its header — the editor still opens the working tree's file.

**The contract as problems.** In a folder with an `ARCHITECTURE.md`, when the window opens and a moment after every save, `archdiff check --json` runs, and each import that crosses the layers against the contract is an error on the line of the import, with the contract's reason: *imports src/db/store.ts: layer routes → db is not in ARCHITECTURE.md. Add the arrow there if it is wanted, else move the import.* The problem links to the contract. This check runs the archdiff that is installed and never downloads one: a repository whose `ARCHITECTURE.md` is prose of its own is left alone. *Check the contract* runs it whatever the way archdiff is found.

## Settings

| Setting | Default | |
|---|---|---|
| `archdiff.command` | *(empty)* | The archdiff to run: a path (relative to the workspace folder, or absolute) or a name on the `PATH`. Empty: found as above. |
| `archdiff.checkOnSave` | `true` | Run the check when the window opens and on save. |
| `archdiff.functionView` | `calls` | The view *Show this function* opens: `calls`, `sequence`, `path`, `focus` or `logic`. |
| `archdiff.embed` | `false` | Show the picture alone, without the page's header and side panels. |

## Good to know

- One panel, and one server per workspace folder, started when first asked for. In a workspace of several folders the commands follow the active editor's folder.
- The functions are the ones archdiff reads in the file as it is saved: save before *Show this function* on new code.
- The extension is off in a workspace you have not trusted (Restricted Mode): it runs the archdiff the workspace installed.
- A webview shows no confirmation dialogs, so leaving a drawing with unsaved changes cannot ask: save the drawing before you open another view.
- What archdiff wrote when something failed is in the *archdiff* channel of the Output view.

## Working on it

```bash
npm run typecheck     # the types
npm test              # the unit tests, with node's test runner
npm run test:editor   # the extension inside a real VS Code, on a stand-in archdiff
```

`npm test` runs without an editor. In a checkout of archdiff it also runs the extension's parts against the archdiff around it — the server's answer that names the functions of a file, the check's report — and, with Chrome and `npm install` done in the repository, the panel's document in a browser with the real page in its frame. `npm run test:editor` uses the VS Code installed on the computer (`VSCODE_EXECUTABLE` names another), or downloads one, and gives it a profile of its own.

How the page tells its host: opened with `?host=1` inside a frame, it posts `{ type: "archdiff:open", file, line, endLine?, head? }` to its parent for every place of the code it would show on its Code tab (`web/src/host.ts` in archdiff). Any editor that can frame a local page can host it the same way.
