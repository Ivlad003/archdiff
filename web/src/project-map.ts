// The project map: the whole repository as a graph laid out by forces
// over the canvas, the way Obsidian draws a vault — a dot per module
// (or per directory when the repository is big), coloured by layer and
// sized by lines, a line per import. Hover names a dot and lights its
// neighbours, a click opens the module's view, Shift+click everything
// joined to it, a double click its inside; the dots of the current
// picture wear a ring, so the reader sees where in the project the
// picture sits. Search filters the labels, the layer chips hide layers.
// Takes the page as its context (page.ts).

import { api, type ProjectMap } from "./api.ts";
import { element, h } from "./dom.ts";
import { page } from "./page.ts";
import { setLink, currentLink } from "./link.ts";

interface Dot {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  layer: number;
  pinned: boolean;
}

/** The colours of the layers, in their order; a twelfth layer wraps around. */
const PALETTE = ["#1565c0", "#2e7d32", "#ef6c00", "#6a1b9a", "#00838f", "#c62828", "#558b2f", "#4527a0", "#ff8f00", "#00695c", "#ad1457", "#37474f"];

/** Iterations of the layout before it stops. */
const ITERATIONS = 320;

let data: ProjectMap | null = null;
let dots: Dot[] = [];
let byId = new Map<string, Dot>();
let neighbours = new Map<string, Set<string>>();
let iteration = 0;
let frame: number | null = null;
/** Screen = world × k + offset. */
let view = { x: 0, y: 0, k: 1 };
let hover: string | null = null;
let search = "";
const hiddenLayers = new Set<string>();
let drag: { id: string | null; startX: number; startY: number; moved: boolean; viewX: number; viewY: number } | null = null;
let loadedFor = "";

const overlay = (): HTMLDivElement => element<HTMLDivElement>("project-map");
const canvas = (): HTMLCanvasElement => element<HTMLCanvasElement>("project-map-canvas");

/** A deterministic sequence in [0, 1), so the same repository lays out the same way each time. */
function random(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The dots and their first places: each layer's dots around a point of a circle, so the layers start apart. */
function seed(map: ProjectMap): void {
  const next = random(map.nodes.length * 7919 + map.edges.length);
  const layers = map.layers.length > 0 ? map.layers : [...new Set(map.nodes.map((node) => node.layer))];
  dots = map.nodes.map((node) => {
    const layer = Math.max(0, layers.indexOf(node.layer));
    const angle = (layer / Math.max(1, layers.length)) * Math.PI * 2;
    const spread = 160 + Math.sqrt(map.nodes.length) * 12;

    return { id: node.id, x: Math.cos(angle) * spread + (next() - 0.5) * 120, y: Math.sin(angle) * spread + (next() - 0.5) * 120, vx: 0, vy: 0, radius: 3 + Math.min(10, Math.sqrt(node.lines) / 4), layer, pinned: false };
  });
  byId = new Map(dots.map((dot) => [dot.id, dot]));
  neighbours = new Map();

  for (const edge of map.edges) {
    neighbours.set(edge.from, (neighbours.get(edge.from) ?? new Set()).add(edge.to));
    neighbours.set(edge.to, (neighbours.get(edge.to) ?? new Set()).add(edge.from));
  }

  iteration = 0;
}

/** One step of the layout: repulsion between every two dots, attraction along the imports, a pull to the centre and to the layer's own centre, cooling. */
function step(): void {
  if (!data || dots.length === 0) return;
  const n = dots.length;
  const k = Math.max(28, Math.sqrt((900 * 900) / n));
  const temperature = Math.max(0.6, 40 * (1 - iteration / ITERATIONS));

  for (const dot of dots) {
    dot.vx = 0;
    dot.vy = 0;
  }

  for (let i = 0; i < n; i++) {
    const a = dots[i]!;

    for (let j = i + 1; j < n; j++) {
      const b = dots[j]!;
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      let distance = Math.hypot(dx, dy);

      if (distance < 0.01) {
        dx = (i - j) * 0.01;
        dy = 0.01;
        distance = 0.014;
      }

      const force = (k * k) / distance / distance;
      a.vx += dx * force;
      a.vy += dy * force;
      b.vx -= dx * force;
      b.vy -= dy * force;
    }
  }

  for (const edge of data.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);

    if (!a || !b) continue;
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const distance = Math.max(0.01, Math.hypot(dx, dy));
    const force = ((distance * distance) / k) * Math.min(3, 0.6 + edge.count * 0.4) / distance;
    a.vx -= dx * force;
    a.vy -= dy * force;
    b.vx += dx * force;
    b.vy += dy * force;
  }

  // The centre of each layer, for the pull that keeps a layer together.
  const centres = new Map<number, { x: number; y: number; n: number }>();

  for (const dot of dots) {
    const centre = centres.get(dot.layer) ?? { x: 0, y: 0, n: 0 };
    centre.x += dot.x;
    centre.y += dot.y;
    centre.n++;
    centres.set(dot.layer, centre);
  }

  for (const dot of dots) {
    if (dot.pinned) continue;
    const centre = centres.get(dot.layer)!;
    dot.vx += (centre.x / centre.n - dot.x) * 0.03 - dot.x * 0.012;
    dot.vy += (centre.y / centre.n - dot.y) * 0.03 - dot.y * 0.012;
    const speed = Math.hypot(dot.vx, dot.vy);
    const capped = Math.min(speed, temperature);

    if (speed > 0) {
      dot.x += (dot.vx / speed) * capped;
      dot.y += (dot.vy / speed) * capped;
    }
  }

  iteration++;
}

/** Fits every dot into the canvas with a margin. */
function fit(): void {
  if (dots.length === 0) return;
  const box = canvas().getBoundingClientRect();
  const minX = Math.min(...dots.map((dot) => dot.x));
  const maxX = Math.max(...dots.map((dot) => dot.x));
  const minY = Math.min(...dots.map((dot) => dot.y));
  const maxY = Math.max(...dots.map((dot) => dot.y));
  const k = Math.min(3, Math.max(0.15, Math.min((box.width - 80) / Math.max(1, maxX - minX), (box.height - 80) / Math.max(1, maxY - minY))));
  view = { k, x: box.width / 2 - ((minX + maxX) / 2) * k, y: box.height / 2 - ((minY + maxY) / 2) * k };
}

/** The modules of the current picture: the dots that wear a ring. */
function currentModules(): Set<string> {
  const files = new Set<string>();

  for (const node of page.nodes().values()) {
    if (node.ref?.file) files.add(node.ref.file);
    else if (node.kind === "module") files.add(node.id);
  }

  if (!data || data.level === "module") return files;
  // A folded map: the directory a file falls in at the map's depth.
  const depth = Number(data.level.slice(4));

  return new Set([...files].map((file) => `dir:${file.split("/").slice(0, depth).join("/")}`));
}

function draw(): void {
  if (!data) return;
  const target = canvas();
  const box = target.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;

  if (target.width !== Math.round(box.width * ratio) || target.height !== Math.round(box.height * ratio)) {
    target.width = Math.round(box.width * ratio);
    target.height = Math.round(box.height * ratio);
  }

  const context = target.getContext("2d")!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  const dark = document.documentElement.classList.contains("dark");
  context.fillStyle = dark ? "#121417" : "#fafafa";
  context.fillRect(0, 0, box.width, box.height);
  const layers = data.layers;
  const visible = (dot: Dot): boolean => !hiddenLayers.has(layers[dot.layer] ?? "");
  const needle = search.trim().toLowerCase();
  const matches = (id: string): boolean => needle === "" || id.toLowerCase().includes(needle);
  const current = currentModules();
  const lit = hover ? new Set([hover, ...(neighbours.get(hover) ?? [])]) : null;
  const sx = (x: number): number => x * view.k + view.x;
  const sy = (y: number): number => y * view.k + view.y;

  // The imports: thin, lighter still when neither end is lit or searched.
  for (const edge of data.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);

    if (!a || !b || !visible(a) || !visible(b)) continue;
    const dim = (lit && !(lit.has(a.id) && lit.has(b.id))) || (needle !== "" && !matches(a.id) && !matches(b.id));
    context.strokeStyle = dim ? (dark ? "rgba(144,164,174,0.12)" : "rgba(96,125,139,0.12)") : lit ? "#ff6f00" : dark ? "rgba(144,164,174,0.45)" : "rgba(96,125,139,0.45)";
    context.lineWidth = Math.min(3, 0.6 + Math.log2(edge.count));
    context.setLineDash(edge.typeOnly ? [3, 3] : []);
    context.beginPath();
    context.moveTo(sx(a.x), sy(a.y));
    context.lineTo(sx(b.x), sy(b.y));
    context.stroke();
  }

  context.setLineDash([]);
  context.font = "11px system-ui, sans-serif";
  context.textBaseline = "middle";

  for (const dot of dots) {
    if (!visible(dot)) continue;
    const x = sx(dot.x);
    const y = sy(dot.y);
    const radius = dot.radius * Math.max(0.7, Math.min(1.6, view.k));
    const dim = (lit && !lit.has(dot.id)) || (needle !== "" && !matches(dot.id));
    context.globalAlpha = dim ? 0.18 : 1;
    context.fillStyle = PALETTE[dot.layer % PALETTE.length]!;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();

    if (current.has(dot.id)) {
      context.strokeStyle = "#ff6f00";
      context.lineWidth = 2.5;
      context.beginPath();
      context.arc(x, y, radius + 3, 0, Math.PI * 2);
      context.stroke();
    }

    const label = data.nodes.find((node) => node.id === dot.id)?.label ?? dot.id;
    const named = !dim && (dot.id === hover || current.has(dot.id) || radius >= 6 || view.k >= 1.6 || (needle !== "" && matches(dot.id)));

    if (named) {
      context.fillStyle = dark ? "#e3e6ea" : "#212121";
      context.fillText(label.length > 48 ? `…${label.slice(-47)}` : label, x + radius + 4, y);
    }

    context.globalAlpha = 1;
  }

  const tip = element<HTMLDivElement>("map-tip");

  if (hover && byId.has(hover)) {
    const node = data.nodes.find((candidate) => candidate.id === hover)!;
    const dot = byId.get(hover)!;
    tip.hidden = false;
    tip.textContent = `${node.label} — ${node.layer}${node.modules ? `, ${node.modules} modules` : ""}, ${node.lines} lines, ${node.fns} functions, ${neighbours.get(hover)?.size ?? 0} joined · click opens, Shift+click focuses, double click goes inside`;
    tip.style.left = `${Math.min(sx(dot.x) + 14, box.width - 320)}px`;
    tip.style.top = `${sy(dot.y) + 14}px`;
  } else tip.hidden = true;
}

function tick(): void {
  frame = null;

  if (!data || overlay().hidden) return;

  if (iteration < ITERATIONS) {
    // Several steps per frame: the layout settles in a second or two, and the first frames already fit the picture.
    for (let i = 0; i < 4 && iteration < ITERATIONS; i++) step();

    if (iteration % 8 === 0 || iteration >= ITERATIONS) fit();
    draw();
    frame = requestAnimationFrame(tick);
  } else draw();
}

function schedule(): void {
  if (frame === null) frame = requestAnimationFrame(tick);
}

/** The dot under a client point, the nearest within its radius plus a few pixels. */
function dotAt(clientX: number, clientY: number): Dot | null {
  const box = canvas().getBoundingClientRect();
  const px = clientX - box.left;
  const py = clientY - box.top;
  let best: { dot: Dot; distance: number } | null = null;

  for (const dot of dots) {
    if (data && hiddenLayers.has(data.layers[dot.layer] ?? "")) continue;
    const distance = Math.hypot(dot.x * view.k + view.x - px, dot.y * view.k + view.y - py);
    const reach = dot.radius * Math.max(0.7, Math.min(1.6, view.k)) + 5;

    if (distance <= reach && (!best || distance < best.distance)) best = { dot, distance };
  }

  return best?.dot ?? null;
}

/** The view a dot opens: a module's, or a folded directory's. */
function viewOfDot(id: string, kind: "open" | "focus" | "inside"): string {
  if (id.startsWith("dir:")) return id;

  return kind === "open" ? `module:${id}` : kind === "focus" ? `focus:${id}` : `inside:${id}`;
}

function renderLayers(): void {
  if (!data) return;
  const chips = element<HTMLSpanElement>("map-layers");
  chips.replaceChildren();

  for (const [i, layer] of data.layers.entries()) {
    const chip = h("button", { class: hiddenLayers.has(layer) ? "chip off" : "chip", title: hiddenLayers.has(layer) ? `Show the ${layer} layer` : `Hide the ${layer} layer`, on: { click: () => {
      if (hiddenLayers.has(layer)) hiddenLayers.delete(layer);
      else hiddenLayers.add(layer);
      renderLayers();
      draw();
    } } }, h("i", { style: `background:${PALETTE[i % PALETTE.length]}` }), layer);
    chips.append(chip);
  }

  const counted = data.nodes.length;
  element<HTMLSpanElement>("map-note").textContent = `${counted} ${data.level === "module" ? "modules" : "directories"}, ${data.edges.length} imports${data.level === "module" ? "" : " (folded: the repository is big)"}`;
}

async function loadMap(): Promise<void> {
  try {
    data = await api.graph();
    loadedFor = JSON.stringify([data.nodes.length, data.edges.length]);
    seed(data);
    renderLayers();
    fit();
    schedule();
  } catch (error) {
    element<HTMLSpanElement>("map-note").textContent = error instanceof Error ? error.message : String(error);
  }
}

/** Shows or hides the map; the data loads on the first opening and again when the code changed. */
export function toggleProjectMap(force?: boolean): void {
  const box = overlay();
  const show = force ?? box.hidden;
  box.hidden = !show;
  element<HTMLButtonElement>("tool-project").classList.toggle("active", show);

  if (!show) return;

  if (!data) void loadMap();
  else {
    fit();
    schedule();
  }

  element<HTMLInputElement>("map-search").focus();
}

export function projectMapOpen(): boolean {
  return !overlay().hidden;
}

/** After the code changed or the picture moved: the rings follow the picture, the data reloads when it is stale. */
export function refreshProjectMap(): void {
  if (overlay().hidden) return;
  // The current picture's modules changed: redraw; a changed repository (the page reloaded its views) reloads the data.
  void api.graph().then((fresh) => {
    if (JSON.stringify([fresh.nodes.length, fresh.edges.length]) !== loadedFor) {
      data = fresh;
      loadedFor = JSON.stringify([fresh.nodes.length, fresh.edges.length]);
      seed(fresh);
      renderLayers();
      fit();
      schedule();
    } else draw();
  });
}

/** Where every dot sits on screen (client coordinates), for the tests. */
export function mapDots(): { id: string; x: number; y: number }[] {
  const box = canvas().getBoundingClientRect();

  return dots.map((dot) => ({ id: dot.id, x: box.left + dot.x * view.k + view.x, y: box.top + dot.y * view.k + view.y }));
}

/** Whether the layout has settled, for the tests. */
export function mapSettled(): boolean {
  return data !== null && iteration >= ITERATIONS;
}

// ── Events ───────────────────────────────────────────────────────────────────

const target = canvas();

target.addEventListener("pointerdown", (event) => {
  const dot = dotAt(event.clientX, event.clientY);
  drag = { id: dot?.id ?? null, startX: event.clientX, startY: event.clientY, moved: false, viewX: view.x, viewY: view.y };
  target.setPointerCapture(event.pointerId);
});

target.addEventListener("pointermove", (event) => {
  if (drag) {
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;

    if (Math.hypot(dx, dy) > 4) drag.moved = true;

    if (drag.moved && drag.id) {
      const dot = byId.get(drag.id);

      if (dot) {
        const box = target.getBoundingClientRect();
        dot.x = (event.clientX - box.left - view.x) / view.k;
        dot.y = (event.clientY - box.top - view.y) / view.k;
        dot.pinned = true;
      }
    } else if (drag.moved) {
      view.x = drag.viewX + dx;
      view.y = drag.viewY + dy;
    }

    draw();

    return;
  }

  const over = dotAt(event.clientX, event.clientY)?.id ?? null;

  if (over !== hover) {
    hover = over;
    target.style.cursor = over ? "pointer" : "";
    draw();
  }
});

target.addEventListener("pointerup", (event) => {
  const was = drag;
  drag = null;

  if (!was || was.moved || !was.id) return;
  // A click on a dot: its view (Shift: everything joined to it); the map closes and the picture opens.
  const key = viewOfDot(was.id, event.shiftKey ? "focus" : "open");
  toggleProjectMap(false);
  setLink({ ...currentLink(), view: key });
});

target.addEventListener("dblclick", (event) => {
  const dot = dotAt(event.clientX, event.clientY);

  if (!dot) return;
  toggleProjectMap(false);
  setLink({ ...currentLink(), view: viewOfDot(dot.id, "inside") });
});

target.addEventListener("pointerleave", () => {
  if (hover) {
    hover = null;
    draw();
  }
});

target.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const box = target.getBoundingClientRect();
    const px = event.clientX - box.left;
    const py = event.clientY - box.top;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const k = Math.max(0.1, Math.min(6, view.k * factor));
    // Zoom around the pointer: the world point under it stays put.
    view = { k, x: px - ((px - view.x) / view.k) * k, y: py - ((py - view.y) / view.k) * k };
    draw();
  },
  { passive: false },
);

element<HTMLInputElement>("map-search").addEventListener("input", () => {
  search = element<HTMLInputElement>("map-search").value;
  draw();
});
element<HTMLInputElement>("map-search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") toggleProjectMap(false);
  event.stopPropagation();
});
element<HTMLButtonElement>("map-close").addEventListener("click", () => toggleProjectMap(false));
element<HTMLButtonElement>("map-fit").addEventListener("click", () => {
  fit();
  draw();
});
element<HTMLButtonElement>("map-relayout").addEventListener("click", () => {
  if (!data) return;
  seed(data);
  schedule();
});
window.addEventListener("resize", () => {
  if (!overlay().hidden) {
    fit();
    draw();
  }
});
