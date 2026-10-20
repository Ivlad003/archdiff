// The keys of the page, outside the editor (which owns its own) and
// outside the fields: Ctrl+B and Ctrl+] fold the side panels, Ctrl+S saves
// a drawing; `/` finds a shape, `v` filters the views, `o` the options,
// `p` the project map, `0` fits, Backspace goes back, the arrows walk
// from the picked shape and Enter goes into it, `s` splits, `m` mix, `d`
// dim, `l` flips the lanes, `[` and `]` step the head through the
// branches, `b` shows the branches, `e` edits, Escape clears (or closes
// the menu and the project map first). A picture read from git (a review,
// a comparison, a commit, the branches) is not drawn on: the keys of the
// tools are off there.
//
// Entry point: the module itself, imported by app.ts.

import { canvasMode, saveDrawing, setMode } from "./canvas.ts";
import { currentLink, readOnlyView, setLink } from "./link.ts";
import { closeMenu, menuOpen } from "./menu.ts";
import { toggleOptions } from "./options-panel.ts";
import { togglePanel } from "./panel.ts";
import { lastPicked, openShape, select, walk } from "./picking.ts";
import { fitPresentation } from "./presentation.ts";
import { projectMapOpen, toggleProjectMap } from "./project-map.ts";
import { flipLanes, focusFind, toggleSplit, toggleTool } from "./toolbar.ts";
import { stepHead } from "./review.ts";
import { focusViewSearch, toggleTree } from "./views-list.ts";

const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;

function isArrow(key: string): key is (typeof ARROWS)[number] {
  return (ARROWS as readonly string[]).includes(key);
}

/** The keys of reading a picture: none while a field has the focus, none with Ctrl, Alt or Cmd held. */
function readingKey(event: KeyboardEvent): void {
  // The tools of the canvas (mix, dim, split, the editor, the project map) need the canvas: not a scene, a page or code.
  const drawable = !readOnlyView(currentLink().view) && currentLink().as === "canvas";
  const picked = lastPicked();

  if (event.key === "/") {
    event.preventDefault();
    focusFind();
  } else if (event.key === "v") {
    event.preventDefault();
    focusViewSearch();
  } else if (event.key === "o") toggleOptions();
  else if (event.key === "p" && drawable) {
    // The map's search box takes the focus: the key is not typed into it as a search.
    event.preventDefault();
    toggleProjectMap();
  } else if (event.key === "0") fitPresentation();
  else if (event.key === "Backspace") history.back();
  else if (isArrow(event.key) && picked) {
    event.preventDefault();
    walk(event.key);
  } else if (event.key === "Enter" && picked && !(event.target instanceof HTMLButtonElement)) {
    // Enter: into the picked shape's own view (deeper), as a second tap would; a shape that opens nothing says so.
    openShape(picked);
  } else if (event.key === "s" && drawable && !document.body.classList.contains("embed")) toggleSplit();
  else if (event.key === "m" && drawable) toggleTool("mix");
  else if (event.key === "d" && drawable) toggleTool("dim");
  else if (event.key === "l") flipLanes();
  else if (event.key === "t") toggleTree();
  else if (event.key === "[" || event.key === "]") stepHead(event.key === "]" ? 1 : -1);
  else if (event.key === "b") setLink({ ...currentLink(), view: "branches", heads: [] });
  else if (event.key === "e" && drawable) setMode("edit");
  else if (event.key === "Escape") select([]);
}

window.addEventListener("keydown", (event) => {
  const target = event.target;
  const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;

  // The menu and the project map take Escape first.
  if (event.key === "Escape" && (menuOpen() || projectMapOpen())) {
    closeMenu();
    toggleProjectMap(false);

    return;
  }

  if (event.ctrlKey && event.key === "b") {
    event.preventDefault();
    togglePanel("left");
  } else if (event.ctrlKey && event.key === "]") {
    event.preventDefault();
    togglePanel("right");
  } else if (event.ctrlKey && event.key === "s" && canvasMode() === "edit") {
    event.preventDefault();
    void saveDrawing();
  } else if (typing) {
    if (event.key === "Escape") (target as HTMLElement).blur();
  } else if (canvasMode() === "view" && !event.ctrlKey && !event.altKey && !event.metaKey) readingKey(event);
});
