// archdiff web for a test: started on a directory, and where it listens,
// read from the line it writes to stderr once it is bound (a minute at
// most). The tests of the HTTP API and of the page start one per file,
// and one of their own on a copy of the fixture when a test needs another
// config (an agent, checks, none at all).
//
// Entry points: `startWeb`, `withOwnServer`.

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTempDir } from "./temp-dir.ts";

const bin = join(import.meta.dirname, "..", "bin", "archdiff.js");
const fixture = join(import.meta.dirname, "fixtures", "sample");

/**
 * The PATH of a test's server: a directory of its own holding node and git, and no coding agent installed on the
 * computer the tests run on — the page offers the agents it finds there, and a test must never start a real one.
 * The fake agents run by their path.
 */
const testBin = mkdtempSync(join(tmpdir(), "archdiff-test-bin-"));
symlinkSync(process.execPath, join(testBin, "node"));
symlinkSync(spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim() || "/usr/bin/git", join(testBin, "git"));
process.on("exit", () => rmSync(testBin, { recursive: true, force: true }));
export const TEST_PATH = testBin;

/** archdiff web on `dir`, on a free port with the arguments given, and the origin it listens on once it says so. */
export function startWeb(dir: string, args: readonly string[] = ["--no-watch"]): { server: ChildProcess; origin: Promise<string> } {
  const server = spawn(process.execPath, [bin, "web", dir, "--port", "0", ...args], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PATH: TEST_PATH } });

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
    prepare(dir);
    const { server, origin } = startWeb(dir);

    try {
      await body(await origin, dir);
    } finally {
      server.kill();
    }
  });
}
