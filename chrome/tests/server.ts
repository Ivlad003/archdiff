// The archdiff of this checkout as a server for a test: `archdiff web` on a
// directory, on a free port, with a home of its own (no test reads the
// settings of the person who runs it), and where it listens, read from the
// line it writes once it is bound. The extension's tests start it as its
// user does — a process, asked over HTTP — and import nothing of archdiff.
//
// Entry point: `startArchdiff`.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dirname, "..", "..", "bin", "archdiff.js");

/** archdiff web on `dir`: the origin it listens on once it says so (a minute at most), and the way to stop it and wait until it is gone. */
export function startArchdiff(dir: string): { origin: Promise<string>; stop(): Promise<void> } {
  const home = mkdtempSync(join(tmpdir(), "archdiff-chrome-home-"));
  const server = spawn(process.execPath, [bin, "web", dir, "--port", "0", "--no-watch"], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, ARCHDIFF_HOME: home } });
  const origin = new Promise<string>((resolve, reject) => {
    let written = "";
    const timer = setTimeout(() => reject(new Error(`archdiff web did not start: ${written}`)), 60_000);
    server.stderr.on("data", (chunk: Buffer) => {
      written += chunk.toString();
      const found = /archdiff web: (http:\/\/[^/\s]+)\//.exec(written);

      if (found) {
        clearTimeout(timer);
        resolve(found[1]!);
      }
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`archdiff web ended with ${code}: ${written}`));
    });
  });
  // A server that never started is a test's failure where its origin is awaited, not an unhandled rejection here.
  origin.catch(() => undefined);

  return {
    origin,
    stop: async () => {
      server.kill();
      await new Promise((resolve) => (server.exitCode === null && server.signalCode === null ? server.once("exit", resolve) : resolve(null)));
      rmSync(home, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
