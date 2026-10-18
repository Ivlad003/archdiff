// The Flow tab: the data flow of a calls view with its mocks (an input
// for the entry, a content per storage, carried by name), the mocks
// generated from the types or by the agent, ▶ play (the predicted steps
// lit one by one) and ▶ run (the entry run for real with the storages
// mocked). Takes the page as its context (page.ts).
//
// Entry points: `loadFlow`, `flowText`, `textarea`.

import { api } from "./api.ts";
import { element } from "./dom.ts";
import { page } from "./page.ts";
import { currentLink } from "./link.ts";
import { agentNameOf } from "./chat.ts";
import { parseView } from "../../src/view-keys.ts";

/** The entry point a calls view starts from (`calls:<path>#<fn>`), or null on any other view. */
function entryOf(key: string): string | null {
  const view = parseView(key);

  return view?.kind === "calls" ? view.subject : null;
}

/** The Markdown of the flow (and of the last run), for the copy button. */
let flowMarkdown = "";

export function flowText(): string {
  return flowMarkdown;
}

const flowMocks = element<HTMLDivElement>("flow-mocks");
const flowSteps = element<HTMLDivElement>("flow-steps");

export function textarea(label: string, value: string, placeholder: string): HTMLTextAreaElement {
  const field = document.createElement("textarea");
  field.value = value;
  field.placeholder = placeholder;
  const caption = document.createElement("label");
  caption.textContent = label;
  flowMocks.append(caption, field);

  return field;
}

let lastFlow: import("./api.ts").FlowResponse["flow"] | null = null;
let mockInput: HTMLTextAreaElement | null = null;
let mockStorages: { id: string; field: HTMLTextAreaElement }[] = [];

/** The flows asked for: one that comes after a newer picture's is dropped, so the tab is the picture's own. */
let flowLoads = 0;

export async function loadFlow(): Promise<void> {
  const mine = ++flowLoads;
  const state = currentLink();
  // Another picture: no steps, mocks or run of the last one stay.
  flowMocks.replaceChildren();
  flowSteps.replaceChildren();
  element("flow-run-result").replaceChildren();
  lastFlow = null;
  flowMarkdown = "";
  element("flow-tab").hidden = entryOf(state.view) === null;

  if (element("flow-tab").hidden) {
    // Its panel goes with its tab: the picture's page shows instead.
    if (element("flow").classList.contains("active")) page.showTab("markdown");

    return;
  }

  const { flow, markdown } = await api.flow(state.view, state.depth);

  if (mine !== flowLoads) return;
  lastFlow = flow;
  flowMarkdown = markdown;
  const entryId = entryOf(state.view)!;
  const input = textarea(`Mock input of ${entryId.slice(entryId.indexOf("#") + 1)} (JSON object: a key per parameter)`, flow.input ?? "", '{"request": {"total": 42}}');
  const storageFields = flow.storages.map((storage) => ({ id: storage.id, field: textarea(`Mock content of ${storage.module} (${storage.storage})`, storage.content ?? "", '{"rows": [{"id": 1}]}') }));
  mockInput = input;
  mockStorages = storageFields;
  const apply = document.createElement("button");
  apply.textContent = "apply mocks";
  apply.title = "Save the mocks with the drawing of this view and carry the values through the steps";
  apply.addEventListener("click", () => {
    const next: unknown[] = [];

    if (input.value.trim() !== "") next.push({ id: entryId, kind: "input", value: input.value.trim() });

    for (const { id, field } of storageFields) if (field.value.trim() !== "") next.push({ id, kind: "storage", value: field.value.trim() });
    page.setMocks(next);
    const canvas = page.canvas();
    void (canvas ? api.saveDrawing(state.view, canvas.scene(), page.mocks()) : Promise.resolve()).then(() => loadFlow()).catch((error: unknown) => (flowSteps.textContent = error instanceof Error ? error.message : String(error)));
  });
  flowMocks.append(apply);

  for (const step of flow.steps) {
    const box = document.createElement("div");
    box.className = `step${step.storage ? " storage" : ""}`;
    box.dataset["id"] = step.id;
    box.style.marginLeft = `${step.depth * 14}px`;
    const head = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = step.name;
    name.style.cursor = "pointer";
    name.title = "Show the code";
    name.addEventListener("click", () => void page.showCode({ id: step.id, kind: "fn", label: step.name, ref: { id: step.id, file: step.module, line: step.line }, x: 0, y: 0, w: 0, h: 0 }));
    head.append(name, "(");

    for (const [i, param] of step.params.entries()) {
      if (i > 0) head.append(", ");
      head.append(`${param.name}: ${param.type}`);

      if (param.value !== undefined) {
        const value = document.createElement("span");
        value.className = "value";
        value.textContent = ` = ${param.value}`;
        value.title = `from ${param.from ?? ""}`;
        head.append(value);
      }
    }

    head.append(`)${step.returns ? ` → ${step.returns}` : ""}`);
    const where = document.createElement("div");
    where.className = "where";
    where.textContent = `${step.module}:${step.line}${step.storage ? ` · storage: ${step.storage}${step.content !== undefined ? ` holds ${step.content}` : ""}` : ""}${step.gaps > 0 ? ` · ${step.gaps} calls not followed` : ""}`;
    box.append(head, where);
    flowSteps.append(box);
  }

  if (flow.steps.length === 0) flowSteps.textContent = "No such function in the graph.";
}

/** Mocks for the entry and the storages: the agent with the description when there is one, else the types; the fields are filled, not saved. */
async function generateMocks(): Promise<void> {
  const state = currentLink();
  const note = element<HTMLInputElement>("mock-description");

  if (entryOf(state.view) === null || !mockInput) return;
  note.disabled = true;
  flowSteps.prepend(Object.assign(document.createElement("div"), { className: "muted", id: "mock-note", textContent: "generating mocks…" }));

  try {
    const result = await api.mocks(state.view, note.value, agentNameOf());
    mockInput.value = JSON.stringify(result.input, null, 2);

    for (const { id, field } of mockStorages) if (result.storages[id] !== undefined) field.value = JSON.stringify(result.storages[id], null, 2);
    element("mock-note").textContent = `mocks from ${result.source}${result.note ? ` (${result.note})` : ""}; apply to carry them through the steps`;
  } catch (error) {
    element("mock-note").textContent = error instanceof Error ? error.message : String(error);
  } finally {
    note.disabled = false;
  }
}

/** Plays the steps of the flow on the diagram: each step's shape lights up in turn, its row in the panel too, as a run would pass through them. */
async function playFlow(): Promise<void> {
  const state = currentLink();

  if (!lastFlow || !page.canvas() || entryOf(state.view) === null) return;
  const button = element<HTMLButtonElement>("flow-play");
  button.disabled = true;
  page.showTab("flow");
  // The steps are of this picture: another one opened stops the play, and its lights are left alone.
  const playing = state.view;
  const here = (): boolean => currentLink().view === playing;

  try {
    for (const step of lastFlow.steps) {
      if (!here()) break;
      page.canvas()?.highlight([step.id]);

      for (const row of flowSteps.querySelectorAll<HTMLElement>(".step")) row.classList.toggle("playing", row.dataset["id"] === step.id);
      flowSteps.querySelector<HTMLElement>(".step.playing")?.scrollIntoView({ block: "nearest" });
      await new Promise((resolve) => setTimeout(resolve, 700));
    }
  } finally {
    if (here()) page.canvas()?.highlight([]);

    for (const row of flowSteps.querySelectorAll<HTMLElement>(".step")) row.classList.remove("playing");
    button.disabled = false;
  }
}

element<HTMLButtonElement>("mock-generate").addEventListener("click", () => void generateMocks());
element<HTMLButtonElement>("flow-play").addEventListener("click", () => void playFlow());

/** The entry run for real: the functions it entered light up green, the predicted ones it missed dim; the report goes under the steps. */
async function runFlowNow(): Promise<void> {
  const state = currentLink();

  if (entryOf(state.view) === null) return;
  const button = element<HTMLButtonElement>("flow-run");
  const panel = element<HTMLDivElement>("flow-run-result");
  button.disabled = true;
  panel.textContent = "running…";
  page.showTab("flow");

  try {
    const { run, markdown } = await api.runFlow(state.view);
    flowMarkdown = `${flowMarkdown}\n\n${markdown}`;
    page.renderMarkdown(panel, markdown);
    const entered = run.steps.map((step) => step.id);

    if (page.canvas()) {
      page.canvas()?.highlight(entered, "#66bb6a");
      page.canvas()?.dim(entered.length > 0 ? [...entered, ...run.unexpected] : null);
    }

    for (const row of flowSteps.querySelectorAll<HTMLElement>(".step")) {
      row.classList.toggle("entered", entered.includes(row.dataset["id"] ?? ""));
      row.classList.toggle("missed", run.missed.includes(row.dataset["id"] ?? ""));
    }
  } catch (error) {
    panel.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
}

element<HTMLButtonElement>("flow-run").addEventListener("click", () => void runFlowNow());
