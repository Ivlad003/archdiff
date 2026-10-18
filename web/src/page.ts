// The context the page's modules share: what app.ts owns (the canvas,
// the shapes and lines of the current picture, the views, the mode, the
// mocks, the title and the review inputs) and what it does for them
// (switching tabs, rendering Markdown, showing code, reloading), reached
// through one object bound at start. The tab modules (chat.ts,
// flow-tab.ts, spec-tab.ts, review.ts) take the page as this context
// rather than reaching into app.ts, the way the server's routes take
// theirs. Nothing here runs at import: `page` is used inside handlers.

import type { Line, Shape, ViewEntry } from "./api.ts";
import type { CanvasHandle } from "./editor.tsx";

export interface PageContext {
  canvas(): CanvasHandle | null;
  nodes(): Map<string, Shape>;
  edges(): Line[];
  views(): ViewEntry[];
  mode(): "view" | "edit";
  mocks(): unknown[];
  setMocks(next: unknown[]): void;
  title: HTMLSpanElement;
  baseInput: HTMLInputElement;
  headInput: HTMLInputElement;
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
