// What the menu of a right click on the canvas holds: on a shape, the
// views it opens (its own, focus, logic, the other pictures of its
// subject), the selection, the agent and its code; on a line, where it
// leads; on the empty canvas, the picture's own actions. menu.ts draws
// the list at the pointer; app.ts opens it with these items.
//
// Entry point: `menuItems`.

import { setMode } from "./canvas.ts";
import { neighbourhoodOf } from "./chains.ts";
import type { PickedLine } from "./editor.tsx";
import { currentLink, reviewing, setLink } from "./link.ts";
import type { MenuItem } from "./menu.ts";
import { siblingViews } from "./navigation.ts";
import { page } from "./page.ts";
import { copyText, showCode } from "./panel.ts";
import { askSelected, labelOf, select, selection, showEdge, toggleSelected } from "./picking.ts";
import { toggleProjectMap } from "./project-map.ts";
import { opensView, standsFor, subjectView, tagOf } from "../../src/shape-keys.ts";
import { parseView } from "../../src/view-keys.ts";

/** The words of "open" for the view a second tap opens, by its kind. */
const OPEN_LABELS: Partial<Record<string, string>> = { inside: "Open: inside it (its functions and calls)", calls: "Open: its calls", layer: "Open: the layer", logic: "Open: its logic", machine: "Open: the machine", dir: "Open: the directory" };

function openLabel(key: string): string {
  return OPEN_LABELS[parseView(key)?.kind ?? ""] ?? `Open ${key}`;
}

/** The menu of a right click: on a shape (its views, the selection, the agent, its code), on a line, or on the empty canvas. */
export function menuItems(id: string | null, lines: PickedLine[]): MenuItem[] {
  const now = currentLink();
  const go = (key: string) => () => setLink({ ...now, view: key });
  const node = id === null ? undefined : page.nodes().get(id);

  if (node) {
    const own = opensView(node);
    const subject = subjectView(node);
    const target = standsFor(node);
    const fnLike = node.kind === "fn" || (node.kind === "action" && target.includes("#"));
    const tag = tagOf(node);
    const items: MenuItem[] = [];

    if (own) items.push({ label: openLabel(own), hint: "tap again", run: go(own) });

    if (node.kind === "module" || node.kind === "participant" || fnLike) items.push({ label: "Focus: everything joined to it", hint: "callers, callees, imports, across the modules", run: go(`focus:${target}`) });

    if (fnLike) items.push({ label: "Logic: the flowchart and its rules", run: go(`logic:${target}`) });

    // The siblings but the view a second tap opens, and focus and logic, which have their own items above.
    for (const sibling of subject ? siblingViews(subject) : []) {
      const kind = parseView(sibling.key)?.kind;

      if (sibling.key !== own && kind !== "focus" && kind !== "logic") items.push({ label: sibling.label, run: go(sibling.key) });
    }
    items.push("—", { label: selection().includes(node.id) ? "Take out of the selection" : "Add to the selection", hint: "Shift+tap", run: () => toggleSelected(node.id) });
    items.push({ label: "Ask the agent about it", hint: tag?.tag ?? "no tag for this kind of shape", disabled: tag === null, run: () => askSelected([node.id]) });
    items.push({ label: "Dim all but its neighbours", run: () => page.canvas()?.dim(neighbourhoodOf(page.edges(), node.id)) });
    items.push("—", { label: "Show the code", disabled: !node.ref?.file, run: () => void showCode(node) });
    items.push({ label: "Copy the name", hint: target, run: () => void copyText(target) });

    return items;
  }

  if (lines.length > 0) {
    const line = lines[0]!;

    return [
      { label: "Where this line leads", hint: `${labelOf(line.from)} → ${labelOf(line.to)}`, run: () => void showEdge(lines, false) },
      { label: "Follow the chain onward", hint: "Shift+tap", run: () => void showEdge(lines, true) },
    ];
  }

  return [
    { label: "Ask the agent about this picture", run: () => askSelected([]) },
    { label: "Project map", hint: "p", run: () => toggleProjectMap(true) },
    { label: "Fit the picture", hint: "0", run: () => page.canvas()?.scrollToContent() },
    { label: "Clear the selection", hint: "Esc", disabled: selection().length === 0, run: () => select([]) },
    { label: "Edit the drawing", hint: "e", disabled: reviewing(now.view), run: () => setMode("edit") },
  ];
}
