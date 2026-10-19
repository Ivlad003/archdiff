// What the page reads from the server: the types of src/diagram.ts (shared
// by import, so the page and the server cannot drift) and one typed fetch
// per API route of src/server.ts.
//
// Entry points: `api`, and the types of its answers.

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
  /** Whether the server follows the code (the page reloads on a change), and the problem when it could not. */
  watching: { on: boolean; problem: string | null };
  stats: { files: number; modules: number; fns: number; classes: number; deps: number; calls: number; gaps: number; unresolvedImports: number; cacheHits: number; cacheMisses: number; ms: { total: number } };
  layers: string[];
  views: ViewEntry[];
}

// The answers are read as their types, not validated: the server is archdiff's own, started with the page, and its
// types are shared by import (src/diagram.ts, src/options.ts), so the two cannot drift; a failed status throws its text.

/** A JSON POST to the server; an `error` in the answer or a failed status throws its text. */
async function post<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
  const body = (await response.json()) as T | { error: string };

  if (!response.ok || (typeof body === "object" && body !== null && "error" in body)) throw new Error(typeof body === "object" && body !== null && "error" in body ? String(body.error) : response.statusText);

  return body as T;
}

/** A JSON GET from the server; a failed status throws the `error` of the answer. */
async function get<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = (await response.json()) as T | { error: string };

  if (!response.ok) throw new Error(typeof body === "object" && body && "error" in body ? body.error : response.statusText);

  return body as T;
}

/** The revisions a picture is drawn against, as the link holds them: the base (null: the default), the head (null: the working tree), the heads of a comparison. */
export interface Refs {
  base: string | null;
  head: string | null;
  heads: readonly string[];
}

/** What a review or a comparison found, as the page reads it for the title (the server sends the whole diff). */
export type ChangeSummary = { kind: "review"; diff: { base: string; changedFiles: string[]; layerEdgesAdded: { from: string; to: string; against?: true }[] }; contract: boolean } | { kind: "compare"; base: string; heads: { head: string; diff: { layerEdgesAdded: { from: string; to: string }[] } }[] };

/** The head of the code as a query parameter after `joint` (`?` or `&`), empty for the working tree. */
function headQuery(joint: string, head: string | null): string {
  return head ? `${joint}head=${encodeURIComponent(head)}` : "";
}

/** The refs as query parameters, empty when there are none. */
function refsQuery(refs: Refs): string {
  return `${refs.base ? `&base=${encodeURIComponent(refs.base)}` : ""}${refs.head ? `&head=${encodeURIComponent(refs.head)}` : ""}${refs.heads.length > 0 ? `&heads=${encodeURIComponent(refs.heads.join(","))}` : ""}`;
}

export interface SceneResponse {
  elements: import("../../src/scene.ts").SceneElement[];
  mocks: { id: string; kind: "input" | "storage"; value: string }[];
  diagram: Diagram;
  markdown: string;
  /** The view has a saved drawing: the shapes sit where the user put them. */
  drawn: boolean;
  /** A review or a comparison: what it found. */
  change: ChangeSummary | null;
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

export const api = {
  tags: (q: string) => get<{ tags: { tag: string; title: string }[] }>(`/api/tags?q=${encodeURIComponent(q)}`),
  /** The context of the tags in `text`; `query` is the picture's options, for `@view:` (the picture as the page shows it). */
  expand: async (text: string, query = ""): Promise<string> => {
    const response = await fetch("/api/expand", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, query }) });
    const body = (await response.json()) as { context: string } | { error: string };

    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : response.statusText);

    return body.context;
  },
  mocks: async (view: string, description: string, agent: string | null): Promise<{ source: string; note?: string; input: Record<string, unknown>; storages: Record<string, unknown> }> => {
    const response = await fetch("/api/flow/mocks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view, description, agent }) });
    const body = (await response.json()) as { source: string; note?: string; input: Record<string, unknown>; storages: Record<string, unknown> } | { error: string };

    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : response.statusText);

    return body;
  },
  branches: () => get<{ current: string | null; base: string | null; branches: Branch[] }>("/api/branches"),
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
  intentFromDocument: (text: string, agent: string | null) => post<{ file: string; source: string; layers: number; modules: number; edges: number; markdown: string }>("/api/intent/document", { text, agent }),
  /** The agents the Chat tab may offer, whether each is installed here, and the one picked first. */
  agents: () => get<{ agents: { name: string; label: string; installed: boolean }[]; default: string | null }>("/api/agents"),
  check: () => get<{ exists: boolean; ok: boolean; markdown: string }>("/api/check"),
  plan: (view: string) => get<{ markdown: string; drawn: boolean; plan: { added: unknown[]; edges: unknown[]; removed: unknown[]; notes: string[] } }>(`/api/plan?view=${encodeURIComponent(view)}`),
  runAgent: async (view: string, prompt: string, resume: string | null, agent: string | null): Promise<{ id: string; agent: string; task: string }> => {
    const response = await fetch("/api/agent/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view, prompt, resume, agent }) });
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
  /** The picture of a view with the link's options and refs: the canvas's scene, the diagram, its Markdown, what a review found. */
  scene: (view: string, options: PictureOptions, refs: Refs) => get<SceneResponse>(`/api/scene?view=${encodeURIComponent(view)}${pictureQueryText(options)}${refsQuery(refs)}`),
  saveDrawing: async (view: string, elements: unknown[], mocks: unknown[]): Promise<{ saved: string }> => {
    const response = await fetch(`/api/drawing?view=${encodeURIComponent(view)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ elements, mocks }) });
    const body = (await response.json()) as { saved: string } | { error: string };

    if (!response.ok || "error" in body) throw new Error("error" in body ? body.error : response.statusText);

    return body;
  },
  /** The views of the code at `head` (a branch, a tag, a commit; null: the working tree). */
  views: (head: string | null = null) => get<ViewsResponse>(`/api/views${headQuery("?", head)}`),
  /** The whole repository at `head` for the project map: every module (or directory, folded) with its layer, every import between them. */
  graph: (head: string | null = null) => get<ProjectMap>(`/api/graph${headQuery("?", head)}`),
  /** The page of a line of the picture the link shows. */
  line: (view: string, from: string, to: string, kind: string, options: PictureOptions, refs: Refs) => get<{ markdown: string }>(`/api/line?view=${encodeURIComponent(view)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&kind=${encodeURIComponent(kind)}${pictureQueryText(options)}${refsQuery(refs)}`),
  /** The page of a shape of the picture the link shows. */
  shape: (view: string, id: string, options: PictureOptions, refs: Refs) => get<{ markdown: string }>(`/api/shape?view=${encodeURIComponent(view)}&id=${encodeURIComponent(id)}${pictureQueryText(options)}${refsQuery(refs)}`),
  /** A file of the code at `head` (null: the working tree's). */
  file: async (path: string, head: string | null = null): Promise<string> => {
    const response = await fetch(`/api/file?path=${encodeURIComponent(path)}${headQuery("&", head)}`);

    if (!response.ok) throw new Error(`cannot read ${path}`);

    return response.text();
  },
  coverage: (head: string | null = null) => get<{ markdown: string; ratio: number; gaps: number; calls: number }>(`/api/coverage${headQuery("?", head)}`),
  /** The download of the Postman collection of the SCAPI operations the code calls, or of one family's. */
  postmanUrl: (family: string | null, head: string | null = null) => `/api/postman${family ? `?family=${encodeURIComponent(family)}` : ""}${headQuery(family ? "&" : "?", head)}`,
  /** The download of a picture in `format`, with the link's options and refs (the Mermaid type among the options). */
  exportUrl: (view: string, format: string, options: PictureOptions, refs: Refs) => `/api/export?view=${encodeURIComponent(view)}&format=${format}${pictureQueryText(options)}${refsQuery(refs)}`,
};
