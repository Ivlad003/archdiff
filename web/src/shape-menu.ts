// What the menu of a right click on the canvas holds: on a shape, the
// views it opens (its own, focus, impact, logic, the other pictures of its
// subject), the changes to suppose of it (a what-if: a module deleted or
// moved, a function split off), the selection, the agent and its code; on
// a line, where it leads; on the empty canvas, the picture's own actions.
// menu.ts draws the list at the pointer; app.ts opens it with these items.
//
// Entry point: `menuItems`.

import { setMode } from "./canvas.ts";
import { neighbourhoodOf } from "./chains.ts";
import type { PickedLine } from "./editor.tsx";
import { currentLink, setLink, readOnlyView } from "./link.ts";
import type { MenuItem } from "./menu.ts";
import { siblingViews } from "./navigation.ts";
import { page } from "./page.ts";
import { copyText, showCode } from "./panel.ts";
import { askSelected, deeperView, explainSelected, labelOf, select, selection, showEdge, toggleSelected } from "./picking.ts";
import { toggleProjectMap } from "./project-map.ts";
import { reviewBase } from "./review.ts";
import { fitPresentation } from "./presentation.ts";
import { commitOfShape, standsFor, subjectView, tagOf } from "../../src/shape-keys.ts";
import { parseView } from "../../src/view-keys.ts";

/** The words of "open" for the view a second tap opens, by its kind. */
const OPEN_LABELS: Partial<Record<string, string>> = { inside: "Open: inside it (its functions and calls)", calls: "Open: its calls", layer: "Open: the layer", logic: "Open: its logic", machine: "Open: the machine", dir: "Open: the directory", commit: "Open: what it did to the architecture" };

function openLabel(key: string): string {
  return OPEN_LABELS[parseView(key)?.kind ?? ""] ?? `Open ${key}`;
}

/** What the reader types for a what-if, as a path of the repository; null when nothing was typed or the question was dismissed. */
function askPath(question: string, offered: string): string | null {
  const typed = window.prompt(question, offered)?.trim().replace(/\\/g, "/") ?? "";

  return typed === "" ? null : typed;
}

/** The what-ifs of a shape: a module deleted, a module moved where the reader says, a top-level function split off into a module the reader names. */
function whatIfItems(kind: string, target: string, open: (key: string) => void): MenuItem[] {
  const hash = target.indexOf("#");
  const module = hash === -1 ? target : target.slice(0, hash);
  const directory = module.slice(0, module.lastIndexOf("/") + 1);

  if (kind === "module" || kind === "participant") {
    return [
      { label: "What if it were deleted", hint: "what breaks, the contract and the cycles after it", run: () => open(`whatif:delete:${target}`) },
      {
        label: "What if it moved…",
        hint: "to a path or a directory you name",
        run: () => {
          const to = askPath(`Move ${target} to (a path, or a directory ending in /):`, directory);

          if (to !== null) open(`whatif:move:${target}>${to}`);
        },
      },
    ];
  }

  // A function of the module's top level; a method leaves with its class.
  if (kind !== "fn" || hash === -1 || target.slice(hash + 1).includes(".")) return [];
  const name = target.slice(hash + 1);

  return [
    {
      label: "What if it were split off…",
      hint: "into a new module you name",
      run: () => {
        const to = askPath(`Split ${name} off ${module} into the new module:`, `${directory}${name}${module.slice(module.lastIndexOf("."))}`);

        if (to !== null) open(`whatif:split:${module}#${name}>${to}`);
      },
    },
  ];
}

/** The menu of a right click: on a shape (its views, the changes to suppose of it, the selection, the agent, its code), on a line, or on the empty canvas. */
export function menuItems(id: string | null, lines: PickedLine[]): MenuItem[] {
  const now = currentLink();
  const go = (key: string) => () => setLink({ ...now, view: key });
  const node = id === null ? undefined : page.nodes().get(id);

  if (node) {
    // What a second tap opens: the shape's own view, or for the function the picture starts from, its logic.
    const own = deeperView(node.id);
    const subject = subjectView(node);
    const target = standsFor(node);
    const fnLike = node.kind === "fn" || (node.kind === "action" && target.includes("#"));
    const tag = tagOf(node);
    const items: MenuItem[] = [];

    if (own) items.push({ label: openLabel(own), hint: "tap again", run: go(own) });

    // A commit (of the branches, of the timeline): the code at it; in the branches, the code and the review of its branch.
    const sha = commitOfShape(node.opens);

    if (sha !== null) {
      const branch = parseView(now.view)?.kind === "branches" ? node.group : undefined;
      items.push({ label: "The code at this commit", hint: `${sha.slice(0, 7)} in the head field`, run: () => setLink({ ...now, view: "layers", head: sha, heads: [] }) });

      if (branch) {
        items.push({ label: `The code of ${branch}`, hint: "its tip in the head field", run: () => setLink({ ...now, view: "layers", head: branch, heads: [] }) });
        items.push({ label: `Review ${branch}`, hint: "since it left the base", disabled: branch === reviewBase(), run: () => setLink({ ...now, view: "review", head: branch, heads: [] }) });
      }
    }

    if (node.kind === "module" || node.kind === "participant" || fnLike) items.push({ label: "Focus: everything joined to it", hint: "callers, callees, imports, across the modules", run: go(`focus:${target}`) });

    // The blast radius of a change to it: a module, a function, or a class with its methods.
    if (node.kind === "module" || node.kind === "participant" || node.kind === "class" || fnLike) items.push({ label: "Impact: what a change to it reaches", hint: "its dependents by distance, the tests, the risk", run: go(`impact:${target}`) });

    if (fnLike && own !== `logic:${target}`) items.push({ label: "Logic: the flowchart and its rules", run: go(`logic:${target}`) });

    // The siblings but the view a second tap opens, and focus, impact and logic, which have their own items above.
    for (const sibling of subject ? siblingViews(subject) : []) {
      const kind = parseView(sibling.key)?.kind;

      if (sibling.key !== own && kind !== "focus" && kind !== "impact" && kind !== "logic") items.push({ label: sibling.label, run: go(sibling.key) });
    }

    // A change supposed, not made: its picture opens as a review's does.
    const supposed = whatIfItems(node.kind, target, (key) => go(key)());

    if (supposed.length > 0) items.push("—", ...supposed);
    items.push("—", { label: selection().includes(node.id) ? "Take out of the selection" : "Add to the selection", hint: "Shift+tap", run: () => toggleSelected(node.id) });
    items.push({ label: "Ask the agent about it", hint: tag?.tag ?? "no tag for this kind of shape", disabled: tag === null, run: () => askSelected([node.id]) });
    items.push({ label: "Explain it, step by step", hint: "a tour the agent writes", disabled: tag === null, run: () => explainSelected([node.id]) });
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
    { label: "Explain this picture, step by step", hint: "a tour the agent writes", run: () => explainSelected([]) },
    { label: "Project map", hint: "p", run: () => toggleProjectMap(true) },
    { label: "Fit the picture", hint: "0", run: () => fitPresentation() },
    { label: "Clear the selection", hint: "Esc", disabled: selection().length === 0, run: () => select([]) },
    { label: "Edit the drawing", hint: "e", disabled: readOnlyView(now.view), run: () => setMode("edit") },
  ];
}
