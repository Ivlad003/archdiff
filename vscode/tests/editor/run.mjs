// Runs the editor test: a real VS Code — the one installed on this
// computer, else one fetched for the test — with a profile of its own, on a
// workspace made here that holds a contract, two source files and the
// stand-in archdiff (stand-in.mjs) as its `node_modules/.bin/archdiff`, as
// npm installs a command. The extension is the one built in dist/; the
// suite (suite.cjs) runs inside the editor. After the editor has closed,
// the stand-in's server must be gone: the extension stops it with the
// window.
//
// `VSCODE_EXECUTABLE` names the editor to use. Entry point: `npm run
// test:editor` in vscode/ (after `npm run build`).

import { runTests } from "@vscode/test-electron";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const extension = join(here, "..", "..");

/** Where an installer puts VS Code; none found, the test fetches one. */
const INSTALLED = [
  process.env["VSCODE_EXECUTABLE"],
  join(homedir(), "AppData", "Local", "Programs", "Microsoft VS Code", "Code.exe"),
  "C:/Program Files/Microsoft VS Code/Code.exe",
  "/Applications/Visual Studio Code.app/Contents/MacOS/Electron",
  "/usr/share/code/code",
  "/snap/code/current/usr/share/code/code",
].find((path) => path !== undefined && existsSync(path));

/** The workspace of the test: a contract, two files, and the stand-in installed as the workspace's archdiff. */
function workspace(root) {
  const dir = join(root, "shop");
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "stand-in"), { recursive: true });
  writeFileSync(join(dir, "ARCHITECTURE.md"), "# Architecture\n\nThe stand-in's contract.\n");
  writeFileSync(join(dir, "src", "place.ts"), 'import { other } from "./other.ts";\n\nexport function place(): string {\n  return other();\n}\n');
  writeFileSync(join(dir, "src", "other.ts"), "export function other(): string {\n  return 'other';\n}\n");
  cpSync(join(here, "stand-in.mjs"), join(dir, "node_modules", "stand-in", "archdiff.mjs"));

  if (process.platform === "win32") {
    // The shim npm writes for a package's command.
    writeFileSync(join(dir, "node_modules", ".bin", "archdiff.cmd"), ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "", 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "", 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\stand-in\\archdiff.mjs" %*', ""].join("\r\n"));
  } else {
    writeFileSync(join(dir, "node_modules", ".bin", "archdiff"), '#!/bin/sh\nexec node "$(dirname "$0")/../stand-in/archdiff.mjs" "$@"\n');
    chmodSync(join(dir, "node_modules", ".bin", "archdiff"), 0o755);
  }

  return dir;
}

/** Whether something listens on a port of this computer. */
function listens(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const root = mkdtempSync(join(tmpdir(), "archdiff-editor-"));
let failed = false;

try {
  const dir = workspace(root);

  await runTests({
    ...(INSTALLED ? { vscodeExecutablePath: INSTALLED } : {}),
    extensionDevelopmentPath: extension,
    extensionTestsPath: join(here, "suite.cjs"),
    // A profile of the test's own, no other extension, and the folder trusted: the extension runs the workspace's archdiff.
    launchArgs: [dir, "--user-data-dir", join(root, "user"), "--extensions-dir", join(root, "extensions"), "--disable-extensions", "--disable-workspace-trust"],
  });

  // The window is closed: the server the extension started for the panel is stopped with it.
  const { port } = JSON.parse(readFileSync(join(dir, "server.json"), "utf8"));

  for (let asked = 0; asked < 40 && (await listens(port)); asked++) await new Promise((resolve) => setTimeout(resolve, 250));

  if (await listens(port)) throw new Error(`the server on port ${port} outlived the editor's window`);
  console.log("editor test: passed (the problems, the panel, the views, the place opened, the server stopped with the window)");
} catch (error) {
  failed = true;
  console.error(`editor test: failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}

process.exit(failed ? 1 : 0);
