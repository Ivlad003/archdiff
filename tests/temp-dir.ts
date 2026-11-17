// A fresh temporary directory for a test that writes, removed afterwards
// whether the test passed or threw: the tests write only into copies,
// never into the fixtures or the repository.
//
// Entry points: `withTempDir`, `canLink`.

import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `body` in a new directory under the system's temporary one (its name starts with `prefix`) and removes the directory after it. */
export async function withTempDir(prefix: string, body: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  try {
    await body(dir);
  } finally {
    // A server just stopped may have a git of its own still ending in the directory: Windows refuses the removal for a moment.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

/** Whether this computer lets a test make a symbolic link (Windows asks for a privilege): the tests of links skip without it. */
export function canLink(): boolean {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-link-probe-"));

  try {
    symlinkSync(dir, join(dir, "probe"), "dir");

    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
