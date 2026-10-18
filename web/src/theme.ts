// Light or dark, remembered in this browser; the system's choice at first.
//
// Entry point: the module itself (the ◐ button), imported by app.ts.

import { element } from "./dom.ts";

function applyTheme(dark: boolean): void {
  document.documentElement.classList.toggle("dark", dark);

  try {
    localStorage.setItem("archdiff.theme", dark ? "dark" : "light");
  } catch {
    // Not remembered.
  }
}

element<HTMLButtonElement>("theme").addEventListener("click", () => applyTheme(!document.documentElement.classList.contains("dark")));

try {
  const saved = localStorage.getItem("archdiff.theme");
  applyTheme(saved ? saved === "dark" : matchMedia("(prefers-color-scheme: dark)").matches);
} catch {
  // Light.
}
