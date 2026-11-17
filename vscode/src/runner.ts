// archdiff as the extension runs it: `archdiff web` on a workspace folder,
// on a port the system picks, kept until it is stopped, and `archdiff
// check --json` run to its end. The server says where it listens on its
// first line to stderr (`archdiff web: http://127.0.0.1:7123/  (…)`), which
// is how the extension learns the port; what it writes after that goes to
// the log. Stopping takes the whole tree of the process: `npx` starts
// archdiff as its child, and on Windows a child outlives a parent that is
// only ended.
//
// No editor API here: node's processes alone. Entry points: `startWeb`,
// `runCheck`, `originOf`, `webArguments`, `checkArguments`, `WebServer`,
// `CheckRun`.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import type { Start } from "./command.ts";

/** A server started: where it listens, and how to stop it. */
export interface WebServer {
  /** `http://127.0.0.1:<port>`: the origin of the page. */
  origin: string;
  port: number;
  stop(): void;
  /** Settles when the process has ended, by `stop` or by itself. */
  ended: Promise<void>;
}

/** What a run of the check left: its exit code (null: it was stopped) and what it printed. */
export interface CheckRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** How long a server may take to say where it listens: `npx` fetches the package on first use. */
const START_TIMEOUT_MS = 180_000;

/** How long a check may run. */
const CHECK_TIMEOUT_MS = 120_000;

/** The origin in what a server wrote to stderr so far, once its line is there; null before. */
export function originOf(stderr: string): string | null {
  return stderr.match(/archdiff web: (http:\/\/[^/\s]+)\//)?.[1] ?? null;
}

/** The arguments of the server on a folder: a port the system picks, on this computer alone. */
export function webArguments(start: Start, folder: string): string[] {
  return [...start.args, "web", folder, "--port", "0"];
}

/** The arguments of the check of a folder, its report as JSON. */
export function checkArguments(start: Start, folder: string): string[] {
  return [...start.args, "check", folder, "--json"];
}

/** Ends a process with every process it started. */
function stopTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    // Windows ends one process at a time unless told of the tree; waited for, since the window may be closing.
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });

    return;
  }

  try {
    // The child leads a group of its own (`detached`), which the signal reaches whole.
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

/**
 * Starts `archdiff web` on `folder` and waits for the line that says where it listens. Rejects with what the
 * process wrote when it ends first, cannot be started, or says nothing for three minutes. `log` gets every line
 * the server writes, before and after.
 */
export function startWeb(start: Start, folder: string, log: (text: string) => void, env: NodeJS.ProcessEnv = process.env): Promise<WebServer> {
  return new Promise((resolve, reject) => {
    const child = spawn(start.file, webArguments(start, folder), { cwd: folder, env, stdio: ["ignore", "ignore", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let written = "";
    let started = false;
    const ended = new Promise<void>((resolveEnded) => child.once("close", () => resolveEnded()));
    const timer = setTimeout(() => {
      stopTree(child);
      reject(new Error(`archdiff web did not say where it listens within ${START_TIMEOUT_MS / 60_000} minutes${written ? `: ${written.trim()}` : ""}`));
    }, START_TIMEOUT_MS);

    child.stderr!.setEncoding("utf8");
    child.stderr!.on("data", (chunk: string) => {
      log(chunk);

      if (started) return;
      written += chunk;
      const origin = originOf(written);

      if (origin === null) return;
      started = true;
      clearTimeout(timer);
      resolve({ origin, port: Number(new URL(origin).port), stop: () => stopTree(child), ended });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${start.file} could not be started: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);

      if (!started) reject(new Error(`archdiff web ended${code === null ? "" : ` with ${code}`} before it listened${written ? `: ${written.trim()}` : ""}`));
    });
  });
}

/**
 * Runs `archdiff check --json` on `folder` to its end. `signal` stops it (a newer run took its place): the code is
 * then null. Rejects when the command cannot be started.
 */
export function runCheck(start: Start, folder: string, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env): Promise<CheckRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(start.file, checkArguments(start, folder), { cwd: folder, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let stopped = false;
    const stop = (): void => {
      stopped = true;
      stopTree(child);
    };
    const timer = setTimeout(stop, CHECK_TIMEOUT_MS);

    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => (stdout += chunk));
    child.stderr!.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`${start.file} could not be started: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      resolve({ code: stopped ? null : code, stdout, stderr });
    });
  });
}
