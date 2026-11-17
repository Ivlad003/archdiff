// The settings window: the agents as this computer has them — where each
// one's program was found or why it was not, the program and the model the
// user places for it, agents of the user's own — and the keys the agents
// run with. It is the page's face of the user's own file (the server's
// settings.ts): every change is sent at once and the window is drawn again
// from the answer, so it always shows what the file holds and whether an
// agent runs as placed. A key's value is typed here and never shown again.
//
// Opens from the Chat tab's button; Escape, ✕ and a press outside close it.
// Entry points: `splitCommand`, `joinCommand` (a command as one line).

import { api, type SettingsAgent, type SettingsView } from "./api.ts";
import { loadAgents } from "./chat.ts";
import { element, h } from "./dom.ts";

const dialog = element<HTMLDialogElement>("settings");
const note = element("settings-note");

/** What the window shows now: the server's last answer. */
let view: SettingsView | null = null;

/** A command typed as one line, in words: spaces part them, "double quotes" keep a word with spaces whole, and a backslash is itself (a Windows path). */
export function splitCommand(line: string): string[] {
  return [...line.matchAll(/(?:"[^"]*"|[^\s"])+/g)].map((word) => word[0].replace(/"/g, ""));
}

/** A command as one line that `splitCommand` reads back. */
export function joinCommand(command: readonly string[]): string {
  return command.map((word) => (word === "" || /\s/.test(word) ? `"${word}"` : word)).join(" ");
}

function say(text: string, wrong = false): void {
  note.textContent = text;
  note.classList.toggle("wrong", wrong);
}

/** Sends a change, draws the window from the answer and has the Chat tab's picker read the agents again; a refusal is said and nothing redrawn, so what was typed can be corrected. Whether it was kept. */
async function change(payload: Parameters<typeof api.changeSettings>[0], done: string): Promise<boolean> {
  try {
    show(await api.changeSettings(payload));
    say(done);
    void loadAgents();

    return true;
  } catch (error) {
    say(`⚠ ${error instanceof Error ? error.message : String(error)}`, true);

    return false;
  }
}

/** The built-in agents as the window's fields have them now. */
function placedAgents(): Record<string, { command: string; model: string; openrouter: boolean }> {
  const placed: Record<string, { command: string; model: string; openrouter: boolean }> = {};

  for (const row of element("settings-agents").querySelectorAll<HTMLElement>(".agent[data-from='built-in']")) {
    placed[row.dataset["agent"]!] = {
      command: row.querySelector<HTMLInputElement>(".agent-command")!.value.trim(),
      model: row.querySelector<HTMLInputElement>(".agent-model")!.value.trim(),
      openrouter: row.querySelector<HTMLInputElement>(".agent-openrouter")?.checked ?? false,
    };
  }

  return placed;
}

/** The user's own agents as the server last listed them. */
function ownAgents(): { name: string; command: string[]; protocol: string; resume: string | null }[] {
  return (view?.agents ?? []).filter((agent) => agent.from === "settings").map((agent) => ({ name: agent.name, command: agent.command as string[], protocol: agent.protocol, resume: agent.resume }));
}

/** Whether an agent can run here, said in a line: the program started for it, or why none is. */
function standing(agent: SettingsAgent): HTMLElement {
  return agent.installed ? h("span", { class: "found", title: "What is started for it" }, `✓ ${agent.path ?? ""}`) : h("span", { class: "missing" }, `✗ ${agent.problem ?? "not installed"}`);
}

function agentRow(agent: SettingsAgent): HTMLElement {
  const savePlaced = (): void => void change({ agents: placedAgents() }, `${agent.label}: kept`);

  if (agent.from !== "built-in") {
    return h(
      "div",
      { class: "agent", dataset: { agent: agent.name, from: agent.from } },
      h(
        "div",
        { class: "agent-head" },
        h("strong", {}, agent.label),
        h("span", { class: "muted" }, agent.from === "server" ? "from archdiff.json or --agent" : `${agent.protocol}${agent.resume ? `, resumes by ${agent.resume}` : ""}`),
        agent.from === "settings" && h("button", { class: "small", title: "Take this agent out of the settings", on: { click: () => void change({ custom: ownAgents().filter((own) => own.name !== agent.name) }, `${agent.name}: removed`) } }, "remove"),
      ),
      h("code", {}, joinCommand(agent.command as string[])),
      standing(agent),
    );
  }

  return h(
    "div",
    { class: "agent", dataset: { agent: agent.name, from: agent.from } },
    h("div", { class: "agent-head" }, h("strong", {}, agent.label), standing(agent)),
    h(
      "div",
      { class: "row" },
      h("label", { class: "wide", title: "The program itself, when it is not found by its name: its full path" }, "program ", h("input", { class: "agent-command", type: "text", value: (agent.command as string | null) ?? "", placeholder: `found by its name: ${agent.program ?? ""}`, on: { change: savePlaced } })),
      h("label", { class: "wide", title: "The model it is told to use; empty: its own" }, "model ", h("input", { class: "agent-model", type: "text", value: agent.model ?? "", placeholder: agent.name === "opencode" ? "its own, or openrouter/…" : "its own", on: { change: savePlaced } })),
      agent.openrouter !== null && h("label", { title: "Run Claude Code on OpenRouter's key (OPENROUTER_API_KEY) instead of Anthropic's own" }, h("input", { class: "agent-openrouter", type: "checkbox", checked: agent.openrouter, on: { change: savePlaced } }), "through OpenRouter"),
    ),
  );
}

/** Draws the window from the server's answer; the field the reader is in keeps the focus, though its row is drawn anew. */
function show(next: SettingsView): void {
  view = next;
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && active.closest(".agent") ? { agent: active.closest<HTMLElement>(".agent")!.dataset["agent"] ?? "", field: active.classList[0] ?? "" } : null;
  element("settings-file").textContent = next.file;
  const broken = element("settings-problem");
  broken.textContent = next.problem ?? "";
  broken.hidden = next.problem === null;
  element("settings-agents").replaceChildren(...next.agents.map(agentRow));

  if (focused && focused.field !== "") [...element("settings-agents").querySelectorAll<HTMLElement>(`.${focused.field}`)].find((field) => field.closest<HTMLElement>(".agent")?.dataset["agent"] === focused.agent)?.focus();
  const set = new Set(next.keys.map((key) => key.name));
  element("settings-keys").replaceChildren(
    ...next.keys.map((key) =>
      h(
        "div",
        { class: "key", dataset: { key: key.name } },
        h("code", {}, key.name),
        h("span", { class: "muted" }, key.empty ? "set, empty" : `set ${key.hint}`.trimEnd()),
        h("button", { class: "small", title: "Take this key out of the settings", on: { click: () => void change({ keys: { [key.name]: null } }, `${key.name}: forgotten`) } }, "forget"),
      ),
    ),
    // A key the server was started with reaches the agents too: said, so that nobody types it a second time.
    ...next.known.filter((key) => key.environment && !set.has(key.name)).map((key) => h("div", { class: "key" }, h("code", {}, key.name), h("span", { class: "muted" }, "from the environment archdiff was started in"))),
  );
  element("key-names").replaceChildren(...next.known.map((key) => h("option", { value: key.name })));
}

async function open(): Promise<void> {
  say("");

  try {
    show(await api.settings());
  } catch (error) {
    // Asked from another computer: the window says so and holds nothing.
    const broken = element("settings-problem");
    broken.textContent = error instanceof Error ? error.message : String(error);
    broken.hidden = false;
  }

  if (!dialog.open) dialog.showModal();
}

element("settings-open").addEventListener("click", () => void open());
element("settings-close").addEventListener("click", () => dialog.close());
// A press on the veil around the window: the dialog itself is the target then, not what is in it.
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

const keyName = element<HTMLInputElement>("key-name");
const keyValue = element<HTMLInputElement>("key-value");

async function setKey(): Promise<void> {
  const name = keyName.value.trim();

  if (name === "") return say("⚠ name the key: the environment variable the agent reads it from", true);

  if (await change({ keys: { [name]: keyValue.value.trim() } }, `${name}: set`)) {
    keyName.value = "";
    keyValue.value = "";
  }
}

element("key-set").addEventListener("click", () => void setKey());
keyValue.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void setKey();
});

const ownName = element<HTMLInputElement>("own-name");
const ownCommand = element<HTMLInputElement>("own-command");
const ownResume = element<HTMLInputElement>("own-resume");

async function addOwn(): Promise<void> {
  const added = { name: ownName.value.trim(), command: splitCommand(ownCommand.value), protocol: element<HTMLSelectElement>("own-protocol").value, resume: ownResume.value.trim() || null };

  if (await change({ custom: [...ownAgents(), added] }, `${added.name}: added`)) {
    ownName.value = "";
    ownCommand.value = "";
    ownResume.value = "";
  }
}

element("own-add").addEventListener("click", () => void addOwn());
ownCommand.addEventListener("keydown", (event) => {
  if (event.key === "Enter") void addOwn();
});
