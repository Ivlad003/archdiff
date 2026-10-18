// The Spec tab: the repository's OpenSpec specs and Gherkin features,
// listed and shown; *spec this view* and *review all specs* hand the
// agent the task (through the Chat tab); *validate* runs the OpenSpec
// CLI. Takes the page as its context (page.ts).

import { api } from "./api.ts";
import { agentNameOf, runState, runTask, taskField } from "./chat.ts";
import { element } from "./dom.ts";
import { page } from "./page.ts";
import { currentLink } from "./link.ts";

/** The text of the open spec, for the copy button. */
export function specTextOf(): string {
  return specText;
}

/** The text of the spec shown, for copy. */
let specText = "";

/** The Markdown of the flow shown, for copy. */

/** Lists the specs and features of the repository and shows the picked one. */
export async function loadSpecs(): Promise<void> {
  const list = element<HTMLSelectElement>("spec-list");
  const state = element<HTMLSpanElement>("spec-state");
  const picked = list.value;

  try {
    const { initialised, specs } = await api.specs();
    list.replaceChildren();

    for (const spec of specs) list.append(new Option(`${spec.kind === "openspec" ? "spec" : "feature"}: ${spec.title}`, spec.path, false, spec.path === picked));
    list.hidden = specs.length === 0;
    state.textContent = specs.length === 0 ? (initialised ? "no specs yet: spec this view, or review all" : "no openspec/ yet: the first run creates it") : `${specs.length} files`;

    if (specs.length > 0) await showSpec(list.value);
    else {
      specText = "";
      element<HTMLDivElement>("spec-text").replaceChildren();
    }
  } catch (error) {
    state.textContent = error instanceof Error ? error.message : String(error);
  }
}

/** Shows one spec: Markdown rendered, a feature as text. */
async function showSpec(path: string): Promise<void> {
  const target = element<HTMLDivElement>("spec-text");

  try {
    const { text } = await api.spec(path);
    specText = text;

    if (path.endsWith(".feature")) target.replaceChildren(Object.assign(document.createElement("pre"), { textContent: text }));
    else page.renderMarkdown(target, text);
  } catch (error) {
    target.textContent = error instanceof Error ? error.message : String(error);
  }
}

element<HTMLSelectElement>("spec-list").addEventListener("change", () => void showSpec(element<HTMLSelectElement>("spec-list").value));

/** Puts the agent's spec task in the Chat tab and runs it there; the Spec tab reloads when the run ends. */
async function specTask(mode: "generate" | "update"): Promise<void> {
  const state = element<HTMLSpanElement>("spec-state");

  try {
    const view = currentLink().view;
    const { markdown } = await api.specPrompt(mode, mode === "generate" && view.includes(":") ? view : null);
    taskField.value = markdown;
    page.showTab("chat");

    if (agentNameOf()) runTask(markdown, null);
    else runState.textContent = "no agent: the task is in the box; start web with --agent claude to run it, or copy it";
  } catch (error) {
    state.textContent = error instanceof Error ? error.message : String(error);
  }
}

element<HTMLButtonElement>("spec-generate").addEventListener("click", () => void specTask("generate"));
element<HTMLButtonElement>("spec-update").addEventListener("click", () => void specTask("update"));
element<HTMLButtonElement>("spec-validate").addEventListener("click", () => {
  const state = element<HTMLSpanElement>("spec-state");
  state.textContent = "validating…";
  void api
    .validateSpecs()
    .then((result) => {
      state.textContent = result.ok ? "valid" : "problems";
      element<HTMLDivElement>("spec-text").replaceChildren(Object.assign(document.createElement("pre"), { textContent: result.output }));
      specText = result.output;
    })
    .catch((error: unknown) => (state.textContent = error instanceof Error ? error.message : String(error)));
});
