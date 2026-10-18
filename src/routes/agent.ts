// The routes of the agent and the contract: running the agent and
// streaming its events, the saved tasks, "code this", ARCHITECTURE.md
// (read, write, from a document), the check against it, the data flow
// and its mocks.
//
// Entry points: `routes`, by `METHOD /path` (server.ts dispatches through
// it), and `TASKS_DIRECTORY`.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dataFlow, flowMarkdown, jsonInAnswer, mockPrompt, mocksFromTypes } from "../flow.ts";
import { mergePlan, planFromScene, taskMarkdown } from "../plan.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { CACHE_DIRECTORY } from "../cache.ts";
import { drawingSlug } from "../drawings.ts";
import { AGENT_PROTOCOL, checkIntent, checkMarkdown, documentPrompt, INTENT_FILE, intentMarkdown, parseIntent, writeIntent } from "../intent.ts";
import { readDrawing } from "../drawings.ts";
import { isJsonObject, isJsonString, parseJson } from "../json.ts";
import { parseView } from "../views.ts";
import { checkEvents, runChecks } from "../checks.ts";
import { runFlow, runMarkdown } from "../run.ts";
import { failed, json, problem, type RouteContext, type RouteRequest } from "./context.ts";

/** Where the prompts sent to the agent are kept, beside the drawings. */
export const TASKS_DIRECTORY = `${CACHE_DIRECTORY}/tasks`;

/** Keeps a prompt sent to the agent under TASKS_DIRECTORY, named by its view and the time, so it can be read or resent without the page; the file's path. */
function saveTask(root: string, view: string, header: string, prompt: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = `${TASKS_DIRECTORY}/${drawingSlug(view)}-${stamp}.md`;
  mkdirSync(join(root, TASKS_DIRECTORY), { recursive: true });
  writeFileSync(join(root, file), `<!-- archdiff:generated — ${header} -->\n${prompt}\n`);

  return file;
}

export async function postAgentRun(ctx: RouteContext, { body, response, request }: RouteRequest): Promise<void> {
  const { root, agentSpec } = ctx;
  // An explicit request from the page: the prompt as the user saw it; `resume` continues the agent's session.
  if (!agentSpec) return problem(response, 400, "no agent: start with --agent claude|cursor or set \"agent\" in archdiff.json");
  let parsed;

  try {
    parsed = parseJson(body);
  } catch {
    return problem(response, 400, "the body must be JSON");
  }

  if (!isJsonObject(parsed) || !isJsonString(parsed["prompt"]) || parsed["prompt"].trim() === "") return problem(response, 400, '"prompt" is required');
  const resume = isJsonString(parsed["resume"]) ? parsed["resume"] : null;
  const runner = ctx.runner();
  // One run at a time: two agents editing one repository would write over each other, and the page follows one.
  const running = runner.running();

  if (running) return problem(response, 409, `the agent is still running (${running.id}): stop it first`);
  // Every run carries the protocol: the contract file, how to ask the user; a resumed session already has it.
  const run = runner.start(resume ? parsed["prompt"] : `${parsed["prompt"].trimEnd()}\n\n${AGENT_PROTOCOL}\n`, resume);
  // The agent edits the repository: the next request analyses afresh, however soon it comes.
  run.subscribe(0, (event) => {
    if (event.kind === "exit") ctx.invalidate();
  });
  // The task as sent, kept beside the drawings.
  const file = saveTask(root, isJsonString(parsed["view"]) ? parsed["view"] : "chat", `task for ${agentSpec.name}, run ${run.id}`, parsed["prompt"]);

  return json(response, { id: run.id, agent: agentSpec.name, task: file });
}

export async function postCode(ctx: RouteContext, { body, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // "code this": the drawing of a view folded into ARCHITECTURE.md first (so it is the contract before it is code), then the task for the agent.
  let parsed;

  try {
    parsed = parseJson(body);
  } catch {
    return problem(response, 400, "the body must be JSON");
  }

  const key = isJsonObject(parsed) && isJsonString(parsed["view"]) ? parsed["view"] : "";

  if (!parseView(key)) return problem(response, 400, "unknown view");
  const analysis = await ctx.fresh();
  const saved = readDrawing(root, key);
  const plan = planFromScene(analysis, key, saved?.elements ?? []);
  const intent = mergePlan(analysis.intent ?? parseIntent(""), plan, analysis.graph);
  writeIntent(root, intent);
  ctx.invalidate();
  const after = await ctx.fresh();
  const report = checkIntent(after, intent);
  const task = [taskMarkdown(plan, after).trimEnd(), "", `## The contract`, "", `${INTENT_FILE} now holds what was drawn. Build what it names and the code does not have yet:`, "", ...report.planned.map((item) => `- \`${item}\``), ...report.plannedEdges.map((item) => `- ${item}`), "", "Keep every import within the arrows of the contract; add an arrow there when one is truly needed and say why."].join("\n");

  return json(response, { markdown: `${task}\n`, intent: intentMarkdown(intent), planned: report.planned.length + report.plannedEdges.length });
}

export async function postIntentDocument(ctx: RouteContext, { body, response }: RouteRequest): Promise<void> {
  const { root, agentSpec } = ctx;
  // A document that holds a flowchart is kept as it is; one in prose becomes the intent through the agent, which writes the Mermaid.
  let parsed;

  try {
    parsed = parseJson(body);
  } catch {
    return problem(response, 400, "the body must be JSON");
  }

  if (!isJsonObject(parsed) || !isJsonString(parsed["text"]) || parsed["text"].trim() === "") return problem(response, 400, '"text" is required');
  const analysis = await ctx.fresh();
  const direct = parseIntent(parsed["text"]);

  if (direct.modules.length === 0 && !agentSpec) return problem(response, 400, "no agent: the document holds no Mermaid flowchart to keep, and writing one from prose needs an agent (start with --agent claude|cursor or set \"agent\" in archdiff.json)");
  let intent = direct;

  if (direct.modules.length === 0 && agentSpec) {
    const prompt = documentPrompt(parsed["text"], analysis.files.some((file) => file.endsWith(".ts")) ? "ts" : null);
    saveTask(root, "intent", `task for ${agentSpec.name}: the contract from a document`, prompt);
    intent = parseIntent(await ctx.runner().runToResult(prompt, 300_000));
  }

  if (intent.modules.length === 0) return problem(response, 502, "the agent gave no Mermaid flowchart; try again or write the block by hand");
  // The document's prose becomes the file's prose when the file had none of its own.
  const final = direct.modules.length > 0 ? intent : { ...intent, before: analysis.intent?.before.trim() ? analysis.intent.before : `# Architecture\n\n${parsed["text"].trim().slice(0, 2000)}\n\n` };
  writeIntent(root, final);
  ctx.invalidate();

  return json(response, { file: INTENT_FILE, source: direct.modules.length > 0 || !agentSpec ? "document" : agentSpec.name, layers: final.layers.length, modules: final.modules.length, edges: final.edges.length, markdown: intentMarkdown(final) });
}

export async function postFlowMocks(ctx: RouteContext, { body, response }: RouteRequest): Promise<void> {
  const { agentSpec } = ctx;
  // Mocks for a calls view: from the agent (with the user's description) when there is one and it answers JSON, else from the types.
  let parsed;

  try {
    parsed = parseJson(body);
  } catch {
    return problem(response, 400, "the body must be JSON");
  }

  const key = isJsonObject(parsed) && isJsonString(parsed["view"]) ? parsed["view"] : "";
  const view = parseView(key);

  if (!view || view.kind !== "calls") return problem(response, 400, "the mocks need a calls: view");
  const description = isJsonObject(parsed) && isJsonString(parsed["description"]) ? parsed["description"] : "";
  const analysis = await ctx.fresh();
  const flow = dataFlow(analysis, view.subject, [], 4);
  const typed = mocksFromTypes(flow);

  if (!agentSpec) return json(response, { source: "types", ...typed });
  const prompt = mockPrompt(flow, description);
  saveTask(ctx.root, key, `task for ${agentSpec.name}: mocks of the flow`, prompt);
  const answer = jsonInAnswer(await ctx.runner().runToResult(prompt));

  if (!answer) return json(response, { source: "types", note: "the agent gave no JSON; the types did", ...typed });

  return json(response, { source: agentSpec.name, input: answer.input ?? typed.input, storages: answer.storages ?? typed.storages });
}

export async function postFlowRun(ctx: RouteContext, { body, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // A real run of a calls view's entry with the saved mocks (and any given here), for the Flow tab's ▶ run.
  let parsed;

  try {
    parsed = parseJson(body);
  } catch {
    return problem(response, 400, "the body must be JSON");
  }

  const key = isJsonObject(parsed) && isJsonString(parsed["view"]) ? parsed["view"] : "";
  const view = parseView(key);

  if (!view || view.kind !== "calls") return problem(response, 400, "the run needs a calls: view");
  const analysis = await ctx.fresh();
  const options: Parameters<typeof runFlow>[2] = { mocks: readDrawing(root, key)?.mocks ?? [] };

  if (isJsonObject(parsed) && isJsonObject(parsed["input"])) options.input = parsed["input"];

  if (isJsonObject(parsed) && isJsonObject(parsed["storages"])) options.storages = parsed["storages"];
  const result = await runFlow(analysis, view.subject, options);

  if (!result.ok) return failed(response, result);

  return json(response, { run: result.value, markdown: runMarkdown(result.value) });
}

export async function postChecks(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  // The checks on request: the contract, then archdiff.json's commands, as the run's events would carry them.
  ctx.invalidate();
  const results = await runChecks(await ctx.fresh());

  return json(response, { results, events: checkEvents(results) });
}

export async function postAgentStop(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const id = url.searchParams.get("id") ?? "";
  const run = ctx.activeRunner()?.runs.get(id);

  if (!run) return problem(response, 404, "no such run");
  run.stop();

  return json(response, { stopped: id });
}

export async function getFlow(ctx: RouteContext, { url, response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // The data-flow of a calls view: the saved mocks of the view carried through the call tree.
  const key = url.searchParams.get("view") ?? "";
  const view = parseView(key);

  if (!view || view.kind !== "calls") return problem(response, 400, "the flow needs a calls: view");
  const depthText = url.searchParams.get("depth");
  const depth = depthText === null || depthText === "" ? 4 : Number(depthText);

  if (!(Number.isInteger(depth) && depth >= 0)) return problem(response, 400, "depth must be a whole number, 0 or more");
  const analysis = await ctx.fresh();

  if (!analysis.graph.nodes.has(view.subject)) return problem(response, 404, `no function "${view.subject}"`);
  const flow = dataFlow(analysis, view.subject, readDrawing(root, key)?.mocks ?? [], depth);

  return json(response, { flow, markdown: flowMarkdown(flow) });
}

export async function getIntent(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  const analysis = await ctx.fresh();

  return json(response, { exists: analysis.intent !== null, markdown: analysis.intent ? intentMarkdown(analysis.intent) : "", file: INTENT_FILE });
}

export async function getCheck(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  const analysis = await ctx.fresh();

  if (!analysis.intent) return json(response, { exists: false, markdown: `# Check\n\nNo ${INTENT_FILE}: draw on the intent view and run "code this", import a document, or \`archdiff intent --init\`.\n`, ok: true });
  const report = checkIntent(analysis, analysis.intent);

  return json(response, { exists: true, ok: report.ok, report, markdown: checkMarkdown(report, root) });
}

export async function getAgentEvents(ctx: RouteContext, { url, response, request }: RouteRequest): Promise<void> {
  // Server-sent events of a run from `after`, until it ends.
  const id = url.searchParams.get("id") ?? "";
  const run = ctx.activeRunner()?.runs.get(id);

  if (!run) return problem(response, 404, "no such run");
  const after = Number(url.searchParams.get("after") ?? "0");
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  const unsubscribe = run.subscribe(Number.isInteger(after) && after >= 0 ? after : 0, (event) => {
    response.write(`data: ${JSON.stringify(event)}\n\n`);

    if (event.kind === "exit") response.end();
  });
  request.on("close", unsubscribe);

  if (run.done) response.end();

  return;
}

export async function getTasks(ctx: RouteContext, { response }: RouteRequest): Promise<void> {
  const { root } = ctx;
  // The tasks sent to the agent so far, newest first, with their first lines.
  const directory = join(root, TASKS_DIRECTORY);
  const { readdirSync } = await import("node:fs");
  const files = existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(".md")).sort().reverse() : [];

  return json(response, { tasks: files.map((name) => ({ file: `${TASKS_DIRECTORY}/${name}`, head: readFileSync(join(directory, name), "utf8").split("\n").slice(1, 4).join(" ").slice(0, 200) })) });
}

/** The handlers by `METHOD /path`. */
export const routes: Record<string, (ctx: RouteContext, request: RouteRequest) => Promise<void>> = {
  "POST /api/agent/run": postAgentRun,
  "POST /api/code": postCode,
  "POST /api/intent/document": postIntentDocument,
  "POST /api/flow/mocks": postFlowMocks,
  "POST /api/agent/stop": postAgentStop,
  "POST /api/checks": postChecks,
  "POST /api/flow/run": postFlowRun,
  "GET /api/flow": getFlow,
  "GET /api/intent": getIntent,
  "GET /api/check": getCheck,
  "GET /api/agent/events": getAgentEvents,
  "GET /api/tasks": getTasks,
};
