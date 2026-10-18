// The extraction worker (pool.ts): receives `{path, content}` jobs, answers
// `{path, facts}` (or `{path, error}`), and exits on `null`.
//
// Entry point: the module itself, started as a worker thread by pool.ts.

import { parentPort } from "node:worker_threads";
import { extractAny } from "./any.ts";

const port = parentPort;

if (!port) throw new Error("extract/worker.ts runs only as a worker thread");

port.on("message", (job: { path: string; content: string } | null) => {
  if (job === null) {
    port.close();

    return;
  }

  extractAny(job.path, job.content).then(
    (facts) => port.postMessage({ path: job.path, facts }),
    (error: unknown) => port.postMessage({ path: job.path, error: error instanceof Error ? error.message : String(error) }),
  );
});
