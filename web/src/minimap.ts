// The minimap at the bottom right of the canvas: the current picture
// small — its lines faint, its shapes as blocks — with the viewport as a
// box; a tap or a drag moves the viewport there. On by default, hidden
// when this browser turned it off and while drawing. Redrawn a few times
// a second while shown: the canvas reports no scroll.
//
// Entry points: `updateMinimap`, `toggleMinimap`.

import { element, remember, remembered } from "./dom.ts";
import { page } from "./page.ts";

const minimap = element<HTMLCanvasElement>("minimap");
/** Where this browser keeps that the minimap was turned off. */
const OFF_KEY = "archdiff.minimap.off";

let wanted = !remembered(OFF_KEY);
let timer: ReturnType<typeof setInterval> | null = null;
/** The scale and the scene corner of the last drawing, for the taps. */
let frame: { scale: number; minX: number; minY: number } | null = null;
let dragging = false;

/** Draws the whole scene small, with the viewport as a box; the frame it drew in is kept for taps. */
function drawMinimap(): void {
  const canvas = page.canvas();

  if (!canvas || minimap.hidden) return;
  const scene = canvas.scene();
  const elements = scene.filter((element) => !element.isDeleted && (element.customData?.["archdiff"] === "node" || element.customData?.["archdiff"] === "lane"));

  if (elements.length === 0) return;
  const minX = Math.min(...elements.map((element) => element.x));
  const minY = Math.min(...elements.map((element) => element.y));
  const maxX = Math.max(...elements.map((element) => element.x + element.width));
  const maxY = Math.max(...elements.map((element) => element.y + element.height));
  const pad = 6;
  const scale = Math.min((minimap.width - 2 * pad) / Math.max(1, maxX - minX), (minimap.height - 2 * pad) / Math.max(1, maxY - minY));
  const drawn = { scale, minX: minX - pad / scale, minY: minY - pad / scale };
  frame = drawn;
  const context = minimap.getContext("2d")!;
  context.clearRect(0, 0, minimap.width, minimap.height);
  const dark = document.documentElement.classList.contains("dark");
  // The lines first, faint, so the shape of the picture reads; then the shapes over them.
  context.strokeStyle = dark ? "rgba(144,164,174,0.5)" : "rgba(96,125,139,0.35)";
  context.lineWidth = 1;

  for (const line of scene) {
    if (line.isDeleted || line.customData?.["archdiff"] !== "edge") continue;
    const points = (line as { points?: [number, number][] }).points ?? [];

    if (points.length < 2) continue;
    context.beginPath();

    for (const [i, [px, py]] of points.entries()) {
      const x = (line.x + px - drawn.minX) * scale;
      const y = (line.y + py - drawn.minY) * scale;

      if (i === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }

    context.stroke();
  }

  for (const element of elements) {
    const role = element.customData?.["archdiff"];
    const kind = String(element.customData?.["kind"] ?? "");
    context.fillStyle = role === "lane" ? (dark ? "#2a2a2a" : "#f1f1f1") : kind === "fn" ? "#90caf9" : kind === "more" ? "#bdbdbd" : dark ? "#9e9e9e" : "#616161";
    context.fillRect((element.x - drawn.minX) * scale, (element.y - drawn.minY) * scale, Math.max(1, element.width * scale), Math.max(1, element.height * scale));
  }

  // The viewport: what the canvas shows, in scene coordinates.
  const viewport = canvas.viewport();
  const size = canvas.size();

  if (viewport && size.width > 0) {
    context.strokeStyle = "#ff6f00";
    context.lineWidth = 1.5;
    context.strokeRect((-viewport.scrollX - drawn.minX) * scale, (-viewport.scrollY - drawn.minY) * scale, (size.width / viewport.zoom) * scale, (size.height / viewport.zoom) * scale);
  }
}

/** Shows the minimap unless it was turned off (the button, remembered) or the picture is empty, and keeps it drawn while the viewport moves. */
export function updateMinimap(): void {
  const empty = !(page.canvas()?.scene() ?? []).some((element) => !element.isDeleted && (element.customData?.["archdiff"] === "node" || element.customData?.["archdiff"] === "lane"));
  minimap.hidden = !wanted || empty || document.body.classList.contains("editing");
  element<HTMLButtonElement>("tool-minimap").classList.toggle("active", wanted);

  if (timer) clearInterval(timer);
  timer = null;

  if (!minimap.hidden) {
    drawMinimap();
    timer = setInterval(drawMinimap, 300);
  }
}

/** The minimap button: hides or shows it, remembered in this browser. */
export function toggleMinimap(): void {
  wanted = !wanted;
  remember(OFF_KEY, !wanted);
  updateMinimap();
}

/** Moves the viewport so the scene point under the pointer is at its centre; a drag keeps moving it. */
function moveTo(event: PointerEvent): void {
  const canvas = page.canvas();
  const viewport = canvas?.viewport();

  if (!canvas || !viewport || !frame) return;
  const size = canvas.size();
  const box = minimap.getBoundingClientRect();
  const sceneX = frame.minX + (event.clientX - box.left) / frame.scale;
  const sceneY = frame.minY + (event.clientY - box.top) / frame.scale;
  canvas.setViewport({ scrollX: size.width / viewport.zoom / 2 - sceneX, scrollY: size.height / viewport.zoom / 2 - sceneY, zoom: viewport.zoom });
  drawMinimap();
}

minimap.addEventListener("pointerdown", (event) => {
  dragging = true;
  minimap.setPointerCapture(event.pointerId);
  moveTo(event);
});
minimap.addEventListener("pointermove", (event) => {
  if (dragging) moveTo(event);
});
minimap.addEventListener("pointerup", () => (dragging = false));
minimap.addEventListener("pointercancel", () => (dragging = false));
