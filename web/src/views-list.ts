// The list of views on the left: every picture the repository has, in
// groups (the overviews, the machines, the layers, the directories, the
// entry points, the types, the modules), filtered as you type (`v`); and
// the header's line with the repository's root and its numbers.
// `loadViews` asks the server again after every change of the code.
//
// Entry points: `loadViews`, `viewEntries`, `renderViews`,
// `focusViewSearch`.

import { api, type ViewEntry } from "./api.ts";
import { setAgentName } from "./chat.ts";
import { element } from "./dom.ts";
import { currentLink, setLink } from "./link.ts";
import { togglePanel } from "./panel.ts";

const list = element<HTMLUListElement>("views");
const search = element<HTMLInputElement>("search");

/** The groups of the list: the overviews by key (`cycles:fns` is a key of the cycles kind), the rest by kind. */
const GROUPS: [label: string, overview: boolean, members: string[]][] = [
  ["Overview", true, ["layers", "coverage", "classes", "matrix", "metrics", "cycles", "cycles:fns", "machines", "events", "tests", "hotspots", "packages", "timeline"]],
  ["State machines", false, ["machine"]],
  ["Layers", false, ["layer"]],
  ["Directories", false, ["dir"]],
  ["Entry points (call trees)", false, ["calls"]],
  ["Types (where they flow)", false, ["type"]],
  ["Modules", false, ["module"]],
];
/** How many views of a group show unfiltered, and filtered: a long group (every module) shows its first; the filter finds the rest. */
const SHOWN = { all: 60, filtered: 400 };

let views: ViewEntry[] = [];

export function viewEntries(): ViewEntry[] {
  return views;
}

export function renderViews(): void {
  const state = currentLink();
  list.replaceChildren();
  const needle = search.value.trim().toLowerCase();
  const cap = needle === "" ? SHOWN.all : SHOWN.filtered;

  for (const [label, overview, kinds] of GROUPS) {
    const members = views.filter((view) => (overview ? kinds.includes(view.key) : kinds.includes(view.kind)) && (needle === "" || view.title.toLowerCase().includes(needle) || view.key.toLowerCase().includes(needle)));

    if (members.length === 0) continue;
    const head = document.createElement("li");
    head.className = "group";
    head.textContent = `${label} (${members.length})`;
    list.append(head);

    for (const view of members.slice(0, cap)) {
      const item = document.createElement("li");
      item.textContent = view.title;
      item.title = view.key;
      item.classList.toggle("active", view.key === state.view);
      item.addEventListener("click", () => setLink({ ...currentLink(), view: view.key }));
      list.append(item);
    }

    if (members.length > cap) {
      const more = document.createElement("li");
      more.className = "muted";
      more.textContent = `… ${members.length - cap} more: type to filter`;
      list.append(more);
    }
  }
}

/** The views and the numbers of the repository, the agent the server may run; the list drawn again. */
export async function loadViews(): Promise<void> {
  const response = await api.views();
  views = response.views;
  setAgentName(response.agent);
  element("root").textContent = response.root;
  const s = response.stats;
  // A server that cannot follow the code says so here: the pictures stay as they were until a reload.
  const notFollowing = response.watching.problem ? ` · ⚠ not following the code: ${response.watching.problem}` : "";
  element("stats").textContent = `${s.files} files · ${s.fns} functions · ${s.deps} imports · ${s.calls} calls · ${s.gaps} gaps · ${s.ms.total} ms${notFollowing}`;
  renderViews();
}

/** The filter of the views focused, the left panel shown (the `v` key). */
export function focusViewSearch(): void {
  togglePanel("left", false);
  search.focus();
  search.select();
}

search.addEventListener("input", () => renderViews());
