// The plan drawn on a diagram: what the user added, connected, removed or
// wrote on the saved scene of a view that the code does not have yet —
// read back as a task for a coding agent (`archdiff plan`, the Chat tab).
// The reverse of `review`: there, code against code; here, the drawing
// against the code. A shape without archdiff's mark is a planned module
// (its label names a file), a planned function (any other label, placed
// in the nearest module), or a planned layer; an arrow between two shapes
// is a planned import (modules) or call (functions); a generated shape
// deleted in the drawing is a planned removal; free text is a note. The
// lanes say the layer of a shape; a planned import between layers that do
// not touch yet is named as a warning, not refused.
//
// Pure: Analysis + view + scene → Plan → Markdown, or → the intent with
// the plan folded into it. Entry points: `planFromScene`, `taskMarkdown`,
// `mergePlan`, `Plan`.

import type { Analysis } from "./analyze.ts";
import { moduleOf, type Graph } from "./graph.ts";
import type { Intent, IntentModule } from "./intent.ts";
import { isJsonObject, isJsonString } from "./json.ts";
import { isSourceFile } from "./files.ts";
import type { SceneElement } from "./scene.ts";
import { parseView } from "./view-keys.ts";

export interface PlannedNode {
  /** The element's ID in the drawing. */
  id: string;
  kind: "module" | "fn" | "layer";
  /** A module: the path as written (an extension added when missing); a function: its name; a layer: its name. */
  name: string;
  /** A function: the module it goes in; a module: its layer when a lane holds it. */
  module?: string;
  layer?: string;
  /** How the place was chosen. */
  because: string;
}

export interface PlannedEdge {
  /** A graph ID (existing) or a drawing element ID (planned), with its label for the text. */
  from: { id: string; label: string; planned: boolean };
  to: { id: string; label: string; planned: boolean };
  kind: "import" | "call";
}

export interface Plan {
  view: string;
  added: PlannedNode[];
  edges: PlannedEdge[];
  removed: { id: string; kind: string; label: string; file?: string; line?: number }[];
  notes: string[];
  /** Planned imports between layers that do not depend on each other yet. */
  layerWarnings: string[];
  /** Arrows and shapes the plan could not read, with the reason. */
  ignored: string[];
}

function generated(element: SceneElement): string | null {
  return isJsonObject(element.customData) && isJsonString(element.customData["archdiff"]) ? element.customData["archdiff"] : null;
}

function centre(element: SceneElement): { x: number; y: number } {
  return { x: element.x + element.width / 2, y: element.y + element.height / 2 };
}

function contains(box: SceneElement, point: { x: number; y: number }): boolean {
  return point.x >= box.x && point.y >= box.y && point.x <= box.x + box.width && point.y <= box.y + box.height;
}

function distance(a: SceneElement, b: SceneElement): number {
  const ca = centre(a);
  const cb = centre(b);

  return Math.hypot(ca.x - cb.x, ca.y - cb.y);
}

/** The text bound to a shape, or the shape's own text, trimmed; empty when none. */
function labelOf(element: SceneElement, elements: readonly SceneElement[]): string {
  const bound = elements.find((candidate) => candidate.type === "text" && candidate["containerId"] === element.id && !candidate.isDeleted);
  const text = bound?.["text"] ?? element["text"];

  return isJsonString(text) ? text.replace(/\s+/g, " ").trim() : "";
}

/** What the passes over a drawing share: the live elements, the lanes and the generated shapes among them, the subject module. */
interface Drawing {
  analysis: Analysis;
  view: ReturnType<typeof parseView>;
  elements: readonly SceneElement[];
  live: SceneElement[];
  lanes: SceneElement[];
  nodes: SceneElement[];
  /** The module a function drawn here belongs to by default: the subject of the view. */
  subjectModule: string | null;
  plan: Plan;
}

/** The kind a generated shape stands for (`customData.kind`). */
function nodeKind(element: SceneElement): string {
  return isJsonObject(element.customData) && isJsonString(element.customData["kind"]) ? element.customData["kind"] : "";
}

/** The shapes the user drew: a module, a function or a layer by their label and place. */
function plannedShapes(d: Drawing): Map<string, PlannedNode> {
  const { analysis, view, elements, live, lanes, nodes, subjectModule, plan } = d;
  const { graph } = analysis;
  const planned = new Map<string, PlannedNode>();

  for (const element of live) {
    if (generated(element) !== null || !["rectangle", "ellipse", "diamond"].includes(element.type)) continue;
    const label = labelOf(element, elements);

    if (label === "") {
      plan.ignored.push(`a ${element.type} without a label`);
      continue;
    }

    const lane = lanes.find((candidate) => contains(candidate, centre(element)));
    const layer = lane ? lane.id.replace(/^lane:/, "") : undefined;

    if (view?.kind === "layers") {
      const node: PlannedNode = { id: element.id, kind: "layer", name: label, because: "drawn on the layers view" };
      planned.set(element.id, node);
      continue;
    }

    // `path#name` is a function of that module, however the path looks; a path or a file name is a module.
    if (!label.includes("#") && (label.includes("/") || isSourceFile(label))) {
      const name = isSourceFile(label) ? label : `${label}.ts`;
      const node: PlannedNode = { id: element.id, kind: "module", name, because: lane ? `drawn in the lane of ${layer}` : "drawn outside every lane" };

      if (layer) node.layer = layer;
      planned.set(element.id, node);
      continue;
    }

    // A function: `path#name` says its module; else the nearest generated module or function shape, else the subject of the view.
    const at = label.indexOf("#");
    let module: string | null = at === -1 ? null : label.slice(0, at);
    let because = at === -1 ? "" : "named with its module";
    const name = at === -1 ? label.replace(/\(.*$/, "").trim() : label.slice(at + 1).replace(/\(.*$/, "").trim();

    if (module === null) {
      const nearest = nodes.filter((candidate) => nodeKind(candidate) === "module" || nodeKind(candidate) === "fn").sort((a, b) => distance(a, element) - distance(b, element))[0];

      if (nearest) {
        module = nodeKind(nearest) === "module" ? nearest.id : moduleOf(nearest.id);
        because = `drawn next to ${nearest.id}`;
      } else if (subjectModule) {
        module = subjectModule;
        because = `drawn on the view of ${subjectModule}`;
      }
    }

    if (module === null) {
      plan.ignored.push(`function "${name}": no module to put it in (write it as path#name)`);
      continue;
    }

    const node: PlannedNode = { id: element.id, kind: "fn", name, module, because };
    const moduleLayer = graph.modules.get(module)?.layer ?? layer;

    if (moduleLayer) node.layer = moduleLayer;
    planned.set(element.id, node);
  }

  return planned;
}

/** The arrows the user drew between shapes: imports or calls, with a warning when they couple layers that are not coupled today. */
function plannedArrows(d: Drawing, planned: ReadonlyMap<string, PlannedNode>): void {
  const { analysis, live, nodes, plan } = d;
  const { graph } = analysis;

  // The end of an arrow: an existing node, a planned shape, or nothing readable.
  const endOf = (elementId: string | undefined): PlannedEdge["from"] | null => {
    if (!elementId) return null;
    const shape = planned.get(elementId);

    if (shape) return { id: elementId, label: shape.kind === "fn" ? `${shape.module}#${shape.name}` : shape.name, planned: true };
    const node = nodes.find((candidate) => candidate.id === elementId);

    if (node) return { id: node.id, label: node.id, planned: false };

    return null;
  };

  const kindOfEnd = (end: PlannedEdge["from"]): "module" | "fn" | "other" => {
    const shape = planned.get(end.id);

    if (shape) return shape.kind === "layer" ? "other" : shape.kind;
    const node = nodes.find((candidate) => candidate.id === end.id);
    const kind = node ? nodeKind(node) : "";

    return kind === "module" || kind === "fn" ? kind : "other";
  };

  const moduleOfEnd = (end: PlannedEdge["from"]): string | null => {
    const shape = planned.get(end.id);

    if (shape) return shape.kind === "module" ? shape.name : (shape.module ?? null);

    return kindOfEnd(end) === "module" ? end.id : kindOfEnd(end) === "fn" ? moduleOf(end.id) : null;
  };

  for (const element of live) {
    if (element.type !== "arrow" || generated(element) !== null) continue;
    const start = element["startBinding"];
    const finish = element["endBinding"];
    const from = endOf(isJsonObject(start) && isJsonString(start["elementId"]) ? start["elementId"] : undefined);
    const to = endOf(isJsonObject(finish) && isJsonString(finish["elementId"]) ? finish["elementId"] : undefined);

    if (!from || !to) {
      plan.ignored.push("an arrow not bound to a shape at both ends");
      continue;
    }

    const kind = kindOfEnd(from) === "fn" && kindOfEnd(to) === "fn" ? "call" : "import";
    plan.edges.push({ from, to, kind });
    const fromModule = moduleOfEnd(from);
    const toModule = moduleOfEnd(to);
    const fromLayer = fromModule ? (graph.modules.get(fromModule)?.layer ?? planned.get(from.id)?.layer) : undefined;
    const toLayer = toModule ? (graph.modules.get(toModule)?.layer ?? planned.get(to.id)?.layer) : undefined;

    if (fromLayer && toLayer && fromLayer !== toLayer) {
      const exists = graph.deps.some((dep) => graph.modules.get(dep.from)?.layer === fromLayer && graph.modules.get(dep.to)?.layer === toLayer && !dep.typeOnly);

      if (!exists) plan.layerWarnings.push(`${fromLayer} → ${toLayer}: no module of ${fromLayer} imports ${toLayer} today`);
    }
  }
}

/** Generated shapes deleted in the drawing: planned removals, with the file and line they stood for. */
function plannedRemovals(d: Drawing): void {
  for (const element of d.elements) {
    if (!element.isDeleted || generated(element) !== "node") continue;
    const removal: Plan["removed"][number] = { id: element.id, kind: nodeKind(element), label: element.id };
    const file = isJsonObject(element.customData) ? element.customData["file"] : undefined;
    const line = isJsonObject(element.customData) ? element.customData["line"] : undefined;

    if (isJsonString(file)) removal.file = file;

    if (typeof line === "number") removal.line = line;
    d.plan.removed.push(removal);
  }
}

/** Free text the user wrote (not a shape's label): the notes of the task. */
function notesOf(d: Drawing): void {
  for (const element of d.live) {
    if (element.type === "text" && generated(element) === null && !isJsonString(element["containerId"])) {
      const text = labelOf(element, d.elements);

      if (text !== "") d.plan.notes.push(text);
    }
  }
}

/**
 * The task drawn on the saved scene of a view: the shapes the user drew
 * (modules, functions, layers), the arrows between shapes (imports,
 * calls), the generated shapes deleted (removals) and the free text
 * (notes), each with the reason it was read so.
 */
export function planFromScene(analysis: Analysis, viewKey: string, elements: readonly SceneElement[]): Plan {
  const view = parseView(viewKey);
  const live = elements.filter((element) => !element.isDeleted);
  const d: Drawing = {
    analysis,
    view,
    elements,
    live,
    lanes: live.filter((element) => generated(element) === "lane"),
    nodes: live.filter((element) => generated(element) === "node"),
    subjectModule: view?.kind === "module" ? view.subject : view?.kind === "calls" ? moduleOf(view.subject) : null,
    plan: { view: viewKey, added: [], edges: [], removed: [], notes: [], layerWarnings: [], ignored: [] },
  };
  const planned = plannedShapes(d);
  d.plan.added = [...planned.values()];
  plannedArrows(d, planned);
  plannedRemovals(d);
  notesOf(d);

  return d.plan;
}

/** Whether the plan asks for anything. */
export function planIsEmpty(plan: Plan): boolean {
  return plan.added.length === 0 && plan.edges.length === 0 && plan.removed.length === 0 && plan.notes.length === 0;
}

/** The task for an agent from a plan: what to add, connect and remove, with the code positions it touches, and the rules to keep. */
export function taskMarkdown(plan: Plan, analysis: Analysis): string {
  const { graph } = analysis;
  const lines = [`<!-- archdiff:generated — plan ${plan.view} -->`, `# Task from the drawing of ${plan.view}`, ""];

  if (planIsEmpty(plan)) {
    lines.push("_The drawing adds nothing to the code: draw a shape with a name, an arrow between two shapes, or delete a shape._", "");

    if (plan.ignored.length > 0) lines.push(...plan.ignored.map((item) => `- ignored: ${item}`), "");

    return `${lines.join("\n").trimEnd()}\n`;
  }

  lines.push(`Repository: ${analysis.root}. The diagram of \`${plan.view}\` was changed by hand; make the code match it.`, "");

  if (plan.added.length > 0) {
    lines.push("## Add", "");

    for (const node of plan.added) {
      if (node.kind === "module") lines.push(`- A new module \`${node.name}\`${node.layer ? ` in layer **${node.layer}**` : ""} (${node.because}).`);
      else if (node.kind === "fn") {
        const existing = graph.modules.get(node.module ?? "");
        const near = existing ? ` — the file exists, ${existing.lines} lines${existing.decls.length > 0 ? `, declarations: ${existing.decls.map((id) => graph.nodes.get(id)?.name).filter(Boolean).join(", ")}` : ""}` : " — a new file";
        lines.push(`- An exported function \`${node.name}\` in \`${node.module}\` (${node.because})${near}.`);
      } else lines.push(`- A new layer **${node.name}**: a directory of its own, named in archdiff.json \`layers\`.`);
    }

    lines.push("");
  }

  if (plan.edges.length > 0) {
    lines.push("## Connect", "");

    for (const edge of plan.edges) {
      const fromNode = graph.nodes.get(edge.from.id);
      const where = fromNode ? ` — ${fromNode.module}:${fromNode.line}` : "";
      lines.push(edge.kind === "call" ? `- \`${edge.from.label}\` calls \`${edge.to.label}\`${edge.to.planned ? " (new)" : ""}${where}.` : `- \`${edge.from.label}\` imports \`${edge.to.label}\`${edge.to.planned ? " (new)" : ""}${where}.`);
    }

    lines.push("");
  }

  if (plan.removed.length > 0) {
    lines.push("## Remove", "");

    for (const removal of plan.removed) lines.push(`- ${removal.kind} \`${removal.label}\`${removal.file ? ` — ${removal.file}${removal.line ? `:${removal.line}` : ""}` : ""}: remove it and every use of it.`);
    lines.push("");
  }

  if (plan.notes.length > 0) {
    lines.push("## Notes written on the drawing", "", ...plan.notes.map((note) => `- ${note}`), "");
  }

  if (plan.layerWarnings.length > 0) {
    lines.push("## ⚠ New dependencies between layers", "", ...plan.layerWarnings.map((warning) => `- ${warning}`), "");
  }

  if (plan.ignored.length > 0) lines.push("## Ignored in the drawing", "", ...plan.ignored.map((item) => `- ${item}`), "");
  lines.push(
    "## Rules",
    "",
    "- Change only what the task names; keep the existing layers and their dependencies as they are, except what the task adds.",
    "- Put a new function next to related ones in the named file, exported, typed, with a short doc comment.",
    "- Run the project's typecheck and tests before finishing, and report what you changed as a list of `file:line`.",
    `- When done, \`npx @ivlad003/archdiff review\` in ${analysis.root} shows the architectural diff; it should contain only this task.`,
  );

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The plan drawn on a view folded into the intent: new modules, functions
 * and layers added, arrows as edges (their ends named in the intent too,
 * with the layer the code gives them), removals taken out, notes kept
 * under the block.
 */
export function mergePlan(intent: Intent, plan: Plan, graph: Graph | null = null): Intent {
  const next: Intent = { ...intent, layers: [...intent.layers], modules: intent.modules.map((module) => ({ ...module, fns: [...module.fns] })), edges: [...intent.edges] };

  const module = (id: string, layer?: string): IntentModule => {
    let found = next.modules.find((candidate) => candidate.id === id);

    if (!found) {
      found = { id, fns: [] };

      if (layer) found.layer = layer;
      next.modules.push(found);
    } else if (layer && !found.layer) found.layer = layer;

    if (layer && !next.layers.some((candidate) => candidate.name === layer)) next.layers.push({ name: layer });

    return found;
  };

  for (const node of plan.added) {
    if (node.kind === "layer") {
      if (!next.layers.some((layer) => layer.name === node.name)) next.layers.push({ name: node.name });
    } else if (node.kind === "module") module(node.name, node.layer);
    else if (node.module) {
      const owner = module(node.module, node.layer);

      if (!owner.fns.some((fn) => fn.name === node.name)) owner.fns.push({ name: node.name });
    }
  }

  for (const edge of plan.edges) {
    for (const end of [edge.from.label, edge.to.label]) {
      const owner = moduleOf(end);
      const layer = graph?.modules.get(owner)?.layer;
      const found = module(owner, next.modules.find((candidate) => candidate.id === owner)?.layer ?? layer);

      if (end.includes("#")) {
        const fnName = end.slice(end.indexOf("#") + 1);

        if (!found.fns.some((fn) => fn.name === fnName)) found.fns.push({ name: fnName });
      }
    }

    if (!next.edges.some((candidate) => candidate.from === edge.from.label && candidate.to === edge.to.label)) next.edges.push({ from: edge.from.label, to: edge.to.label });
  }

  // A module drawn without a lane takes the layer the code gives it, when the code has it.
  for (const candidate of next.modules) {
    const layer = graph?.modules.get(candidate.id)?.layer;

    if (!candidate.layer && layer) {
      candidate.layer = layer;

      if (!next.layers.some((known) => known.name === layer)) next.layers.push({ name: layer });
    }
  }

  for (const removal of plan.removed) {
    next.modules = next.modules.filter((candidate) => candidate.id !== removal.label);

    for (const candidate of next.modules) candidate.fns = candidate.fns.filter((fn) => `${candidate.id}#${fn.name}` !== removal.label);
    next.edges = next.edges.filter((edge) => edge.from !== removal.label && edge.to !== removal.label && moduleOf(edge.from) !== removal.label && moduleOf(edge.to) !== removal.label);
  }

  if (plan.notes.length > 0) next.after = `${next.after.trimEnd()}\n\n## Notes from the drawing\n\n${plan.notes.map((note) => `- ${note}`).join("\n")}\n`;

  return next;
}
