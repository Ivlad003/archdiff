// The context menu of the page: a list of actions at the pointer, opened
// by a right click on a shape, a line or the empty canvas, closed by a
// click anywhere else, Escape or a scroll. One menu element, filled per
// opening; shape-menu.ts says what the items are.
//
// Entry points: `openMenu`, `closeMenu`, `menuOpen`, `MenuItem`.

import { h } from "./dom.ts";

/** One line of the menu: a label with what it does, a hint shown muted, or a separator. */
export type MenuItem = { label: string; hint?: string; disabled?: boolean; run: () => void } | "—";

let menu: HTMLUListElement | null = null;

function ensure(): HTMLUListElement {
  if (menu) return menu;
  menu = h("ul", { id: "context-menu", role: "menu", hidden: true });
  document.body.append(menu);
  // Anything outside the menu closes it; a click on an item runs it and closes it.
  document.addEventListener("pointerdown", (event) => {
    if (menu && !menu.hidden && event.target instanceof Node && !menu.contains(event.target)) closeMenu();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu && !menu.hidden) {
      closeMenu();
      event.stopPropagation();
    }
  });
  window.addEventListener("blur", closeMenu);
  document.addEventListener("scroll", closeMenu, true);

  return menu;
}

/** Opens the menu with `items` at the client point, kept inside the window. */
export function openMenu(items: readonly MenuItem[], at: { x: number; y: number }): void {
  const list = ensure();
  list.replaceChildren();

  for (const item of items) {
    if (item === "—") {
      list.append(h("li", { class: "separator", role: "separator" }));
      continue;
    }

    const row = h("li", { role: "menuitem", class: item.disabled ? "disabled" : "", on: { click: () => {
      if (item.disabled) return;
      closeMenu();
      item.run();
    } } }, item.label, item.hint ? h("span", { class: "hint" }, item.hint) : null);
    list.append(row);
  }

  list.hidden = false;
  list.style.left = "0px";
  list.style.top = "0px";
  const width = list.offsetWidth;
  const height = list.offsetHeight;
  list.style.left = `${Math.max(4, Math.min(at.x, window.innerWidth - width - 4))}px`;
  list.style.top = `${Math.max(4, Math.min(at.y, window.innerHeight - height - 4))}px`;
}

export function closeMenu(): void {
  if (menu) menu.hidden = true;
}

export function menuOpen(): boolean {
  return menu !== null && !menu.hidden;
}
