// Guided tours on the page: a tour is a list of steps through the
// pictures, each the link of a view with its options, the shapes selected
// there and a note in Markdown (src/tours.ts keeps them as files of the
// repository). The header's *tours* menu lists the tours, plays one and
// starts the recording of a new one; while the link names a tour
// (`tour=<name>&step=N`) a bar under the title shows it: its title, the
// steps to pick from, ‹ and › (`,` and `.`), the note of the step, and the
// recording — *add step* keeps the picture shown now with its options and
// selection under a note typed there, *✎ note* rewrites a note, *remove*
// takes a step out, *link* copies the step's address. A link that names
// the tour and the step alone, as it is shared, opens the step's picture
// and selects its shapes. The reader may walk off a step — the bar says
// so and leads back.
//
// Entry points: `enterTour`, `showTourBar`, `tourDrawn`.

import { api, type Tour, type TourStep } from "./api.ts";
import { leaveEdit } from "./canvas.ts";
import { element, h } from "./dom.ts";
import { currentLink, setLink, stepHash, type Link } from "./link.ts";
import { page } from "./page.ts";
import { copyText } from "./panel.ts";
import { select, selection, showPath } from "./picking.ts";
import { notice } from "./title.ts";
import { offerWalk } from "./walk.ts";

const bar = element<HTMLDivElement>("tour");
const steps = element<HTMLSelectElement>("tour-steps");
const noteBox = element<HTMLDivElement>("tour-note");
const editor = element<HTMLDivElement>("tour-editor");
const text = element<HTMLTextAreaElement>("tour-text");
const state = element<HTMLSpanElement>("tour-state");
const menu = element<HTMLDetailsElement>("tours-menu");

/** The tour the link names, as the server last gave it; null while the link names none, or one that is not there yet. */
let tour: Tour | null = null;
/** A step just opened by the tour (a press, a shared link): its shapes are selected once its picture is drawn. */
let entered: { name: string; step: number } | null = null;
/** What the editor under the bar is writing: a new step's note, or the note of the step shown. */
let writing: "add" | "note" | null = null;

/** The page embedded in a split pane shows its picture alone: the tour is the first pane's, whatever the address it was given says. */
const embedded = new URLSearchParams(location.search).get("embed") === "1";

/** A name a tour's file can have, as the server checks it. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** The address of a step: the step's own link, then the tour and the step's number. */
function hashOf(step: TourStep, name: string, number: number): string {
  return `${step.link}&tour=${encodeURIComponent(name)}&step=${number}`;
}

/** The tour of a name, read from the server; null when there is none (a tour about to be recorded). */
async function read(name: string): Promise<Tour | null> {
  try {
    return await api.tour(name);
  } catch {
    return null;
  }
}

/**
 * Before a picture is loaded: the tour the link names is read (anew when the link names another), and a link that
 * names the tour and the step alone — as it is shared — becomes the step's own link, in place.
 */
export async function enterTour(): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const name = params.get("tour");

  if (name === null || !NAME.test(name)) {
    tour = null;

    return;
  }

  if (tour?.name !== name) tour = await read(name);

  if (params.has("view") || !tour || tour.steps.length === 0) return;
  const number = Math.min(Math.max(1, Math.floor(Number(params.get("step") ?? 1)) || 1), tour.steps.length);
  entered = { name, step: number };
  history.replaceState(null, "", `#${hashOf(tour.steps[number - 1]!, name, number)}`);
}

/** The first line of a note as plain words, for the list of steps. */
function firstLine(note: string): string {
  const line = (note.trim().split("\n")[0] ?? "").replace(/[*_`#>]/g, "").trim();

  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/** The bar as the link says: the tour, the steps, the note of the step the link is at. */
export function showTourBar(link: Link): void {
  bar.hidden = embedded || link.tour === null;
  const playing = tour !== null && tour.steps.length > 0;
  offerWalk("tour", !bar.hidden && playing ? step : null);

  if (bar.hidden) {
    showEditor(null);

    return;
  }

  const count = tour?.steps.length ?? 0;
  const shown = tour?.steps[link.step - 1] ?? null;
  element("tour-title").textContent = tour?.title ?? link.tour;
  steps.replaceChildren(...(count === 0 ? [new Option("no steps yet", "0")] : (tour?.steps ?? []).map((each, i) => new Option(`${i + 1} of ${count}${firstLine(each.note) ? ` · ${firstLine(each.note)}` : ""}`, String(i + 1)))));

  if (count > 0 && !shown) steps.prepend(new Option("pick a step", "0"));
  steps.value = shown ? String(link.step) : "0";
  steps.disabled = count === 0;
  element<HTMLButtonElement>("tour-prev").disabled = !shown || link.step <= 1;
  element<HTMLButtonElement>("tour-next").disabled = count === 0 || link.step >= count;

  for (const id of ["tour-edit", "tour-remove", "tour-link"]) element<HTMLButtonElement>(id).disabled = !shown;
  noteBox.hidden = !shown || writing !== null;

  if (shown) page.renderMarkdown(noteBox, shown.note.trim() === "" ? "_No note for this step._" : shown.note);
  showState(link);
}

/** What the end of the bar says: where the tour stands, and when the picture shown is no longer the step's. */
function showState(link: Link): void {
  const count = tour?.steps.length ?? 0;
  const shown = tour?.steps[link.step - 1] ?? null;
  state.textContent = count === 0 ? "recording: add step keeps the picture shown, its selection and a note" : !shown ? "" : stepHash(link) === shown.link ? "" : `away from step ${link.step}: ‹ › or the list lead back`;
}

/** Once a picture is drawn: the shapes of a step just opened are selected, and the bar says whether the picture is the step's. */
export function tourDrawn(link: Link): void {
  if (embedded || link.tour === null) return;
  const shown = tour?.steps[link.step - 1] ?? null;

  // A step just opened, and a step whose own picture is drawn anew (the code changed, an agent's run ended): its shapes
  // are shown again. A picture the reader walked off to keeps what the reader picked.
  if (shown && ((entered && entered.name === link.tour && entered.step === link.step) || stepHash(link) === shown.link)) {
    const ids = shown.select.filter((id) => page.nodes().has(id));

    // A step whose shapes are a way to follow lights the lines from each to the next; any other selects them.
    if (shown.path && ids.length > 1) showPath(ids);
    else if (ids.length > 0) select(ids, ids.length === 1);
  }

  entered = null;
  showState(link);
}

/** Opens a step of the tour: its picture with its options, then its selection. */
function open(number: number): void {
  const stepTo = tour?.steps[number - 1];

  if (!tour || !stepTo || !leaveEdit()) return;
  showEditor(null);
  entered = { name: tour.name, step: number };
  const hash = `#${hashOf(stepTo, tour.name, number)}`;

  // The address of the step is the address now (the reader only picked other shapes): the picture is drawn again for it.
  if (location.hash === hash) void page.load();
  else location.hash = hash;
}

/** The next or the previous step (`.` and `,`); past either end it says so and stays. */
function step(by: 1 | -1): void {
  if (!tour) return;
  const link = currentLink();
  // Off the tour's steps (a link that names none): on to the first.
  const next = link.step === 0 ? 1 : link.step + by;

  if (next < 1 || next > tour.steps.length) return notice(by === 1 ? "the last step of the tour" : "the first step of the tour");
  open(next);
}

// ── Recording ────────────────────────────────────────────────────────────────

/** Shows the editor for a new step's note or for the note of the step shown; null puts it away. */
function showEditor(what: "add" | "note" | null): void {
  writing = what;
  editor.hidden = what === null;
  element<HTMLButtonElement>("tour-keep").textContent = what === "note" ? "keep the note" : "keep the step";

  if (what === null) return;
  noteBox.hidden = true;
  text.value = what === "note" ? (tour?.steps[currentLink().step - 1]?.note ?? "") : "";
  text.focus();
}

/** Saves the tour with these steps (and title) and keeps what the server made of it. */
async function save(name: string, title: string, next: TourStep[]): Promise<boolean> {
  try {
    tour = (await api.saveTour(name, title, next)).tour;

    return true;
  } catch (error) {
    notice(error instanceof Error ? error.message : String(error));

    return false;
  }
}

/** Keeps what the editor holds: a new step after the one shown — the picture, its options and its selection now — or the rewritten note. */
async function keep(): Promise<void> {
  const link = currentLink();

  if (link.tour === null || writing === null) return;
  const all = [...(tour?.steps ?? [])];

  if (writing === "note") {
    const shown = all[link.step - 1];

    if (!shown) return;
    all[link.step - 1] = { ...shown, note: text.value };

    if (!(await save(link.tour, tour?.title ?? link.tour, all))) return;
    showEditor(null);
    showTourBar(link);

    return;
  }

  const at = Math.min(link.step, all.length);
  all.splice(at, 0, { link: stepHash(link), select: [...selection()], note: text.value });

  if (!(await save(link.tour, tour?.title ?? link.tour, all))) return;
  showEditor(null);
  // The new step is the one shown: its address, and its selection back once the picture is drawn again.
  entered = { name: link.tour, step: at + 1 };
  notice(`step ${at + 1} of ${all.length} kept in the tour ${link.tour}`);
  setLink({ ...link, step: at + 1 });
}

/** Takes the step shown out of the tour; the one before it (or the new first) is shown. */
async function remove(): Promise<void> {
  const link = currentLink();
  const all = [...(tour?.steps ?? [])];

  if (link.tour === null || !all[link.step - 1] || !confirm(`Take step ${link.step} out of the tour ${tour?.title ?? link.tour}?`)) return;
  all.splice(link.step - 1, 1);

  if (!(await save(link.tour, tour?.title ?? link.tour, all))) return;

  if (all.length === 0) setLink({ ...link, step: 0 });
  else open(Math.max(1, link.step - 1));
}

element<HTMLButtonElement>("tour-prev").addEventListener("click", () => step(-1));
element<HTMLButtonElement>("tour-next").addEventListener("click", () => step(1));
steps.addEventListener("change", () => open(Number(steps.value)));
element<HTMLButtonElement>("tour-add").addEventListener("click", () => showEditor(writing === "add" ? null : "add"));
element<HTMLButtonElement>("tour-edit").addEventListener("click", () => showEditor(writing === "note" ? null : "note"));
element<HTMLButtonElement>("tour-keep").addEventListener("click", () => void keep());
element<HTMLButtonElement>("tour-cancel").addEventListener("click", () => {
  showEditor(null);
  showTourBar(currentLink());
});
text.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void keep();
});
element<HTMLButtonElement>("tour-remove").addEventListener("click", () => void remove());
element<HTMLButtonElement>("tour-link").addEventListener("click", () => {
  const link = currentLink();

  if (link.tour === null) return;
  void copyText(`${location.origin}${location.pathname}#tour=${encodeURIComponent(link.tour)}&step=${link.step}`).then((done) => notice(done ? `the link to step ${link.step} is copied: tour=${link.tour}&step=${link.step}` : "the link could not be copied"));
});
// Leaving the tour keeps the picture: the link says the same without the tour.
element<HTMLButtonElement>("tour-end").addEventListener("click", () => {
  showEditor(null);
  setLink({ ...currentLink(), tour: null, step: 0 });
});
// The title of the tour, rewritten on a press.
element("tour-title").addEventListener("click", () => {
  const link = currentLink();

  if (link.tour === null || !tour) return;
  const title = prompt("The title of the tour", tour.title);

  if (title !== null && title.trim() !== "") void save(link.tour, title.trim(), tour.steps).then(() => showTourBar(currentLink()));
});

// ── The menu of the tours ────────────────────────────────────────────────────

/** Plays a tour from its first step; one without steps is opened to be recorded. */
function play(name: string, count: number): void {
  menu.open = false;

  if (!leaveEdit()) return;
  tour = null;

  if (count === 0) return setLink({ ...currentLink(), tour: name, step: 0 });
  entered = { name, step: 1 };
  location.hash = `tour=${encodeURIComponent(name)}&step=1`;
}

/** The tours of the repository in the menu, each to play or to remove, as the server lists them now. */
async function listTours(): Promise<void> {
  const list = element<HTMLDivElement>("tours-list");
  const note = element<HTMLDivElement>("tours-note");

  try {
    const { directory, tours } = await api.tours();
    list.replaceChildren(
      ...tours.map((each) =>
        h(
          "div",
          { class: "row" },
          h("button", { class: "play", title: `Play the tour from its first step (${each.name})`, dataset: { tour: each.name }, on: { click: () => play(each.name, each.steps) } }, `▶ ${each.title} · ${each.steps} ${each.steps === 1 ? "step" : "steps"}`),
          h(
            "button",
            {
              class: "icon",
              title: "Remove the tour: its file is deleted",
              on: {
                click: () => {
                  if (confirm(`Remove the tour ${each.title}? Its file ${directory}/${each.name}.json is deleted.`)) void api.removeTour(each.name).then(() => listTours());
                },
              },
            },
            "✕",
          ),
        ),
      ),
    );
    note.textContent = tours.length === 0 ? `no tours yet in ${directory}/` : `kept in ${directory}/`;
  } catch (error) {
    list.replaceChildren();
    note.textContent = error instanceof Error ? error.message : String(error);
  }
}

/** Starts the recording of a tour by the name typed: a tour of that name that exists is played instead. */
async function record(): Promise<void> {
  const field = element<HTMLInputElement>("tour-name");
  const name = field.value.trim();

  if (!NAME.test(name)) {
    element("tours-note").textContent = "a name of letters, digits, . - _ (it is the file's name)";

    return;
  }

  const known = await read(name);
  field.value = "";
  play(name, known?.steps.length ?? 0);
}

element<HTMLButtonElement>("tour-record").addEventListener("click", () => void record());
element<HTMLInputElement>("tour-name").addEventListener("keydown", (event) => {
  if (event.key === "Enter") void record();
});
// The list is fixed and placed under its button, as the export menu's is: the header clips what overflows it.
menu.addEventListener("toggle", () => {
  if (!menu.open) return;
  const summary = menu.querySelector("summary")!.getBoundingClientRect();
  const box = element<HTMLDivElement>("tours");
  box.style.top = `${summary.bottom + 4}px`;
  box.style.left = `${Math.max(8, Math.min(summary.left, window.innerWidth - box.offsetWidth - 8))}px`;
  void listTours();
});
