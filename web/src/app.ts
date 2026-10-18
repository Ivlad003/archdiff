// The page: the list of views on the left, one Excalidraw canvas in the
// middle (reading by default, drawing on demand), and on the right the
// Markdown of the picture or of what is picked on it, the code, the
// coverage, the flow, the chat and the spec. The view and the options
// live in the URL hash (link.ts), so a link opens the same picture and the
// browser's back button walks the path taken. Every change re-asks the
// server, which re-analyses from its cache: the pictures are live.
//
// This module holds the current picture — its shapes, lines and mocks —
// binds the context the other modules read it through (page.ts), loads
// the picture whenever the link or the code changes, and hands the
// canvas's taps to picking.ts. The parts live beside it: the title
// (title.ts), the side panels (panel.ts), what a tap picks (picking.ts),
// the right-click menu (shape-menu.ts), the canvas and the drawing
// (canvas.ts), the toolbar (toolbar.ts), the minimap (minimap.ts), the
// options (options-panel.ts), the views (views-list.ts), the exports
// (export-menu.ts), the review (review.ts), the keys (shortcuts.ts), and
// the tabs of the flow, the chat and the spec.
//
// Entry point: the module itself, loaded by index.html.

import { api, type Line, type Shape } from "./api.ts";
import { canvasHandle, canvasMode, leaveEdit, showScene } from "./canvas.ts";
import { loadAgents, loadTasks } from "./chat.ts";
import { element } from "./dom.ts";
import { renderExports } from "./export-menu.ts";
import { loadFlow } from "./flow-tab.ts";
import { codeHead, currentLink, refsOf, reviewing, readOnlyView, wrongInLink } from "./link.ts";
import { closeMenu, menuOpen, openMenu } from "./menu.ts";
import { updateMinimap } from "./minimap.ts";
import { showOptions } from "./options-panel.ts";
import { bindPage } from "./page.ts";
import { loadCoverage, markdownPanel, renderMarkdown, setMarkdown, setPicturePage, showCode, showTab } from "./panel.ts";
import { openShape, resetSelection, select, selection, tap } from "./picking.ts";
import { mapDots, mapSettled, refreshProjectMap } from "./project-map.ts";
import { loadBranches, loadCommits, loadHeadRefs, showReviewBars } from "./review.ts";
import { menuItems } from "./shape-menu.ts";
import "./shortcuts.ts";
import "./theme.ts";
import { notice, renderCrumbs, setReason, showEmpty, showNoTitle, showPendingNotice, showTitle } from "./title.ts";
import { renderCanvasTools, setPictureLanes } from "./toolbar.ts";
import { listedHead, loadViews, renderViews, viewEntries } from "./views-list.ts";
import { depthWarning } from "../../src/options.ts";
import { drawnAtHead, parseView, usesDepth } from "../../src/view-keys.ts";

/** The shapes of the current picture by ID. */
let nodes = new Map<string, Shape>();
/** The lines of the current picture, in the diagram's order (the order the canvas names them by). */
let edges: Line[] = [];
/** The mocks of the current view's flow, saved with its drawing. */
let mocks: unknown[] = [];

// The modules reach the page through this context (page.ts), bound before any of them runs a handler.
bindPage({
  canvas: canvasHandle,
  nodes: () => nodes,
  edges: () => edges,
  views: viewEntries,
  mode: canvasMode,
  mocks: () => mocks,
  setMocks: (next) => {
    mocks = next;
  },
  showTab,
  renderMarkdown,
  showCode,
  load: () => load(),
  // After an agent run the code changed: the views, the stats and the coverage.
  loadViews: reloadCode,
});

/** What the canvas does on a tap, a double tap, its own selection (a box in the editor) and a right click. */
/** The code changed (a file saved, an agent run): the views, the stats and the coverage read it again. */
async function reloadCode(): Promise<void> {
  await loadViews();
  void loadCoverage();
}

const CANVAS_EVENTS = {
  pick: tap,
  open: openShape,
  selection: (ids: string[]) => select(ids),
  menu: (id: string | null, at: { x: number; y: number }, lines: Parameters<typeof menuItems>[1]) => openMenu(menuItems(id, lines), at),
};

/** The loads started so far: a load that a newer one overtook (the link changed while it waited) stops where it is. */
let loads = 0;
/** The view whose picture the canvas shows, once its load drew it: for the browser tests. */
let drawn: string | null = null;
/** The link (the hash) of the picture the canvas shows: where a reader who stays in the editor is taken back. */
let shownHash = location.hash;

/**
 * Draws the picture the link names: the fields and bars from the link, then the scene, the title, the page and the
 * tabs. The link may change while the scene is asked for; the newest load draws, and an older one that is still
 * waiting writes nothing more, so a slow picture never lands over the one the link names now.
 */
async function load(): Promise<void> {
  const generation = ++loads;
  const overtaken = (): boolean => generation !== loads;
  const state = currentLink();
  const hash = location.hash;

  // Another head (a branch, a commit picked in the header): the views, the coverage and the map of its code.
  if (codeHead(state) !== listedHead()) {
    try {
      await loadViews();
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
    }

    if (overtaken()) return;
    void loadCoverage();
  }

  // A new picture: nothing selected in it yet.
  resetSelection();
  closeMenu();
  showOptions(state);
  renderCanvasTools(state);
  renderViews();
  // While a deep picture is drawn, which may take a while, the line says why.
  const kind = parseView(state.view)?.kind;
  const deep = kind !== undefined && usesDepth(kind) ? depthWarning(state.depth) : null;
  setReason(deep ? `⚠ ${deep}` : "");
  // A change (a review, a comparison, a commit) is read, not drawn on; the chat has nothing to build from it.
  element<HTMLButtonElement>("edit").disabled = readOnlyView(state.view);
  element("chat-tab").hidden = readOnlyView(state.view);

  /** The scene is on the canvas: a failure after it (the flow, the page) leaves the picture be. */
  let shown = false;

  try {
    renderCrumbs(state);
    showReviewBars(state);
    const result = await api.scene(state.view, state, refsOf(state));

    if (overtaken()) return;
    showTitle(result.diagram, result.change, result.drawn, drawnAtHead(kind) ? state.head : null);
    nodes = new Map(result.diagram.nodes.map((node) => [node.id, node]));
    edges = result.diagram.edges;
    mocks = result.mocks;
    setPictureLanes(state, result.diagram.groups, result.diagram.lanes ?? "rows");
    await showScene(state.view, result.elements, CANVAS_EVENTS);

    if (overtaken()) return;
    shown = true;
    drawn = state.view;
    shownHash = hash;
    // Nothing on the canvas (no shape, no stroke of a drawing): it says why in the middle, not a blank canvas.
    showEmpty(result.elements.length === 0 ? { head: "Nothing to draw here", why: result.diagram.reason || "the picture has no shapes" } : null);
    updateMinimap();
    // A value of the link the options table refuses is left out of the picture, and said first.
    const wrong = wrongInLink().map((problem) => `⚠ ignored in the link: ${problem}`);
    setReason([...wrong, result.diagram.reason ?? ""].filter(Boolean).join("; "));
    renderExports(state);

    if (state.view === "review") void loadCommits(state);

    if (reviewing(state.view)) void loadBranches(state);
    setPicturePage(result.markdown);
    refreshProjectMap();
    await loadFlow();
  } catch (error) {
    if (overtaken()) return;
    const message = error instanceof Error ? error.message : String(error);
    showNoTitle();
    setMarkdown(markdownPanel, message);
    showTab("markdown");

    // No picture for this link: the last one would pass for it; the canvas is cleared and says why.
    if (!shown) {
      nodes = new Map();
      edges = [];
      mocks = [];
      await showScene(state.view, [], CANVAS_EVENTS);

      if (overtaken()) return;
      drawn = state.view;
      shownHash = hash;
      showEmpty({ head: "This picture could not be drawn", why: message });
      updateMinimap();
    }
  }

  if (!overtaken()) showPendingNotice();
}

// Live reload: the server watches the sources; a drawing in progress stays until the editor is left.
api.changes((path) => {
  if (canvasMode() === "edit") {
    notice(`${path} changed; the drawing stays until you leave the editor`);

    return;
  }

  notice(`${path} changed — reloaded`);
  void reloadCode().then(() => load());
});

window.addEventListener("hashchange", () => {
  // A drawing with changes keeps the reader when asked: the link goes back to the picture being drawn on, so the
  // address, the title and the next save all name that picture.
  if (leaveEdit(true)) void load();
  else history.replaceState(null, "", shownHash);
});

// Embedded in a split pane: no header, no side panels, just the picture and its toolbar.
if (new URLSearchParams(location.search).get("embed") === "1") document.body.classList.add("embed");
element<HTMLButtonElement>("back").addEventListener("click", () => history.back());

// A handle for the browser tests and for debugging in the console: the canvas and the state of the page.
(window as unknown as { archdiff: unknown }).archdiff = { canvas: canvasHandle, state: currentLink, nodes: () => nodes, drawn: () => drawn, selected: selection, peeked: () => canvasHandle()?.peeked() ?? null, mapDots, mapSettled, menuOpen };

void (async () => {
  // A repository the server cannot read (a broken archdiff.json) is said in the middle of the page, not a blank one.
  try {
    await loadViews();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showNoTitle();
    setMarkdown(markdownPanel, message);
    showEmpty({ head: "The repository could not be read", why: message });

    return;
  }

  await loadAgents();
  await load();
  await loadCoverage();
  await loadTasks();
  await loadHeadRefs();
})();
