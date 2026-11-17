// archdiff web for a test: started on a directory, and where it listens,
// read from the line it writes to stderr once it is bound (a minute at
// most). The tests of the HTTP API and of the page start one per file,
// and one of their own on a copy of the fixture when a test needs another
// config (an agent, checks, none at all). Every server takes a directory
// of the tests for the user's home (`ARCHDIFF_HOME`): no test reads the
// settings and the keys of the person who runs it, nor finds the agents
// installed for them.
//
// Entry points: `startWeb`, `withOwnServer`, `homeOf`, `fakeCommand`,
// `TEST_BIN`, `TEST_PATH`.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { withTempDir } from "./temp-dir.ts";

const bin = join(import.meta.dirname, "..", "bin", "archdiff.js");
const fixture = join(import.meta.dirname, "fixtures", "sample");

/** The commands of the coding agents the page offers: none of them may be on a test server's PATH. */
const AGENT_COMMANDS = ["claude", "cursor-agent", "codex", "opencode"];

/**
 * The PATH of a test's server: a directory of its own holding node and git, and no coding agent installed on the
 * computer the tests run on — the page offers the agents it finds there, and a test must never start a real one.
 * The fake agents run by their path. On Windows a link needs a privilege and git its own directory beside it: the
 * PATH stays as it is, less every directory that holds an agent, with the test's directory first.
 */
const testBin = mkdtempSync(join(tmpdir(), "archdiff-test-bin-"));
process.on("exit", () => rmSync(testBin, { recursive: true, force: true }));

function testPath(): string {
  if (process.platform !== "win32") {
    symlinkSync(process.execPath, join(testBin, "node"));
    symlinkSync(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git", join(testBin, "git"));

    return testBin;
  }

  const extensions = ["", ...(process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")];
  const holdsAgent = (directory: string): boolean => AGENT_COMMANDS.some((command) => extensions.some((extension) => existsSync(join(directory, command + extension))));

  return [testBin, ...(process.env["PATH"] ?? "").split(delimiter).filter((directory) => directory !== "" && !holdsAgent(directory))].join(delimiter);
}

/** The directory first on a test server's PATH: a test that needs an agent by its name puts a fake one here. */
export const TEST_BIN = testBin;
export const TEST_PATH = testPath();

/** The home of the servers that keep no settings: empty, and shared. */
const emptyHome = mkdtempSync(join(tmpdir(), "archdiff-test-home-"));
process.on("exit", () => rmSync(emptyHome, { recursive: true, force: true }));

/** The home of the server `withOwnServer` starts on `dir`: its settings are `.archdiff/settings.json` under it. */
export function homeOf(dir: string): string {
  return join(dir, ".home");
}

/**
 * A command that runs `script` with node, as an agent installed on this computer is one: a shell script, or on
 * Windows the shim npm writes — a batch file beside the script it names — which archdiff has to read to start it.
 * The path to name the command by (the shim's, without its extension, on Windows).
 */
export function fakeCommand(dir: string, name: string, script: string): string {
  if (process.platform !== "win32") {
    writeFileSync(join(dir, name), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, { mode: 0o755 });

    return join(dir, name);
  }

  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  cpSync(script, join(dir, "node_modules", name, basename(script)));
  writeFileSync(join(dir, `${name}.cmd`), ["@ECHO off", "GOTO start", ":find_dp0", "SET dp0=%~dp0", "EXIT /b", ":start", "SETLOCAL", "CALL :find_dp0", "", 'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ") ELSE (", '  SET "_prog=node"', "  SET PATHEXT=%PATHEXT:;.JS;=;%", ")", "", `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\${name}\\${basename(script)}" %*`, ""].join("\r\n"));

  return join(dir, name);
}

/** archdiff web on `dir`, on a free port with the arguments given, and the origin it listens on once it says so; `home` is what it takes for the user's home. */
export function startWeb(dir: string, args: readonly string[] = ["--no-watch"], home: string = emptyHome): { server: ChildProcess; origin: Promise<string> } {
  const server = spawn(process.execPath, [bin, "web", dir, "--port", "0", ...args], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PATH: TEST_PATH, ARCHDIFF_HOME: home } });

  return { server, origin: originOf(server) };
}

/** Where a server just started listens, from the line it writes to stderr; rejected when it exits first or says nothing for a minute. */
function originOf(server: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${text}`)), 60_000);
    server.stderr!.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      const match = text.match(/archdiff web: (http:\/\/[^/]+)\//);

      if (match) {
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited with ${code}: ${text}`));
    });
  });
}

/** A server of its own on a copy of the sample fixture that `prepare` configures, for `body`; stopped and the copy removed after it. */
export function withOwnServer(prefix: string, prepare: (dir: string) => void, body: (origin: string, dir: string) => Promise<void>): Promise<void> {
  return withTempDir(prefix, async (dir) => {
    cpSync(fixture, dir, { recursive: true });
    mkdirSync(homeOf(dir));
    prepare(dir);
    const { server, origin } = startWeb(dir, undefined, homeOf(dir));

    try {
      await body(await origin, dir);
    } finally {
      server.kill();
    }
  });
}
