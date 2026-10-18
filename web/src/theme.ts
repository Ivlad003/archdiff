// Light or dark: the reader's choice of the ◐ button, remembered in this
// browser; until there is one, the system's, followed as it changes.
//
// Entry point: the module itself (the ◐ button), imported by app.ts.

import { element } from "./dom.ts";

const system = matchMedia("(prefers-color-scheme: dark)");

/** The theme the reader chose, or null: the system's. */
function chosen(): "dark" | "light" | null {
  try {
    const saved = localStorage.getItem("archdiff.theme");

    return saved === "dark" || saved === "light" ? saved : null;
  } catch {
    return null;
  }
}

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);
}

element<HTMLButtonElement>("theme").addEventListener("click", () => {
  const dark = !document.documentElement.classList.contains("dark");
  applyTheme(dark);

  try {
    localStorage.setItem("archdiff.theme", dark ? "dark" : "light");
  } catch {
    // Not remembered.
  }
});

// The system's theme, while the reader has chosen none: a change of it (dusk, a setting) follows.
system.addEventListener("change", () => {
  if (chosen() === null) applyTheme(system.matches);
});

applyTheme((chosen() ?? (system.matches ? "dark" : "light")) === "dark");
