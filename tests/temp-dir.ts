// A fresh temporary directory for a test that writes, removed afterwards
// whether the test passed or threw: the tests write only into copies,
// never into the fixtures or the repository.
//
// Entry point: `withTempDir`.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Runs `body` in a new directory under the system's temporary one (its name starts with `prefix`) and removes the directory after it. */
export async function withTempDir(prefix: string, body: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
