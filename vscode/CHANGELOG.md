# Changelog

## 0.1.0

The first version, for archdiff 0.6 and newer.

- *archdiff: Open* starts `archdiff web` on the workspace folder — the archdiff of the workspace, else of the PATH, else `npx @ivlad003/archdiff` — on a free port, shows its page in a panel beside the editor and stops the server with the window.
- *Show this file* and *Show this function* point the page at the view of the active editor's file or of the function under the cursor.
- A place of the code picked on the page — a shape, a `file:line` — opens in the editor.
- `archdiff check --json` on save: each import against `ARCHITECTURE.md` is a problem on its line. What breaks a rule of `archdiff.json` is one too, in the check's words; a violation the baseline lists is a note, not an error.
