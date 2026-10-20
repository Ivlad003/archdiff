// The DOM helpers the page uses everywhere: an element by ID (or a plain
// error naming the ID missing from index.html), `h` to build an element
// with its attributes and children in one call (the lists the page
// renders — views, tasks, lanes, chips, questions — were each a block
// of createElement calls), and a flag remembered in this browser.
//
// Entry points: `element`, `h`, `remembered`, `remember`.

export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (!found) throw new Error(`no #${id}`);

  return found as T;
}

/** What `h` takes as attributes: strings set as attributes, `class` and `className` the class, `dataset` the data attributes, `on` the listeners, `title`/`hidden`/`disabled` the properties. */
export interface Attributes {
  class?: string;
  className?: string;
  title?: string;
  hidden?: boolean;
  disabled?: boolean;
  dataset?: Record<string, string>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (event: HTMLElementEventMap[K]) => void }>;
  [attribute: string]: unknown;
}

export type Child = Node | string | null | undefined | false;

/** An element with its attributes and children: `h("li", { class: "group", on: { click } }, "text", child)`. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attributes: Attributes = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;

    if (name === "class" || name === "className") node.className = String(value);
    else if (name === "dataset") for (const [key, item] of Object.entries(value as Record<string, string>)) node.dataset[key] = item;
    else if (name === "on") for (const [type, listener] of Object.entries(value as Record<string, EventListener>)) node.addEventListener(type, listener);
    else if (name === "hidden" || name === "disabled" || name === "checked" || name === "selected") (node as unknown as Record<string, unknown>)[name] = value;
    else if (name === "title" || name === "textContent" || name === "value" || name === "placeholder") (node as unknown as Record<string, unknown>)[name] = String(value);
    else node.setAttribute(name, String(value));
  }

  for (const child of children) if (child !== null && child !== undefined && child !== false) node.append(child);

  return node;
}

/** A yes/no the browser remembers (a folded panel, the theme); false without storage. */
export function remembered(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** Remembers a yes/no in this browser; silently nothing without storage. */
export function remember(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // A private window: the choice lasts the page.
  }
}

/** A list of names this browser remembered under `key` (the open folders, the folded headings); empty when none, or when the storage is off. */
export function rememberedList(key: string): string[] {
  try {
    const kept: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");

    return Array.isArray(kept) ? kept.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Keeps a list of names under `key` in this browser. */
export function rememberList(key: string, list: Iterable<string>): void {
  try {
    localStorage.setItem(key, JSON.stringify([...list]));
  } catch {
    // A private window: the list lasts the page.
  }
}
