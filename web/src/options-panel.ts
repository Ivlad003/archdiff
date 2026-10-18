// The options menu of the header: depth, packages, the changes laid over,
// the fold limit, the line weight, hubs, the Mermaid type, the overlays
// and the presets. Each change goes into the link, so the picture is
// asked for again; "remember" keeps the options as this browser's
// defaults, "reset" forgets them. `showOptions` fills the fields from the
// link on every load.
//
// Entry points: `showOptions`, `applyOptions`, `toggleOptions`, `MAX_DEPTH`.

import { element } from "./dom.ts";
import { notice } from "./title.ts";
import { PRESETS, currentLink, forgetDefaults, rememberDefaults, setLink, type Link } from "./link.ts";
import { page } from "./page.ts";
import { MERMAID_STYLES, OVERLAYS, type MermaidStyle, type Overlay } from "../../src/options.ts";

/** The deepest depth the page offers (the field's `max`): the depth field and the −/+ buttons stop there. */
export const MAX_DEPTH = 12;

const menu = element<HTMLDetailsElement>("options-menu");
const depthInput = element<HTMLInputElement>("depth");
const packagesInput = element<HTMLInputElement>("packages");
const changesInput = element<HTMLInputElement>("changes");
const limitInput = element<HTMLInputElement>("limit");
const weightInput = element<HTMLInputElement>("weight");
const hubsInput = element<HTMLInputElement>("hubs");
const mermaidSelect = element<HTMLSelectElement>("mermaid");
const presetSelect = element<HTMLSelectElement>("preset");
const overlayBoxes = (): HTMLInputElement[] => [...document.querySelectorAll<HTMLInputElement>("#options .overlay")];

/** A value of the Mermaid select that the options table knows. */
function isMermaidStyle(value: string): value is MermaidStyle {
  return (MERMAID_STYLES as readonly string[]).includes(value);
}

/** The fields of the options as the link has them. */
export function showOptions(state: Link): void {
  depthInput.value = state.depth === null ? "" : String(state.depth);
  packagesInput.checked = state.packages;
  changesInput.checked = state.changes;
  limitInput.value = state.limit === null ? "" : String(state.limit);
  weightInput.value = state.weight === null ? "" : String(state.weight);
  hubsInput.checked = state.hubs;
  element<HTMLInputElement>("only-changes").checked = state.onlyChanges;
  mermaidSelect.value = state.mermaid;

  for (const box of overlayBoxes()) box.checked = state.overlays.includes(box.value as Overlay);
}

/** Sets the link as `setLink` does; when the link does not change (the options equal the defaults now), the page still reloads to show them. */
export function applyOptions(state: Link): void {
  const before = location.hash;
  setLink(state);

  if (location.hash === before) void page.load();
}

/** Opens or closes the options (the `o` key). */
export function toggleOptions(): void {
  menu.open = !menu.open;
}

depthInput.addEventListener("change", () => {
  const typed = Number(depthInput.value);
  setLink({ ...currentLink(), depth: depthInput.value === "" || !Number.isFinite(typed) ? null : Math.max(0, Math.min(MAX_DEPTH, Math.floor(typed))) });
});
packagesInput.addEventListener("change", () => setLink({ ...currentLink(), packages: packagesInput.checked }));
changesInput.addEventListener("change", () => setLink({ ...currentLink(), changes: changesInput.checked }));
limitInput.addEventListener("change", () => setLink({ ...currentLink(), limit: limitInput.value === "" ? null : Math.max(1, Number(limitInput.value)) }));
mermaidSelect.addEventListener("change", () => {
  const value = mermaidSelect.value;
  setLink({ ...currentLink(), mermaid: isMermaidStyle(value) ? value : "auto" });
});
weightInput.addEventListener("change", () => setLink({ ...currentLink(), weight: weightInput.value === "" || Number(weightInput.value) <= 1 ? null : Math.floor(Number(weightInput.value)) }));
hubsInput.addEventListener("change", () => setLink({ ...currentLink(), hubs: hubsInput.checked }));
presetSelect.addEventListener("change", () => {
  const preset = PRESETS[presetSelect.value];
  presetSelect.value = "";

  if (preset) applyOptions({ ...currentLink(), ...preset });
});

for (const box of overlayBoxes()) {
  box.addEventListener("change", () => {
    const overlays = overlayBoxes()
      .filter((each) => each.checked)
      .map((checked) => checked.value)
      .filter((value): value is Overlay => OVERLAYS.includes(value as Overlay));
    setLink({ ...currentLink(), overlays });
  });
}

// The panel is fixed so the header's clipping does not cut it: placed under the summary when it opens, kept inside the window.
menu.addEventListener("toggle", () => {
  if (!menu.open) return;
  const summary = menu.querySelector("summary")!.getBoundingClientRect();
  const panel = element<HTMLDivElement>("options");
  panel.style.top = `${summary.bottom + 4}px`;
  panel.style.left = `${Math.max(8, Math.min(summary.left, window.innerWidth - panel.offsetWidth - 8))}px`;
});
document.addEventListener("pointerdown", (event) => {
  if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
});

element<HTMLButtonElement>("options-default").addEventListener("click", () => {
  const now = currentLink();
  notice(rememberDefaults(now) ? "options remembered as the defaults of this browser" : "no storage: the options last this page");
  applyOptions(now);
});
element<HTMLButtonElement>("options-reset").addEventListener("click", () => {
  forgetDefaults();
  applyOptions({ ...currentLink(), depth: null, limit: null, packages: false, overlays: [], mermaid: "auto", changes: false, weight: null, hubs: true, expand: [], lanes: "auto" });
});
