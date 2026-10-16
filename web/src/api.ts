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
  /** The agent the server may run, or null. */
  agent: string | null;
  stats: { files: number; modules: number; fns: number; classes: number; deps: number; calls: number; gaps: number; unresolvedImports: number; cacheHits: number; cacheMisses: number; ms: { total: number } };
  layers: string[];
  views: ViewEntry[];
}

export interface DiagramResponse {
  diagram: Diagram;
  markdown: string;
  /** The view has a saved drawing: the shapes sit where the user put them. */
  drawn: boolean;
}

export interface ReviewResponse {
  diff: { base: string; changedFiles: string[]; layerEdgesAdded: { from: string; to: string }[] };
  diagram: Diagram;
  elements: import("../../src/scene.ts").SceneElement[];
  markdown: string;
}

async function get<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T | { error: string };

  if (!response.ok) throw new Error(typeof body === "object" && body && "error" in body ? body.error : response.statusText);

  return body as T;
}

export interface SceneResponse {
  elements: import("../../src/scene.ts").SceneElement[];
  mocks: { id: string; kind: "input" | "storage"; value: string }[];
  diagram: Diagram;
  markdown: string;
  /** The view has a saved drawing: the shapes sit where the user put them. */
  drawn: boolean;
}

export interface FlowStep {
  id: string;
  name: string;
  module: string;
  line: number;
  depth: number;
  params: { name: string; type: string; value?: string; from?: string }[];
  returns: string | null;
  storage?: string;
  content?: string;
  gaps: number;
}

export interface FlowResponse {
  flow: { entry: string; steps: FlowStep[]; storages: { id: string; module: string; storage: string; content?: string }[]; input?: string };
  markdown: string;
}

export interface AgentEvent {
  seq: number;
  kind: "text" | "tool" | "result" | "init" | "raw" | "stderr" | "exit";
  text: string;
  sessionId?: string;
}

export const api = {
  plan: (view: string) => get<{ markdown: string; drawn: boolean; plan: { added: unknown[]; edges: unknown[]; removed: unknown[]; notes: string[] } }>(`/api/plan?view=${encodeURIComponent(view)}`),
  runAgent: async (view: string, prompt: string, resume: string | null): Promise<{ id: string; agent: string; task: string }> => {
    const response = await fetch("/api/agent/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view, prompt, resume }) });
    const body = (await response.json()) as { id: string; agent: string; task: string } | { error: string };

    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : response.statusText);

    return body;
  },
  stopAgent: (id: string) => fetch(`/api/agent/stop?id=${encodeURIComponent(id)}`, { method: "POST" }),
  /** Streams the events of a run; returns the closer. */
  agentEvents: (id: string, onEvent: (event: AgentEvent) => void, onEnd: () => void): (() => void) => {
    const source = new EventSource(`/api/agent/events?id=${encodeURIComponent(id)}`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as AgentEvent;
      onEvent(event);

      if (event.kind === "exit") {
        source.close();
        onEnd();
      }
    };
    source.onerror = () => {
      source.close();
      onEnd();
    };

    return () => source.close();
  },
  flow: (view: string, depth: number | null) => get<FlowResponse>(`/api/flow?view=${encodeURIComponent(view)}${depth === null ? "" : `&depth=${depth}`}`),
  scene: (view: string, depth: number | null, packages: boolean) => get<SceneResponse>(`/api/scene?view=${encodeURIComponent(view)}${depth === null ? "" : `&depth=${depth}`}${packages ? "&packages=1" : ""}`),
  saveLayout: async (view: string, elements: unknown[], mocks: unknown[]): Promise<{ saved: string }> => {
    const response = await fetch(`/api/layout?view=${encodeURIComponent(view)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements, mocks }) });
    const body = (await response.json()) as { saved: string } | { error: string };

    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : response.statusText);

    return body;
  },
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
