// Overlays: marks laid over any view without changing its structure, so
// two questions are answered by one picture. `tests`: modules no test
// file imports are marked; `storages`: modules that hold data (stores,
// databases, caches) are labelled; `heat`: every module or function is
// shaded by the calls into it from other modules; `instability`: every
// module shaded by Martin's I (metrics.ts); and three read from git, from
// the commits of the picture's range (git.ts's `gitStats`, read by
// picture.ts at the edge): `churn` shades every module by the commits
// that changed its file, `coupling` joins the modules changed together,
// `ownership` names and tints each module's main author. Pure functions
// of a diagram, the analysis and those statistics; `--overlay a,b` and
// the options panel of the page apply them in order after the review's
// own overlay (diff.ts).
//
// Entry points: `applyOverlays`, `parseOverlays`, `overlayTests`,
// `overlayStorages`, `overlayHeat`, `overlayChurn`, `overlayCoupling`,
// `overlayOwnership`, `OVERLAYS`.

import type { Analysis } from "./analyze.ts";
import type { Diagram, Line, Shape } from "./diagram.ts";
import type { GitStats } from "./git.ts";
import { OWNER_TINTS } from "./looks.ts";
import { storageOf } from "./flow.ts";
import { moduleOf, type Graph } from "./graph.ts";
import { moduleOfShape, standsFor } from "./shape-keys.ts";
import { overlayInstability } from "./metrics.ts";

import { OVERLAYS, type Overlay } from "./options.ts";
import { counted } from "./words.ts";

export { OVERLAYS, type Overlay } from "./options.ts";

/** A test module, by its path (the same rule as the tests view). */
const TEST_MODULE = /(^|\/)(tests?|__tests__|spec|e2e)\/|[.\-_](test|spec|stories)\.[cm]?[jt]sx?$|_test\.(py|rs|php|go)$|(^|\/)tests?_[^/]*\.py$|Test\.php$|(Tests?|IT)\.java$|Tests?\.cs$|(^|\/)[^/]*[.]Tests?\//;

/** Modules no test file imports get a mark and a line in their label. */
export function overlayTests(diagram: Diagram, graph: Graph): Diagram {
  const covered = new Set(graph.deps.filter((dep) => TEST_MODULE.test(dep.from) && !TEST_MODULE.test(dep.to)).map((dep) => dep.to));
  let untested = 0;
  const nodes = diagram.nodes.map((node) => {
    const module = moduleOfShape(node);

    if (!module || TEST_MODULE.test(module) || covered.has(module) || !graph.modules.has(module)) return node;
    untested++;

    return { ...node, label: `${node.label}\nno tests`, diff: node.diff ?? ("warning" as const) };
  });

  return { ...diagram, nodes, reason: [diagram.reason, `${untested} ${untested === 1 ? "shape of a module" : "shapes of modules"} no test imports (orange)`].filter(Boolean).join("; ") };
}

/** Modules that hold data are labelled with what they are. */
export function overlayStorages(diagram: Diagram, analysis: Analysis): Diagram {
  const cache = new Map<string, string | null>();
  let found = 0;
  const nodes = diagram.nodes.map((node) => {
    const module = moduleOfShape(node);

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

  return { ...diagram, nodes, reason: [diagram.reason, `${found} ${found === 1 ? "storage" : "storages"} (⛁)`].filter(Boolean).join("; ") };
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
    const id = standsFor(node);
    const count = node.kind === "module" || node.kind === "participant" ? intoModule.get(id) : node.kind === "fn" || node.kind === "class" ? intoNode.get(id) : undefined;

    // A diff mark of the review or the tests overlay stays; the shade sits under it.
    if (count === undefined) return node;

    return { ...node, heat: count / max, label: `${node.label}\n${counted(count, "call")} in` };
  });

  return { ...diagram, nodes, reason: [diagram.reason, "shade: calls in from other modules"].filter(Boolean).join("; ") };
}

/** The file a shape is the module of: a module's own shape (or a sequence's participant), not a function in it. */
function fileOfShape(node: Shape): string | null {
  return node.kind === "module" || node.kind === "participant" ? standsFor(node) : null;
}

/**
 * Churn: every module shaded by how many commits of the range changed its file, the count in its label; a layer by
 * the changes of its modules together. Where the code moves most.
 */
export function overlayChurn(diagram: Diagram, graph: Graph, stats: GitStats): Diagram {
  const ofLayer = new Map<string, number>();

  for (const [file, count] of stats.churn) {
    const layer = graph.modules.get(file)?.layer;

    if (layer !== undefined) ofLayer.set(layer, (ofLayer.get(layer) ?? 0) + count);
  }

  const countOf = (node: Shape): number => {
    const file = fileOfShape(node);

    return (node.kind === "layer" ? ofLayer.get(standsFor(node)) : file === null ? undefined : stats.churn.get(file)) ?? 0;
  };
  const max = Math.max(1, ...diagram.nodes.map(countOf));
  const nodes = diagram.nodes.map((node) => {
    const count = countOf(node);

    return count === 0 ? node : { ...node, heat: count / max, label: `${node.label}\n${counted(count, "change")}` };
  });

  return { ...diagram, nodes, reason: [diagram.reason, `shade: churn, the commits of ${stats.range} that changed each file (${counted(stats.commits, "commit")} read)`].filter(Boolean).join("; ") };
}

/** How many lines of files changed together one picture is given: the pairs most often together. */
const COCHANGE_LINES = 40;

/**
 * Change coupling: a dashed line, without a direction, between two modules of the picture whose files the commits
 * of the range changed together at least twice, labelled with how often. A pair no import joins is coupled where
 * the code does not say so.
 */
export function overlayCoupling(diagram: Diagram, stats: GitStats): Diagram {
  const shapes = new Map<string, string>();

  for (const node of diagram.nodes) {
    const file = fileOfShape(node);

    if (file !== null && !shapes.has(file)) shapes.set(file, node.id);
  }

  const lines: Line[] = [];

  for (const pair of stats.coupling) {
    const a = shapes.get(pair.a);
    const b = shapes.get(pair.b);

    if (a !== undefined && b !== undefined && lines.length < COCHANGE_LINES) lines.push({ from: a, to: b, kind: "cochange", count: pair.together, label: `×${pair.together}` });
  }

  const note = lines.length > 0 ? `${counted(lines.length, "pair")} of modules changed together at least twice in ${stats.range} (dashed, × the commits)` : `no two modules of this picture changed together twice in ${stats.range}`;

  return { ...diagram, edges: [...diagram.edges, ...lines], reason: [diagram.reason, note].filter(Boolean).join("; ") };
}

/**
 * Ownership: every module named for the author of most of the commits that changed its file (with the share, when
 * others changed it too) and tinted with that author's colour — the authors of the most modules of the picture each
 * have one, the rest share the last.
 */
export function overlayOwnership(diagram: Diagram, stats: GitStats): Diagram {
  const owned = new Map<string, number>();

  for (const node of diagram.nodes) {
    const file = fileOfShape(node);
    const owner = file === null ? undefined : stats.owners.get(file);

    if (owner) owned.set(owner.author, (owned.get(owner.author) ?? 0) + 1);
  }

  const authors = [...owned].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([author]) => author);
  const nodes = diagram.nodes.map((node) => {
    const file = fileOfShape(node);
    const owner = file === null ? undefined : stats.owners.get(file);

    if (!owner) return node;

    return { ...node, tint: OWNER_TINTS[Math.min(authors.indexOf(owner.author), OWNER_TINTS.length - 1)]!, label: `${node.label}\n◉ ${owner.author}${owner.commits < owner.of ? ` ${Math.round((100 * owner.commits) / owner.of)}%` : ""}` };
  });
  const note = authors.length > 0 ? `ownership, the author of most of the commits that changed each file (the last ${counted(stats.ownersFrom, "commit")}): ${authors.slice(0, 8).map((author) => `${author} ${owned.get(author)}`).join(", ")}${authors.length > 8 ? `, ${authors.length - 8} more` : ""}` : "ownership: no commit changed a module of this picture";

  return { ...diagram, nodes, reason: [diagram.reason, note].filter(Boolean).join("; ") };
}

/** The overlays applied in the order given; those read from git are left out when `git` could not be read (the picture says why). */
export function applyOverlays(diagram: Diagram, analysis: Analysis, overlays: readonly Overlay[], git?: GitStats): Diagram {
  let out = diagram;

  for (const overlay of overlays) {
    if (overlay === "tests") out = overlayTests(out, analysis.graph);
    else if (overlay === "storages") out = overlayStorages(out, analysis);
    else if (overlay === "heat") out = overlayHeat(out, analysis.graph);
    else if (overlay === "instability") out = overlayInstability(out, analysis);
    else if (overlay === "churn" && git) out = overlayChurn(out, analysis.graph, git);
    else if (overlay === "coupling" && git) out = overlayCoupling(out, git);
    else if (overlay === "ownership" && git) out = overlayOwnership(out, git);
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
