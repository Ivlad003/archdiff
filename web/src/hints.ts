// The hints of the page: what a button, a tab or a mark is for, said in a
// bubble beside it a moment after the pointer rests on it or the keyboard
// comes to it — and at once on the next thing, when the reader is already
// reading hints. The text is the element's `title` (index.html and the
// modules write them, in the page's language): the browser's own tooltip
// shows the same words, but a second later, small and in the system's
// look, and never for the keyboard. While a bubble shows, the element's
// `title` is put aside so the browser does not show its own over it, and
// comes back as the bubble goes.
//
// Entry point: the module itself, imported by app.ts.

/** How long the pointer rests before the first hint, and before the next once one has shown. */
const REST = { first: 450, next: 80 };
/** How long after a hint went the next one still comes at once. */
const WARM = 600;
/** The room between the bubble and what it is about, and between the bubble and the window's edge. */
const GAP = 8;

const bubble = document.createElement("div");
bubble.id = "hint-bubble";
bubble.setAttribute("role", "tooltip");
bubble.hidden = true;
document.body.append(bubble);

/** The element the bubble is about, with the `title` put aside for it. */
let shown: { anchor: HTMLElement; title: string } | null = null;
/** The element a hint is waited for. */
let pending: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let wentAt = 0;
/** Where the pointer was last: a hint of something big (a list, the canvas's line) shows by the pointer, not by its far edge. */
let pointer = { x: 0, y: 0 };

function hide(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  pending = null;

  if (!shown) return;
  // The title comes back, unless the page wrote a new one meanwhile.
  if (!shown.anchor.hasAttribute("title")) shown.anchor.setAttribute("title", shown.title);
  shown.anchor.removeAttribute("aria-describedby");
  shown = null;
  bubble.hidden = true;
  wentAt = performance.now();
}

function show(anchor: HTMLElement, byPointer: boolean): void {
  const title = anchor.getAttribute("title") ?? "";

  if (title.trim() === "" || !anchor.isConnected) return;
  hide();
  shown = { anchor, title };
  anchor.removeAttribute("title");
  anchor.setAttribute("aria-describedby", bubble.id);
  bubble.textContent = title;
  bubble.hidden = false;
  const box = anchor.getBoundingClientRect();
  const width = bubble.offsetWidth;
  const height = bubble.offsetHeight;
  // By the pointer for something big, where its edge may be far from what the reader looks at; else under its middle.
  const big = box.width > 360 || box.height > 80;
  const x = byPointer && big ? pointer.x - width / 2 : box.left + box.width / 2 - width / 2;
  const under = byPointer && big ? pointer.y + 18 : box.bottom + GAP;
  const over = (byPointer && big ? pointer.y - 12 : box.top - GAP) - height;
  bubble.style.left = `${Math.round(Math.max(GAP, Math.min(x, window.innerWidth - width - GAP)))}px`;
  bubble.style.top = `${Math.round(under + height + GAP <= window.innerHeight || over < GAP ? under : over)}px`;
}

/** The nearest element with a hint, from where the pointer or the focus is. */
function hinted(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>("[title]") : null;
}

function wait(anchor: HTMLElement | null, byPointer: boolean): void {
  if (anchor === (shown?.anchor ?? pending)) return;
  hide();

  if (!anchor) return;
  pending = anchor;
  timer = setTimeout(() => {
    timer = null;
    pending = null;
    show(anchor, byPointer);
  }, performance.now() - wentAt < WARM ? REST.next : REST.first);
}

document.addEventListener("mousemove", (event) => {
  pointer = { x: event.clientX, y: event.clientY };
}, { passive: true });
document.addEventListener("mouseover", (event) => {
  const next = hinted(event.target);

  // Still on what the bubble is about (its title is aside, so the nearest hint is none or one around it): the hint
  // stays. A part of it with a hint of its own, or anything else, is the next one waited for.
  if (shown && event.target instanceof Node && shown.anchor.contains(event.target) && (next === null || !shown.anchor.contains(next))) return;
  wait(next, true);
});
document.addEventListener("mouseout", (event) => {
  if (event.relatedTarget === null) hide();
});
// The keyboard: a hint for what Tab comes to, not for what a click focuses.
document.addEventListener("focusin", (event) => {
  if (event.target instanceof HTMLElement && event.target.matches(":focus-visible") && !event.target.matches("input:not([type=checkbox]):not([type=range]), textarea")) wait(hinted(event.target), false);
});
document.addEventListener("focusout", hide);

// A press, a key, a scroll: the reader is doing, not reading; the hint goes, and the one of what was pressed does not come back by itself.
for (const type of ["mousedown", "keydown", "wheel"] as const) document.addEventListener(type, hide, { capture: true, passive: true });
document.addEventListener("scroll", hide, { capture: true, passive: true });
window.addEventListener("blur", hide);
