// The one DOM helper the page uses everywhere: an element by ID, or a
// plain error naming the ID that is missing from index.html.

export function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);

  if (!found) throw new Error(`no #${id}`);

  return found as T;
}
