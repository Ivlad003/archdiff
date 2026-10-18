// The intent view: ARCHITECTURE.md drawn against the code. Lanes are the
// intent's layers, shapes its modules and functions — plain when the code
// has them, `planned` (dashed blue) when not yet — plus, in those layers,
// the code's modules the intent does not name (`warning`, orange). Lines
// likewise: planned when the import or call is not in the code, orange
// when the code has one the intent does not.
//
// A view beside views-more.ts: Analysis + Intent → Diagram, pure. The
// contract itself (parsing, writing, checking) lives in intent.ts, in the
// core, so this is the only module of the views that reads it as a picture.
// Entry point: `intentView`.

import type { Analysis } from "./analyze.ts";
import type { PictureContent, Line, Lane, Shape } from "./diagram.ts";
import { INTENT_FILE, type Intent } from "./intent.ts";

/**
 * The intent drawn against the code: lanes are the intent's layers, shapes
 * its modules and functions — plain when the code has them, `planned`
 * (dashed blue) when not yet — plus, in those layers, the code's modules
 * the intent does not name (`warning`, orange). Lines likewise: planned
 * when the import or call is not in the code, orange when the code has
 * one the intent does not.
 */
export function intentView(analysis: Analysis, intent: Intent | null): PictureContent {
  if (!intent) return { title: "Intent", nodes: [], edges: [], groups: [], reason: `no ${INTENT_FILE}: archdiff intent --init writes one from the code, archdiff import <file> from a document, or draw here and run the agent` };
  const { graph } = analysis;
  const layerNames = [...intent.layers.map((layer) => layer.name)];

  for (const module of intent.modules) if (module.layer && !layerNames.includes(module.layer)) layerNames.push(module.layer);
  const nodes: Shape[] = [];
  const edges: Line[] = [];
  const shown = new Set<string>();
  let planned = 0;
  let beyond = 0;

  for (const module of intent.modules) {
    const built = graph.modules.has(module.id);
    // The path is the label; the description goes to the panel (`doc`), where it has room.
    const node: Shape = { id: module.id, kind: "module", label: module.id, ref: { id: module.id, file: module.id, line: 1 }, x: 0, y: 0, w: 0, h: 0 };

    if (module.layer) node.group = module.layer;

    if (!built) {
      node.diff = "planned";
      planned++;
    }

    if (module.description) node.doc = module.description;
    nodes.push(node);
    shown.add(module.id);

    for (const fn of module.fns) {
      const id = `${module.id}#${fn.name}`;
      const real = graph.nodes.get(id);
      const fnNode: Shape = { id, kind: "fn", label: fn.name, ref: real ? { id, file: real.module, line: real.line, endLine: real.endLine } : { id, file: module.id }, x: 0, y: 0, w: 0, h: 0 };

      if (module.layer) fnNode.group = module.layer;

      if (!real) {
        fnNode.diff = "planned";
        planned++;
      }

      if (fn.description) fnNode.doc = fn.description;
      nodes.push(fnNode);
      shown.add(id);
    }
  }

  // The code's modules of the intent's layers that the intent does not name: beyond the drawing.
  const layerSet = new Set(layerNames);

  for (const module of [...graph.modules.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (shown.has(module.id) || !layerSet.has(module.layer)) continue;
    nodes.push({ id: module.id, kind: "module", label: `${module.id}\nnot in the intent`, ref: { id: module.id, file: module.id, line: 1 }, group: module.layer, diff: "warning", x: 0, y: 0, w: 0, h: 0 });
    shown.add(module.id);
    beyond++;
  }

  const seen = new Set<string>();

  const push = (edge: Line): void => {
    const key = `${edge.from}\u0000${edge.to}`;

    if (seen.has(key) || edge.from === edge.to) return;
    seen.add(key);
    edges.push(edge);
  };

  const inCode = (from: string, to: string): boolean => (from.includes("#") || to.includes("#") ? graph.calls.some((call) => call.from === from && call.to === to) : graph.deps.some((dep) => dep.from === from && dep.to === to));

  for (const edge of intent.edges) {
    if (!shown.has(edge.from) || !shown.has(edge.to)) continue;
    const kind = edge.from.includes("#") || edge.to.includes("#") ? "call" : "dependency";
    const line: Line = { from: edge.from, to: edge.to, kind };

    if (edge.label) line.label = edge.label;

    if (!inCode(edge.from, edge.to)) line.diff = "planned";
    push(line);
  }

  const intended = new Set(intent.edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  let extra = 0;

  for (const dep of graph.deps) {
    if (!shown.has(dep.from) || !shown.has(dep.to) || dep.typeOnly || intended.has(`${dep.from}\u0000${dep.to}`)) continue;
    push({ from: dep.from, to: dep.to, kind: "dependency", diff: "warning" });
    extra++;
  }

  const groups: Lane[] = layerNames.map((name) => ({ id: name, label: intent.layers.find((layer) => layer.name === name)?.description ? `${name} — ${intent.layers.find((layer) => layer.name === name)!.description}` : name, kind: "lane", x: 0, y: 0, w: 0, h: 0 }));
  const parts = [planned > 0 ? `${planned} planned, not built yet (dashed)` : "everything planned is built", beyond > 0 ? `${beyond} modules beyond the intent (orange)` : "", extra > 0 ? `${extra} imports beyond the intent (orange)` : ""].filter(Boolean);

  return { title: `Intent: ${INTENT_FILE} against the code`, nodes, edges, groups, reason: parts.join("; "), question: "what was intended, what is built, and where the code went beyond the intent" };
}
