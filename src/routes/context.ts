// What every route handler gets: the server's context (the repository, the
// options, the analysis cache, the agent, the live-reload listeners, the
// placed-diagram helper) and the request (URL, body, response, request),
// plus the three ways to answer. The handlers live in pictures.ts,
// agent.ts and git.ts; server.ts builds the context and dispatches by
// `METHOD /path`.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Analysis } from "../analyze.ts";
import type { AgentRunner, AgentSpec } from "../agent.ts";
import type { layout } from "../diagram.ts";
import type { Overlay } from "../overlays.ts";
import type { ServeOptions } from "../server.ts";

/** The options of a picture as the query names them. */
export interface PictureOptions {
  depth?: number;
  limit?: number;
  weight?: number;
  hubs: boolean;
  packages: boolean;
  changes: boolean;
  onlyChanges: boolean;
  overlays: Overlay[];
  expand: string[];
  hide: string[];
}

export interface RouteContext {
  root: string;
  options: ServeOptions;
  /** The agent the page may run; null: the Chat tab only writes tasks. */
  agentSpec: AgentSpec | null;
  /** The analysis, shared by a burst of requests; `invalidate` after the repository changed. */
  fresh(): Promise<Analysis>;
  invalidate(): void;
  /** The agent runner, made on first use; throws without an agent. */
  runner(): AgentRunner;
  /** The runner when one was made already (its runs), else null. */
  activeRunner(): AgentRunner | null;
  /** The responses waiting on `/api/changes`. */
  changeListeners: Set<ServerResponse>;
  /** The placed diagram of a view with the picture's options; null for an unknown view. */
  placed(analysis: Analysis, key: string, picked: PictureOptions, base?: string | null, head?: string | null): Promise<ReturnType<typeof layout> | null>;
  optionsOf(url: URL): PictureOptions;
}

export interface RouteRequest {
  url: URL;
  /** The body of a POST; "" for a GET. */
  body: string;
  response: ServerResponse;
  request: IncomingMessage;
}

export function send(response: ServerResponse, status: number, type: string, body: string | Buffer): void {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

export function json(response: ServerResponse, value: unknown): void {
  send(response, 200, "application/json", JSON.stringify(value));
}

export function problem(response: ServerResponse, status: number, message: string): void {
  send(response, status, "application/json", JSON.stringify({ error: message }));
}
