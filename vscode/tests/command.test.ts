// Which archdiff the extension runs (src/command.ts), on computers the
// tests name: a Linux and a Windows one, each a set of files and a PATH.
// The Windows cases hold the batch files as npm writes them — a package's
// shim, and npm's own npx.cmd — since those are what the search reads.
//
// Entry point: run by `npm test` in vscode/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { findArchdiff, PACKAGE, type Machine } from "../src/command.ts";

/** A computer: its platform, its files by path (a batch file's text matters, any other is ""), and its environment. */
function machine(platform: "linux" | "win32", files: Record<string, string>, env: Record<string, string>): Machine {
  // Windows names a file whatever the case of its letters.
  const key = (path: string): string => (platform === "win32" ? path.toLowerCase() : path);
  const known = new Map(Object.entries(files).map(([path, text]) => [key(path), text]));

  return { platform, env, isFile: (path) => known.has(key(path)), read: (path) => known.get(key(path)) ?? "" };
}

/** The shim npm writes on Windows for a package's command: a batch file that hands a script beside it to node. */
function shim(target: string): string {
  return ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "", 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "", `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`, ""].join("\r\n");
}

/** npm's own npx.cmd, as Node's installer puts it beside node.exe. */
const NPX_CMD = [":: Created by npm, please don't edit manually.", "@ECHO OFF", "", "SETLOCAL", "", 'SET "NODE_EXE=%~dp0\\node.exe"', 'IF NOT EXIST "%NODE_EXE%" (', '  SET "NODE_EXE=node"', ")", "", 'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"', 'SET "NPX_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npx-cli.js"', "FOR /F \"delims=\" %%F IN ('CALL \"%NODE_EXE%\" \"%NPM_PREFIX_JS%\"') DO (", '  SET "NPM_PREFIX_NPX_CLI_JS=%%F\\node_modules\\npm\\bin\\npx-cli.js"', ")", 'IF EXIST "%NPM_PREFIX_NPX_CLI_JS%" (', '  SET "NPX_CLI_JS=%NPM_PREFIX_NPX_CLI_JS%"', ")", "", '"%NODE_EXE%" "%NPX_CLI_JS%" %*', ""].join("\r\n");

const NODE_DIR = "C:\\Program Files\\nodejs";
const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";

test("the workspace's own archdiff comes first, then the PATH's, then npx; with none of them the problem says what to install", () => {
  const env = { PATH: "/usr/local/bin:/usr/bin" };
  const all = { "/repo/node_modules/.bin/archdiff": "", "/usr/local/bin/archdiff": "", "/usr/bin/npx": "" };

  assert.deepEqual(findArchdiff("/repo", null, machine("linux", all, env)), { ok: true, start: { file: "/repo/node_modules/.bin/archdiff", args: [], from: "workspace" } });
  assert.deepEqual(findArchdiff("/repo", "", machine("linux", { "/usr/local/bin/archdiff": "", "/usr/bin/npx": "" }, env)), { ok: true, start: { file: "/usr/local/bin/archdiff", args: [], from: "path" } });
  assert.deepEqual(findArchdiff("/repo", null, machine("linux", { "/usr/bin/npx": "" }, env)), { ok: true, start: { file: "/usr/bin/npx", args: ["--yes", PACKAGE], from: "npx" } });
  // Another folder's archdiff is not this one's.
  assert.deepEqual(findArchdiff("/other", null, machine("linux", { "/repo/node_modules/.bin/archdiff": "", "/usr/bin/npx": "" }, env)), { ok: true, start: { file: "/usr/bin/npx", args: ["--yes", PACKAGE], from: "npx" } });
  const none = findArchdiff("/repo", null, machine("linux", {}, env));
  assert.deepEqual(none, { ok: false, problem: `archdiff is not installed (npm install --save-dev ${PACKAGE}), and npx is not on the PATH to fetch it` });
});

test("the command the settings name is the one run — a path in the workspace, an absolute one, a name on the PATH — and a missing one is a problem, not a reason to run another", () => {
  const env = { PATH: "/usr/local/bin" };
  const files = { "/repo/tools/archdiff": "", "/opt/archdiff/bin/archdiff.js": "", "/usr/local/bin/archdiff-next": "", "/repo/node_modules/.bin/archdiff": "" };
  const linux = machine("linux", files, env);

  assert.deepEqual(findArchdiff("/repo", "tools/archdiff", linux), { ok: true, start: { file: "/repo/tools/archdiff", args: [], from: "setting" } });
  assert.deepEqual(findArchdiff("/repo", " /opt/archdiff/bin/archdiff.js ", linux), { ok: true, start: { file: "/opt/archdiff/bin/archdiff.js", args: [], from: "setting" } });
  assert.deepEqual(findArchdiff("/repo", "archdiff-next", linux), { ok: true, start: { file: "/usr/local/bin/archdiff-next", args: [], from: "setting" } });
  assert.deepEqual(findArchdiff("/repo", "tools/gone", linux), { ok: false, problem: "the setting archdiff.command names tools/gone, which is not a file" });
  assert.deepEqual(findArchdiff("/repo", "gone", linux), { ok: false, problem: "the setting archdiff.command names gone, which is not on the PATH" });
});

test("on Windows a shim of npm is read for the script it hands to node, and node is started with it: the node beside the shim, else the PATH's", () => {
  const env = { Path: `${NPM_DIR};${NODE_DIR}` };
  const script = "C:\\repo\\node_modules\\@ivlad003\\archdiff\\bin\\archdiff.js";
  const local = machine("win32", { "C:\\repo\\node_modules\\.bin\\archdiff.cmd": shim("..\\@ivlad003\\archdiff\\bin\\archdiff.js"), [script]: "", [`${NODE_DIR}\\node.exe`]: "" }, env);

  assert.deepEqual(findArchdiff("C:\\repo", null, local), { ok: true, start: { file: `${NODE_DIR}\\node.exe`, args: [script], from: "workspace" } });

  // Installed for the user: npm's directory on the PATH, and a node.exe beside the shim wins over the PATH's.
  const globalScript = `${NPM_DIR}\\node_modules\\@ivlad003\\archdiff\\bin\\archdiff.js`;
  const files = { [`${NPM_DIR}\\archdiff.cmd`]: shim("node_modules\\@ivlad003\\archdiff\\bin\\archdiff.js"), [globalScript]: "", [`${NODE_DIR}\\node.exe`]: "" };

  assert.deepEqual(findArchdiff("C:\\repo", null, machine("win32", files, env)), { ok: true, start: { file: `${NODE_DIR}\\node.exe`, args: [globalScript], from: "path" } });
  assert.deepEqual(findArchdiff("C:\\repo", null, machine("win32", { ...files, [`${NPM_DIR}\\node.exe`]: "" }, env)), { ok: true, start: { file: `${NPM_DIR}\\node.exe`, args: [globalScript], from: "path" } });

  // A program of the name is started as it is, before a batch file beside it.
  assert.deepEqual(findArchdiff("C:\\repo", null, machine("win32", { ...files, [`${NPM_DIR}\\archdiff.exe`]: "" }, env)), { ok: true, start: { file: `${NPM_DIR}\\archdiff.exe`, args: [], from: "path" } });
});

test("on Windows npx is npm's own batch file: node is started with the script it names, then --yes and the package", () => {
  const cli = `${NODE_DIR}\\node_modules\\npm\\bin\\npx-cli.js`;
  const windows = machine("win32", { [`${NODE_DIR}\\npx.cmd`]: NPX_CMD, [`${NODE_DIR}\\npx`]: "", [`${NODE_DIR}\\node.exe`]: "", [cli]: "" }, { PATH: NODE_DIR });

  assert.deepEqual(findArchdiff("C:\\repo", null, windows), { ok: true, start: { file: `${NODE_DIR}\\node.exe`, args: [cli, "--yes", PACKAGE], from: "npx" } });
});

test("on Windows what cannot be started says why: a shim whose script is gone, no node for it, a batch file that is no shim", () => {
  const env = { PATH: NPM_DIR };
  const script = `${NPM_DIR}\\node_modules\\@ivlad003\\archdiff\\bin\\archdiff.js`;
  const text = shim("node_modules\\@ivlad003\\archdiff\\bin\\archdiff.js");

  assert.deepEqual(findArchdiff("C:\\repo", null, machine("win32", { [`${NPM_DIR}\\archdiff.cmd`]: text }, env)), { ok: false, problem: `${NPM_DIR}\\archdiff.cmd runs ${script}, which is not there` });
  assert.deepEqual(findArchdiff("C:\\repo", null, machine("win32", { [`${NPM_DIR}\\archdiff.cmd`]: text, [script]: "" }, env)), { ok: false, problem: `${NPM_DIR}\\archdiff.cmd runs ${script} with node, which is not on the PATH` });
  assert.deepEqual(findArchdiff("C:\\repo", null, machine("win32", { [`${NPM_DIR}\\archdiff.bat`]: "@echo off\r\ncall something %*\r\n" }, env)), {
    ok: false,
    problem: `${NPM_DIR}\\archdiff.bat is a batch file that is no shim of npm: name the program it runs in the setting archdiff.command`,
  });
});
