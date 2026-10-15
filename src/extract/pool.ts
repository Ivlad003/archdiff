// Parallel extraction: a pool of worker threads, each with its own
// tree-sitter runtime, parsing files as the main thread hands them out.
// Parsing is the cold-start cost of an analysis (the graph is cheap), and
// WASM parsing is synchronous, so threads are the only way to use more
// than one core. Below `MIN_PARALLEL` files the main thread parses alone:
// starting workers costs more than it saves.
//
// Sits between analyze.ts and extractTs: paths + contents → FileFacts.
// Entry point: `extractAll`.

import { cpus } from "node:os";
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { FileFacts } from "./facts.ts";
import { extractTs } from "./ts.ts";

/** Fewer files than this are parsed on the main thread. */
const MIN_PARALLEL = 40;

export interface ExtractJob {
  path: string;
  content: string;
}

interface WorkerReply {
  path: string;
  facts?: FileFacts;
  error?: string;
}

/** The worker script: `.ts` in a checkout (Node strips the types), `.js` in the published package. */
function workerUrl(): URL {
  const ts = new URL("./worker.ts", import.meta.url);

  return existsSync(ts) ? ts : new URL("./worker.js", import.meta.url);
}

/** Revives the Set of `FileFacts` after the structured clone (which keeps Sets, but a JSON transport would not). */
function revive(facts: FileFacts): FileFacts {
  return facts.exports instanceof Set ? facts : { ...facts, exports: new Set(facts.exports as unknown as string[]) };
}

/** Extracts every job, in parallel when there are enough; the result keeps the jobs' order. */
export async function extractAll(jobs: readonly ExtractJob[], threads = Math.max(1, Math.min(8, cpus().length - 1))): Promise<FileFacts[]> {
  if (jobs.length < MIN_PARALLEL || threads <= 1) {
    const out: FileFacts[] = [];

    for (const job of jobs) out.push(await extractTs(job.path, job.content));

    return out;
  }

  const results = new Array<FileFacts | undefined>(jobs.length);
  const index = new Map(jobs.map((job, i) => [job.path, i]));
  let next = 0;
  const url = workerUrl();

  const run = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const worker = new Worker(url);

      const feed = (): void => {
        if (next >= jobs.length) {
          worker.postMessage(null);

          return;
        }

        const job = jobs[next++]!;
        worker.postMessage(job);
      };

      worker.on("message", (reply: WorkerReply) => {
        if (reply.error !== undefined) {
          reject(new Error(`${reply.path}: ${reply.error}`));
          void worker.terminate();

          return;
        }

        results[index.get(reply.path)!] = revive(reply.facts!);
        feed();
      });
      worker.on("error", reject);
      worker.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`extraction worker exited with ${code}`))));
      feed();
    });

  await Promise.all(Array.from({ length: Math.min(threads, jobs.length) }, run));

  return results.map((facts, i) => facts ?? { path: jobs[i]!.path, endLine: 1, endCol: 1, imports: [], decls: [], exports: new Set(), reexportsAll: [], exportRows: [], unsupported: [], valueRefs: [], moduleCalls: [], completeness: "opaque", parseError: { line: 1, reason: "not extracted" } });
}
