// The extraction worker (pool.ts): receives `{id, path, content}` jobs,
// answers `{id, path, facts}` (or `{id, path, error}`), and exits on `null`.
// The id tells two versions of one path apart (a history's commits).
//
// Entry point: the module itself, started as a worker thread by pool.ts.

import { parentPort } from "node:worker_threads";
import { extractAny } from "./any.ts";

const port = parentPort;

if (!port) throw new Error("extract/worker.ts runs only as a worker thread");

port.on("message", (job: { id: number; path: string; content: string } | null) => {
  if (job === null) {
    port.close();

    return;
  }

  extractAny(job.path, job.content).then(
    (facts) => port.postMessage({ id: job.id, path: job.path, facts }),
    (error: unknown) => port.postMessage({ id: job.id, path: job.path, error: error instanceof Error ? error.message : String(error) }),
  );
});
