// The Chat tab: the task drawn on the view, and the agent that does it —
// the run with its streamed events (a turn is the question, its steps
// folded under a summary, and the answer rendered), the question protocol
// (an archdiff-question block becomes option buttons, an answer resumes
// the session), the @tags expanded into context, a question about the
// picture or the selected shapes (answered without edits), the slash
// commands, the checks after a run and what the run did to the violations
// of the contract (fixed, surviving, added), the document that becomes
// the contract, and the previous tasks. Takes the page as its context
// (page.ts).
//
// A line that starts with a slash, in any of the tab's fields, is a
// command of the page (src/chat-commands.ts names them, commands.ts does
// them): it runs with or without an agent, its answer stands in the
// transcript, and the commands are suggested as they are typed. An agent
// writes the same commands in an `archdiff-do` block of its answer to show
// the reader something; the page runs the ones an agent may.
//
// Entry points: `askAbout`, `runTask`, `setAgentName`, `agentNameOf`, `loadAgents`,
// `loadTasks`, `askAgent`, `agentCommand`, `runChecksNow`, `stopRun`,
// `pickAgent`, and the elements `taskField`, `runButton`, `runState`,
// `transcript`.

import { api } from "./api.ts";
import { element, h } from "./dom.ts";
import { revealDetails } from "./layout.ts";
import { page } from "./page.ts";
import { readOnlyView, setLink, currentLink } from "./link.ts";
import { CHAT_COMMANDS, doCommands, parseCommandLine } from "../../src/chat-commands.ts";
import { pictureQueryText } from "../../src/options.ts";
import { tagsIn } from "../../src/shape-keys.ts";

export const taskField = element<HTMLTextAreaElement>("task");
export const runButton = element<HTMLButtonElement>("run");
const stopButton = element<HTMLButtonElement>("stop");
export const runState = element<HTMLSpanElement>("run-state");
export const transcript = element<HTMLDivElement>("transcript");
const followup = element<HTMLInputElement>("followup");
let agentName: string | null = null;
let currentRun: { id: string; close: () => void; sessionId: string | null; stopped: boolean; agent: string } | null = null;
/** Whether a run is going: a second one would write over the first's work (the server refuses it too), and the transcript follows one. */
let running = false;
/** An answer to the agent's question given while its turn still ran: sent when the run ends. */
let queuedAnswer: string | null = null;

/** The turn being written: the question's row, its steps folded under a summary, and the answer. */
let turn: { steps: HTMLDetailsElement; summary: HTMLElement; count: number; answer: HTMLDivElement; lastText: string; answered: boolean } | null = null;

/** A row of the transcript; a check and a line of the run's report say by their mark whether they passed (✔) or failed (✘). */
function row(kind: string, text: string): HTMLDivElement {
  const judged = kind === "check" || kind === "report";

  return h("div", { class: `ev ${kind}${judged && text.startsWith("✘") ? " failed" : judged && text.startsWith("✔") ? " passed" : ""}` }, text);
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
 * latest); the result is the answer, shown; the checks, the run's report
 * (the violations it fixed, the ones that survive, the ones it added) and
 * the exit stand below it. The text is kept in `.ev` rows for the copy button.
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
  } else if (turn && kind !== "check" && kind !== "report" && kind !== "exit") {
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
export async function runChecksNow(): Promise<void> {
  const button = element<HTMLButtonElement>("checks");
  button.disabled = true;
  runState.textContent = "running the checks…";

  try {
    const { events } = await api.runChecks();

    for (const event of events) appendEvent(event.kind, event.text);
    runState.textContent = events.length === 0 ? "no checks: no ARCHITECTURE.md and no \"checks\" in archdiff.json" : events.every((event) => event.text.startsWith("✔")) ? "every check passed" : "a check failed; see the transcript";
    page.showTab("chat");
  } catch (error) {
    showRunError(error);
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

/** Tags in a text (`tagsIn` of shape-keys.ts: @module:…, @fn:…, @flow:…, @view:…) become their context for the agent; @view: takes the picture's options. */
async function withContext(prompt: string): Promise<string> {
  if (tagsIn(prompt).length === 0) return prompt;

  try {
    const context = await api.expand(prompt, pictureQueryText(currentLink()).replace(/^&/, ""));

    return context ? `${prompt}\n\n${context}` : prompt;
  } catch {
    return prompt;
  }
}

// ── The commands: a slash line of the reader's, a block of an agent's ─────────

/** What a command said of itself, in the transcript under the line that asked for it; a failure reads as one. */
function said(markdown: string, failed = false): void {
  const answer = h("div", { class: `answer ev result${failed ? " failed" : ""}` });
  page.renderMarkdown(answer, markdown);
  transcript.append(answer);
  transcript.scrollTop = transcript.scrollHeight;
}

/** Runs a slash line of the reader's: the page does what it says, and what the command says of itself stands in the transcript. */
function runSlash(line: string): void {
  transcript.append(row("you", `▸ ${line.trim()}`));
  page.showTab("chat");
  void page.command(line, "reader").then(
    (answer) => {
      if (answer !== "") said(answer);
    },
    (error: unknown) => said(`⚠ ${error instanceof Error ? error.message : String(error)}`, true),
  );
}

/**
 * Whether a field's text is meant as a command: a slash and a word at its start. A word that names no command is one
 * all the same — a command mistyped, which the page answers with the list; it is never sent to an agent as a task.
 * A path (`/src/x.ts is wrong`) is no command: a slash follows its first word.
 */
function isCommand(text: string): boolean {
  return parseCommandLine(text) !== null || /^\/[a-z]+(\s|$)/i.test(text.trim());
}

/**
 * The commands of an agent's `archdiff-do` blocks, run in order, each once per run (the agent's text and its result
 * may both carry the block): the page shows what the agent asks it to, and a line of the transcript says which
 * command that was — or why it was not run.
 */
function doForAgent(text: string, run: { done: Set<string>; queue: Promise<void> }): void {
  for (const line of doCommands(text)) {
    if (run.done.has(line)) continue;
    run.done.add(line);
    run.queue = run.queue.then(() =>
      page.command(line, "agent").then(
        (answer) => void transcript.append(row("do", `↳ ${line}${answer === "" ? "" : ` — ${answer.replace(/[`*]/g, "").split("\n")[0]}`}`)),
        (error: unknown) => void transcript.append(row("do failed", `↳ ${line} — ⚠ ${error instanceof Error ? error.message : String(error)}`)),
      ),
    );
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
  revealDetails();
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

  // A command, not a question: the page does it, agent or none.
  if (isCommand(question)) {
    askInput.value = "";
    runSlash(question);

    return;
  }

  // A turn still going takes no second task: the question stays in its field, to be asked when the run's line says it ended.
  if (question === "" || (agentName !== null && busy())) return;
  const state = currentLink();
  const picture = element<HTMLInputElement>("ask-picture").checked && !readOnlyView(state.view);
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

/** A question put to the agent as the question row puts it (the `/ask` command). */
export function askAgent(question: string): void {
  askInput.value = question;
  askQuestion();
}

element<HTMLButtonElement>("ask-go").addEventListener("click", askQuestion);
askInput.addEventListener("keydown", (event) => {
  // While a suggestion is offered, Enter takes it (the handler below); else it asks.
  if (event.key === "Enter" && !enterCompletes(askInput)) {
    suggest.hidden = true;
    askQuestion();
  }

  event.stopPropagation();
});

// `@` in the task or the follow-up opens suggestions; Enter or a click inserts the tag.
const suggest = element<HTMLUListElement>("tag-suggest");
let suggestFor: HTMLTextAreaElement | HTMLInputElement | null = null;
let suggestIndex = 0;

/**
 * Whether Enter in `field` takes the suggestion offered: one is offered there, and it is not what the field holds
 * already — a command typed whole is run by Enter, not written a second time.
 */
function enterCompletes(field: HTMLTextAreaElement | HTMLInputElement): boolean {
  if (suggest.hidden || suggestFor !== field) return false;
  const offered = suggest.querySelectorAll("li")[suggestIndex]?.querySelector("code")?.textContent;

  return offered !== undefined && offered !== null && offered !== field.value.trim();
}

function tagAtCursor(field: HTMLTextAreaElement | HTMLInputElement): { start: number; query: string; command?: true } | null {
  const upTo = field.value.slice(0, field.selectionStart ?? field.value.length);
  // A slash and the start of a name, with nothing before it: a command being typed.
  const command = upTo.match(/^\/([a-z]*)$/);

  if (command) return { start: 0, query: command[1] ?? "", command: true };
  const match = upTo.match(/@([\w:/#.\-]*)$/);

  return match ? { start: upTo.length - match[0].length, query: match[1] ?? "" } : null;
}

async function showSuggestions(field: HTMLTextAreaElement | HTMLInputElement): Promise<void> {
  const at = tagAtCursor(field);

  if (!at) {
    suggest.hidden = true;

    return;
  }

  // The commands whose name starts as typed, from the table; the tags from the server.
  const tags = at.command ? CHAT_COMMANDS.filter((command) => command.name.startsWith(at.query)).slice(0, 14).map((command) => ({ tag: `/${command.name}`, title: `${command.args ? ` ${command.args} ` : " "}— ${command.does}` })) : (await api.tags(at.query)).tags;
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

for (const field of [element<HTMLTextAreaElement>("task"), element<HTMLInputElement>("followup"), askInput]) {
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
      // Enter on a command typed whole is the field's own, to run it.
      if (key === "Enter" && !enterCompletes(field)) return;
      event.preventDefault();
      const code = items[suggestIndex]?.querySelector("code")?.textContent;

      if (code) insertTag(code);
    } else if (key === "Escape") suggest.hidden = true;
  });
}

async function readTask(): Promise<void> {
  const state = currentLink();

  if (readOnlyView(state.view)) return;

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

    // The agent asks in the middle of its turn, and the turn goes on for a moment (its result, the checks): an answer
    // given meanwhile is kept and sent when the turn ends, to the session it has then — not refused and lost.
    if (running) {
      queuedAnswer = reply;
      runState.textContent = `the answer goes to ${currentRun ? labelOf(currentRun.agent) : "the agent"} as soon as this turn ends`;

      return;
    }

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

/** The Chat tab's own commands — the contract built from the drawing, reviewed by the agent, written from a document — by button or by a slash line. */
export async function agentCommand(command: "code" | "diagram" | "doc", argument: string): Promise<void> {
  const state = currentLink();

  // "code this" folds the drawing into the contract before the run: not while another run edits the repository.
  if (command !== "doc" && busy()) return;

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
    else if (!agentName) runState.textContent = "no agent picked: the task is in the box; pick an agent above to run it";

    return;
  }

  const ask = argument.trim() === "" ? "Review ARCHITECTURE.md as an architect would: are the layer names and module paths clear and consistent, is anything missing between the layers (an import that will be needed), is any layer too thin or too fat, does anything in the prose contradict the diagram? Fix what is clearly wrong in the file (keep the Mermaid valid, keep the prose), and ask me about anything that is a real choice." : `About ARCHITECTURE.md: ${argument.trim()}. Edit the file (keep the Mermaid valid, keep the prose) and ask me when a choice is mine.`;
  taskField.value = ask;

  if (agentName) runTask(ask, null);
  else runState.textContent = "no agent: start web with --agent claude to run it";
}

/** Runs `written` on the agent; `shown` is what the transcript's own row says when the prompt wraps a shorter question. */
/** The buttons of a run: while the agent works, run is off and stop on; after it, the follow-up opens once its session can be resumed. */
function setRunning(next: boolean, resumable = false): void {
  running = next;
  runButton.disabled = next;
  runButton.classList.toggle("running", next);
  stopButton.disabled = !next;
  followup.disabled = next || !resumable;
}

/** A run is going: the run's line says so, and the caller starts nothing. */
function busy(): boolean {
  if (running) runState.textContent = `${currentRun ? labelOf(currentRun.agent) : "the agent"} is still running: stop it, or wait for its answer`;

  return running;
}

/** A failure of the run or of a command, on the run's line. */
function showRunError(error: unknown): void {
  runState.textContent = error instanceof Error ? error.message : String(error);
}

export function runTask(written: string, resume: string | null, shown: string = written): void {
  // A slash line is a command, not a task: the page does it, with an agent picked or none.
  if (isCommand(written)) return runSlash(written);

  if (!agentName || written.trim() === "" || busy()) return;
  element<HTMLDivElement>("question").hidden = true;
  const state = currentLink();
  setRunning(true);
  runState.textContent = `running ${labelOf(agentName)}…`;

  if (!resume) {
    transcript.replaceChildren();
    turn = null;
    queuedAnswer = null;
  }

  appendEvent("you", `▸ ${shown.length > 300 ? `${shown.slice(0, 300)}…` : shown}`);
  const touched = new Set<string>();
  let lightTimer: ReturnType<typeof setTimeout> | null = null;
  void withContext(written)
    // A follow-up resumes the session with the agent that holds it, whichever is picked now.
    .then((prompt) => api.runAgent(state.view, prompt, resume, resume ? (currentRun?.agent ?? agentName) : agentName))
    .then(({ id, task, agent }) => {
      runState.textContent = `running ${labelOf(agent)} (${id}); task saved to ${task}`;
      const run = { id, sessionId: resume, stopped: false, agent, close: () => {} };
      const shownByAgent = { done: new Set<string>(), queue: Promise.resolve() };
      currentRun = run;
      run.close = api.agentEvents(
        id,
        (event) => {
          if (event.sessionId) run.sessionId = event.sessionId;

          if (event.kind !== "init") appendEvent(event.kind, event.text);

          if (event.kind === "text" || event.kind === "result") {
            showQuestion(event.text, run);
            doForAgent(event.text, shownByAgent);
          }

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
          setRunning(false, run.sessionId !== null);
          const who = labelOf(run.agent);
          runState.textContent = run.stopped ? `${who} stopped; the diagram is reloaded with what it changed` : element<HTMLDivElement>("question").hidden ? `${who} finished; the diagram is reloaded — compare with review, check against the contract` : `${who} asks a question`;
          page.canvas()?.highlight([]);
          // The agent changed the code: the live diagram and the page.views() follow.
          void page.loadViews().then(() => page.load());
          void loadTasks();
          // The answer the reader gave while the turn ran: on with it, in the session the turn left (a stopped run takes none).
          const kept = queuedAnswer;
          queuedAnswer = null;

          if (kept !== null && !run.stopped && run.sessionId !== null) runTask(kept, run.sessionId);
        },
      );
    })
    .catch((error: unknown) => {
      showRunError(error);
      queuedAnswer = null;
      setRunning(false);
    });
}

element<HTMLButtonElement>("plan").addEventListener("click", () => void readTask().catch(showRunError));
element<HTMLButtonElement>("code-this").addEventListener("click", () => void agentCommand("code", "").catch(showRunError));
element<HTMLButtonElement>("improve-diagram").addEventListener("click", () => void agentCommand("diagram", "").catch(showRunError));
element<HTMLButtonElement>("from-document").addEventListener("click", () => void agentCommand("doc", ""));

const documentGo = async (): Promise<void> => {
  const text = element<HTMLTextAreaElement>("document").value.trim();

  if (text === "") return;
  const state = element<HTMLSpanElement>("document-state");
  state.textContent = "writing the architecture…";
  element<HTMLButtonElement>("document-go").disabled = true;

  try {
    const result = await api.intentFromDocument(text, agentName);
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
  // Enter runs a command as it stands (a suggestion offered takes the key first); a task is run by Ctrl+Enter.
  if (event.key === "Enter" && !enterCompletes(taskField) && (event.ctrlKey || event.metaKey || isCommand(taskField.value))) {
    event.preventDefault();
    suggest.hidden = true;
    const written = taskField.value;

    if (isCommand(written)) taskField.value = "";
    runTask(written, null);
  }
});

/** Stops the run that is going; whether there was one. */
export function stopRun(): boolean {
  if (!currentRun || !running) return false;
  currentRun.stopped = true;
  void api.stopAgent(currentRun.id);

  return true;
}

stopButton.addEventListener("click", () => void stopRun());
followup.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || followup.value.trim() === "" || enterCompletes(followup)) return;
  suggest.hidden = true;
  const message = followup.value.trim();

  if (isCommand(message)) {
    followup.value = "";
    runSlash(message);
  } else if (currentRun) {
    followup.value = "";
    runTask(message, currentRun.sessionId);
  }
});


/** The agent picked in the Chat tab (its name); null: none, the tasks are only written. */
export function agentNameOf(): string | null {
  return agentName;
}

/** What the page calls the agents it offers, by name. */
const agentLabels = new Map<string, string>();
/** Whether any agent is installed here: without one the picker says what to install. */
let anyInstalled = false;

/** An agent's label (Claude Code, Codex…), its name when the page does not know it. */
function labelOf(name: string | null): string {
  return name === null ? "the agent" : (agentLabels.get(name) ?? name);
}

/** The agent picked: the run button usable only with one, and a word beside the picker when there is none. */
export function setAgentName(name: string | null): void {
  agentName = name;
  runButton.disabled = !name;
  element("agent-name").textContent = name ? "" : anyInstalled ? "no agent picked: the tasks are only written" : "no agent found: Claude Code, Cursor, Codex or OpenCode runs the tasks — place one in the settings";
}

const agentSelect = element<HTMLSelectElement>("agent-select");

/**
 * The agents of the picker: each one the server offers, those not installed here greyed out, and "none" (the tasks
 * only written). The one picked before in this browser when it is still installed, else the server's first.
 */
export async function loadAgents(): Promise<void> {
  let offered: Awaited<ReturnType<typeof api.agents>>;

  try {
    offered = await api.agents();
  } catch {
    setAgentName(null);

    return;
  }

  agentLabels.clear();
  anyInstalled = offered.agents.some((agent) => agent.installed);
  agentSelect.replaceChildren(
    ...offered.agents.map((agent) => {
      agentLabels.set(agent.name, agent.label);

      return h("option", { value: agent.name, disabled: !agent.installed, title: agent.installed ? "" : "not found on this computer: the settings say why, and place it" }, agent.installed ? agent.label : `${agent.label} — not installed`);
    }),
    h("option", { value: "" }, "none: write the tasks only"),
  );
  let remembered: string | null = null;

  try {
    remembered = localStorage.getItem("archdiff.agent");
  } catch {
    // Not remembered.
  }

  const usable = (name: string | null): boolean => name !== null && offered.agents.some((agent) => agent.name === name && agent.installed);
  const picked = remembered === "" ? null : usable(remembered) ? remembered : offered.default;
  agentSelect.value = picked ?? "";
  setAgentName(picked);
}

/** Picks the agent `name` names (its name or its label; `none` for none) as the picker does, and says which; thrown when it is not offered or cannot run here. */
export function pickAgent(name: string): string {
  const asked = name.trim().toLowerCase();
  const option = [...agentSelect.options].find((each) => (asked === "none" ? each.value === "" : each.value.toLowerCase() === asked || (agentLabels.get(each.value) ?? "").toLowerCase() === asked));

  if (!option) throw new Error(`agent: one of ${[...agentSelect.options].map((each) => each.value || "none").join(", ")}`);

  if (option.disabled) throw new Error(`${labelOf(option.value)} cannot run here: the settings say why (/settings)`);
  agentSelect.value = option.value;
  agentSelect.dispatchEvent(new Event("change"));

  return option.value === "" ? "No agent: the tasks are only written." : `The tasks and the questions go to ${labelOf(option.value)}.`;
}

agentSelect.addEventListener("change", () => {
  setAgentName(agentSelect.value || null);

  try {
    localStorage.setItem("archdiff.agent", agentSelect.value);
  } catch {
    // Not remembered.
  }
});

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
