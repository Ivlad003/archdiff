// What happens to a picture after its view built it and before it is laid
// out: hubs become badges, lanes are hidden, modules are opened in place
// (the mix), the tail folds into "… N in dir/" shapes, light lines are
// dropped. Each step is a pure function Diagram → Diagram that explains
// itself in `reason`; `viewOf` applies them in that order.
//
// Entry points: `hubsAsBadges`, `hideLanes`, `expandInPlace`, `fold`,
// `dropLightLines`, `MAX_SHAPES`.

import type { Diagram, DiagramEdge, DiagramGroup, DiagramNode } from "./diagram.ts";
import { moduleOf, type Graph } from "./graph.ts";
import { fnNode } from "./nodes.ts";
/**
 * More shapes than this and a view folds the tail into one shape. Studies of
 * diagram reading put the comfortable count far lower (7–10 at a glance); 40
 * keeps a lane grid readable while a folded shape still opens on a tap.
 */
export const MAX_SHAPES = 40;

/** A module imported by at least this many of a picture's modules, and at least HUB_SHARE of them, is a hub. */
const HUB_MIN_IMPORTERS = 6;

/** The share of a picture's modules that must import a module for it to be a hub: a quarter marks the logger and the shared types, not a busy neighbour. */
const HUB_SHARE = 0.25;

/** On a big map a quarter is hundreds; this many importers make a hub whatever the picture's size. */
const HUB_MAX_IMPORTERS = 40;

/** The deepest directory holding every path; "" when they share none. */
function commonDirectory(paths: readonly string[]): string {
  if (paths.length === 0) return "";
  let parts = paths[0]!.split("/").slice(0, -1);

  for (const path of paths) {
    const own = path.split("/").slice(0, -1);
    let n = 0;

    while (n < parts.length && n < own.length && parts[n] === own[n]) n++;
    parts = parts.slice(0, n);
  }

  return parts.join("/");
}

/**
 * A big picture folded: the first `limit` shapes stay (the subject first,
 * then the diagram's order, which the views sort by importance); the rest
 * are grouped by directory into `more` shapes — one per directory with
 * its count, which opens that directory's view on a tap — and the edges of
 * the dropped shapes point to their group. Functions fold by module into
 * one shape per module. The Markdown of the view still lists everything.
 */
export function fold(diagram: Diagram, limit: number): Diagram {
  if (diagram.nodes.length <= limit) return diagram;
  const kept = diagram.nodes.slice(0, limit);
  const dropped = diagram.nodes.slice(limit);
  const keptIds = new Set(kept.map((node) => node.id));
  // The group of a dropped shape: a module by the directory just below the common root of the dropped modules
  // (the view's own directory folds into its subdirectories), a function by its module, anything else into one "more".
  const droppedModules = dropped.filter((node) => node.kind === "module").map((node) => node.id);
  const common = commonDirectory(droppedModules);

  const groupOf = (node: DiagramNode): { id: string; label: string; view: string | null } => {
    if (node.kind === "module") {
      const rest = common === "" ? node.id : node.id.slice(common.length + 1);
      const slash = rest.indexOf("/");
      // A file directly under the common directory folds into that directory; a file deeper into its first subdirectory.
      const folder = slash === -1 ? common : common === "" ? rest.slice(0, slash) : `${common}/${rest.slice(0, slash)}`;
      const label = folder === "" ? "(root)" : `${folder}/`;

      return { id: `more:${folder || "(root)"}`, label, view: folder === "" ? null : `dir:${folder}` };
    }

    if (node.kind === "fn") {
      const module = moduleOf(node.ref?.id ?? node.id);

      return { id: `more:${module}`, label: module, view: `module:${module}` };
    }

    return { id: "more", label: "more", view: null };
  };

  const groups = new Map<string, DiagramNode & { members: string[] }>();
  const groupOfId = new Map<string, string>();

  for (const node of dropped) {
    const group = groupOf(node);
    let shape = groups.get(group.id);

    if (!shape) {
      shape = { id: group.id, kind: "more", label: group.label, count: 0, x: 0, y: 0, w: 0, h: 0, members: [] };

      if (group.view) shape.ref = { id: group.view };

      if (node.group !== undefined) shape.group = node.group;
      groups.set(group.id, shape);
    }

    shape.count = (shape.count ?? 0) + 1;
    shape.members.push(node.id);
    groupOfId.set(node.id, group.id);
  }

  // Too many groups is no better than too many shapes: beyond a dozen, the smallest merge into one "other".
  let folded = [...groups.values()].sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || (a.id < b.id ? -1 : 1));

  if (folded.length > 12) {
    const rest = folded.slice(11);
    const other: DiagramNode & { members: string[] } = { id: "more", kind: "more", label: "other", count: rest.reduce((sum, shape) => sum + (shape.count ?? 0), 0), x: 0, y: 0, w: 0, h: 0, members: rest.flatMap((shape) => shape.members) };

    for (const member of other.members) groupOfId.set(member, "more");
    folded = [...folded.slice(0, 11), other];
  }

  for (const shape of folded) shape.label = `… ${shape.count} in ${shape.label}`;
  // The lines into or out of a folded shape merge into one per (from, to, kind), which counts the lines behind it, so
  // a weight filter can thin them and the Markdown can say how many.
  const merged = new Map<string, DiagramEdge>();

  for (const edge of diagram.edges) {
    const from = keptIds.has(edge.from) ? edge.from : (groupOfId.get(edge.from) ?? "more");
    const to = keptIds.has(edge.to) ? edge.to : (groupOfId.get(edge.to) ?? "more");

    if (from === to) continue;
    const key = `${from}\u0000${to}\u0000${edge.kind}`;
    const existing = merged.get(key);

    if (existing) existing.count = (existing.count ?? 1) + (edge.count ?? 1);
    else merged.set(key, from === edge.from && to === edge.to ? { ...edge } : { from, to, kind: edge.kind, count: edge.count ?? 1 });
  }

  const edges = [...merged.values()].map((edge) => (edge.count === 1 && !diagram.edges.includes(edge) ? { from: edge.from, to: edge.to, kind: edge.kind } : edge));
  const nodes = [...kept, ...folded.map(({ members: _members, ...shape }) => shape)];
  const lanes = diagram.groups.filter((group) => nodes.some((node) => node.group === group.id));
  const note = `${dropped.length} of ${diagram.nodes.length} shapes folded by directory; tap a folded shape to open it, the Markdown lists them all`;

  return { ...diagram, nodes, edges, groups: lanes, reason: [diagram.reason, note].filter(Boolean).join("; ") };
}

/**
 * Modules that most of a picture's modules import — a logger, the shared
 * types — leave the picture: their lines would cross everything and say
 * little. Each importer gets a badge line "+ log.ts, types.ts" instead, and
 * the reason names the hubs with their counts. The view's own subject is
 * never a hub. The Markdown of a module still lists every import.
 */
export function hubsAsBadges(diagram: Diagram, subject: string | null): Diagram {
  const modules = diagram.nodes.filter((node) => node.kind === "module");

  if (modules.length < 8) return diagram;
  const ids = new Set(modules.map((node) => node.id));
  const importers = new Map<string, Set<string>>();

  for (const edge of diagram.edges) {
    if (edge.kind !== "dependency" || !ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    importers.set(edge.to, new Set([...(importers.get(edge.to) ?? []), edge.from]));
  }

  const threshold = Math.max(HUB_MIN_IMPORTERS, Math.min(HUB_MAX_IMPORTERS, Math.ceil(modules.length * HUB_SHARE)));
  const hubs = modules.filter((node) => node.id !== subject && (importers.get(node.id)?.size ?? 0) >= threshold).map((node) => node.id);

  if (hubs.length === 0) return diagram;
  const hubSet = new Set(hubs);
  const badge = new Map<string, string[]>();

  for (const hub of hubs) for (const importer of importers.get(hub)!) badge.set(importer, [...(badge.get(importer) ?? []), hub.slice(hub.lastIndexOf("/") + 1)]);
  const nodes = diagram.nodes.filter((node) => !hubSet.has(node.id)).map((node) => (badge.has(node.id) ? { ...node, label: `${node.label}\n+ ${badge.get(node.id)!.join(", ")}` } : node));
  const edges = diagram.edges.filter((edge) => !hubSet.has(edge.from) && !hubSet.has(edge.to));
  const note = `hubs as badges, not drawn: ${hubs.map((hub) => `${hub} (imported by ${importers.get(hub)!.size} of ${modules.length})`).join(", ")}`;

  return { ...diagram, nodes, edges, reason: [diagram.reason, note].filter(Boolean).join("; ") };
}

/** Lines standing for fewer imports or calls than `weight` leave the picture; the shapes stay. */
export function dropLightLines(diagram: Diagram, weight: number): Diagram {
  if (weight <= 1) return diagram;
  const kept = diagram.edges.filter((edge) => edge.kind === "lifeline" || edge.kind === "message" || (edge.count ?? 1) >= weight);
  const dropped = diagram.edges.length - kept.length;

  if (dropped === 0) return diagram;

  return { ...diagram, edges: kept, reason: [diagram.reason, `${dropped} lines lighter than ${weight} left out`].filter(Boolean).join("; ") };
}

/**
 * The mix of a module view and the inside of some of its modules: each
 * module named in `expand` leaves its lane and becomes a lane of its own
 * functions and classes, with the calls among them; a line into the module
 * lands on the functions the source actually calls (the rest on a small
 * "rest of the module" shape), a line out of it leaves from the functions
 * that make the calls. Structure and detail in one picture, where it is
 * wanted and nowhere else.
 */
export function expandInPlace(diagram: Diagram, graph: Graph, expand: readonly string[]): Diagram {
  const present = new Set(diagram.nodes.filter((node) => node.kind === "module").map((node) => node.id));
  const opened = expand.filter((id) => present.has(id) && graph.modules.has(id));

  if (opened.length === 0) return diagram;
  const openedSet = new Set(opened);
  const nodes: DiagramNode[] = diagram.nodes.filter((node) => !openedSet.has(node.id));
  const edges: DiagramEdge[] = [];
  const groups: DiagramGroup[] = [...diagram.groups];
  const restOf = (module: string): string => `${module}#(rest)`;
  // The functions of every opened module, by module, and the calls among them.
  const fnsOf = new Map<string, string[]>();

  for (const module of opened) {
    const laneId = `inside:${module}`;
    const own = [...graph.nodes.values()].filter((node) => node.module === module && node.kind !== "type").map((node) => node.id);
    fnsOf.set(module, own);
    groups.push({ id: laneId, label: `${module} (inside)`, kind: "lane", x: 0, y: 0, w: 0, h: 0 });

    for (const id of own) nodes.push({ ...fnNode(graph, id), group: laneId });
    nodes.push({ id: restOf(module), kind: "module", label: `${module.slice(module.lastIndexOf("/") + 1)}\n(rest of the module)`, ref: { id: module, file: module, line: 1 }, group: laneId, x: 0, y: 0, w: 0, h: 0 });
  }

  const seen = new Set<string>();

  const push = (edge: DiagramEdge): void => {
    const key = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;

    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  };

  for (const module of opened) {
    const own = new Set(fnsOf.get(module)!);

    for (const call of graph.calls) if (own.has(call.from) && own.has(call.to) && call.from !== call.to) push({ from: call.from, to: call.to, kind: call.kind });
  }

  // The lines of the picture: those touching an opened module land on its functions where a call names one.
  for (const edge of diagram.edges) {
    const fromOpen = openedSet.has(edge.from);
    const toOpen = openedSet.has(edge.to);

    if (!fromOpen && !toOpen) {
      push(edge);
      continue;
    }

    if (fromOpen && toOpen) {
      // Between two opened modules: the calls between their functions, else rest → rest.
      const calls = graph.calls.filter((call) => moduleOf(call.from) === edge.from && moduleOf(call.to) === edge.to && fnsOf.get(edge.from)!.includes(call.from) && fnsOf.get(edge.to)!.includes(call.to));

      if (calls.length === 0) push({ from: restOf(edge.from), to: restOf(edge.to), kind: edge.kind });
      else for (const call of calls) push({ from: call.from, to: call.to, kind: call.kind });
    } else if (toOpen) {
      // Into the module: the functions called from the source's module (or from the source function itself).
      const sourceModule = diagram.nodes.find((node) => node.id === edge.from);
      const fromModule = sourceModule?.kind === "fn" ? moduleOf(sourceModule.ref?.id ?? edge.from) : edge.from;
      const targets = new Set(graph.calls.filter((call) => moduleOf(call.from) === fromModule && fnsOf.get(edge.to)!.includes(call.to)).map((call) => call.to));

      if (targets.size === 0) push({ from: edge.from, to: restOf(edge.to), kind: edge.kind });
      else for (const target of targets) push({ from: edge.from, to: target, kind: "call" });
    } else {
      // Out of the module: the functions that call into the target's module.
      const targetModule = diagram.nodes.find((node) => node.id === edge.to);
      const toModule = targetModule?.kind === "fn" ? moduleOf(targetModule.ref?.id ?? edge.to) : edge.to;
      const sources = new Set(graph.calls.filter((call) => fnsOf.get(edge.from)!.includes(call.from) && (moduleOf(call.to) === toModule || call.to === toModule)).map((call) => call.from));

      if (sources.size === 0) push({ from: restOf(edge.from), to: edge.to, kind: edge.kind });
      else for (const source of sources) push({ from: source, to: edge.to, kind: "call" });
    }
  }

  const note = `opened in place: ${opened.join(", ")}`;

  return { ...diagram, nodes, edges, groups, reason: [diagram.reason, note].filter(Boolean).join("; ") };
}

/** The picture without the lanes named: their shapes and every line touching them go; a lane the picture lacks is ignored. */
export function hideLanes(diagram: Diagram, lanes: readonly string[]): Diagram {
  const hidden = new Set(lanes.filter((lane) => diagram.groups.some((group) => group.id === lane)));

  if (hidden.size === 0) return diagram;
  const gone = new Set(diagram.nodes.filter((node) => node.group !== undefined && hidden.has(node.group)).map((node) => node.id));
  const nodes = diagram.nodes.filter((node) => !gone.has(node.id));
  const edges = diagram.edges.filter((edge) => !gone.has(edge.from) && !gone.has(edge.to));
  const groups = diagram.groups.filter((group) => !hidden.has(group.id));

  return { ...diagram, nodes, edges, groups, reason: [diagram.reason, `lanes hidden: ${[...hidden].join(", ")} (${gone.size} shapes)`].filter(Boolean).join("; ") };
}
