// The drawn picture: shapes, lines and lanes, and the layout that places
// them. A `Diagram` is what every view (views.ts) produces, what the web
// canvas draws, and what every export (export/*.ts) translates — so the
// layout runs once, in plain TypeScript, and the same inputs give the same
// JSON. Ranks by depth, order by barycentre, fixed sizes; nothing here reads
// a file.
//
// Pipeline: Graph → view → Diagram (unplaced) → `layout` → Diagram (placed).
// Entry points: `layout`, `SIZE`, and the types.

import { greedyOrder } from "./order.ts";

/** The marking of a shape in the picture of a diff (`archdiff review`). */
/**
 * `added`, `removed`, `changed`: a review's marks; `warning`: a finding (a
 * module without tests, code beyond the intent), orange; `planned`: in the
 * intent but not in the code yet, dashed blue.
 */
export type DiffMark = "added" | "removed" | "changed" | "warning" | "planned";

/** One shape: what it stands for, its lane, and its box once laid out. */
export interface DiagramNode {
  id: string;
  /**
   * `layer`: a lane drawn as a box (the layers view); `module`: a file;
   * `fn`: a function, method or class; `external`: a package or a built-in;
   * `hole`: a call archdiff could not resolve; `start`: an entry point;
   * `more`: the shapes a big view folds away (`count` of them), so the
   * picture stays readable — the Markdown lists them all; `participant`:
   * a module at the top of a sequence view; `anchor`: an invisible point
   * (the foot of a lifeline); `event`: an event name (emitted, listened
   * to); `cell`: a box of a table or a bar of a chart, sized by the view;
   * `package`: a package of a monorepo; `class`: a class or interface box
   * of the class diagram, its label the fields and methods line by line;
   * `state`: a state of a state machine (or a machine in the list of them);
   * `fragment`: a dashed frame of a sequence around the calls under one
   * guard (`opt`, `loop`), its label top left; `decision`: a branch of a
   * function's logic (a diamond: an `if`, a `switch`, a loop header, a
   * `try`); `action`: one or two plain statements of it; `end`: where a
   * path of it ends (`return`, `throw`, the end of the body).
   */
  kind: "layer" | "module" | "fn" | "external" | "hole" | "start" | "more" | "participant" | "anchor" | "event" | "cell" | "package" | "class" | "state" | "fragment" | "decision" | "action" | "end";
  /** How hot the shape is, 0–1 (a hotspot's calls in, a matrix cell's count): the fill darkens with it. */
  heat?: number;
  label: string;
  /** The code the shape stands for: a graph ID and a position. */
  ref?: { id?: string; file?: string; line?: number; endLine?: number };
  /** A `fn`: its signature as written, for the properties panel. */
  signature?: string;
  /** The documentation comment of the code, for the properties panel. */
  doc?: string;
  /** The picture of a diff: added, removed or changed since the base; absent for context. */
  diff?: DiffMark;
  /** A `hole`: why the call is not resolved. */
  reason?: string;
  /** The lane (layer) the shape sits in. */
  group?: string;
  /** How many things the shape stands for when it summarises (a layer: its modules). */
  count?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One line between two shapes. */
export interface DiagramEdge {
  from: string;
  to: string;
  /**
   * `dependency`: an import; `call`: a resolved call; `ref`: a function passed as a value (may be called);
   * `message`: one call of a sequence view, in order; `lifeline`: the dashed line under a participant;
   * `flow`: the next step of a function's logic, labelled with the branch taken (`yes`, `no`, a case, `each`, `done`).
   */
  kind: "dependency" | "call" | "ref" | "message" | "lifeline" | "flow";
  label?: string;
  /** The line's own bends, scene coordinates, when the view placed it (a sequence): exports draw these instead of routing. */
  route?: { x: number; y: number }[];
  /** How many underlying edges the line stands for (a layer edge: imports between its modules). */
  count?: number;
  diff?: DiffMark;
  /** Only types cross the line (`import type`): drawn dashed, counted only when asked (`--types`). */
  typeOnly?: true;
}

/** A lane: one layer, a band across the diagram. */
export interface DiagramGroup {
  id: string;
  label: string;
  kind: "lane";
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A drawn view: shapes, lines, lanes, and why it is empty or cut short. */
export interface Diagram {
  /** The view key the picture answers (`layers`, `module:src/x.ts`, …). */
  view: string;
  title: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
  groups: DiagramGroup[];
  /** Why the diagram is empty or cut short. */
  reason?: string;
  /** The one question the picture answers, for the page and the Markdown ("which modules of the layer import which"). */
  question?: string;
  /** The revision the picture was drawn from: the short commit and its date; exports carry it so a file says what it shows. */
  stamp?: { commit: string; date: string };
  /** The subject of the view does not exist (no such module, function, layer or directory): the reason says which. */
  missing?: true;
  /** `down`: a stack, one shape per row (the layers view); else ranks as columns from the left. */
  direction?: "down";
  /** The shapes have their places already (a sequence view): `layout` keeps them, exports draw the routes given. */
  placed?: true;
  /** How the lanes lie: bands down the picture (`rows`) or blocks across it (`columns`); absent: rows, or columns on a map of many lanes. */
  lanes?: "rows" | "columns";
  /** Some shapes sit where the user put them, not in the layout's columns: the lines are routed on a grid around every shape (route-free.ts). */
  freeform?: true;
  /** A sequence view: the Mermaid export is a sequenceDiagram and the Markdown lists the messages in order. */
  sequence?: { participants: string[]; messages: { from: string; to: string; label: string; line: number; times?: number }[]; fragments?: SequenceFragment[] };
  /** A machine view: the states and transitions behind the picture (Mermaid: a stateDiagram-v2; Markdown: a table). */
  machine?: MachineData;
  /** A metrics view: the numbers behind the table, for the Markdown and the quadrant chart. */
  metrics?: Metrics;
  /** A logic view: the function, and every path from its start to an exit as a rule (the Markdown's table); the Mermaid is a flowchart TB. */
  logic?: LogicData;
  /** A class view: the Mermaid export is a classDiagram. */
  classes?: { boxes: { id: string; name: string; kind: "class" | "interface" | "type"; fields: string[]; methods: string[] }[]; relations: { from: string; to: string; kind: "extends" | "implements" }[] };
}

/** A frame of a sequence around the messages `first`..`last` (indices): the calls under one guard. */
export interface SequenceFragment {
  kind: "opt" | "loop";
  label: string;
  first: number;
  last: number;
  /** How deep the frame nests: 0 outermost. */
  level: number;
}

/** A state machine as a picture carries it (machines.ts). */
export interface MachineData {
  name: string;
  module: string;
  initial: string | null;
  /** `declared`: named by a type; `assigned`: set somewhere in the code. */
  states: { name: string; declared: boolean; assigned: boolean }[];
  /** `from` is `*` for a transition from any state; `event` names a library's event, `fn` the function that makes it. */
  transitions: { from: string; to: string; event?: string; fn?: string; line: number }[];
}

/** A function's logic as a picture carries it (logic.ts): the paths from the start to every exit, each the conditions taken and what it ends in. */
export interface LogicData {
  fn: string;
  module: string;
  /** How many branches, loops and exits the body has. */
  decisions: number;
  loops: number;
  exits: number;
  paths: LogicPath[];
  /** The body had more statements than the picture holds. */
  truncated?: true;
  /** More paths than the table lists. */
  morePaths?: number;
}

/** One way through a function: the branches taken in order (`total < 0: yes`), the calls on the way, and how it ends. */
export interface LogicPath {
  conditions: string[];
  calls: string[];
  /** `return order`, `throw new Error("…")`, or `end` for the end of the body. */
  outcome: string;
  kind: "return" | "throw" | "end";
}

/** The whole repository for the page's project map (project-map.ts): a dot per module (or directory), a line per import. */
export interface ProjectMap {
  layers: string[];
  nodes: ProjectMapNode[];
  edges: ProjectMapEdge[];
  /** `module`, or `dir:<depth>` when the modules were folded to directories of that depth. */
  level: string;
}

export interface ProjectMapNode {
  /** The module's path, or a directory's when the map is folded (`dir:` prefix). */
  id: string;
  label: string;
  layer: string;
  /** Lines of code, the size of the dot. */
  lines: number;
  fns: number;
  /** Folded: how many modules the dot stands for. */
  modules?: number;
}

export interface ProjectMapEdge {
  from: string;
  to: string;
  count: number;
  typeOnly?: true;
}

/** The coupling and cohesion of one module (metrics.ts): Martin's Ca, Ce, I, A and D, and the cohesion of its functions. */
export interface ModuleMetrics {
  id: string;
  layer: string;
  /** Afferent coupling: modules of the repository that import it. */
  ca: number;
  /** Efferent coupling: modules of the repository it imports. */
  ce: number;
  /** Ce / (Ca + Ce): 0 stable (depended upon), 1 unstable (depends on others). */
  instability: number;
  /** Types and interfaces among its top-level declarations, 0–1. */
  abstractness: number;
  /** |A + I − 1|: the distance from the main sequence. */
  distance: number;
  /** 1 when its functions form one group (by calls, shared callees and shared types), 0 when each stands alone. */
  cohesion: number;
  lines: number;
  fns: number;
  callsIn: number;
  callsOut: number;
}

export interface LayerMetrics {
  name: string;
  modules: number;
  ca: number;
  ce: number;
  instability: number;
  abstractness: number;
  distance: number;
}

export interface Metrics {
  modules: ModuleMetrics[];
  layers: LayerMetrics[];
}

/** Far from the main sequence, and coupled enough for it to matter: an isolated module (Ca = Ce = 0) has D = 1 and no pain. */
export function farFromMainSequence(row: ModuleMetrics): boolean {
  return row.distance >= 0.7 && row.ca + row.ce >= 2;
}

/** Manual places that win over the computed ones, by node ID. */
export type Positions = Readonly<Record<string, { x: number; y: number; w?: number; h?: number }>>;

/** The box of every kind of shape. */
export const SIZE: Record<DiagramNode["kind"], { w: number; h: number }> = {
  layer: { w: 180, h: 60 },
  module: { w: 170, h: 56 },
  fn: { w: 170, h: 56 },
  external: { w: 150, h: 50 },
  hole: { w: 60, h: 40 },
  start: { w: 36, h: 36 },
  more: { w: 150, h: 50 },
  participant: { w: 150, h: 44 },
  anchor: { w: 2, h: 2 },
  event: { w: 150, h: 44 },
  cell: { w: 70, h: 34 },
  package: { w: 180, h: 60 },
  class: { w: 230, h: 80 },
  state: { w: 150, h: 50 },
  fragment: { w: 2, h: 2 },
  decision: { w: 230, h: 80 },
  action: { w: 230, h: 64 },
  end: { w: 170, h: 48 },
};

/** One cell of the grid: the largest shape and the gaps around it. */
const CELL_W = 260;

const CELL_H = 90;

const LANE_PAD = 20;

/** At most this many shapes one above another in a lane's rank; more wrap into the next column. */
const MAX_ROWS = 8;

/** The gap between two lanes lying as columns. */
const LANE_GAP = 24;

/** More lanes than this on a map, and they lie as columns unless the picture says rows. */
const COLUMNS_ABOVE = 6;

/** The room kept around a shape the user placed by hand, so a computed shape never sits on it. */
const MANUAL_MARGIN = 12;

/** The ranks of a picture: each shape's longest path from a root (back edges of a cycle ignored), and the forward edges kept. */
interface Ranked {
  rank: Map<string, number>;
  /** The edges that go forward in the depth-first order (`from\u0000to`); the others close a cycle and are ignored. */
  forward: Set<string>;
  out: Map<string, string[]>;
}

/** Ranks by depth: a depth-first order from every root (then from whatever a cycle left unreached), an edge back onto the stack ignored, and the longest path along the edges kept. */
function rankNodes(diagram: Diagram, index: ReadonlyMap<string, number>): Ranked {
  // The edges as adjacency, ignoring self-loops and edges to unknown shapes.
  const out = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const edge of diagram.edges) {
    if (!index.has(edge.from) || !index.has(edge.to) || edge.from === edge.to) continue;
    out.set(edge.from, [...(out.get(edge.from) ?? []), edge.to]);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const state = new Map<string, "open" | "done">();
  const order: string[] = [];

  const visit = (start: string): void => {
    // Iterative, so a long call chain cannot overflow the stack.
    const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];

    if (state.get(start)) return;
    state.set(start, "open");

    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const targets = out.get(top.id) ?? [];

      if (top.next < targets.length) {
        const next = targets[top.next++]!;

        if (!state.get(next)) {
          state.set(next, "open");
          stack.push({ id: next, next: 0 });
        }
      } else {
        state.set(top.id, "done");
        order.push(top.id);
        stack.pop();
      }
    }
  };

  const roots = diagram.nodes.filter((node) => !indegree.get(node.id)).map((node) => node.id);

  for (const id of [...roots, ...diagram.nodes.map((node) => node.id)]) visit(id);
  // `order` is a reverse topological order of the edges kept; ranks follow it backwards.
  const forward = new Set<string>();
  const position = new Map(order.map((id, i) => [id, i]));

  for (const [from, list] of out) for (const to of list) if (position.get(from)! > position.get(to)!) forward.add(`${from}\u0000${to}`);
  const rank = new Map<string, number>();

  for (const id of [...order].reverse()) {
    const own = rank.get(id) ?? 0;
    rank.set(id, own);

    for (const to of out.get(id) ?? []) if (forward.has(`${id}\u0000${to}`)) rank.set(to, Math.max(rank.get(to) ?? 0, own + 1));
  }

  return { rank, forward, out };
}

/** Where each shape sits in its (lane, rank) cell: its slot, and how many shapes the cell holds. */
interface Ordered {
  slot: Map<string, number>;
  count: Map<string, number>;
}

/**
 * Orders the shapes of every rank: by lane, then next to what leads into
 * them (the mean place of their predecessors, rank by rank: the
 * barycentre, to reduce crossings; a shape without neighbours keeps its
 * place), then diagram order; then two sweeps back (by successors) and
 * forth (by predecessors), the usual layered ordering, which settles most
 * crossings a single pass leaves.
 */
function orderRanks(diagram: Diagram, ranked: Ranked, index: ReadonlyMap<string, number>, laneOf: (node: DiagramNode) => number): Ordered {
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();

  for (const [from, list] of ranked.out) {
    for (const to of list) {
      if (!ranked.forward.has(`${from}\u0000${to}`)) continue;
      preds.set(to, [...(preds.get(to) ?? []), from]);
      succs.set(from, [...(succs.get(from) ?? []), to]);
    }
  }

  const ordinal = new Map<string, number>();
  const byRank = new Map<number, DiagramNode[]>();

  for (const node of diagram.nodes) byRank.set(ranked.rank.get(node.id)!, [...(byRank.get(ranked.rank.get(node.id)!) ?? []), node]);
  const slot = new Map<string, number>();
  const count = new Map<string, number>();

  // One pass over a rank: sort its shapes by lane, the mean place of their neighbours on the side given, then diagram
  // order, and give each its slot in its (lane, rank) cell.
  const place = (r: number, neighbours: Map<string, string[]>): void => {
    const pull = (node: DiagramNode): number => {
      const known = (neighbours.get(node.id) ?? []).map((id) => ordinal.get(id)).filter((value): value is number => value !== undefined);

      return known.length === 0 ? (ordinal.get(node.id) ?? Infinity) : known.reduce((sum, value) => sum + value, 0) / known.length;
    };

    const keys = new Map(byRank.get(r)!.map((node) => [node.id, pull(node)]));
    const sorted = [...byRank.get(r)!].sort((a, b) => laneOf(a) - laneOf(b) || keys.get(a.id)! - keys.get(b.id)! || index.get(a.id)! - index.get(b.id)!);

    for (const node of byRank.get(r)!) count.delete(`${laneOf(node)}:${r}`);

    for (const node of sorted) {
      const key = `${laneOf(node)}:${r}`;
      const n = count.get(key) ?? 0;
      count.set(key, n + 1);
      slot.set(node.id, n);
      ordinal.set(node.id, laneOf(node) * 100000 + n);
    }
  };

  const ranks = [...byRank.keys()].sort((a, b) => a - b);

  for (const r of ranks) place(r, preds);

  for (let sweep = 0; sweep < 2; sweep++) {
    for (const r of [...ranks].reverse()) place(r, succs);

    for (const r of ranks) place(r, preds);
  }

  return { slot, count };
}

/** The grid: the left edge of every rank's block, the top of every lane, the cell size, and how many rows a cell wraps into. */
interface Grid {
  left: Map<number, number>;
  top: Map<number, number>;
  rows: Map<number, number>;
  gridW: number;
  gridH: number;
  rowsOf(key: string): number;
}

/**
 * The grid of the cells: a lane's rank with many shapes wraps into columns
 * of at most MAX_ROWS (a fn calling thirty others is a block, not a
 * column taller than the screen); a rank is as wide as the most columns
 * any lane's cell needs; a lane is as tall as its fullest rank; cells grow
 * to the tallest and widest shape (class boxes carry their own size).
 */
function gridOf(diagram: Diagram, ordered: Ordered, laneCount: number, sized: (node: DiagramNode) => { w: number; h: number }): Grid {
  const columns = new Map<number, number>();

  const rowsOf = (key: string): number => {
    const n = ordered.count.get(key) ?? 0;

    return Math.ceil(n / Math.ceil(n / MAX_ROWS));
  };

  for (const [key, n] of ordered.count) {
    const r = Number(key.split(":")[1]);
    columns.set(r, Math.max(columns.get(r) ?? 1, Math.ceil(n / MAX_ROWS)));
  }

  const gridW = Math.max(CELL_W, ...diagram.nodes.map((node) => sized(node).w + 40));
  const gridH = Math.max(CELL_H, ...diagram.nodes.map((node) => sized(node).h + 24));
  const left = new Map<number, number>();
  let x = LANE_PAD;

  for (let r = 0; r <= Math.max(0, ...columns.keys()); r++) {
    left.set(r, x);
    x += (columns.get(r) ?? 1) * gridW;
  }

  const rows = new Map<number, number>();

  for (const key of ordered.count.keys()) {
    const lane = Number(key.split(":")[0]);
    rows.set(lane, Math.max(rows.get(lane) ?? 0, rowsOf(key)));
  }

  const top = new Map<number, number>();
  let y = 0;

  // Shapes without a lane go last.
  for (const lane of [...Array.from({ length: laneCount }, (_, i) => i), laneCount]) {
    if (!rows.has(lane)) continue;
    top.set(lane, y);
    y += rows.get(lane)! * gridH + 2 * LANE_PAD;
  }

  return { left, top, rows, gridW, gridH, rowsOf };
}

/**
 * Places the shapes: the rank of a node is its longest path from a node
 * without predecessors (back edges of a cycle ignored), its column block;
 * within a lane and a rank, nodes go next to their predecessors (their mean
 * place), then by their order in the diagram; more than `MAX_ROWS` of them
 * wrap into further columns of the block. Lanes are horizontal bands as tall
 * as their fullest rank, or blocks across the picture (`lanes: "columns"`).
 * `positions` override the computed place of a node, and the computed
 * shapes keep clear of them. Pure: a new diagram.
 */
export function layout(diagram: Diagram, positions: Positions = {}): Diagram {
  // A placed diagram keeps its places; only manual positions win.
  if (diagram.placed) {
    return { ...diagram, nodes: diagram.nodes.map((node) => (Object.hasOwn(positions, node.id) ? { ...node, x: positions[node.id]!.x, y: positions[node.id]!.y } : node)) };
  }

  const index = new Map(diagram.nodes.map((node, i) => [node.id, i]));
  const laneIds = diagram.groups.map((group) => group.id);
  const laneOf = (node: DiagramNode): number => (node.group !== undefined && laneIds.includes(node.group) ? laneIds.indexOf(node.group) : laneIds.length);
  const sized = (node: DiagramNode): { w: number; h: number } => (node.w > 0 && node.h > 0 ? { w: node.w, h: node.h } : SIZE[node.kind]);
  const ranked = rankNodes(diagram, index);
  const ordered = orderRanks(diagram, ranked, index, laneOf);
  const { left, top, rows, gridW, gridH, rowsOf } = gridOf(diagram, ordered, laneIds.length, sized);

  // Place each shape centred in its grid cell; a manual position wins.
  const nodes = diagram.nodes.map((node): DiagramNode => {
    const size = sized(node);
    const lane = laneOf(node);
    const r = ranked.rank.get(node.id)!;
    const height = rowsOf(`${lane}:${r}`);
    const n = ordered.slot.get(node.id)!;

    // A stack: one row per shape, in the diagram's order; the canvas draws its edges as arcs beside it.
    const placed =
      diagram.direction === "down"
        ? { ...node, x: LANE_PAD + (gridW - size.w) / 2, y: LANE_PAD + index.get(node.id)! * gridH + (gridH - size.h) / 2, w: size.w, h: size.h }
        : {
            ...node,
            x: left.get(r)! + Math.floor(n / height) * gridW + (gridW - size.w) / 2,
            y: top.get(lane)! + LANE_PAD + (n % height) * gridH + (gridH - size.h) / 2,
            w: size.w,
            h: size.h,
          };

    const manual = Object.hasOwn(positions, node.id) ? positions[node.id] : undefined;

    return manual ? { ...placed, x: manual.x, y: manual.y, w: manual.w ?? placed.w, h: manual.h ?? placed.h } : placed;
  });

  // A computed shape never sits on one the user placed: it moves down its column, a row at a time, until it is clear.
  const manualIds = new Set(nodes.filter((node) => Object.hasOwn(positions, node.id)).map((node) => node.id));

  if (manualIds.size > 0) avoidManual(nodes, manualIds, gridH);
  const right = Math.max(0, ...nodes.map((node) => node.x + node.w)) + LANE_PAD;

  // Lanes span the full width and grow to enclose any shape moved outside their band.
  const groups = diagram.groups.map((group, lane): DiagramGroup => {
    const members = nodes.filter((node) => laneOf(node) === lane);
    const from = Math.min(top.get(lane) ?? 0, ...members.map((node) => node.y - LANE_PAD));
    const to = Math.max((top.get(lane) ?? 0) + (rows.get(lane) ?? 0) * gridH + 2 * LANE_PAD, ...members.map((node) => node.y + node.h + LANE_PAD));

    return { ...group, x: 0, y: from, w: right, h: to - from };
  });

  // Lanes as columns: a map of many layers reads across, each lane a block, in the order the lines flow.
  const columnsWanted = diagram.lanes === "columns" || (diagram.lanes === undefined && groups.length > COLUMNS_ABOVE && /^(modules|layer:|dir:)/.test(diagram.view));

  if (columnsWanted && diagram.direction !== "down" && manualIds.size === 0 && groups.length > 1) return lanesAsColumns({ ...diagram, nodes, groups }, laneOf);

  return manualIds.size > 0 ? { ...diagram, nodes, groups, freeform: true } : { ...diagram, nodes, groups };
}

/** Shapes the user placed keep their place; a computed shape on top of one moves down its column until it is clear. */
function avoidManual(nodes: DiagramNode[], manualIds: ReadonlySet<string>, step: number): void {
  const manual = nodes.filter((node) => manualIds.has(node.id));

  const clashes = (node: DiagramNode): boolean => manual.some((other) => node.x < other.x + other.w + MANUAL_MARGIN && node.x + node.w + MANUAL_MARGIN > other.x && node.y < other.y + other.h + MANUAL_MARGIN && node.y + node.h + MANUAL_MARGIN > other.y);

  for (const node of nodes) {
    if (manualIds.has(node.id) || node.kind === "anchor") continue;

    for (let tries = 0; tries < 60 && clashes(node); tries++) node.y += step;
  }
}

/**
 * The lanes laid as columns: each lane a block holding its shapes as the
 * row layout placed them (ranks left to right inside the block), the
 * blocks side by side in the order most lines flow (a lane nothing of
 * the rest imports first), top-aligned. Shapes without a lane make a
 * last block. Pure: a new diagram.
 */
function lanesAsColumns(diagram: Diagram, laneOf: (node: DiagramNode) => number): Diagram {
  const laneCount = diagram.groups.length;
  const counts = new Map<string, number>();
  const index = new Map(diagram.nodes.map((node) => [node.id, node]));

  for (const edge of diagram.edges) {
    const from = index.get(edge.from);
    const to = index.get(edge.to);

    if (!from || !to) continue;
    const a = String(laneOf(from));
    const b = String(laneOf(to));

    if (a !== b) counts.set(`${a}\u0000${b}`, (counts.get(`${a}\u0000${b}`) ?? 0) + (edge.count ?? 1));
  }

  const lanes = [...new Set(diagram.nodes.map((node) => String(laneOf(node))))];
  const order = greedyOrder(lanes, counts);
  const moved = new Map<string, DiagramNode>();
  const boxes = new Map<string, { x: number; w: number; h: number }>();
  let offset = LANE_PAD;

  for (const lane of order) {
    const members = diagram.nodes.filter((node) => String(laneOf(node)) === lane);
    const minX = Math.min(...members.map((node) => node.x));
    const minY = Math.min(...members.map((node) => node.y));
    const width = Math.max(...members.map((node) => node.x + node.w)) - minX + 2 * LANE_PAD;
    const height = Math.max(...members.map((node) => node.y + node.h)) - minY + 3 * LANE_PAD;

    for (const node of members) moved.set(node.id, { ...node, x: node.x - minX + offset + LANE_PAD, y: node.y - minY + 2 * LANE_PAD });
    boxes.set(lane, { x: offset, w: width, h: height });
    offset += width + LANE_GAP;
  }

  const nodes = diagram.nodes.map((node) => moved.get(node.id) ?? node);
  const groups = diagram.groups.map((group, lane): DiagramGroup => {
    const box = boxes.get(String(lane));

    return box ? { ...group, x: box.x, y: 0, w: box.w, h: box.h } : { ...group, x: 0, y: 0, w: 0, h: 0 };
  });

  // A lane without shapes has no block: it is left out, as the row layout leaves an empty band out.
  return { ...diagram, nodes, groups: groups.filter((group, lane) => boxes.has(String(lane)) || lane >= laneCount), lanes: "columns" };
}
