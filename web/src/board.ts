// The walk of the board of uncommitted changes (`view=changes`): the bar
// under the title with the steps — the whole board, then every group of
// changed modules in the order a reviewer reads them (src/board.ts) — and
// the buttons and keys (`.` and `,`) that step through them. A step opens
// the group's own picture (`changes:<layer>:<dir>`) with its diff on the
// Markdown tab. The board is of the working tree, so the live reload
// draws it again whenever a file changes: the bar is filled from every
// picture anew, and a group the change no longer holds says so.
//
// Entry points: `showBoardBar`, `fillBoardBar`, `openBoard`.

import type { Board } from "./api.ts";
import { leaveEdit } from "./canvas.ts";
import { element } from "./dom.ts";
import { revealDetails } from "./layout.ts";
import { currentLink, setLink, type Link } from "./link.ts";
import { page } from "./page.ts";
import { notice } from "./title.ts";
import { offerWalk } from "./walk.ts";
import { parseView } from "../../src/view-keys.ts";

const bar = element<HTMLDivElement>("board");
const steps = element<HTMLSelectElement>("board-steps");
const note = element<HTMLSpanElement>("board-note");

/** The view of the whole board, the first step of the walk. */
const BOARD = "changes";

/** The steps of the walk as the last picture gave them: the board, then its groups. */
let keys: string[] = [BOARD];
/** A step was just taken: the picture it leads to shows its page (the group's diff) on the Markdown tab. */
let stepped = false;

function onBoard(view: string): boolean {
  return parseView(view)?.kind === "changes";
}

/** The bar on the board's views and nowhere else, as the link says — before the picture comes. */
export function showBoardBar(state: Link): void {
  bar.hidden = !onBoard(state.view);
  offerWalk("board", bar.hidden ? null : step);
}

/** The steps of the walk from the picture just drawn, the current one picked; null (no picture) leaves only the board. */
export function fillBoardBar(state: Link, board: Board | null): void {
  if (!onBoard(state.view)) return;
  const groups = board?.groups ?? [];
  keys = [BOARD, ...groups.map((group) => group.key)];
  steps.replaceChildren(new Option(`the whole board: ${groups.length} ${groups.length === 1 ? "group" : "groups"}`, BOARD));

  for (const [i, group] of groups.entries()) steps.append(new Option(`${i + 1} of ${groups.length} · ${group.label} — ${group.modules.length} ${group.modules.length === 1 ? "module" : "modules"}`, group.key));

  // A group the working tree no longer changes (committed, put back while its picture was open): named, to step on from.
  if (!keys.includes(state.view)) steps.prepend(Object.assign(new Option(`${state.view.slice(BOARD.length + 1)} — no longer changed`, state.view), { disabled: true }));
  steps.value = state.view;
  const at = keys.indexOf(state.view);
  element<HTMLButtonElement>("board-prev").disabled = at === 0;
  element<HTMLButtonElement>("board-next").disabled = at === keys.length - 1;
  note.textContent = board === null ? "" : `against ${board.base} · ${board.files} ${board.files === 1 ? "source file" : "source files"} changed`;

  if (stepped) {
    stepped = false;
    page.showTab("markdown");
    revealDetails();
  }
}

/** Opens a step of the walk: its picture, and its page on the Markdown tab once it is drawn. */
function open(key: string): void {
  if (key === currentLink().view || !leaveEdit()) return;
  stepped = true;
  setLink({ ...currentLink(), view: key });
}

/** The next or the previous step of the walk; past either end it says so and stays. */
function step(by: 1 | -1): void {
  const at = keys.indexOf(currentLink().view);
  // From a group that is gone: on to the first group, back to the board.
  const next = at === -1 ? (by === 1 && keys.length > 1 ? 1 : 0) : at + by;

  if (next < 0 || next >= keys.length) return notice(by === 1 ? "the last group of the walk" : "the whole board: the walk starts here");
  open(keys[next]!);
}

/** The board of the uncommitted changes, from any view (the `c` key). */
export function openBoard(): void {
  if (leaveEdit()) setLink({ ...currentLink(), view: BOARD, heads: [] });
}

element<HTMLButtonElement>("board-prev").addEventListener("click", () => step(-1));
element<HTMLButtonElement>("board-next").addEventListener("click", () => step(1));
steps.addEventListener("change", () => open(steps.value));
