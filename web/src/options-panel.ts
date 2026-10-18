// The options menu of the header: depth, packages, the changes laid over,
// the fold limit, the line weight, hubs, the Mermaid type, the overlays
// and the presets. Each change goes into the link, so the picture is
// asked for again; "remember" keeps the options as this browser's
// defaults, "reset" forgets them and sets every option of the picture back
// to the built-in one. `showOptions` fills the fields from the link on
// every load: the depth's placeholder is the view's own depth, a depth
// past DEEP_DEPTH is marked with its warning (there is no ceiling), and
// the Mermaid types that draw another kind of view are greyed out.
//
// Entry points: `showOptions`, `applyOptions`, `toggleOptions`.

import { element } from "./dom.ts";
import { notice, noticeAfterLoad } from "./title.ts";
import { PRESETS, currentLink, forgetDefaults, rememberDefaults, setLink, type Link } from "./link.ts";
import { page } from "./page.ts";
import { DEFAULT_PICTURE_OPTIONS, MERMAID_ONLY_FOR, MERMAID_STYLES, OVERLAYS, depthWarning, type MermaidStyle, type Overlay } from "../../src/options.ts";
import { FOLD, defaultDepth, foldLimit, parseView, usesDepth } from "../../src/view-keys.ts";

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

/** A typed whole number, or null for an empty or unreadable field (a number field holds "" for what it cannot read). */
function wholeNumber(input: HTMLInputElement): number | null {
  const typed = Number(input.value);

  return input.value.trim() === "" || !Number.isFinite(typed) ? null : Math.floor(typed);
}

/** The fields of the options as the link has them, the depth's placeholder and warning, and the Mermaid types the view can be. */
export function showOptions(state: Link): void {
  const kind = parseView(state.view)?.kind;
  const own = kind !== undefined && usesDepth(kind) ? defaultDepth(kind) : null;
  const warning = own === null ? null : depthWarning(state.depth);
  depthInput.value = state.depth === null ? "" : String(state.depth);
  depthInput.placeholder = own === null ? "not used here" : `auto (${own})`;
  depthInput.classList.toggle("warn", warning !== null);
  depthInput.title = warning ?? (own === null ? "This view does not go a depth from a subject" : `How far from the subject the picture goes; ${own} by default`);
  packagesInput.checked = state.packages;
  changesInput.checked = state.changes;
  limitInput.value = state.limit === null ? "" : String(state.limit);
  // The view's own fold, as the placeholder: the whole map keeps more shapes than the others.
  limitInput.placeholder = String(kind === undefined ? FOLD : foldLimit(kind));
  weightInput.value = state.weight === null ? "" : String(state.weight);
  hubsInput.checked = state.hubs;
  element<HTMLInputElement>("only-changes").checked = state.onlyChanges;

  // A type that draws another kind of view (a state diagram of no machine, a gitGraph of no timeline) is greyed out.
  for (const option of mermaidSelect.options) {
    const only = isMermaidStyle(option.value) ? MERMAID_ONLY_FOR[option.value] : undefined;
    option.disabled = only !== undefined && only.kind !== kind && option.value !== state.mermaid;
    option.title = only !== undefined && only.kind !== kind ? `draws ${only.what} only` : "";
  }

  mermaidSelect.value = state.mermaid;

  for (const box of overlayBoxes()) box.checked = state.overlays.includes(box.value as Overlay);
}

/** Sets the link as `setLink` does; when the link does not change (the options equal the defaults now), the page still reloads to show them. */
export function applyOptions(state: Link): void {
  const before = location.hash;
  setLink(state);

  if (location.hash === before) void page.load();
}

/** Sets one option; when the link stays the same (a value the field had to correct to the one in force), the fields are shown again. */
function setOption(next: Link): void {
  const before = location.hash;
  setLink(next);

  if (location.hash === before) showOptions(currentLink());
}

/** Opens or closes the options (the `o` key). */
export function toggleOptions(): void {
  menu.open = !menu.open;
}

depthInput.addEventListener("change", () => {
  // No ceiling: a deep picture is drawn, and the reason says it may be big.
  const typed = wholeNumber(depthInput);
  setOption({ ...currentLink(), depth: typed === null ? null : Math.max(0, typed) });
});
packagesInput.addEventListener("change", () => setOption({ ...currentLink(), packages: packagesInput.checked }));
changesInput.addEventListener("change", () => setOption({ ...currentLink(), changes: changesInput.checked }));
limitInput.addEventListener("change", () => {
  const typed = wholeNumber(limitInput);
  setOption({ ...currentLink(), limit: typed === null ? null : Math.max(1, typed) });
});
mermaidSelect.addEventListener("change", () => {
  const value = mermaidSelect.value;
  setOption({ ...currentLink(), mermaid: isMermaidStyle(value) ? value : "auto" });
});
weightInput.addEventListener("change", () => {
  const typed = wholeNumber(weightInput);
  setOption({ ...currentLink(), weight: typed === null || typed <= 1 ? null : typed });
});
hubsInput.addEventListener("change", () => setOption({ ...currentLink(), hubs: hubsInput.checked }));
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
    setOption({ ...currentLink(), overlays });
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
  // The reload that follows clears the line: the notice comes once the picture is drawn.
  noticeAfterLoad(rememberDefaults(now) ? "options remembered as the defaults of this browser" : "no storage: the options last this page");
  applyOptions(now);
});
element<HTMLButtonElement>("options-reset").addEventListener("click", () => {
  forgetDefaults();
  noticeAfterLoad("every option back to the built-in one; the remembered defaults are forgotten");
  // Every option of the picture, the ones of the toolbar and the lanes menu too (opened modules, hidden lanes, type-only imports).
  applyOptions({ ...currentLink(), ...DEFAULT_PICTURE_OPTIONS });
});

// A notice of the field itself, given at once: the picture of a deep depth may take a while to come.
depthInput.addEventListener("input", () => {
  const typed = wholeNumber(depthInput);
  const warning = depthWarning(typed);
  depthInput.classList.toggle("warn", warning !== null);

  if (warning) notice(`⚠ ${warning}`);
});
