// The page is waiting: a thin bar runs under the header while the server
// is asked for something and has not answered for longer than a blink —
// a picture, a shape's page, a file, the branches. Without it a press on a
// slow repository looks like nothing happened until the answer lands. A
// panel whose own content is being read dims meanwhile (`loading`), the
// old content staying in place: nothing jumps while it waits.
//
// Entry points: `waitingOn`, `loading`.

import { t } from "./i18n.ts";

/** How long a request may take before the bar shows: an answer that comes at once never flashes it. */
const BLINK = 180;

const bar = document.createElement("div");
bar.id = "busy";
bar.hidden = true;
bar.setAttribute("role", "progressbar");
bar.setAttribute("aria-label", t("Loading"));
document.body.append(bar);

let waiting = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

/** The bar runs while `request` is not settled (and any other is not); the request itself comes back. */
export function waitingOn<T>(request: Promise<T>): Promise<T> {
  waiting++;
  timer ??= setTimeout(() => {
    timer = null;
    bar.hidden = waiting === 0;
  }, BLINK);

  const done = (): void => {
    waiting--;

    if (waiting > 0) return;

    if (timer !== null) clearTimeout(timer);
    timer = null;
    bar.hidden = true;
  };

  request.then(done, done);

  return request;
}

/** Marks an element as being read anew (dimmed, its content kept) or as read. */
export function loading(target: HTMLElement, on: boolean): void {
  target.classList.toggle("loading", on);
  target.setAttribute("aria-busy", String(on));
}
