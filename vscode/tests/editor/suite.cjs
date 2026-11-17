// The extension inside a real editor, on the stand-in archdiff of the
// test's workspace (stand-in.mjs): the check's problems once the window is
// open and again after a save, the panel on the page, the view of the
// function under the cursor and of the file shown without loading the page
// again, and the place the page asks for opened in the editor beside it.
// The editor loads this file in its extension host, where `vscode` is, and
// calls `run`; a rejection fails the test.
//
// Entry point: `run`, named to the editor by run.mjs (`npm run test:editor`).

const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const vscode = require("vscode");

/** Asks until `read` gives something, a quarter of a second apart; fails naming what was waited for after half a minute. */
async function until(what, read) {
  for (let asked = 0; asked < 120; asked++) {
    const value = await read();

    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`waited half a minute for ${what}`);
}

/** The lines of a log the stand-in writes in the workspace, as it wrote them. */
function logOf(folder, name) {
  const file = join(folder, name);

  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [];
}

exports.run = async function run() {
  const folder = vscode.workspace.workspaceFolders[0];
  const root = folder.uri.fsPath;
  const place = vscode.Uri.joinPath(folder.uri, "src", "place.ts");
  const other = vscode.Uri.joinPath(folder.uri, "src", "other.ts");
  const seen = () => logOf(root, "seen.log").map((line) => JSON.parse(line));
  const extension = vscode.extensions.getExtension("ivlad003.archdiff-vscode");
  assert.ok(extension, "the extension is not installed in the test's editor");
  const api = await extension.activate();

  // The window is open on a folder with a contract: the check ran, and its violation is a problem on the import's line.
  const problems = await until("the problem of src/place.ts", () => {
    const found = vscode.languages.getDiagnostics(place);

    return found.length > 0 ? found : null;
  });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].message, "imports src/other.ts: layer app → db is not in ARCHITECTURE.md. Add the arrow there if it is wanted, else move the import.");
  assert.deepEqual([problems[0].source, problems[0].code, problems[0].severity, problems[0].range.start.line], ["archdiff", "contract", vscode.DiagnosticSeverity.Error, 0]);
  assert.ok(problems[0].relatedInformation[0].location.uri.fsPath.endsWith("ARCHITECTURE.md"));

  // A save runs it again, a moment later.
  const ran = logOf(root, "checks.log").length;
  const document = await vscode.workspace.openTextDocument(place);
  const editor = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  await editor.edit((edit) => edit.insert(new vscode.Position(document.lineCount, 0), "// saved by the test\n"));
  await document.save();
  await until("the check after a save", () => logOf(root, "checks.log").length > ran);
  // The problem of the file, now open, is on the whole line of its import.
  await until("the problem on the whole line", () => vscode.languages.getDiagnostics(place)[0]?.range.end.character === document.lineAt(0).text.length);

  // Open: the server starts, the panel shows its page beside the editor, and the page loads in the panel's frame, hosted.
  assert.equal(api.shown(), null);
  await vscode.commands.executeCommand("archdiff.open");
  const opened = api.shown();
  assert.ok(opened && /^http:\/\/127\.0\.0\.1:\d+\/\?host=1$/.test(opened.url), JSON.stringify(opened));
  assert.equal(opened.folder, root);
  const tabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => ({ label: tab.label, webview: tab.input instanceof vscode.TabInputWebview, column: group.viewColumn })));
  // The editor lists the new tab a moment after it made the panel.
  const panel = await until("the panel's tab", () => tabs().find((tab) => tab.webview));
  assert.deepEqual(panel, { label: `archdiff — ${folder.name}`, webview: true, column: vscode.ViewColumn.Two }, JSON.stringify(tabs()));
  const loaded = await until("the page loaded in the panel", () => seen().find((entry) => entry.what === "loaded"));
  assert.deepEqual([loaded.hosted, loaded.search, loaded.hash], ["true", "?host=1", ""]);

  // Show this function, the cursor inside `place`: the page is pointed at its call tree, and not loaded again.
  const inPlace = await vscode.window.showTextDocument(document, vscode.ViewColumn.One);
  inPlace.selection = new vscode.Selection(3, 2, 3, 2);
  await vscode.commands.executeCommand("archdiff.showFunction");
  assert.equal(api.shown().url, `${opened.url}#view=calls%3Asrc%2Fplace.ts%23place`);
  const moved = await until("the page on the function's view", () => seen().find((entry) => entry.what === "hashchange"));
  assert.deepEqual([moved.hash, moved.load], ["#view=calls%3Asrc%2Fplace.ts%23place", loaded.load]);

  // The page asked for a place of the code (the stand-in does, after each change of its view): the editor beside the
  // panel shows that file with the cursor on the line, and the panel is still there.
  const shown = await until("src/other.ts opened at its second line", () => vscode.window.visibleTextEditors.find((candidate) => candidate.document.uri.fsPath === other.fsPath && candidate.selection.active.line === 1));
  assert.equal(shown.viewColumn, vscode.ViewColumn.One);
  assert.ok(tabs().some((tab) => tab.webview && tab.column === vscode.ViewColumn.Two), JSON.stringify(tabs()));

  // Show this file, from the explorer's menu (the file is handed over): its module's view, in the same page.
  await vscode.commands.executeCommand("archdiff.showFile", place);
  assert.equal(api.shown().url, `${opened.url}#view=module%3Asrc%2Fplace.ts`);
  const again = await until("the page on the file's view", () => seen().find((entry) => entry.what === "hashchange" && entry.hash === "#view=module%3Asrc%2Fplace.ts"));
  assert.equal(again.load, loaded.load);
  assert.equal(seen().filter((entry) => entry.what === "loaded").length, 1, "the page was loaded again");
  assert.equal(tabs().filter((tab) => tab.webview).length, 1, "a second panel");
};
