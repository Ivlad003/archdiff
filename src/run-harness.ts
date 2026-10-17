// The main script of a run's child process: imports the entry module
// (through the hooks run-register.ts set up), calls the entry function
// with the arguments the plan gives, waits for its result, and prints
// one JSON report on stdout — the trace of the functions entered, the
// calls the mocks took, the result or the error. The parent (run.ts)
// reads it; nothing else of this process reaches the user.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

interface Plan {
  entryFile: string;
  entryExport: string;
  args: unknown[];
  timeoutMs: number;
}

interface Recorder {
  events: { kind: "enter" | "storage"; id?: string; module?: string; member?: string; args?: unknown[]; t: number }[];
}

const plan = JSON.parse(readFileSync(process.env["ARCHDIFF_RUN"]!, "utf8")) as Plan;
const recorder = (globalThis as unknown as { __archdiff: Recorder }).__archdiff;
const started = performance.now();

const report = (result: unknown, error: string | null): void => {
  const text = JSON.stringify({ events: recorder.events, result, error, ms: Math.round(performance.now() - started) }, (_key, item: unknown) => (typeof item === "function" ? "[function]" : typeof item === "bigint" ? String(item) : item instanceof Map ? Object.fromEntries(item) : item instanceof Set ? [...item] : item));
  process.stdout.write(`\n@@archdiff-run@@${text}\n`);
};

const timer = setTimeout(() => {
  report(null, `stopped after ${plan.timeoutMs} ms`);
  process.exit(0);
}, plan.timeoutMs);

try {
  const module = (await import(pathToFileURL(plan.entryFile).href)) as Record<string, unknown>;
  const entry = module[plan.entryExport] ?? (plan.entryExport === "default" ? module["default"] : undefined);

  if (typeof entry !== "function") throw new Error(`${plan.entryFile} has no exported function ${plan.entryExport}`);
  const value: unknown = await (entry as (...args: unknown[]) => unknown)(...plan.args);
  report(value, null);
} catch (error) {
  report(null, error instanceof Error ? `${error.name}: ${error.message}` : String(error));
} finally {
  clearTimeout(timer);
  process.exit(0);
}
