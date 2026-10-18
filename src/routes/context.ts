// What every route handler gets: the server's context (the repository, the
// options, the analysis cache, the agent, the live-reload listeners, the
// picture of a request) and the request (URL, body, response, request),
// plus the ways to answer and to read a picture's request from a query. The handlers live in pictures.ts,
// agent.ts and git.ts; server.ts builds the context and dispatches by
// `METHOD /path`.
//
// Entry points: `RouteContext`, `RouteRequest`, `requestOf`, `optionsOf`,
// `send`, `json`, `problem`, `failed`.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Analysis } from "../analyze.ts";
import type { AgentRunner, AgentSpec } from "../agent.ts";
import { readPictureOptions, type PictureOptions } from "../options.ts";
import type { Picture, PictureRequest } from "../picture.ts";
import { ok, wrong, type Result } from "../result.ts";
import type { ServeOptions } from "../server.ts";
import { parseView } from "../view-keys.ts";

export type { PictureOptions } from "../options.ts";

export interface RouteContext {
  root: string;
  options: ServeOptions;
  /** The names the Host header of a request may give (server.ts's `allowedHosts`): any other is refused. */
  hosts: ReadonlySet<string>;
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
  /** Whether the server follows the code (`--no-watch` turns it off), and the problem when it could not. */
  watching: { on: boolean; problem: string | null };
  /** The picture the query names (`requestOf`), drawn on the code it is of (`analysisFor`); the problem with the request, or git's when it refuses. */
  picture(query: URLSearchParams): Promise<Result<Picture>>;
  /**
   * The analysis a query's picture is drawn on: the code at its `head` (a branch, a tag, a commit), the working tree
   * without one; a change (a review, a comparison, a commit, the timeline, the branches) reads its own revisions
   * against the working tree's. Rejects naming an unknown head.
   */
  analysisFor(query: URLSearchParams): Promise<Analysis>;
}


/**
 * The picture a query names: `view=<key>`, the picture's options as
 * options.ts names them, and the refs `base` (else `defaultBase`, the
 * server's `--base`), `head` and `heads=a,b`. A problem names an unknown
 * view or a wrong option.
 */
export function requestOf(query: URLSearchParams, defaultBase: string | null): Result<PictureRequest> {
  const view = parseView(query.get("view") ?? "");

  if (!view) return wrong("unknown view");
  const read = readPictureOptions((name) => query.get(name), "param");

  if (!read.ok) return read;
  const heads = (query.get("heads") ?? "").split(",").filter((head) => head !== "");

  return ok({ view, options: read.value.options, refs: { base: query.get("base") || defaultBase, head: query.get("head") || null, heads } });
}

/** The picture's options as a query names them, or the problem with one of them. */
export function optionsOf(query: URLSearchParams): Result<PictureOptions> {
  const read = readPictureOptions((name) => query.get(name), "param");

  return read.ok ? ok(read.value.options) : read;
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

/** The problem of a failed result, as the API reports it. */
export function failed(response: ServerResponse, result: { ok: false; problem: { status: number; message: string } }): void {
  problem(response, result.problem.status, result.problem.message);
}
