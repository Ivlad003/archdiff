// The room of the page: what gives way to the canvas, and when. The two
// side panels are docked beside the centre while the window has the room
// (the centre keeps the width Excalidraw's desktop layout needs); below it
// a panel is a drawer — out of the way until asked for, then laid over the
// canvas, which keeps its size and its picture's place. A docked panel
// folds away and back (the header's buttons, the tabs on the centre's
// edges, Ctrl+B and Ctrl+]) and is as wide as the reader drags its edge
// (a double click: the width it came with); both are remembered in this
// browser. The right drawer opens by itself for what a tap picks and goes
// when nothing is picked any more; the left one goes once a view is
// picked. *Full canvas* (`f`) makes both panels drawers on any window:
// the canvas has the page's whole width, and what a tap picks still comes
// to be read. The canvas's toolbar folds to its first controls (by itself
// on a narrow canvas), the legend hides, and the menus of the page — the
// options, the exports, the lanes — close on a press outside them and on
// Escape.
//
// Entry points: `showPanel`, `panelShown`, `revealDetails`,
// `releaseDetails`, `closeDrawers`, `drawerOpen`, `closeOpenDrawers`,
// `detailsCover`, `onDetailsClosed`, `toggleFullCanvas`, `toggleLegend`,
// `toggleTools`, `closePopovers`, `popoverOpen`.

import { element, remember, rememberText, remembered, rememberedText } from "./dom.ts";
import { page } from "./page.ts";

export type Side = "left" | "right";

/** The width the centre keeps beside docked panels: under it Excalidraw folds into its phone layout, its toolbar along the bottom. */
const CENTRE_ROOM = 730;
/** The canvas under this width has no room for a row of every tool: the toolbar folds to its first controls unless the reader said otherwise. */
const TOOLS_ROOM = 860;
/** How narrow and how wide a panel may be dragged, and how far past the narrowest a drag folds it away. */
const WIDTHS: Record<Side, { min: number; max: number }> = { left: { min: 180, max: 560 }, right: { min: 280, max: 900 } };
const FOLD_PAST = 70;

const body = document.body;
/** The page embedded in a split pane has no panels, no header and no legend to arrange. */
const embedded = new URLSearchParams(location.search).get("embed") === "1";

/** The right drawer was opened by a pick, not by the reader: it goes with the pick. */
let openedByPick = false;

/** Who hears that the details' drawer went: the picture it was moved for goes back (picking.ts). */
const closedListeners = new Set<() => void>();

/** Calls `listener` whenever the open drawer of the details goes away, whoever closed it. */
export function onDetailsClosed(listener: () => void): void {
  closedListeners.add(listener);
}

/** Takes a drawer away; the details' going is told to who listens. */
function closeDrawer(side: Side): void {
  if (!body.classList.contains(`open-${side}`)) return;
  body.classList.remove(`open-${side}`);

  if (side === "right") for (const listener of closedListeners) listener();
}

/** How much of the canvas's right side the open drawer of the details covers, in pixels; 0 when none is open. */
export function detailsCover(): number {
  return !embedded && isDrawer("right") && body.classList.contains("open-right") ? element("right").getBoundingClientRect().width : 0;
}

/** The width of a panel as the styles have it now (the reader's, else the page's own for this window), in pixels. */
function panelWidth(side: Side): number {
  const width = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--${side}`));

  return Number.isFinite(width) ? width : side === "left" ? 280 : 420;
}

function isDrawer(side: Side): boolean {
  return body.classList.contains(`drawer-${side}`);
}

/** Whether the panel is on the page now: a docked one not folded away, a drawer that is open. */
export function panelShown(side: Side): boolean {
  return isDrawer(side) ? body.classList.contains(`open-${side}`) : !body.classList.contains(`hide-${side}`);
}

/** The buttons that fold a panel say what a press does now, and the header's whether the panel is there. */
function sync(): void {
  const names: Record<Side, [what: string, key: string]> = { left: ["the views", "Ctrl+B"], right: ["the details", "Ctrl+]"] };

  for (const side of ["left", "right"] as const) {
    const shown = panelShown(side);
    const [what, key] = names[side];
    const tab = element<HTMLButtonElement>(`edge-${side}`);
    // The arrow points where the panel's edge goes.
    tab.textContent = (side === "left") === shown ? "‹" : "›";
    tab.title = `${shown ? "Hide" : "Show"} ${what} (${key})`;
    tab.setAttribute("aria-expanded", String(shown));
    element<HTMLButtonElement>(`toggle-${side}`).setAttribute("aria-pressed", String(shown));
  }
}

/** A picture the reader did not move is fitted again to the room the canvas has now (its toolbar folded, a row gone). */
function refit(): void {
  requestAnimationFrame(() => {
    const canvas = page.canvas();

    if (canvas && !canvas.moved()) canvas.scrollToContent();
  });
}

/**
 * Docked or a drawer, by the room: the right panel gives way first, when the two panels would leave the centre under
 * `CENTRE_ROOM`; the left one when it alone would. Full canvas makes both drawers. A panel that is docked again is as
 * the reader left it docked.
 */
function arrange(): void {
  if (embedded) return;
  const full = body.classList.contains("full-canvas");
  const room = window.innerWidth;
  const drawers: Record<Side, boolean> = { left: full || room - panelWidth("left") < CENTRE_ROOM, right: full || room - panelWidth("left") - panelWidth("right") < CENTRE_ROOM };

  for (const side of ["left", "right"] as const) {
    // A panel docked again is no open drawer.
    if (!drawers[side]) closeDrawer(side);
    body.classList.toggle(`drawer-${side}`, drawers[side]);
  }

  if (!drawers.right) openedByPick = false;
  sync();
}

/** Shows a panel or takes it away; without `on`, the other of what it is now. A docked panel's choice is remembered, a drawer's lasts until it closes. */
export function showPanel(side: Side, on?: boolean): void {
  if (embedded) return;
  const next = on ?? !panelShown(side);

  if (isDrawer(side)) {
    if (next) body.classList.add(`open-${side}`);
    else closeDrawer(side);

    if (side === "right") openedByPick = false;
  } else {
    body.classList.toggle(`hide-${side}`, !next);
    remember(`archdiff.hide-${side}`, !next);
  }

  if (side === "right" && next) body.classList.remove("news-right");
  sync();
}

/**
 * Something to read on the right — a shape's page, a line's, the code, the chat: a drawer opens for it (and goes with
 * the pick, `releaseDetails`); a docked panel the reader folded away stays away, and its tab says there is something.
 */
export function revealDetails(): void {
  if (embedded || panelShown("right")) return;

  if (isDrawer("right")) {
    body.classList.add("open-right");
    openedByPick = true;
    sync();
  } else body.classList.add("news-right");
}

/** Nothing picked any more: the drawer a pick opened goes, and the tab's mark. */
export function releaseDetails(): void {
  body.classList.remove("news-right");

  if (!openedByPick) return;
  openedByPick = false;
  closeDrawer("right");
  sync();
}

/** A new picture: the drawer of the views goes (a view was picked), and the one a pick opened. */
export function closeDrawers(): void {
  if (isDrawer("left") && body.classList.contains("open-left")) {
    closeDrawer("left");
    sync();
  }

  releaseDetails();
}

/** Whether a drawer is open: Escape closes it before it clears the selection. */
export function drawerOpen(): boolean {
  return (["left", "right"] as const).some((side) => isDrawer(side) && body.classList.contains(`open-${side}`));
}

/** Closes every open drawer (Escape). */
export function closeOpenDrawers(): void {
  for (const side of ["left", "right"] as const) if (isDrawer(side)) closeDrawer(side);
  openedByPick = false;
  sync();
}

// ── Full canvas ──────────────────────────────────────────────────────────────

/** The canvas across the whole page: both panels become drawers, whatever room the window has (`f`); remembered in this browser. */
export function toggleFullCanvas(force?: boolean): void {
  if (embedded) return;
  const on = body.classList.toggle("full-canvas", force);
  remember("archdiff.full-canvas", on);
  const button = element<HTMLButtonElement>("full-canvas");
  button.classList.toggle("active", on);
  button.setAttribute("aria-pressed", String(on));
  arrange();
}

// ── The legend and the toolbar ───────────────────────────────────────────────

/** Shows the legend under the canvas or hides it; remembered in this browser. */
export function toggleLegend(force?: boolean): void {
  const off = body.classList.toggle("legend-off", force === undefined ? undefined : !force);
  remember("archdiff.legend.off", off);
  const button = element<HTMLButtonElement>("legend-toggle");
  button.classList.toggle("active", !off);
  button.setAttribute("aria-pressed", String(!off));
}

/** Where this browser keeps the reader's choice for the toolbar: `folded` or `open`; nothing kept, the canvas's width decides. */
const TOOLS_KEY = "archdiff.tools";

/** The toolbar as the reader chose it, else folded on a canvas too narrow for one row of every tool. */
function arrangeTools(): void {
  const chosen = rememberedText(TOOLS_KEY);
  const width = element("canvas-wrap").clientWidth;
  const folded = chosen === "folded" || (chosen !== "open" && width > 0 && width < TOOLS_ROOM);
  const changed = folded !== body.classList.contains("tools-folded");
  body.classList.toggle("tools-folded", folded);
  const button = element<HTMLButtonElement>("tools-fold");
  button.classList.toggle("active", !folded);
  button.setAttribute("aria-expanded", String(!folded));
  button.textContent = folded ? "tools ▸" : "tools ◂";

  if (changed) refit();
}

/** Folds the canvas's toolbar to its first controls (the picture, show as, find) or unfolds it; the choice is remembered. */
export function toggleTools(): void {
  rememberText(TOOLS_KEY, body.classList.contains("tools-folded") ? "open" : "folded");
  arrangeTools();
}

// ── The menus of the page ────────────────────────────────────────────────────

/** The menus that open under a button of the page (a `details` each): one at a time, closed by a press outside or Escape. */
const popovers = (): HTMLDetailsElement[] => [...document.querySelectorAll<HTMLDetailsElement>("details.popover")];

export function popoverOpen(): boolean {
  return popovers().some((menu) => menu.open);
}

/** Closes the open menus, but the one given. */
export function closePopovers(but: HTMLDetailsElement | null = null): void {
  for (const menu of popovers()) if (menu !== but && menu.open) menu.open = false;
}

document.addEventListener("pointerdown", (event) => {
  const inside = event.target instanceof Element ? event.target.closest<HTMLDetailsElement>("details.popover") : null;
  closePopovers(inside);
});

for (const menu of popovers()) {
  menu.addEventListener("toggle", () => {
    if (menu.open) closePopovers(menu);
  });
}

// ── A panel's width ──────────────────────────────────────────────────────────

/** The reader's width of a panel, kept in this browser; null puts the page's own back. */
function setWidth(side: Side, width: number | null): void {
  if (width === null) document.documentElement.style.removeProperty(`--${side}`);
  else document.documentElement.style.setProperty(`--${side}`, `${Math.round(width)}px`);
}

/** The widest a panel may be now: its own ceiling, and what leaves the centre room beside the other docked panel. */
function widest(side: Side): number {
  const other: Side = side === "left" ? "right" : "left";
  const beside = !isDrawer(side) && !isDrawer(other) && panelShown(other) ? panelWidth(other) : 0;

  return Math.max(WIDTHS[side].min, Math.min(WIDTHS[side].max, window.innerWidth - beside - (isDrawer(side) ? 64 : 360)));
}

/** A drag of a panel's edge sets its width; dragged well past its narrowest, the panel folds away at the width it had. */
function listenForResize(side: Side): void {
  const handle = element<HTMLDivElement>(`resize-${side}`);

  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const from = event.clientX;
    const before = panelWidth(side);
    let fold = false;
    body.classList.add("resizing");

    const move = (moved: PointerEvent): void => {
      const wanted = before + (side === "left" ? moved.clientX - from : from - moved.clientX);
      fold = wanted < WIDTHS[side].min - FOLD_PAST;
      handle.classList.toggle("folding", fold);
      setWidth(side, Math.max(WIDTHS[side].min, Math.min(widest(side), wanted)));
    };

    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
      handle.classList.remove("folding");
      body.classList.remove("resizing");

      if (fold) {
        setWidth(side, before);
        showPanel(side, false);
      } else rememberText(`archdiff.width-${side}`, String(Math.round(panelWidth(side))));

      arrange();
    };

    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  });
  // A double click: the width the page gives the panel in this window.
  handle.addEventListener("dblclick", () => {
    setWidth(side, null);
    rememberText(`archdiff.width-${side}`, null);
    arrange();
  });
}

// ── The page as this browser left it ─────────────────────────────────────────

if (!embedded) {
  for (const side of ["left", "right"] as const) {
    const kept = Number(rememberedText(`archdiff.width-${side}`));

    if (Number.isFinite(kept) && kept >= WIDTHS[side].min && kept <= WIDTHS[side].max) setWidth(side, kept);

    if (remembered(`archdiff.hide-${side}`)) body.classList.add(`hide-${side}`);
    listenForResize(side);
    element<HTMLButtonElement>(`toggle-${side}`).addEventListener("click", () => showPanel(side));
    element<HTMLButtonElement>(`edge-${side}`).addEventListener("click", () => showPanel(side));
  }

  if (remembered("archdiff.full-canvas")) body.classList.add("full-canvas");
  element<HTMLButtonElement>("full-canvas").classList.toggle("active", body.classList.contains("full-canvas"));
  element<HTMLButtonElement>("full-canvas").addEventListener("click", () => toggleFullCanvas());
  window.addEventListener("resize", arrange);
  // A press on the centre leaves the views' drawer: the reader went on to the picture.
  element("centre").addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element) || event.target.closest(".edge-tab")) return;

    if (isDrawer("left") && body.classList.contains("open-left")) {
      closeDrawer("left");
      sync();
    }
  });
  arrange();
}

if (remembered("archdiff.legend.off")) body.classList.add("legend-off");
element<HTMLButtonElement>("legend-toggle").classList.toggle("active", !body.classList.contains("legend-off"));
element<HTMLButtonElement>("legend-toggle").addEventListener("click", () => toggleLegend());
element<HTMLButtonElement>("tools-fold").addEventListener("click", () => toggleTools());
new ResizeObserver(arrangeTools).observe(element("canvas-wrap"));
arrangeTools();
