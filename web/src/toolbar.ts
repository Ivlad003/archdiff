// The toolbar over the canvas: the picture select (this subject's
// pictures, then the overviews), the detail presets and depth −/+, the
// tools mix and dim, close opened, split, the lanes (which show; rows or
// columns), the minimap and the project map, only-changes, and find.
// `renderCanvasTools` sets every button from the link on each load;
// `setPictureLanes` takes the lanes of the picture once it is drawn.
//
// Entry points: `renderCanvasTools`, `setPictureLanes`, `toggleTool`,
// `toggleSplit`, `flipLanes`, `focusFind`.

import { findShapes } from "./chains.ts";
import { element } from "./dom.ts";
import { clearNotice, notice } from "./title.ts";
import { OVERVIEWS, currentLink, detailPresets, setLink, type Detail, type Link } from "./link.ts";
import { updateMinimap, toggleMinimap } from "./minimap.ts";
import { siblingViews } from "./navigation.ts";
import { applyOptions } from "./options-panel.ts";
import { page } from "./page.ts";
import { select, tools } from "./picking.ts";
import { projectMapOpen, toggleProjectMap } from "./project-map.ts";
import { defaultDepth, parseView, usesDepth } from "../../src/view-keys.ts";

/** Two canvases side by side need the room Excalidraw's desktop layout wants; below it the split stacks. */
const SPLIT_SIDE_BY_SIDE = 1520;

/** The lanes of the current picture, for the lanes menu. */
let pictureGroups: { id: string; label: string }[] = [];
/** How the current picture's lanes lie, as the layout says: the lanes button flips it. */
let pictureLanes: "rows" | "columns" = "rows";

/** The lanes menu: a box per lane of the picture (and per hidden lane, to bring it back). */
function renderLanes(state: Link): void {
  const list = element<HTMLDivElement>("lanes");
  list.replaceChildren();
  const all = [...pictureGroups, ...state.hideLanes.filter((id) => !pictureGroups.some((group) => group.id === id)).map((id) => ({ id, label: id }))];
  element<HTMLDetailsElement>("lanes-menu").hidden = all.length === 0;

  for (const lane of all) {
    const label = document.createElement("label");
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !state.hideLanes.includes(lane.id);
    box.addEventListener("change", () => {
      const now = currentLink();
      setLink({ ...now, hideLanes: box.checked ? now.hideLanes.filter((id) => id !== lane.id) : [...now.hideLanes, lane.id] });
    });
    label.append(box, lane.label);
    list.append(label);
  }
}

/** The lanes of a picture just drawn and how the layout laid them: the lanes menu and the lanes button read them. */
export function setPictureLanes(state: Link, groups: readonly { id: string; label: string }[], lanes: "rows" | "columns"): void {
  pictureGroups = groups.map((group) => ({ id: group.id, label: group.label }));
  pictureLanes = lanes;
  renderLanes(state);
}

/** The canvas toolbar: the picture select (this subject's pictures, then the overviews), the detail buttons and the tool states. */
export function renderCanvasTools(state: Link): void {
  const picture = element<HTMLSelectElement>("picture");
  picture.replaceChildren();
  const siblings = siblingViews(state.view);

  if (siblings.length > 0) {
    const group = document.createElement("optgroup");
    group.label = "this subject";

    for (const sibling of siblings) group.append(new Option(sibling.label, sibling.key, false, sibling.key === state.view));
    picture.append(group);
  }

  const overview = document.createElement("optgroup");
  overview.label = "overview";

  for (const [key, label] of OVERVIEWS) overview.append(new Option(label, key, false, key === state.view));
  picture.append(overview);

  if (!siblings.some((sibling) => sibling.key === state.view) && !OVERVIEWS.some(([key]) => key === state.view)) picture.prepend(new Option(state.view, state.view, true, true));
  const detail = Object.entries(detailPresets(state.view)).find(([, preset]) => (preset.depth ?? null) === state.depth && (preset.limit ?? null) === state.limit && (preset.weight ?? null) === state.weight && preset.hubs === state.hubs)?.[0];

  for (const button of document.querySelectorAll<HTMLButtonElement>("#canvas-tools [data-detail]")) button.classList.toggle("active", button.dataset["detail"] === detail);
  // A view that goes no depth from a subject (the layers, a matrix) has no depth to step.
  const kind = parseView(state.view)?.kind;
  const stepped = kind !== undefined && usesDepth(kind);

  for (const id of ["depth-less", "depth-more"]) {
    const button = element<HTMLButtonElement>(id);
    button.disabled = !stepped;
    button.title = stepped ? "One step less or more from the subject (no ceiling: past 12 the picture warns)" : "This view does not go a depth from a subject";
  }

  element<HTMLButtonElement>("tool-mix").classList.toggle("active", tools.mix);
  element<HTMLButtonElement>("tool-dim").classList.toggle("active", tools.dim);
  element<HTMLButtonElement>("mix-clear").hidden = state.expand.length === 0;
  element<HTMLButtonElement>("mix-clear").textContent = `close opened (${state.expand.length})`;
  element<HTMLButtonElement>("tool-split").classList.toggle("active", document.body.classList.contains("split"));
  element<HTMLButtonElement>("tool-project").classList.toggle("active", projectMapOpen());
  renderLanes(state);
  updateMinimap();
}

/** Turns a tool of the tap on or off (`m` mix, `d` dim); one at a time, and turning dim off clears the dimming. */
export function toggleTool(name: "mix" | "dim"): void {
  tools[name] = !tools[name];
  const other = name === "mix" ? "dim" : "mix";

  if (tools[name]) tools[other] = false;

  if (name === "dim" && !tools.dim) page.canvas()?.dim(null);
  renderCanvasTools(currentLink());

  if (!tools[name]) clearNotice();
  else notice(name === "mix" ? "mix: tap a module to open it in place; tap its rest shape to close it" : "dim: tap a shape to dim all but its neighbours; tap nothing to clear");
}

/** Opens or closes the second picture beside the canvas: the same page, embedded, starting from the current link. */
export function toggleSplit(force?: boolean): void {
  const on = document.body.classList.toggle("split", force);
  const pane = element<HTMLDivElement>("split");
  const frame = element<HTMLIFrameElement>("split-frame");
  pane.hidden = !on;
  document.body.classList.toggle("stacked", on && window.innerWidth < SPLIT_SIDE_BY_SIDE);

  if (on && !frame.src) frame.src = `${location.pathname}?embed=1${location.hash}`;
  element<HTMLButtonElement>("tool-split").classList.toggle("active", on);
  // The canvas has its new width only after the layout settles: fit then, not now.
  setTimeout(() => page.canvas()?.scrollToContent(), 200);
}

/** Rows ↔ columns, from what the picture shows (the layout says how it laid the lanes), so the first press always flips it. */
export function flipLanes(): void {
  setLink({ ...currentLink(), lanes: pictureLanes === "rows" ? "columns" : "rows" });
}

/** One step of depth, from the link's depth or the view's own (no ceiling: a deep picture says so in its reason). */
function stepDepth(step: -1 | 1): void {
  const now = currentLink();
  const kind = parseView(now.view)?.kind;
  const current = now.depth ?? (kind === undefined ? 1 : defaultDepth(kind));
  setLink({ ...now, depth: Math.max(0, current + step) });
}

element<HTMLButtonElement>("fit").addEventListener("click", () => page.canvas()?.scrollToContent());
element<HTMLSelectElement>("picture").addEventListener("change", () => setLink({ ...currentLink(), view: element<HTMLSelectElement>("picture").value, expand: [] }));

for (const button of document.querySelectorAll<HTMLButtonElement>("#canvas-tools [data-detail]")) {
  button.addEventListener("click", () => {
    const now = currentLink();
    applyOptions({ ...now, ...detailPresets(now.view)[button.dataset["detail"] as Detail] });
  });
}

element<HTMLButtonElement>("depth-less").addEventListener("click", () => stepDepth(-1));
element<HTMLButtonElement>("depth-more").addEventListener("click", () => stepDepth(1));
element<HTMLButtonElement>("tool-mix").addEventListener("click", () => toggleTool("mix"));
element<HTMLButtonElement>("tool-dim").addEventListener("click", () => toggleTool("dim"));
element<HTMLButtonElement>("mix-clear").addEventListener("click", () => setLink({ ...currentLink(), expand: [] }));
element<HTMLButtonElement>("tool-split").addEventListener("click", () => toggleSplit());
window.addEventListener("resize", () => {
  if (document.body.classList.contains("split")) document.body.classList.toggle("stacked", window.innerWidth < SPLIT_SIDE_BY_SIDE);
});
element<HTMLButtonElement>("tool-lanes").addEventListener("click", () => flipLanes());
element<HTMLButtonElement>("tool-minimap").addEventListener("click", () => toggleMinimap());
element<HTMLButtonElement>("tool-project").addEventListener("click", () => toggleProjectMap());
element<HTMLInputElement>("only-changes").addEventListener("change", () => {
  const only = element<HTMLInputElement>("only-changes").checked;
  // Only the changes needs the changes laid over.
  setLink({ ...currentLink(), onlyChanges: only, changes: only ? true : currentLink().changes });
});

// ── Find: a shape of this picture by name, else a view by its subject ────────

const findInput = element<HTMLInputElement>("find");

/** The find field focused (the `/` key). */
export function focusFind(): void {
  findInput.focus();
  findInput.select();
}

findInput.addEventListener("input", () => {
  const hits = findShapes(page.nodes(), findInput.value);
  page.canvas()?.highlight(hits.slice(0, 20).map((node) => node.id));

  if (findInput.value.trim() === "") clearNotice();
  else notice(`${hits.length} ${hits.length === 1 ? "shape matches" : "shapes match"}`);
});
findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const first = findShapes(page.nodes(), findInput.value)[0];

    if (first) {
      select([first.id], true);
    } else {
      // Nothing in this picture (folded away, or elsewhere): the first view whose subject matches opens instead.
      const needle = findInput.value.trim().toLowerCase();
      const subjects = page.views().filter((candidate) => candidate.key.includes(":"));
      const entry = subjects.find((candidate) => candidate.key.slice(candidate.key.indexOf(":") + 1).toLowerCase() === needle) ?? subjects.find((candidate) => candidate.key.toLowerCase().includes(needle));

      if (entry) {
        notice(`not in this picture: opening ${entry.key}`);
        setLink({ ...currentLink(), view: entry.key });
      }
    }
  } else if (event.key === "Escape") {
    findInput.value = "";
    page.canvas()?.highlight([]);
    clearNotice();
    findInput.blur();
  }

  event.stopPropagation();
});
