// The one colour scale the exports share: a fill from near white to a deep
// blue by a shape's heat (calls in, a matrix cell's count). Its own module so
// that drawio.ts and excalidraw.ts, which share routes and colours, do not
// import each other.
//
// Entry point: `heatColour`.
/** A fill from near white to a deep blue by `heat` 0–1. */
export function heatColour(heat: number): string {
  const t = Math.max(0, Math.min(1, heat));
  const channel = (from: number, to: number): string => Math.round(from + (to - from) * t).toString(16).padStart(2, "0");

  return `#${channel(0xf7, 0x1e)}${channel(0xf9, 0x5a)}${channel(0xfc, 0x9e)}`;
}
