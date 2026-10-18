// The router for shapes placed anywhere: when the user has dragged shapes
// about, the columns the layout router relies on (routeEdges in
// excalidraw.ts) no longer exist, so lines are found on a sparse grid
// instead — the x and y lines of every shape's sides, pushed out by a
// margin, and the middles of the gaps between them — by A* over the
// grid's crossings outside every shape, with a cost for every bend and
// for a segment other lines already use, so routes stay orthogonal,
// avoid every shape but their own ends, and spread out. Ports are the
// middle of the side that faces the other end.
//
// Pure: a placed diagram in, a route per line out. Entry point:
// `routeFree`; `routeEdges` picks it when the shapes do not lie in columns.

import type { Diagram, Line, Shape } from "../diagram.ts";
import type { Point } from "./excalidraw.ts";

/** The room kept between a line and a shape. */
const MARGIN = 14;

/** The cost of a bend, in pixels of length. */
const BEND = 40;

/** The cost of sharing a grid segment with another line, in pixels of length. */
const SHARED = 24;

/** The sorted distinct values of a list, within 1 px. */
function distinct(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[] = [];

  for (const value of sorted) if (out.length === 0 || value - out[out.length - 1]! > 1) out.push(value);

  return out;
}

/** The side of `from` that faces `to`, as the port of a line between them, and which axis the line leaves along. */
function portOf(from: Shape, to: Shape, outgoing: boolean): { x: number; y: number; axis: "x" | "y" } {
  const dx = to.x + to.w / 2 - (from.x + from.w / 2);
  const dy = to.y + to.h / 2 - (from.y + from.h / 2);

  // The far side wins by the larger centre distance, so a line leaves left or right unless the other end is clearly above or below.
  if (Math.abs(dx) >= Math.abs(dy) * 0.8) return { x: dx >= 0 ? from.x + from.w : from.x, y: from.y + from.h / 2, axis: "x" };

  return { x: from.x + from.w / 2, y: dy >= 0 ? from.y + from.h : from.y, axis: outgoing ? "y" : "y" };
}

/**
 * Routes every line of a placed diagram around every shape, on a sparse
 * grid of the shapes' sides. A line between shapes that overlap, or whose
 * ends the grid cannot reach, is drawn straight.
 */
export function routeFree(diagram: Diagram): Map<Line, Point[]> {
  const boxes = new Map(diagram.nodes.filter((node) => node.kind !== "anchor" && node.kind !== "fragment").map((node) => [node.id, node]));
  const obstacles = [...boxes.values()];
  const usable = diagram.edges.filter((edge) => boxes.has(edge.from) && boxes.has(edge.to) && edge.from !== edge.to && !edge.route);
  const routes = new Map<Line, Point[]>();

  if (usable.length === 0) return routes;
  // The grid lines: every side pushed out by the margin, and the middle of every gap between neighbouring sides.
  const xsRaw = obstacles.flatMap((node) => [node.x - MARGIN, node.x + node.w + MARGIN]);
  const ysRaw = obstacles.flatMap((node) => [node.y - MARGIN, node.y + node.h + MARGIN]);
  const withMiddles = (values: number[]): number[] => {
    const sorted = distinct(values);
    const out = [...sorted];

    for (let i = 1; i < sorted.length; i++) if (sorted[i]! - sorted[i - 1]! > 2 * MARGIN) out.push((sorted[i]! + sorted[i - 1]!) / 2);

    return distinct(out);
  };
  // The ports of every line are grid lines too, so a route starts and ends exactly at a side.
  const ports = new Map<Line, { start: ReturnType<typeof portOf>; end: ReturnType<typeof portOf> }>();

  for (const edge of usable) {
    const from = boxes.get(edge.from)!;
    const to = boxes.get(edge.to)!;
    ports.set(edge, { start: portOf(from, to, true), end: portOf(to, from, false) });
  }

  const xs = withMiddles([...xsRaw, ...[...ports.values()].flatMap((port) => [port.start.x, port.end.x])]);
  const ys = withMiddles([...ysRaw, ...[...ports.values()].flatMap((port) => [port.start.y, port.end.y])]);
  const xi = new Map(xs.map((x, i) => [x, i]));
  const yi = new Map(ys.map((y, i) => [y, i]));
  // A crossing is free when no shape covers it (a port's crossing sits on a side, so its own shape is allowed there).
  const inside = (x: number, y: number, except: ReadonlySet<string>): boolean => obstacles.some((node) => !except.has(node.id) && x > node.x + 1 && x < node.x + node.w - 1 && y > node.y + 1 && y < node.y + node.h - 1);
  // Segments other lines already run along, keyed by their two crossings.
  const used = new Map<string, number>();
  const key = (a: number, b: number, c: number, d: number): string => (a < c || (a === c && b < d) ? `${a},${b}-${c},${d}` : `${c},${d}-${a},${b}`);

  const nearest = (values: number[], value: number): number => {
    let best = 0;

    for (let i = 1; i < values.length; i++) if (Math.abs(values[i]! - value) < Math.abs(values[best]! - value)) best = i;

    return best;
  };

  for (const edge of usable) {
    const { start, end } = ports.get(edge)!;
    const own = new Set([edge.from, edge.to]);
    const sx = xi.get(start.x) ?? nearest(xs, start.x);
    const sy = yi.get(start.y) ?? nearest(ys, start.y);
    const ex = xi.get(end.x) ?? nearest(xs, end.x);
    const ey = yi.get(end.y) ?? nearest(ys, end.y);
    // The ports on the grid exactly (a side within a pixel of another grid line shares it), so no segment is diagonal.
    const startPoint = { x: xs[sx]!, y: ys[sy]! };
    const endPoint = { x: xs[ex]!, y: ys[ey]! };
    const goal = `${ex},${ey}`;
    // A* over (column, row, direction): the direction makes a bend cost once, where it happens.
    type State = { x: number; y: number; dir: 0 | 1 | 2 | 3 | -1; cost: number; estimate: number; prev: State | null };
    const open: State[] = [{ x: sx, y: sy, dir: -1, cost: 0, estimate: Math.abs(xs[ex]! - xs[sx]!) + Math.abs(ys[ey]! - ys[sy]!), prev: null }];
    const best = new Map<string, number>();
    let found: State | null = null;
    let steps = 0;

    while (open.length > 0 && steps++ < 40000) {
      // The cheapest open state; the list is small enough for a scan.
      let at = 0;

      for (let i = 1; i < open.length; i++) if (open[i]!.cost + open[i]!.estimate < open[at]!.cost + open[at]!.estimate) at = i;
      const state = open.splice(at, 1)[0]!;
      const id = `${state.x},${state.y},${state.dir}`;

      if ((best.get(id) ?? Infinity) <= state.cost) continue;
      best.set(id, state.cost);

      if (`${state.x},${state.y}` === goal) {
        found = state;
        break;
      }

      const moves: [number, number, 0 | 1 | 2 | 3][] = [[1, 0, 0], [-1, 0, 1], [0, 1, 2], [0, -1, 3]];

      for (const [dx, dy, dir] of moves) {
        const nx = state.x + dx;
        const ny = state.y + dy;

        if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
        const px = xs[nx]!;
        const py = ys[ny]!;
        // A move may not enter a shape, nor cross one along the way (a long grid step can span a shape's whole width).
        const midX = (xs[state.x]! + px) / 2;
        const midY = (ys[state.y]! + py) / 2;

        if (inside(px, py, own) && `${nx},${ny}` !== goal) continue;

        if (inside(midX, midY, own) && !(nx === ex && ny === ey)) continue;
        // The first move must leave the start port along its axis; the last must enter the end port along its.
        if (state.prev === null && ((start.axis === "x" && dy !== 0) || (start.axis === "y" && dx !== 0))) continue;

        if (nx === ex && ny === ey && ((end.axis === "x" && dy !== 0) || (end.axis === "y" && dx !== 0))) continue;
        const length = Math.abs(px - xs[state.x]!) + Math.abs(py - ys[state.y]!);
        const bend = state.dir !== -1 && state.dir !== dir ? BEND : 0;
        const shared = (used.get(key(state.x, state.y, nx, ny)) ?? 0) * SHARED;
        open.push({ x: nx, y: ny, dir, cost: state.cost + length + bend + shared, estimate: Math.abs(xs[ex]! - px) + Math.abs(ys[ey]! - py), prev: state });
      }
    }

    if (!found) {
      // No way through the grid (the ends are walled in): an L through the midpoint, which is at least orthogonal.
      routes.set(edge, [startPoint, { x: endPoint.x, y: startPoint.y }, endPoint]);
      continue;
    }

    // Back along the states; keep only the bends, with the two ports exact.
    const cells: { x: number; y: number }[] = [];

    for (let state: State | null = found; state; state = state.prev) cells.unshift({ x: state.x, y: state.y });

    for (let i = 1; i < cells.length; i++) used.set(key(cells[i - 1]!.x, cells[i - 1]!.y, cells[i]!.x, cells[i]!.y), (used.get(key(cells[i - 1]!.x, cells[i - 1]!.y, cells[i]!.x, cells[i]!.y)) ?? 0) + 1);
    const points: Point[] = cells.map((cell) => ({ x: xs[cell.x]!, y: ys[cell.y]! }));
    const route: Point[] = [startPoint];

    for (let i = 1; i < points.length - 1; i++) {
      const before = points[i - 1]!;
      const here = points[i]!;
      const after = points[i + 1]!;
      const straight = (before.x === here.x && here.x === after.x) || (before.y === here.y && here.y === after.y);

      if (!straight) route.push(here);
    }

    route.push(endPoint);
    routes.set(edge, route);
  }

  return routes;
}
