// What the page reads from the server: the types of src/diagram.ts (shared
// by import, so the page and the server cannot drift) and one typed fetch
// per API route of src/server.ts.

export type { Diagram, Line, Lane, Shape } from "../../src/diagram.ts";
export type { ProjectMap, MapLine, MapDot } from "../../src/diagram.ts";
import type { ProjectMap } from "../../src/diagram.ts";
import type { Diagram } from "../../src/diagram.ts";
import { pictureQueryText, type PictureOptions } from "../../src/options.ts";
import type { View } from "../../src/view-keys.ts";

export interface ViewEntry {
  key: string;
  title: string;
  kind: View["kind"];
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
  diff: { base: string; changedFiles: string[]; layerEdgesAdded: { from: string; to: string; against?: true }[] };
  diagram: Diagram;
  elements: import("../../src/scene.ts").SceneElement[];
  markdown: string;
  /** The head has ARCHITECTURE.md: only the layer dependencies against it are findings. */
  contract: boolean;
}

/** A JSON POST to the server; an `error` in the answer or a failed status throws its text. */
async function post<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = (await response.json()) as T | { error: string };

  if (!response.ok || (typeof body === "object" && body !== null && "error" in body)) throw new Error(typeof body === "object" && body !== null && "error" in body ? String(body.error) : response.statusText);

  return body as T;
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
  kind: "text" | "tool" | "result" | "init" | "raw" | "stderr" | "exit" | "check";
  text: string;
  sessionId?: string;
  /** The files a tool event touched: the page lights their shapes. */
  files?: string[];
}

export interface Commit {
  sha: string;
  short: string;
  author: string;
  date: string;
  subject: string;
}

export interface Branch {
  name: string;
  sha: string;
  date: string;
  subject: string;
  remote: boolean;
  current: boolean;
}

export interface CompareResponse {
  base: string;
  heads: { head: string; diff: { changedFiles: string[]; layerEdgesAdded: { from: string; to: string }[]; modulesAdded: string[]; modulesRemoved: string[]; nodesChanged: unknown[]; depsAdded: unknown[] } }[];
  diagram: Diagram;
  elements: import("../../src/scene.ts").SceneElement[];
  markdown: string;
}

export const api = {
  tags: (q: string) => get<{ tags: { tag: string; title: string }[] }>(`/api/tags?q=${encodeURIComponent(q)}`),
  /** The context of the tags in `text`; `query` is the picture's options, for `@view:` (the picture as the page shows it). */
  expand: async (text: string, query = ""): Promise<string> => {
    const response = await fetch("/api/expand", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, query }) });
    const body = (await response.json()) as { context: string } | { error: string };

    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : response.statusText);

    return body.context;
  },
  mocks: async (view: string, description: string): Promise<{ source: string; note?: string; input: Record<string, unknown>; storages: Record<string, unknown> }> => {
    const response = await fetch("/api/flow/mocks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view, description }) });
    const body = (await response.json()) as { source: string; note?: string; input: Record<string, unknown>; storages: Record<string, unknown> } | { error: string };

    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : response.statusText);

    return body;
  },
  branches: () => get<{ current: string | null; base: string | null; branches: Branch[] }>("/api/branches"),
  compare: (base: string | null, heads: string[]) => get<CompareResponse>(`/api/compare?heads=${encodeURIComponent(heads.join(","))}${base ? `&base=${encodeURIComponent(base)}` : ""}`),
  commits: (base: string | null, head: string | null) => get<{ base: string; head: string; commits: Commit[] }>(`/api/commits?${base ? `base=${encodeURIComponent(base)}&` : ""}${head ? `head=${encodeURIComponent(head)}` : ""}`),
  fileHistory: (path: string) => get<{ path: string; commits: Commit[] }>(`/api/history?path=${encodeURIComponent(path)}`),
  tasks: () => get<{ tasks: { file: string; head: string }[] }>("/api/tasks"),
  /** Tells `onChange` whenever a source file changes; returns the closer. */
  changes: (onChange: (path: string) => void): (() => void) => {
    const source = new EventSource("/api/changes");
    source.onmessage = (message) => {
      const data = JSON.parse(message.data as string) as { path?: string };

      if (data.path) onChange(data.path);
    };

    return () => source.close();
  },
  specs: () => get<{ initialised: boolean; specs: { path: string; title: string; kind: "openspec" | "gherkin" }[] }>("/api/specs"),
  spec: (path: string) => get<{ path: string; text: string }>(`/api/spec?path=${encodeURIComponent(path)}`),
  specPrompt: (mode: "generate" | "update", view: string | null) => get<{ markdown: string }>(`/api/spec/prompt?mode=${mode}${view ? `&view=${encodeURIComponent(view)}` : ""}`),
  validateSpecs: () => post<{ ok: boolean; output: string }>("/api/spec/validate", {}),
  code: (view: string) => post<{ markdown: string; intent: string; planned: number }>("/api/code", { view }),
  intent: () => get<{ exists: boolean; markdown: string; file: string }>("/api/intent"),
  saveIntent: (markdown: string) => post<{ file: string; layers: number; modules: number; edges: number }>("/api/intent", { markdown }),
  intentFromDocument: (text: string) => post<{ file: string; source: string; layers: number; modules: number; edges: number; markdown: string }>("/api/intent/document", { text }),
  check: () => get<{ exists: boolean; ok: boolean; markdown: string }>("/api/check"),
  plan: (view: string) => get<{ markdown: string; drawn: boolean; plan: { added: unknown[]; edges: unknown[]; removed: unknown[]; notes: string[] } }>(`/api/plan?view=${encodeURIComponent(view)}`),
  runAgent: async (view: string, prompt: string, resume: string | null): Promise<{ id: string; agent: string; task: string }> => {
    const response = await fetch("/api/agent/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view, prompt, resume }) });
    const body = (await response.json()) as { id: string; agent: string; task: string } | { error: string };

    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : response.statusText);

    return body;
  },
  stopAgent: (id: string) => fetch(`/api/agent/stop?id=${encodeURIComponent(id)}`, { method: "POST" }),
  /** The contract and the checks of archdiff.json, run now; the events as the transcript shows them. */
  runChecks: () => post<{ results: { command: string; ok: boolean; output: string }[]; events: { kind: string; text: string }[] }>("/api/checks", {}),
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
  /** A real run of the entry with the saved mocks: the functions entered, the storage calls, the result, against the prediction. */
  runFlow: (view: string) => post<{ run: { steps: { id: string; order: number }[]; storageCalls: { module: string; member: string; args: unknown[] }[]; result: unknown; error: string | null; ms: number; predicted: string[]; missed: string[]; unexpected: string[] }; markdown: string }>("/api/flow/run", { view }),
  scene: (view: string, options: PictureOptions, base: string | null, head: string | null) => get<SceneResponse>(`/api/scene?view=${encodeURIComponent(view)}${pictureQueryText(options)}${base ? `&base=${encodeURIComponent(base)}` : ""}${head ? `&head=${encodeURIComponent(head)}` : ""}`),
  saveLayout: async (view: string, elements: unknown[], mocks: unknown[]): Promise<{ saved: string }> => {
    const response = await fetch(`/api/layout?view=${encodeURIComponent(view)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements, mocks }) });
    const body = (await response.json()) as { saved: string } | { error: string };

    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : response.statusText);

    return body;
  },
  views: () => get<ViewsResponse>("/api/views"),
  /** The whole repository for the project map: every module (or directory, folded) with its layer, every import between them. */
  graph: () => get<ProjectMap>("/api/graph"),
  diagram: (view: string, depth: number | null) => get<DiagramResponse>(`/api/diagram?view=${encodeURIComponent(view)}${depth === null ? "" : `&depth=${depth}`}`),
  edge: (view: string, from: string, to: string, kind: string, options = "") => get<{ markdown: string }>(`/api/edge?view=${encodeURIComponent(view)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&kind=${encodeURIComponent(kind)}${options}`),
  node: (view: string, id: string, options = "") => get<{ markdown: string }>(`/api/node?view=${encodeURIComponent(view)}&id=${encodeURIComponent(id)}${options}`),
  file: async (path: string): Promise<string> => {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}`);

    if (!response.ok) throw new Error(`cannot read ${path}`);

    return response.text();
  },
  coverage: () => get<{ markdown: string; ratio: number; gaps: number; calls: number }>("/api/coverage"),
  review: (base: string | null, head: string | null) => get<ReviewResponse>(`/api/review?${base ? `base=${encodeURIComponent(base)}&` : ""}${head ? `head=${encodeURIComponent(head)}` : ""}`),
  exportUrl: (view: string, format: string, base: string | null, head: string | null = null, heads: string[] = [], extra = "") => `/api/export?view=${encodeURIComponent(view)}&format=${format}${base ? `&base=${encodeURIComponent(base)}` : ""}${head ? `&head=${encodeURIComponent(head)}` : ""}${heads.length > 0 ? `&heads=${encodeURIComponent(heads.join(","))}` : ""}${extra}`,
};
