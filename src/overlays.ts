// Overlays: marks laid over any view without changing its structure, so
// two questions are answered by one picture. `tests`: modules no test
// file imports are marked; `storages`: modules that hold data (stores,
// databases, caches) are labelled; `heat`: every module or function is
// shaded by the calls into it from other modules. Pure functions of a
// diagram and the analysis; `--overlay a,b` and the options panel of the
// page apply them in order after the review's own overlay (diff.ts).

import type { Analysis } from "./analyze.ts";
import type { Diagram, DiagramNode } from "./diagram.ts";
import { storageOf } from "./flow.ts";
import { moduleOf, type Graph } from "./graph.ts";

import { OVERLAYS, type Overlay } from "./options.ts";

export { OVERLAYS, type Overlay } from "./options.ts";

/** A test module, by its path (the same rule as the tests view). */
const TEST_MODULE = /(^|\/)(tests?|__tests__|spec|e2e)\/|[.\-_](test|spec|stories)\.[cm]?[jt]sx?$|_test\.(py|rs|php)$|(^|\/)tests?_[^/]*\.py$|Test\.php$/;

/** The module a shape stands for, when it stands for a module or a function of one. */
function moduleOfNode(node: DiagramNode): string | null {
  if (node.kind === "module" || node.kind === "participant") return node.ref?.id ?? node.id;

  if (node.kind === "fn" || node.kind === "class") return moduleOf(node.ref?.id ?? node.id);

  return null;
}

/** Modules no test file imports get a mark and a line in their label. */
export function overlayTests(diagram: Diagram, graph: Graph): Diagram {
  const covered = new Set(graph.deps.filter((dep) => TEST_MODULE.test(dep.from) && !TEST_MODULE.test(dep.to)).map((dep) => dep.to));
  let untested = 0;
  const nodes = diagram.nodes.map((node) => {
    const module = moduleOfNode(node);

    if (!module || TEST_MODULE.test(module) || covered.has(module) || !graph.modules.has(module)) return node;
    untested++;

    return { ...node, label: `${node.label}\nno tests`, diff: node.diff ?? ("warning" as const) };
  });

  return { ...diagram, nodes, reason: [diagram.reason, `${untested} shapes of modules no test imports (orange)`].filter(Boolean).join("; ") };
}

/** Modules that hold data are labelled with what they are. */
export function overlayStorages(diagram: Diagram, analysis: Analysis): Diagram {
  const cache = new Map<string, string | null>();
  let found = 0;
  const nodes = diagram.nodes.map((node) => {
    const module = moduleOfNode(node);

    if (!module) return node;
    let storage = cache.get(module);

    if (storage === undefined) {
      storage = storageOf(analysis, module);
      cache.set(module, storage);
    }

    if (!storage) return node;
    found++;

    return { ...node, label: `${node.label}\n⛁ ${storage}` };
  });

  return { ...diagram, nodes, reason: [diagram.reason, `${found} storages (⛁)`].filter(Boolean).join("; ") };
}

/** Every module or function shaded by the calls into it from other modules. */
export function overlayHeat(diagram: Diagram, graph: Graph): Diagram {
  const intoModule = new Map<string, number>();
  const intoNode = new Map<string, number>();

  for (const call of graph.calls) {
    const from = moduleOf(call.from);
    const to = moduleOf(call.to);

    if (from === to) continue;
    intoModule.set(to, (intoModule.get(to) ?? 0) + 1);
    intoNode.set(call.to, (intoNode.get(call.to) ?? 0) + 1);
  }

  const max = Math.max(1, ...intoModule.values());
  const nodes = diagram.nodes.map((node) => {
    const id = node.ref?.id ?? node.id;
    const count = node.kind === "module" || node.kind === "participant" ? intoModule.get(id) : node.kind === "fn" || node.kind === "class" ? intoNode.get(id) : undefined;

    // A diff mark of the review or the tests overlay stays; the shade sits under it.
    if (count === undefined) return node;

    return { ...node, heat: count / max, label: `${node.label}\n${count} calls in` };
  });

  return { ...diagram, nodes, reason: [diagram.reason, "shade: calls in from other modules"].filter(Boolean).join("; ") };
}

/** The overlays applied in the order given. */
export function applyOverlays(diagram: Diagram, analysis: Analysis, overlays: readonly Overlay[]): Diagram {
  let out = diagram;

  for (const overlay of overlays) {
    if (overlay === "tests") out = overlayTests(out, analysis.graph);
    else if (overlay === "storages") out = overlayStorages(out, analysis);
    else if (overlay === "heat") out = overlayHeat(out, analysis.graph);
  }

  return out;
}

/** `a,b` → the overlays named, in order; an unknown name is an error naming it. */
export function parseOverlays(text: string | null | undefined): Overlay[] {
  if (!text) return [];
  const names = text.split(",").map((name) => name.trim()).filter((name) => name !== "");

  for (const name of names) if (!OVERLAYS.includes(name as Overlay)) throw new Error(`unknown overlay "${name}" (${OVERLAYS.join(", ")})`);

  return [...new Set(names)] as Overlay[];
}
