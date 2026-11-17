// The extension: archdiff beside the editor. *archdiff: Open* starts
// `archdiff web` on the workspace folder — the archdiff the folder
// installed, else the PATH's, else npx's (command.ts) — on a free port, and
// shows its page in a panel beside the editor; the server is stopped with
// the window. *Show this file* and *Show this function* point the page at
// the view of the active editor's file, or of the function the cursor is in
// (views.ts). The page tells the panel which place of the code a reader
// asks for, and the editor opens it (panel.ts). On save, a moment later,
// `archdiff check --json` runs on a folder that has an ARCHITECTURE.md, and
// every import against the contract is a problem on its line
// (diagnostics.ts).
//
// One panel, and one server per workspace folder, started when first asked
// for. This module is the wiring to the editor's API; what it decides is in
// the modules beside it, which the tests run without an editor.
//
// Entry points: `activate`, `deactivate` (the editor calls them), `Api`.

import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import * as vscode from "vscode";
import { findArchdiff, type Machine, type Start } from "./command.ts";
import { byFile, CONTRACT, findingsOf, type Finding, type Findings } from "./diagnostics.ts";
import { isOpenMessage, panelHtml, type OpenMessage, type ShowMessage } from "./panel.ts";
import { runCheck, startWeb, type WebServer } from "./runner.ts";
import { FUNCTION_VIEWS, functionAt, functionsOfInside, functionView, insideRequest, moduleView, pageUrl, repositoryPath, type FunctionViewKind } from "./views.ts";

/** What the extension answers to whoever activates it (another extension, its own tests): what the panel shows now. */
export interface Api {
  /** The folder and the address of the page in the panel; null while there is no panel. */
  shown(): { folder: string; url: string } | null;
}

/** This computer, for the search of the command. */
const MACHINE: Machine = {
  platform: process.platform,
  env: process.env,
  isFile: (path) => statSync(path, { throwIfNoEntry: false })?.isFile() ?? false,
  read: (path) => readFileSync(path, "utf8"),
};

/** How long after a save the check runs: a save of several files is one run. */
const CHECK_DELAY_MS = 400;

let log: vscode.OutputChannel;
let problems: vscode.DiagnosticCollection;

/** The server of each workspace folder (by its path), started or starting. */
const servers = new Map<string, Promise<WebServer>>();
/** The servers that listen now: what closing the window stops. */
const listening = new Set<WebServer>();
/** The panel, the folder whose page it shows, and the address shown last. */
let panel: { view: vscode.WebviewPanel; folder: vscode.WorkspaceFolder; origin: string; url: string } | null = null;

/** The check of a folder: the run waiting for its moment, the one under way, and the files that carry its problems. */
interface CheckState {
  timer: NodeJS.Timeout | null;
  running: AbortController | null;
  shown: vscode.Uri[];
}

const checks = new Map<string, CheckState>();

function setting<T>(name: string, folder: vscode.WorkspaceFolder, fallback: T): T {
  return vscode.workspace.getConfiguration("archdiff", folder.uri).get<T>(name) ?? fallback;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The archdiff to run for a folder; throws naming what is missing. */
function commandOf(folder: vscode.WorkspaceFolder): Start {
  const found = findArchdiff(folder.uri.fsPath, setting<string>("command", folder, ""), MACHINE);

  if (!found.ok) throw new Error(found.problem);

  return found.start;
}

// ── The server and the panel ─────────────────────────────────────────────────

/** The server of a folder, started on first use (a notification says so while it starts); a start that failed is tried again next time. */
function serverOf(folder: vscode.WorkspaceFolder): Promise<WebServer> {
  const key = folder.uri.fsPath;
  const known = servers.get(key);

  if (known) return known;
  const starting = Promise.resolve(
    vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `archdiff: starting the page of ${folder.name}…` }, async () => {
      const start = commandOf(folder);
      log.appendLine(`${folder.name}: ${[start.file, ...start.args].join(" ")} web (${start.from === "npx" ? "npx fetches archdiff on first use" : `found by ${start.from}`})`);

      return startWeb(start, key, (text) => log.append(text));
    }),
  );
  servers.set(key, starting);
  starting.then(
    (server) => {
      listening.add(server);
      // A server that ended — stopped, or fallen — is forgotten, and the panel on its page with it.
      void server.ended.then(() => {
        listening.delete(server);

        if (servers.get(key) === starting) servers.delete(key);

        if (panel?.origin === server.origin) panel.view.dispose();
        log.appendLine(`${folder.name}: archdiff web ended`);
      });
    },
    () => {
      if (servers.get(key) === starting) servers.delete(key);
    },
  );

  return starting;
}

/** The column for the code beside the panel: one that shows a file already, else the first (the second, when the panel has the first). */
function codeColumn(beside: vscode.WebviewPanel): vscode.ViewColumn {
  const editor = vscode.window.visibleTextEditors.find((candidate) => candidate.viewColumn !== undefined && candidate.viewColumn !== beside.viewColumn);

  return editor?.viewColumn ?? (beside.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
}

/** Opens the place the page asked for in the editor beside the panel, which keeps the focus: the file of the working tree, at the line. */
async function openPlace(folder: vscode.WorkspaceFolder, place: OpenMessage, beside: vscode.WebviewPanel): Promise<void> {
  const segments = place.file.split("/");

  // A path of the repository, never one that climbs out of it.
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return;
  const start = new vscode.Position(place.line - 1, 0);

  try {
    const editor = await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, ...segments), { viewColumn: codeColumn(beside), preserveFocus: true, selection: new vscode.Range(start, start) });
    editor.revealRange(new vscode.Range(start, new vscode.Position(Math.max(place.line, place.endLine ?? place.line) - 1, 0)), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  } catch (error) {
    void vscode.window.showWarningMessage(`archdiff: ${place.file} could not be opened${place.head ? ` (the page shows ${place.head}, the editor the working tree)` : ""}: ${messageOf(error)}`);
  }
}

/**
 * Shows the page of a folder in the panel: on `view`, or — null — where the page is (where it opens by itself, the
 * first time). The panel is made beside the editor on first use; a view is shown by pointing the page at its
 * address, which loads the page again only when the server or the query changed. A view keeps the focus in the editor.
 */
async function show(folder: vscode.WorkspaceFolder, view: string | null): Promise<void> {
  const server = await serverOf(folder);
  const url = pageUrl(server.origin, view, setting("embed", folder, false));

  if (panel && panel.origin === server.origin) {
    if (view !== null) {
      panel.url = url;
      void panel.view.webview.postMessage({ type: "archdiff:show", url } satisfies ShowMessage);
    }

    panel.view.reveal(undefined, view !== null);

    return;
  }

  // The frame is on a port of this computer: named to the editor, which carries it to where the extension runs.
  const options: vscode.WebviewOptions = { enableScripts: true, portMapping: [{ webviewPort: server.port, extensionHostPort: server.port }] };

  if (panel) {
    panel.view.webview.options = options;
    panel.view.reveal(undefined, view !== null);
    panel = { ...panel, folder, origin: server.origin, url };
  } else {
    const created = vscode.window.createWebviewPanel("archdiff", "archdiff", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: view !== null }, { ...options, retainContextWhenHidden: true });
    created.onDidDispose(() => {
      if (panel?.view === created) panel = null;
    });
    created.webview.onDidReceiveMessage((message: unknown) => {
      if (panel?.view === created && isOpenMessage(message)) void openPlace(panel.folder, message, created);
    });
    panel = { view: created, folder, origin: server.origin, url };
  }

  panel.view.title = `archdiff — ${folder.name}`;
  panel.view.webview.html = panelHtml(url, server.origin, randomBytes(16).toString("base64"));
}

// ── The commands ─────────────────────────────────────────────────────────────

/** The folder a command is about: the active editor's, the only one, or the one picked; null when there is none or none was picked. */
async function folderInUse(): Promise<vscode.WorkspaceFolder | null> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const active = vscode.window.activeTextEditor ? vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri) : undefined;

  if (active) return active;

  if (folders.length === 0) {
    void vscode.window.showWarningMessage("archdiff: open a folder first: the page is of a repository.");

    return null;
  }

  return folders.length === 1 ? folders[0]! : ((await vscode.window.showWorkspaceFolderPick({ placeHolder: "The folder archdiff draws" })) ?? null);
}

/** The file a command is about — the one handed to it (the explorer's menu), else the active editor's — as archdiff names it in its folder; null, said, when it is no file of the workspace. */
function fileInUse(given: unknown): { folder: vscode.WorkspaceFolder; path: string } | null {
  const uri = given instanceof vscode.Uri ? given : vscode.window.activeTextEditor?.document.uri;
  const folder = uri?.scheme === "file" ? vscode.workspace.getWorkspaceFolder(uri) : undefined;
  const path = uri && folder ? repositoryPath(folder.uri.fsPath, uri.fsPath) : null;

  if (!folder || path === null) {
    void vscode.window.showWarningMessage(uri ? "archdiff: this file is in no folder of the workspace." : "archdiff: open a file first.");

    return null;
  }

  return { folder, path };
}

/** A JSON answer of the server; rejects with the server's own words (`error`) when it refuses. */
function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    get(url, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        try {
          const answer: unknown = JSON.parse(text);
          const refused = response.statusCode !== 200 && typeof answer === "object" && answer !== null && "error" in answer ? String(answer.error) : null;

          if (response.statusCode === 200) resolve(answer);
          else reject(new Error(refused ?? `the server answered ${response.statusCode}`));
        } catch (error) {
          reject(new Error(`the server did not answer JSON (${messageOf(error)})`));
        }
      });
    }).on("error", reject);
  });
}

async function open(): Promise<void> {
  const folder = await folderInUse();

  if (folder) await show(folder, null);
}

async function showFile(given: unknown): Promise<void> {
  const file = fileInUse(given);

  if (file) await show(file.folder, moduleView(file.path));
}

/** The view of the function the cursor is in, as archdiff names its functions; outside every function, or in a file archdiff does not read, the file's view, saying so. */
async function showFunction(): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const file = fileInUse(undefined);

  if (!editor || !file) return;
  const server = await serverOf(file.folder);
  const kind = setting<string>("functionView", file.folder, "calls");
  let view = moduleView(file.path);

  try {
    const fn = functionAt(functionsOfInside(await getJson(`${server.origin}${insideRequest(file.path)}`), file.path), editor.selection.active.line + 1);

    if (fn) view = functionView(FUNCTION_VIEWS.find((candidate): candidate is FunctionViewKind => candidate === kind) ?? "calls", fn.id);
    else vscode.window.setStatusBarMessage("archdiff: no function at the cursor (as the file is saved): the file's view", 6000);
  } catch (error) {
    vscode.window.setStatusBarMessage(`archdiff: ${messageOf(error)}: the file's view`, 6000);
  }

  await show(file.folder, view);
}

// ── The check ────────────────────────────────────────────────────────────────

function checkOf(key: string): CheckState {
  let state = checks.get(key);

  if (!state) {
    state = { timer: null, running: null, shown: [] };
    checks.set(key, state);
  }

  return state;
}

/** One finding as a problem on its line: the whole line when the file is open, its start otherwise; the contract is its related place. */
function problemOf(finding: Finding, uri: vscode.Uri, contract: vscode.Uri): vscode.Diagnostic {
  const document = vscode.workspace.textDocuments.find((candidate) => candidate.uri.toString() === uri.toString());
  const line = finding.line - 1;
  const range = document && line < document.lineCount ? document.lineAt(line).range : new vscode.Range(line, 0, line, 200);
  const problem = new vscode.Diagnostic(range, finding.message, vscode.DiagnosticSeverity.Error);
  problem.source = "archdiff";
  problem.code = "contract";
  problem.relatedInformation = [new vscode.DiagnosticRelatedInformation(new vscode.Location(contract, new vscode.Position(0, 0)), `the contract: ${CONTRACT}`)];

  return problem;
}

/** The problems of a folder's check, in place of those of its last run. */
function showFindings(folder: vscode.WorkspaceFolder, state: CheckState, findings: readonly Finding[]): void {
  for (const uri of state.shown) problems.delete(uri);
  state.shown = [];
  const contract = vscode.Uri.joinPath(folder.uri, CONTRACT);

  for (const [file, list] of byFile(findings)) {
    const uri = vscode.Uri.joinPath(folder.uri, ...file.split("/"));
    problems.set(uri, list.map((finding) => problemOf(finding, uri, contract)));
    state.shown.push(uri);
  }
}

/**
 * Runs the check of a folder and shows what it found. A folder without ARCHITECTURE.md has nothing to check
 * against: its problems go, and archdiff is not started. A check nobody asked for (a save, the window opening) runs
 * the archdiff that is installed and never fetches one. A run under way gives way to this one. What went wrong is
 * in the log, and said aloud when the check was asked for by hand.
 */
async function check(folder: vscode.WorkspaceFolder, byHand: boolean): Promise<void> {
  const key = folder.uri.fsPath;
  const state = checkOf(key);
  state.running?.abort();
  state.running = null;

  if (!MACHINE.isFile(join(key, CONTRACT))) {
    showFindings(folder, state, []);

    if (byHand) void vscode.window.showInformationMessage(`archdiff: ${folder.name} has no ${CONTRACT}, nothing to check against (archdiff intent --init writes one from the code).`);

    return;
  }

  const running = new AbortController();
  state.running = running;
  let read: Findings;

  try {
    const configured = setting<string>("command", folder, "");
    const found = findArchdiff(key, configured, MACHINE);

    // A save fetches nothing, and says nothing where no archdiff is installed: a folder whose ARCHITECTURE.md is
    // prose of its own never asked for one. A command the settings name and that is not there is said; by hand, npx may run.
    if (!byHand && (found.ok ? found.start.from === "npx" : configured.trim() === "")) {
      state.running = null;

      return;
    }

    if (!found.ok) throw new Error(found.problem);
    const run = await runCheck(found.start, key, running.signal);

    // Stopped, or overtaken by a newer run: that one shows its own.
    if (run.code === null || state.running !== running) return;
    read = run.code === 0 || run.code === 1 ? findingsOf(run.stdout) : { ok: false, problem: run.stderr.trim() || `archdiff check ended with ${run.code}` };
  } catch (error) {
    if (state.running !== running) return;
    read = { ok: false, problem: messageOf(error) };
  }

  state.running = null;

  if (!read.ok) {
    log.appendLine(`${folder.name}: the check could not run: ${read.problem}`);

    if (byHand) void vscode.window.showErrorMessage(`archdiff: the check could not run: ${read.problem}`);
    else vscode.window.setStatusBarMessage("archdiff: the check could not run (see the archdiff log)", 6000);

    return;
  }

  showFindings(folder, state, read.findings);
  const count = read.findings.length + read.unplaced;
  const said = count === 0 ? `archdiff: ${folder.name} follows ${CONTRACT}` : `archdiff: ${count} ${count === 1 ? "import goes" : "imports go"} against ${CONTRACT}`;

  if (byHand) void vscode.window.showInformationMessage(said);
  else vscode.window.setStatusBarMessage(said, 5000);
}

/** The check of a folder a moment from now; a save before that moment moves it. */
function checkSoon(folder: vscode.WorkspaceFolder): void {
  const state = checkOf(folder.uri.fsPath);

  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = null;
    void check(folder, false);
  }, CHECK_DELAY_MS);
}

/** A folder that left the workspace: its server stopped, its check and its problems gone. */
function forget(folder: vscode.WorkspaceFolder): void {
  const key = folder.uri.fsPath;
  const state = checks.get(key);

  if (state) {
    if (state.timer) clearTimeout(state.timer);
    state.running?.abort();
    showFindings(folder, state, []);
    checks.delete(key);
  }

  void servers.get(key)?.then((server) => server.stop(), () => undefined);
}

// ── The editor's entry points ────────────────────────────────────────────────

/** A command that says what went wrong, with the log one click away. */
function command(name: string, body: (...args: unknown[]) => Promise<void>): vscode.Disposable {
  return vscode.commands.registerCommand(name, async (...args: unknown[]) => {
    try {
      await body(...args);
    } catch (error) {
      log.appendLine(`${name}: ${messageOf(error)}`);

      if ((await vscode.window.showErrorMessage(`archdiff: ${messageOf(error)}`, "Show the log")) !== undefined) log.show();
    }
  });
}

export function activate(context: vscode.ExtensionContext): Api {
  log = vscode.window.createOutputChannel("archdiff");
  problems = vscode.languages.createDiagnosticCollection("archdiff");
  context.subscriptions.push(
    log,
    problems,
    command("archdiff.open", open),
    command("archdiff.showFile", showFile),
    command("archdiff.showFunction", showFunction),
    command("archdiff.check", async () => {
      const folder = await folderInUse();

      if (folder) await check(folder, true);
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      const folder = vscode.workspace.getWorkspaceFolder(document.uri);

      if (folder && setting("checkOnSave", folder, true)) checkSoon(folder);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((change) => change.removed.forEach(forget)),
    { dispose: deactivate },
  );

  // The problems of the code as it is, before the first save.
  for (const folder of vscode.workspace.workspaceFolders ?? []) if (setting("checkOnSave", folder, true)) checkSoon(folder);

  return { shown: () => (panel ? { folder: panel.folder.uri.fsPath, url: panel.url } : null) };
}

/** The window closes: every server stops, with what it started, and no check is left running. */
export function deactivate(): void {
  for (const state of checks.values()) {
    if (state.timer) clearTimeout(state.timer);
    state.running?.abort();
  }

  for (const server of [...listening]) server.stop();

  // One still starting is stopped as soon as it listens.
  for (const starting of servers.values()) void starting.then((server) => server.stop(), () => undefined);
}
