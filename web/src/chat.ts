// The Chat tab: the task drawn on the view, and the agent that does it —
// the run with its streamed events (a turn is the question, its steps
// folded under a summary, and the answer rendered), the question protocol
// (an archdiff-question block becomes option buttons, an answer resumes
// the session), the @tags expanded into context, a question about the
// picture or the selected shapes (answered without edits), the slash
// commands, the checks after a run, the document that becomes the
// contract, and the previous tasks. Takes the page as its context
// (page.ts).

import { api } from "./api.ts";
import { element, h } from "./dom.ts";
import { page } from "./page.ts";
import { reviewing, setLink, currentLink } from "./link.ts";
import { pictureQueryText } from "../../src/options.ts";

export const taskField = element<HTMLTextAreaElement>("task");
export const runButton = element<HTMLButtonElement>("run");
const stopButton = element<HTMLButtonElement>("stop");
export const runState = element<HTMLSpanElement>("run-state");
export const transcript = element<HTMLDivElement>("transcript");
const followup = element<HTMLInputElement>("followup");
let agentName: string | null = null;
let currentRun: { id: string; close: () => void; sessionId: string | null } | null = null;

/** The turn being written: the question's row, its steps folded under a summary, and the answer. */
let turn: { steps: HTMLDetailsElement; summary: HTMLElement; count: number; answer: HTMLDivElement; lastText: string; answered: boolean } | null = null;

function row(kind: string, text: string): HTMLDivElement {
  return h("div", { class: `ev ${kind}${kind === "check" && text.startsWith("✘") ? " failed" : ""}` }, text);
}

/** The answer of the turn, rendered as Markdown under its folded steps. */
function showAnswer(text: string): void {
  if (!turn) return;
  turn.answered = true;
  turn.answer.className = "answer ev result";
  page.renderMarkdown(turn.answer, text);
  turn.summary.textContent = `${turn.count} ${turn.count === 1 ? "step" : "steps"} (tools, thoughts) — click to unfold`;
}

/**
 * One event of a run in the transcript: the question opens a turn; tool
 * calls, thoughts and noise go under its folded summary (which names the
 * latest); the result is the answer, shown; the checks and the exit stand
 * below it. The text is kept in `.ev` rows for the copy button.
 */
function appendEvent(kind: string, text: string): void {
  if (kind === "you") {
    const summary = h("summary", {}, "working…");
    const steps = h("details", { class: "steps" }, summary);
    const answer = h("div", { class: "answer" });
    transcript.append(row("you", text), steps, answer);
    turn = { steps, summary, count: 0, answer, lastText: "", answered: false };
  } else if (turn && kind === "result") {
    // The result is the answer, shown in full; an empty one leaves the last text as the answer at the exit.
    if (text.trim() !== "") showAnswer(text);
  } else if (turn && kind !== "check" && kind !== "exit") {
    turn.steps.append(row(kind, text));
    turn.count++;
    const line = text.split("\n")[0] ?? "";
    turn.summary.textContent = `${turn.count} ${turn.count === 1 ? "step" : "steps"} · ${line.length > 90 ? `${line.slice(0, 90)}…` : line}`;

    if (kind === "text") turn.lastText = text;
  } else {
    // The exit without a result (a custom agent): the last text is the answer.
    if (turn && kind === "exit" && !turn.answered && turn.lastText) showAnswer(turn.lastText);
    transcript.append(row(kind, text));
  }

  transcript.scrollTop = transcript.scrollHeight;
}

/** The contract and the configured checks, run now and shown in the transcript. */
async function runChecksNow(): Promise<void> {
  const button = element<HTMLButtonElement>("checks");
  button.disabled = true;
  runState.textContent = "running the checks…";

  try {
    const { events } = await api.runChecks();

    for (const event of events) appendEvent(event.kind, event.text);
    runState.textContent = events.length === 0 ? "no checks: no ARCHITECTURE.md and no \"checks\" in archdiff.json" : events.every((event) => event.text.startsWith("✔")) ? "every check passed" : "a check failed; see the transcript";
    page.showTab("chat");
  } catch (error) {
    runState.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    button.disabled = false;
  }
}

element<HTMLButtonElement>("checks").addEventListener("click", () => void runChecksNow());

/** The shapes of the current diagram that stand for `files` (a path, or its end), to light while the agent works on them. */
function shapesOfFiles(files: readonly string[]): string[] {
  const ids: string[] = [];

  for (const node of page.nodes().values()) {
    const file = node.ref?.file;

    if (!file) continue;

    if (files.some((candidate) => candidate === file || candidate.endsWith(`/${file}`))) ids.push(node.id);
  }

  return ids;
}

/** Tags in a text (@module:…, @fn:…, @layer:…, @dir:…, @flow:…, @type:…, @logic:…, @view:…) become their context for the agent; @view: takes the picture's options. */
async function withContext(prompt: string): Promise<string> {
  if (!/@(module|fn|layer|dir|flow|type|logic|view):\S/.test(prompt)) return prompt;

  try {
    const context = await api.expand(prompt, pictureQueryText(currentLink()).replace(/^&/, ""));

    return context ? `${prompt}\n\n${context}` : prompt;
  } catch {
    return prompt;
  }
}

// ── A question about the picture or the selected shapes ──────────────────────

const askInput = element<HTMLInputElement>("ask");
let askSubjects: { tag: string; label: string }[] = [];

function renderAskAbout(): void {
  const box = element<HTMLDivElement>("ask-about");
  box.replaceChildren();
  box.hidden = askSubjects.length === 0;

  if (box.hidden) return;
  box.append("about: ");

  for (const subject of askSubjects) {
    box.append(h("span", { class: "chip", title: subject.tag }, subject.label, h("button", { title: "Leave it out", on: { click: () => {
      askSubjects = askSubjects.filter((each) => each.tag !== subject.tag);
      renderAskAbout();
    } } }, "×")));
  }
}

/** Puts the shapes in the question box ("about: …") and opens the Chat tab on it; an empty list asks about the picture alone. */
export function askAbout(subjects: { tag: string; label: string }[]): void {
  const seen = new Set<string>();
  askSubjects = subjects.filter((subject) => !seen.has(subject.tag) && seen.add(subject.tag));
  renderAskAbout();
  page.showTab("chat");
  askInput.focus();
}

/**
 * Sends the question to the agent with its subjects as tags (expanded into
 * their Markdown by `withContext`) and, when the box is ticked, the picture
 * itself as `@view:`; the agent is told to answer, not to edit. Without an
 * agent the question with its context goes into the task box, to be copied.
 */
function askQuestion(): void {
  const question = askInput.value.trim();

  if (question === "") return;
  const state = currentLink();
  const picture = element<HTMLInputElement>("ask-picture").checked && !reviewing(state.view);
  const about = askSubjects.length > 0 ? `\n\nIt is about: ${askSubjects.map((subject) => `${subject.label} (${subject.tag})`).join(", ")}.` : "";
  const prompt = `Answer the question below about this repository: read the code you need, and change no file.\n\nQuestion: ${question}${about}${picture ? `\n\nThe picture I am looking at: @view:${state.view}` : ""}`;
  askInput.value = "";

  if (agentName) {
    runTask(prompt, null, `${question}${askSubjects.length > 0 ? ` (about ${askSubjects.map((subject) => subject.label).join(", ")})` : ""}${picture ? " (with the picture)" : ""}`);

    return;
  }

  runState.textContent = "no agent: writing the question with its context into the task box…";
  void withContext(prompt).then((text) => {
    taskField.value = text;
    runState.textContent = "no agent: the question with its context is in the task box — copy it to your assistant (start web with --agent claude to ask here)";
  });
}

element<HTMLButtonElement>("ask-go").addEventListener("click", askQuestion);
askInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") askQuestion();
  event.stopPropagation();
});

// `@` in the task or the follow-up opens suggestions; Enter or a click inserts the tag.
const suggest = element<HTMLUListElement>("tag-suggest");
let suggestFor: HTMLTextAreaElement | HTMLInputElement | null = null;
let suggestIndex = 0;

function tagAtCursor(field: HTMLTextAreaElement | HTMLInputElement): { start: number; query: string } | null {
  const upTo = field.value.slice(0, field.selectionStart ?? field.value.length);
  const match = upTo.match(/@([\w:/#.\-]*)$/);

  return match ? { start: upTo.length - match[0].length, query: match[1] ?? "" } : null;
}

async function showSuggestions(field: HTMLTextAreaElement | HTMLInputElement): Promise<void> {
  const at = tagAtCursor(field);

  if (!at) {
    suggest.hidden = true;

    return;
  }

  const { tags } = await api.tags(at.query);
  suggest.replaceChildren();
  suggestFor = field;
  suggestIndex = 0;

  for (const [i, tag] of tags.entries()) {
    const item = document.createElement("li");
    item.className = i === 0 ? "active" : "";
    const code = document.createElement("code");
    code.textContent = tag.tag;
    item.append(code, tag.title);
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      insertTag(tag.tag);
    });
    suggest.append(item);
  }

  suggest.hidden = tags.length === 0;
  const box = field.getBoundingClientRect();
  const parent = element("chat").getBoundingClientRect();
  suggest.style.left = `${box.left - parent.left}px`;
  suggest.style.top = `${box.bottom - parent.top}px`;
}

function insertTag(tag: string): void {
  if (!suggestFor) return;
  const at = tagAtCursor(suggestFor);

  if (!at) return;
  const after = suggestFor.value.slice(suggestFor.selectionStart ?? suggestFor.value.length);
  suggestFor.value = `${suggestFor.value.slice(0, at.start)}${tag} ${after}`;
  const caret = at.start + tag.length + 1;
  suggestFor.setSelectionRange(caret, caret);
  suggest.hidden = true;
  suggestFor.focus();
}

for (const field of [element<HTMLTextAreaElement>("task"), element<HTMLInputElement>("followup")]) {
  field.addEventListener("input", () => void showSuggestions(field));
  field.addEventListener("blur", () => setTimeout(() => (suggest.hidden = true), 150));
  field.addEventListener("keydown", (event: Event) => {
    if (suggest.hidden) return;
    const key = (event as KeyboardEvent).key;
    const items = [...suggest.querySelectorAll("li")];

    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      suggestIndex = (suggestIndex + (key === "ArrowDown" ? 1 : items.length - 1)) % Math.max(1, items.length);
      items.forEach((item, i) => item.classList.toggle("active", i === suggestIndex));
    } else if (key === "Enter" || key === "Tab") {
      event.preventDefault();
      const code = items[suggestIndex]?.querySelector("code")?.textContent;

      if (code) insertTag(code);
    } else if (key === "Escape") suggest.hidden = true;
  });
}

async function readTask(): Promise<void> {
  const state = currentLink();

  if (reviewing(state.view)) return;

  // The current drawing first, so an unsaved stroke counts.
  const canvas = page.canvas();

  if (canvas && page.mode() === "edit") await api.saveDrawing(state.view, canvas.scene(), page.mocks());
  const { markdown, drawn } = await api.plan(state.view);
  taskField.value = markdown;
  runButton.disabled = !agentName;
  runState.textContent = drawn ? "" : "no drawing saved for this view: edit, draw, save";
}

/** The question box: a fenced ```archdiff-question block in the agent's text, rendered as the question and its options; an answer resumes the session. */
function showQuestion(text: string, run: { sessionId: string | null }): boolean {
  const match = text.match(/```archdiff-question\s*\n([\s\S]*?)```/);

  if (!match) return false;
  let asked: { question?: unknown; options?: unknown };

  try {
    asked = JSON.parse(match[1]!) as { question?: unknown; options?: unknown };
  } catch {
    return false;
  }

  const question = typeof asked.question === "string" ? asked.question : "";
  const options = Array.isArray(asked.options) ? asked.options.filter((option): option is string => typeof option === "string") : [];

  if (question === "") return false;
  const box = element<HTMLDivElement>("question");
  box.replaceChildren();
  const heading = document.createElement("div");
  heading.className = "q";
  heading.textContent = `❓ ${question}`;
  box.append(heading);
  const row = document.createElement("div");
  row.className = "options";

  const answer = (reply: string): void => {
    box.hidden = true;
    runTask(reply, run.sessionId);
  };

  for (const option of options) {
    const button = document.createElement("button");
    button.textContent = option;
    button.addEventListener("click", () => answer(option));
    row.append(button);
  }

  const other = document.createElement("input");
  other.placeholder = "another answer (Enter)";
  other.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && other.value.trim() !== "") answer(other.value.trim());
    event.stopPropagation();
  });
  row.append(other);
  box.append(row);
  box.hidden = false;

  return true;
}

/** The Chat tab's commands, by button or by a slash line in the task field. */
async function runCommand(command: "code" | "diagram" | "doc", argument: string): Promise<void> {
  const state = currentLink();

  if (command === "doc") {
    const textarea = element<HTMLTextAreaElement>("document");
    const hidden = textarea.hidden;
    textarea.hidden = !hidden ? true : false;
    element<HTMLDivElement>("document-row").hidden = textarea.hidden;

    if (!textarea.hidden) {
      if (argument) textarea.value = argument;
      textarea.focus();
    }

    return;
  }

  if (command === "code") {
    // The drawing first, so an unsaved stroke counts; then the contract, then the task.
    const canvas = page.canvas();

    if (canvas && page.mode() === "edit") await api.saveDrawing(state.view, canvas.scene(), page.mocks());
    runState.textContent = "folding the drawing into the contract…";
    const result = await api.code(state.view);
    taskField.value = result.markdown;
    runState.textContent = result.planned === 0 ? "the contract is built already; the task has nothing to build" : `${result.planned} planned items in the contract`;

    if (result.planned > 0 && agentName) runTask(result.markdown, null);
    else if (!agentName) runState.textContent = "no agent: the task is in the box; start web with --agent claude to run it";

    return;
  }

  const ask = argument.trim() === "" ? "Review ARCHITECTURE.md as an architect would: are the layer names and module paths clear and consistent, is anything missing between the layers (an import that will be needed), is any layer too thin or too fat, does anything in the prose contradict the diagram? Fix what is clearly wrong in the file (keep the Mermaid valid, keep the prose), and ask me about anything that is a real choice." : `About ARCHITECTURE.md: ${argument.trim()}. Edit the file (keep the Mermaid valid, keep the prose) and ask me when a choice is mine.`;
  taskField.value = ask;

  if (agentName) runTask(ask, null);
  else runState.textContent = "no agent: start web with --agent claude to run it";
}

/** Runs `written` on the agent; `shown` is what the transcript's own row says when the prompt wraps a shorter question. */
export function runTask(written: string, resume: string | null, shown: string = written): void {
  if (!agentName || written.trim() === "") return;
  element<HTMLDivElement>("question").hidden = true;

  // A slash line is a command, not a task.
  const slash = written.trim().match(/^\/(code|diagram|doc)\b\s*([\s\S]*)$/);

  if (slash) {
    void runCommand(slash[1] as "code" | "diagram" | "doc", slash[2] ?? "").catch((error: unknown) => (runState.textContent = error instanceof Error ? error.message : String(error)));

    return;
  }
  const state = currentLink();
  runButton.disabled = true;
  runButton.classList.add("running");
  stopButton.disabled = false;
  followup.disabled = true;
  runState.textContent = `running ${agentName}…`;

  if (!resume) {
    transcript.replaceChildren();
    turn = null;
  }

  appendEvent("you", `▸ ${shown.length > 300 ? `${shown.slice(0, 300)}…` : shown}`);
  const touched = new Set<string>();
  let lightTimer: ReturnType<typeof setTimeout> | null = null;
  void withContext(written)
    .then((prompt) => api.runAgent(state.view, prompt, resume))
    .then(({ id, task }) => {
      runState.textContent = `running ${agentName} (${id}); task saved to ${task}`;
      const run = { id, sessionId: resume, close: () => {} };
      currentRun = run;
      run.close = api.agentEvents(
        id,
        (event) => {
          if (event.sessionId) run.sessionId = event.sessionId;

          if (event.kind !== "init") appendEvent(event.kind, event.text);

          if (event.kind === "text" || event.kind === "result") showQuestion(event.text, run);

          // The shapes of the files the agent touches light up as it works, like a run passing through them.
          if (event.files && page.canvas()) {
            const ids = shapesOfFiles(event.files);

            for (const id of ids) touched.add(id);

            if (ids.length > 0) {
              page.canvas()?.highlight(ids);

              if (lightTimer) clearTimeout(lightTimer);
              lightTimer = setTimeout(() => page.canvas()?.highlight([...touched], "#ffb74d"), 1200);
            }
          }
        },
        () => {
          runButton.disabled = false;
          runButton.classList.remove("running");
          stopButton.disabled = true;
          followup.disabled = run.sessionId === null;
          runState.textContent = element<HTMLDivElement>("question").hidden ? `${agentName} finished; the diagram is reloaded — compare with review, check against the contract` : `${agentName} asks a question`;
          page.canvas()?.highlight([]);
          // The agent changed the code: the live diagram and the page.views() follow.
          void page.loadViews().then(() => page.load());
          void loadTasks();
        },
      );
    })
    .catch((error: unknown) => {
      runState.textContent = error instanceof Error ? error.message : String(error);
      runButton.disabled = false;
      runButton.classList.remove("running");
      stopButton.disabled = true;
    });
}

element<HTMLButtonElement>("plan").addEventListener("click", () => void readTask().catch((error: unknown) => (runState.textContent = error instanceof Error ? error.message : String(error))));
element<HTMLButtonElement>("code-this").addEventListener("click", () => void runCommand("code", "").catch((error: unknown) => (runState.textContent = error instanceof Error ? error.message : String(error))));
element<HTMLButtonElement>("improve-diagram").addEventListener("click", () => void runCommand("diagram", "").catch((error: unknown) => (runState.textContent = error instanceof Error ? error.message : String(error))));
element<HTMLButtonElement>("from-document").addEventListener("click", () => void runCommand("doc", ""));

const documentGo = async (): Promise<void> => {
  const text = element<HTMLTextAreaElement>("document").value.trim();

  if (text === "") return;
  const state = element<HTMLSpanElement>("document-state");
  state.textContent = "writing the architecture…";
  element<HTMLButtonElement>("document-go").disabled = true;

  try {
    const result = await api.intentFromDocument(text);
    state.textContent = `${result.file}: ${result.layers} layers, ${result.modules} modules, ${result.edges} imports (from ${result.source})`;
    element<HTMLTextAreaElement>("document").hidden = true;
    element<HTMLDivElement>("document-row").hidden = true;
    setLink({ ...currentLink(), view: "intent" });
    void page.loadViews().then(() => page.load());
  } catch (error) {
    state.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    element<HTMLButtonElement>("document-go").disabled = false;
  }
};

element<HTMLButtonElement>("document-go").addEventListener("click", () => void documentGo());
element<HTMLTextAreaElement>("document").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void documentGo();
  event.stopPropagation();
});
runButton.addEventListener("click", () => runTask(taskField.value, null));
taskField.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey || /^\/(code|diagram|doc)\b/.test(taskField.value.trim()))) {
    event.preventDefault();
    runTask(taskField.value, null);
  }
});
stopButton.addEventListener("click", () => {
  if (currentRun) void api.stopAgent(currentRun.id);
});
followup.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && followup.value.trim() !== "" && currentRun) {
    const message = followup.value.trim();
    followup.value = "";
    runTask(message, currentRun.sessionId);
  }
});


/** The agent the server may run, as the views response named it; null without one. */
export function agentNameOf(): string | null {
  return agentName;
}

/** The agent the server may run: named over the task box, and the run button usable only with one. */
export function setAgentName(name: string | null): void {
  agentName = name;
  runButton.disabled = !name;
  element("agent-name").textContent = name ? `agent: ${name}` : "no agent: start archdiff web --agent claude|cursor to run tasks";
}

export async function loadTasks(): Promise<void> {
  try {
    const { tasks } = await api.tasks();
    const list = element<HTMLUListElement>("tasks");
    list.replaceChildren();

    for (const task of tasks.slice(0, 30)) {
      const item = document.createElement("li");
      item.textContent = `${task.file.slice(task.file.lastIndexOf("/") + 1)} — ${task.head}`;
      list.append(item);
    }

    element("tasks-box").hidden = tasks.length === 0;
  } catch {
    element("tasks-box").hidden = true;
  }
}
