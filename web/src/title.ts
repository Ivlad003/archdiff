// The title of the picture over the canvas (with what a review or a
// comparison found), the crumbs back up to the overviews, and the line
// under the canvas — the reason the picture looks as it does, or for a
// moment a notice from a tool (a count of matches, a save, a file that
// changed). app.ts sets the title and the reason on every load; a tool
// gives its notice and clears it, and the reason comes back. A button that
// reloads the picture keeps its notice for after the load
// (`noticeAfterLoad`), which would otherwise clear it. A picture with
// nothing to draw, or one that could not be drawn, says why in the
// middle of the canvas (`showEmpty`): a blank canvas looks broken.
//
// Entry points: `showTitle`, `showNoTitle`, `renderCrumbs`, `setReason`,
// `notice`, `clearNotice`, `noticeAfterLoad`, `showPendingNotice`,
// `showEmpty`.

import type { ChangeSummary } from "./api.ts";
import { element, h } from "./dom.ts";
import { currentLink, setLink, type Link } from "./link.ts";
import { crumbsOf } from "./navigation.ts";
import { page } from "./page.ts";

const title = element<HTMLSpanElement>("title-text");
const reason = element<HTMLDivElement>("reason");
const empty = element<HTMLDivElement>("empty");

/** The note in the middle of an empty canvas: what it is (nothing to draw, or no picture) and why; null takes it away. */
export function showEmpty(note: { head: string; why: string } | null): void {
  empty.hidden = note === null;
  empty.replaceChildren(...(note === null ? [] : [h("p", {}, h("strong", {}, note.head), note.why)]));
}

/** What a review or a comparison found, for the title: the files changed and the new layer dependencies (against the contract, when there is one). */
function changeTitle(change: ChangeSummary | null): string {
  if (!change) return "";

  if (change.kind === "compare") {
    const warnings = change.heads.filter((head) => head.diff.layerEdgesAdded.length > 0).length;

    return warnings > 0 ? ` — ⚠ ${warnings === 1 ? "1 head adds" : `${warnings} heads add`} a layer dependency` : "";
  }

  const { diff, contract } = change;
  const findings = contract ? diff.layerEdgesAdded.filter((edge) => edge.against) : diff.layerEdgesAdded;
  const dependencies = (count: number): string => (count === 1 ? "1 new layer dependency" : `${count} new layer dependencies`);

  return ` — ${diff.changedFiles.length === 1 ? "1 source file" : `${diff.changedFiles.length} source files`} changed${findings.length > 0 ? ` — ⚠ ${dependencies(findings.length)}${contract ? " against ARCHITECTURE.md" : ""}` : diff.layerEdgesAdded.length > 0 ? ` — ${dependencies(diff.layerEdgesAdded.length)}, allowed by ARCHITECTURE.md` : ""}`;
}

/** The picture's title with what its change found and whether it was drawn by hand; the question it answers as the tooltip. */
export function showTitle(picture: { title: string; question?: string }, change: ChangeSummary | null, drawn: boolean): void {
  title.textContent = `${picture.title}${changeTitle(change)}${drawn ? " (drawn by hand)" : ""}`;
  title.title = picture.question ? `${picture.question[0]!.toUpperCase()}${picture.question.slice(1)}.` : "";
}

/** The title when no picture could be drawn: the error is on the Markdown tab. */
export function showNoTitle(): void {
  title.textContent = "archdiff";
  title.title = "";
}

/** The crumbs from the overviews down to the current view; every crumb but the last opens its view. */
export function renderCrumbs(state: Link): void {
  const box = element<HTMLSpanElement>("crumbs");
  box.replaceChildren();
  const crumbs = crumbsOf(page.views(), state.view);

  for (const [i, crumb] of crumbs.entries()) {
    if (i > 0) box.append(" › ");

    if (i === crumbs.length - 1) box.append(crumb.label);
    else {
      const link = document.createElement("a");
      link.textContent = crumb.label;
      link.addEventListener("click", () => setLink({ ...currentLink(), view: crumb.key }));
      box.append(link);
    }
  }
}

/** The reason of the picture shown, and whether it is bigger than the canvas even at the smallest zoom (said after the reason). */
let pictureReason = "";
let overflowing = false;

/** The line under the canvas: the reason, then the overflow's note; kept as its tooltip so a notice can give way back to it. */
function showReason(): void {
  const text = [pictureReason, overflowing ? "bigger than the canvas even at the smallest zoom: it starts from its beginning; drag along it or use the minimap" : ""].filter(Boolean).join("; ");
  reason.textContent = text;
  reason.title = text;
}

/** The picture's reason under the title; a new reason is a new picture, which the fit says again whether it overflows. */
export function setReason(text: string): void {
  pictureReason = text;
  overflowing = false;
  showReason();
}

/** Whether the fit left part of the picture off the canvas (it is bigger than the canvas at the smallest zoom). */
export function setOverflow(on: boolean): void {
  if (on === overflowing) return;
  overflowing = on;
  showReason();
}

/** A notice under the title for a moment: a tool's hint, a count of matches, a save, a file that changed. */
export function notice(text: string): void {
  reason.textContent = text;
}

/** The picture's reason back under the title, after a notice. */
export function clearNotice(): void {
  reason.textContent = reason.title || "";
}

/** A notice kept for after the picture now being drawn: the load that a button starts clears the line first. */
let pending: string | null = null;

/** A notice to give once the next picture is drawn (`remember as defaults`, `reset`). */
export function noticeAfterLoad(text: string): void {
  pending = text;
}

/** The kept notice, given now that the picture is drawn. */
export function showPendingNotice(): void {
  if (pending === null) return;
  notice(pending);
  pending = null;
}
