// What the page reads from the server: the types of src/diagram.ts (shared
// by import, so the page and the server cannot drift) and one typed fetch
// per API route of src/server.ts.

export type { Diagram, DiagramEdge, DiagramGroup, DiagramNode } from "../../src/diagram.ts";
import type { Diagram } from "../../src/diagram.ts";

export interface ViewEntry {
  key: string;
  title: string;
  kind: "layers" | "layer" | "module" | "calls" | "coverage";
  layer?: string;
}

export interface ViewsResponse {
  root: string;
  stats: { files: number; modules: number; fns: number; classes: number; deps: number; calls: number; gaps: number; unresolvedImports: number; cacheHits: number; cacheMisses: number; ms: { total: number } };
  layers: string[];
  views: ViewEntry[];
}

export interface DiagramResponse {
  diagram: Diagram;
  markdown: string;
}

export interface ReviewResponse {
  diff: { base: string; changedFiles: string[]; layerEdgesAdded: { from: string; to: string }[] };
  diagram: Diagram;
  markdown: string;
}

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T | { error: string };

  if (!response.ok) throw new Error(typeof body === "object" && body && "error" in body ? body.error : response.statusText);

  return body as T;
}

export const api = {
  views: () => get<ViewsResponse>("/api/views"),
  diagram: (view: string, depth: number | null) => get<DiagramResponse>(`/api/diagram?view=${encodeURIComponent(view)}${depth === null ? "" : `&depth=${depth}`}`),
  node: (view: string, id: string) => get<{ markdown: string }>(`/api/node?view=${encodeURIComponent(view)}&id=${encodeURIComponent(id)}`),
  file: async (path: string): Promise<string> => {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);

    if (!response.ok) throw new Error(`cannot read ${path}`);

    return response.text();
  },
  coverage: () => get<{ markdown: string; ratio: number; gaps: number; calls: number }>("/api/coverage"),
  review: (base: string | null) => get<ReviewResponse>(`/api/review${base ? `?base=${encodeURIComponent(base)}` : ""}`),
  exportUrl: (view: string, format: string, base: string | null) => `/api/export?view=${encodeURIComponent(view)}&format=${format}${base ? `&base=${encodeURIComponent(base)}` : ""}`,
};
