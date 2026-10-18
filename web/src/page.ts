// The context the page's modules share: the current picture (its shapes,
// lines and mocks, held by app.ts), the canvas and its mode (canvas.ts),
// the views (views-list.ts), and what the panels and the loading do for
// the others (panel.ts, app.ts) — reached through one object app.ts binds
// at start. It breaks the cycles: the modules app.ts and panel.ts import
// read the page through it rather than importing them back. Nothing here
// runs at import: `page` is used inside handlers.
//
// Entry points: `page`, `bindPage`, `PageContext`.

import type { Line, Shape, ViewEntry } from "./api.ts";
import type { CanvasHandle } from "./editor.tsx";

export interface PageContext {
  canvas(): CanvasHandle | null;
  /** The shapes of the current picture by ID. */
  nodes(): Map<string, Shape>;
  /** The lines of the current picture, in the diagram's order (the order the canvas names them by). */
  edges(): Line[];
  views(): ViewEntry[];
  mode(): "view" | "edit";
  /** The mocks of the current view's flow, saved with its drawing. */
  mocks(): unknown[];
  setMocks(next: unknown[]): void;
  showTab(name: string): void;
  renderMarkdown(target: HTMLElement, markdown: string): void;
  showCode(node: Shape): Promise<void>;
  load(): Promise<void>;
  loadViews(): Promise<void>;
}

/** The page, once bound; a use before that names the key, which is a bug of the module's loading order. */
export let page: PageContext = new Proxy({} as PageContext, {
  get: (_target, key) => {
    throw new Error(`page.${String(key)} used before the page is bound`);
  },
});

export function bindPage(context: PageContext): void {
  page = context;
}
