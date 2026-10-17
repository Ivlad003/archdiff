// A run of an entry point with the storages mocked (`archdiff run`, the
// Flow tab's ▶ run): the real code of the repository runs in a child
// Node process with its module hooks — every project function traced at
// the start of its body, the storage packages (a database client,
// node:fs, fetch) replaced by recorders that answer from the mocks —
// under Node's permission model, which refuses the file system for
// writing, child processes and workers of its own. What comes back is
// what happened: the functions entered in order, the calls the storages
// took, the result or the error; set against the predicted data flow
// (flow.ts), the steps it missed and the ones it did not foresee.
// TypeScript and JavaScript, a top-level exported function.
//
// Sits at the I/O edge beside flow.ts: Analysis + entry + mocks → child
// process → RunResult. Entry points: `runFlow`, `runMarkdown`, `RunResult`.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Analysis } from "./analyze.ts";
import { CACHE_DIRECTORY } from "./cache.ts";
import { functionBodies } from "./extract/bodies.ts";
import { dataFlow, parseSignature, STORAGE_PACKAGES } from "./flow.ts";
import { nodeId } from "./graph.ts";
import { createResolver } from "./resolve.ts";
import type { Mock } from "./scene.ts";

export interface RunOptions {
  /** The arguments of the entry, by parameter name. */
  input?: Record<string, unknown>;
  /** What each storage holds: by package (`node:fs`, `pg`) or by the module that imports it (`src/db/store.ts`). */
  storages?: Record<string, unknown>;
  /** The mocks saved with the view's drawing (the Flow tab's): the input of the entry and the content of the storages. */
  mocks?: readonly Mock[];
  timeoutMs?: number;
}

export interface RunResult {
  entry: string;
  /** The functions entered, in order (a function entered twice is listed twice). */
  steps: { id: string; order: number }[];
  /** What the mocked storages were asked. */
  storageCalls: { module: string; member: string; args: unknown[] }[];
  result: unknown;
  error: string | null;
  ms: number;
  /** The steps the data flow predicted (flow.ts), those it predicted that were not entered, and those entered that it did not predict. */
  predicted: string[];
  missed: string[];
  unexpected: string[];
  /** The last lines the child process wrote to stderr, when any (a warning, a stack). */
  stderr?: string;
}

/** The plan the child process reads: see run-hooks.ts and run-harness.ts. */
interface RunPlan {
  root: string;
  entryFile: string;
  entryExport: string;
  args: unknown[];
  timeoutMs: number;
  resolutions: Record<string, Record<string, string>>;
  bodies: Record<string, { id: string; start: number; end: number; expression: boolean }[]>;
  mocks: Record<string, { content: unknown; names: string[] }>;
}

const DEFAULT_TIMEOUT_MS = 20_000;

/** A specifier that names a storage package archdiff mocks: the table of flow.ts, plus the config's, `fs` with or without `node:`. */
function isStoragePackage(specifier: string, analysis: Analysis): boolean {
  const key = specifier === "fs" || specifier === "fs/promises" || specifier === "node:fs/promises" ? "node:fs" : specifier;

  return key in STORAGE_PACKAGES || key in analysis.config.storagePackages;
}

/** The modules the entry's module can load: its imports, transitively (what the run may reach). */
function reachable(analysis: Analysis, module: string): Set<string> {
  const { graph } = analysis;
  const seen = new Set([module]);
  const stack = [module];

  while (stack.length > 0) {
    const at = stack.pop()!;

    for (const dep of graph.deps) {
      if (dep.from !== at || !graph.modules.has(dep.to) || seen.has(dep.to)) continue;
      seen.add(dep.to);
      stack.push(dep.to);
    }
  }

  return seen;
}

/** The arguments of the entry from the input, by parameter name; a destructured parameter takes the keys it names, or the whole input. */
function argumentsOf(signature: string | null, input: Record<string, unknown>): unknown[] {
  return parseSignature(signature).params.map((param) => {
    if (!param.name.startsWith("{")) return input[param.name];
    const keys = param.name.replace(/^\{|\}$/g, "").split(",").map((part) => part.split(":")[0]!.trim()).filter((key) => key !== "");
    const picked: Record<string, unknown> = {};

    for (const key of keys) if (key in input) picked[key] = input[key];

    return Object.keys(picked).length > 0 ? picked : input;
  });
}

/**
 * Runs `entry` (`<path>#<fn>`) with the mocks. The entry must be an
 * exported top-level function of a TypeScript or JavaScript module; a
 * method, a nested function or another language is refused with a reason.
 */
export async function runFlow(analysis: Analysis, entry: string, options: RunOptions = {}): Promise<RunResult> {
  const { graph, root } = analysis;
  const node = graph.nodes.get(entry);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const predicted = dataFlow(analysis, entry, [], 8).steps.map((step) => step.id);
  const refuse = (error: string): RunResult => ({ entry, steps: [], storageCalls: [], result: null, error, ms: 0, predicted, missed: predicted, unexpected: [] });

  if (!node || node.kind !== "fn") return refuse(`no function "${entry}"`);

  if (node.parent) return refuse("a method cannot be run on its own; run the function that creates the object");

  if (!/\.[cm]?[jt]sx?$/.test(node.module)) return refuse("only a TypeScript or JavaScript function can be run");
  const exportName = graph.resolvedExports.get(node.module)?.get("default") === entry ? "default" : node.name;

  if (!node.exported && exportName !== "default") return refuse(`${node.name} is not exported from ${node.module}`);
  // The input: given, else the saved mock of the entry; the storages likewise, module mocks mapped to the packages the module imports.
  const savedInput = options.mocks?.find((mock) => mock.kind === "input" && mock.id === entry)?.value;
  const savedObject = savedInput !== undefined ? parseLoosely(savedInput) : {};
  const input: Record<string, unknown> = options.input ?? (savedObject && typeof savedObject === "object" && !Array.isArray(savedObject) ? (savedObject as Record<string, unknown>) : {});
  const storages: Record<string, unknown> = {};

  for (const mock of options.mocks ?? []) if (mock.kind === "storage") storages[mock.id] = parseLoosely(mock.value);

  for (const [key, value] of Object.entries(options.storages ?? {})) storages[key] = value;
  const resolve = createResolver(root, graph.modules.keys(), [...analysis.facts.values()]);
  const modules = [...reachable(analysis, node.module)].filter((module) => /\.[cm]?[jt]sx?$/.test(module));
  const plan: RunPlan = { root, entryFile: join(root, node.module), entryExport: exportName, args: argumentsOf(node.signature, input), timeoutMs, resolutions: {}, bodies: {}, mocks: {} };
  const mockNames = new Map<string, Set<string>>();

  // The resolutions and the trace points of every module the run may load.
  for (const module of modules) {
    const file = analysis.facts.get(module);

    if (!file) continue;
    const absolute = join(root, module);
    const map: Record<string, string> = {};

    for (const fact of file.imports) {
      if (fact.typeOnly) continue;
      const target = resolve(module, fact.source);

      if (target.kind === "file") map[fact.source] = join(root, target.path);
      else if ((target.kind === "package" || target.kind === "builtin") && isStoragePackage(fact.source, analysis)) {
        map[fact.source] = `mock:${fact.source}`;
        const names = mockNames.get(fact.source) ?? new Set<string>();

        for (const binding of fact.bindings) names.add(binding.kind === "named" ? binding.imported : binding.kind === "default" ? "default" : "*");
        mockNames.set(fact.source, names);
      }
    }

    plan.resolutions[absolute] = map;
    // The trace points: each function body by the position of the node that declares it, matched to the graph's nodes.
    const byPosition = new Map<string, string>();

    const walk = (decl: (typeof file.decls)[number], parent: string | undefined): void => {
      byPosition.set(`${decl.line}:${decl.col}`, nodeId(module, decl.name, parent));

      for (const member of decl.members) walk(member, parent ? `${parent}.${decl.name}` : decl.name);
    };

    for (const decl of file.decls) walk(decl, undefined);
    const bodies = await functionBodies(module, readFileSync(absolute, "utf8"));
    const points: RunPlan["bodies"][string] = [];

    for (const [position, body] of bodies) {
      const id = byPosition.get(position);

      if (id) points.push({ id, start: body.start, end: body.end, expression: body.expression });
    }

    plan.bodies[absolute] = points;
  }

  // The mocks: a package's content by its name, or by a module that imports it (the Flow tab's storages are modules).
  for (const [name, names] of mockNames) plan.mocks[name] = { content: storages[name] ?? storages[name.replace(/^node:/, "")] ?? null, names: [...names] };

  for (const [key, content] of Object.entries(storages)) {
    if (plan.mocks[key] || !graph.modules.has(key)) continue;

    for (const fact of analysis.facts.get(key)?.imports ?? []) if (plan.mocks[fact.source] && plan.mocks[fact.source]!.content === null) plan.mocks[fact.source]!.content = content;
  }

  if (storages["fetch"] !== undefined) plan.mocks["fetch"] = { content: storages["fetch"], names: [] };
  const directory = join(root, CACHE_DIRECTORY);
  mkdirSync(directory, { recursive: true });
  const planFile = join(directory, `run-${process.pid}-${Date.now()}.json`);
  writeFileSync(planFile, JSON.stringify(plan));
  const here = fileURLToPath(import.meta.url);
  const extension = here.endsWith(".ts") ? ".ts" : ".js";
  const register = join(here, "..", `run-register${extension}`);
  const harness = join(here, "..", `run-harness${extension}`);
  const started = performance.now();

  try {
    return await new Promise<RunResult>((resolveRun) => {
      // The permission model: read anywhere, no writes, no child processes; the hooks thread is a worker and is allowed.
      const child = spawn(process.execPath, ["--permission", "--allow-fs-read=*", "--allow-worker", "--no-warnings", "--import", register, harness], { cwd: root, env: { ...process.env, ARCHDIFF_RUN: planFile }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stderr = `${stderr}${chunk.toString()}`.slice(-4000)));
      const timer = setTimeout(() => child.kill(), timeoutMs + 2000);
      child.on("error", (error) => {
        clearTimeout(timer);
        resolveRun({ ...refuse(error.message), ms: Math.round(performance.now() - started) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const at = stdout.lastIndexOf("@@archdiff-run@@");
        const ms = Math.round(performance.now() - started);

        if (at === -1) {
          const tail = stderr.trim().split("\n").slice(-12).join("\n");

          resolveRun({ ...refuse(`the run gave no report (exit ${code ?? "signal"})${tail ? `: ${tail}` : ""}`), ms, ...(tail ? { stderr: tail } : {}) });

          return;
        }

        const report = JSON.parse(stdout.slice(at + "@@archdiff-run@@".length).split("\n")[0]!) as { events: { kind: string; id?: string; module?: string; member?: string; args?: unknown[]; t: number }[]; result: unknown; error: string | null; ms: number };
        const steps = report.events.filter((event) => event.kind === "enter").map((event, i) => ({ id: event.id!, order: i + 1 }));
        const entered = new Set(steps.map((step) => step.id));
        const storageCalls = report.events.filter((event) => event.kind === "storage").map((event) => ({ module: event.module!, member: event.member!, args: event.args ?? [] }));
        const out: RunResult = { entry, steps, storageCalls, result: report.result, error: report.error, ms, predicted, missed: predicted.filter((id) => !entered.has(id)), unexpected: [...entered].filter((id) => !predicted.includes(id)) };
        const tail = stderr.trim().split("\n").slice(-12).join("\n");

        if (tail) out.stderr = tail;
        resolveRun(out);
      });
    });
  } finally {
    rmSync(planFile, { force: true });
  }
}

/** JSON when it parses, else the text itself (a mock typed by hand). */
function parseLoosely(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** The run as Markdown: the steps in order against the prediction, the storage calls, the result. */
export function runMarkdown(run: RunResult): string {
  const lines = [`<!-- archdiff:generated — run ${run.entry} -->`, `# Run of ${run.entry}`, ""];

  if (run.error) lines.push(`**Error:** ${run.error}`, "");
  lines.push(`${run.steps.length} functions entered in ${run.ms} ms; ${run.storageCalls.length} storage calls; ${run.missed.length} predicted steps not entered, ${run.unexpected.length} entered that the flow did not predict.`, "");

  if (run.steps.length > 0) {
    lines.push("## Steps, as they happened", "");

    for (const step of run.steps) lines.push(`${step.order}. \`${step.id}\`${run.predicted.includes(step.id) ? "" : " — not predicted"}`);
    lines.push("");
  }

  if (run.missed.length > 0) lines.push("## Predicted, not entered", "", ...run.missed.map((id) => `- \`${id}\``), "");

  if (run.storageCalls.length > 0) {
    lines.push("## Storage calls", "");

    for (const call of run.storageCalls) lines.push(`- \`${call.module}\` ${call.member}(${call.args.map((arg) => JSON.stringify(arg)).join(", ")})`);
    lines.push("");
  }

  if (!run.error) lines.push("## Result", "", "```json", JSON.stringify(run.result, null, 2) ?? "undefined", "```", "");

  if (run.stderr) lines.push("## stderr", "", "```", run.stderr, "```", "");

  return `${lines.join("\n").trimEnd()}\n`;
}
