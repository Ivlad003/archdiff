// The Model Context Protocol over stdio, as much of it as a server of
// tools needs, written by hand: JSON-RPC 2.0 messages, one per line, read
// from stdin and answered on stdout — `initialize` (the handshake, with
// the revision agreed on), `ping`, `tools/list` and `tools/call`; a
// notification (`notifications/initialized`) gets no answer, and
// `notifications/cancelled` drops the answer of the request it names.
// Nothing but those messages is written to stdout; the notes of the
// analysis go to stderr, as the protocol lets a server's log go. The
// server sends no request of its own, has no resources and no prompts,
// and stops when stdin ends.
//
// A tool answers with text. What goes wrong is told apart as the protocol
// tells it: a call that was wrong — an unknown tool or argument, a value
// the tool refuses — is a JSON-RPC error (-32602) carrying the tool's
// message; a tool that ran and failed (git refused) is a result marked
// `isError` with the reason as its text. Requests are answered as they
// finish, not in the order they came: an agent asks several at once.
//
// The revisions spoken are those with the `initialize` handshake; a
// client of a later one probes with `server/discover`, is told the method
// is not found, and falls back to the handshake, as that revision says.
//
// Sits at the edge, between the `mcp` command (cli.ts) and the tools
// (mcp-tools.ts), and knows nothing of archdiff: the tools are handed in.
// Entry points: `serveMcp`, `McpServer`, `McpTool`, `MCP_VERSIONS`.

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Result } from "./result.ts";

/** The revisions of the protocol this server speaks, newest first: what it does — tools that answer with text — is the same in all of them. */
export const MCP_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** One tool: how an agent finds it (the name, the description, the JSON Schema of its arguments) and the function that answers. */
export interface McpTool {
  name: string;
  /** The name a client shows a person. */
  title: string;
  /** What the tool answers and when to ask it: an agent picks a tool by this text. */
  description: string;
  inputSchema: { type: "object"; properties: Record<string, object>; required?: string[]; additionalProperties: false };
  /** The tool changes nothing: a client may run it without asking. */
  readOnly: boolean;
  /** Answers one call: the text, or the problem of a wrong argument (a JSON-RPC error); a failure while it ran is thrown (a result marked `isError`). */
  call(args: Readonly<Record<string, unknown>>): Promise<Result<string>>;
}

export interface McpServer {
  name: string;
  version: string;
  /** How to use the tools together, which a client hands its model at the start. */
  instructions: string;
  tools: readonly McpTool[];
}

/** The JSON-RPC error codes the server answers with. */
const ERRORS = { parse: -32700, request: -32600, method: -32601, params: -32602, internal: -32603 } as const;

type RequestId = string | number;

type Response = { jsonrpc: "2.0"; id: RequestId | null; result: unknown } | { jsonrpc: "2.0"; id: RequestId | null; error: { code: number; message: string } };

function success(id: RequestId, result: unknown): Response {
  return { jsonrpc: "2.0", id, result };
}

function failure(id: RequestId | null, code: number, message: string): Response {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs one tool for a `tools/call`: the tool by its name, its arguments checked against the names its schema knows, its answer as text. */
async function callTool(server: McpServer, id: RequestId, params: Record<string, unknown>): Promise<Response> {
  const name = params["name"];
  const tool = server.tools.find((candidate) => candidate.name === name);

  if (!tool) return failure(id, ERRORS.params, `Unknown tool: ${typeof name === "string" ? name : JSON.stringify(name ?? null)} (${server.tools.map((candidate) => candidate.name).join(", ")})`);
  const args = params["arguments"] ?? {};

  if (!isObject(args)) return failure(id, ERRORS.params, `${tool.name}: the arguments must be an object`);
  // An argument the tool does not know is a typo, not a silent extra: as a flag the CLI does not know.
  const known = Object.keys(tool.inputSchema.properties);
  const stray = Object.keys(args).find((key) => !known.includes(key));

  if (stray !== undefined) return failure(id, ERRORS.params, `${tool.name}: unknown argument "${stray}" (${known.length > 0 ? known.join(", ") : "it takes none"})`);

  try {
    const result = await tool.call(args);

    return result.ok ? success(id, { content: [{ type: "text", text: result.value }], isError: false }) : failure(id, ERRORS.params, result.problem.message);
  } catch (error) {
    // The tool ran and failed (git refused, a file could not be read): the reason is the answer, marked as an error.
    return success(id, { content: [{ type: "text", text: messageOf(error) }], isError: true });
  }
}

/** The answer to one message; null for a notification and for a response, which get none. */
async function answer(server: McpServer, message: unknown): Promise<Response | null> {
  if (!isObject(message) || message["jsonrpc"] !== "2.0") return failure(isObject(message) && isRequestId(message["id"]) ? message["id"] : null, ERRORS.request, "Invalid Request: not a JSON-RPC 2.0 message");
  const { id, method } = message;

  // A response answers a request, and this server sends none.
  if (typeof method !== "string") return "result" in message || "error" in message ? null : failure(isRequestId(id) ? id : null, ERRORS.request, "Invalid Request: no method");

  // A notification: the client is ready, or gave a request up.
  if (id === undefined) return null;

  if (!isRequestId(id)) return failure(null, ERRORS.request, "Invalid Request: the id must be a string or a number");
  const params = message["params"] ?? {};

  if (!isObject(params)) return failure(id, ERRORS.params, `${method}: the params must be an object`);

  switch (method) {
    case "initialize": {
      // The revision the client asks for when this server speaks it, else the newest it does: the client decides whether that will do.
      const asked = params["protocolVersion"];

      return success(id, { protocolVersion: MCP_VERSIONS.find((version) => version === asked) ?? MCP_VERSIONS[0], capabilities: { tools: {} }, serverInfo: { name: server.name, version: server.version }, instructions: server.instructions });
    }

    case "ping":
      return success(id, {});
    case "tools/list":
      return success(id, { tools: server.tools.map(({ name, title, description, inputSchema, readOnly }) => ({ name, title, description, inputSchema, annotations: { readOnlyHint: readOnly } })) });
    case "tools/call":
      return callTool(server, id, params);
    default:
      return failure(id, ERRORS.method, `Method not found: ${method}`);
  }
}

/**
 * Serves the tools over a pair of streams (stdin and stdout unless given) until the input ends and every request
 * read from it is answered. A line that is not JSON is a parse error; a batch (an array of messages, which the
 * 2025-03-26 revision allows) is answered by one array.
 */
export function serveMcp(server: McpServer, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const working = new Set<Promise<void>>();
  /** The requests being answered, and those of them the client gave up: their answers are not sent. */
  const inFlight = new Set<RequestId>();
  const cancelled = new Set<RequestId>();
  const write = (response: Response | Response[]): void => void output.write(`${JSON.stringify(response)}\n`);

  const one = async (message: unknown): Promise<Response | null> => {
    if (isObject(message) && message["method"] === "notifications/cancelled" && message["id"] === undefined) {
      const given = isObject(message["params"]) ? message["params"]["requestId"] : undefined;

      if (isRequestId(given) && inFlight.has(given)) cancelled.add(given);

      return null;
    }

    const id = isObject(message) && isRequestId(message["id"]) && typeof message["method"] === "string" ? message["id"] : null;

    if (id !== null) inFlight.add(id);

    try {
      const response = await answer(server, message);

      return id !== null && cancelled.has(id) ? null : response;
    } catch (error) {
      return failure(id, ERRORS.internal, messageOf(error));
    } finally {
      if (id !== null) {
        inFlight.delete(id);
        cancelled.delete(id);
      }
    }
  };

  const receive = async (line: string): Promise<void> => {
    let message: unknown;

    try {
      message = JSON.parse(line);
    } catch (error) {
      return write(failure(null, ERRORS.parse, `Parse error: ${messageOf(error)}`));
    }

    if (!Array.isArray(message)) {
      const response = await one(message);

      if (response) write(response);

      return;
    }

    if (message.length === 0) return write(failure(null, ERRORS.request, "Invalid Request: an empty batch"));
    const responses = (await Promise.all(message.map(one))).filter((response): response is Response => response !== null);

    if (responses.length > 0) write(responses);
  };

  return new Promise((done) => {
    const lines = createInterface({ input, crlfDelay: Infinity });

    lines.on("line", (line) => {
      if (line.trim() === "") return;
      // A line that could not be answered at all (the output gone) is said on stderr, and the next one is still read.
      const work: Promise<void> = receive(line)
        .catch((error: unknown) => void process.stderr.write(`archdiff mcp: ${messageOf(error)}\n`))
        .finally(() => working.delete(work));
      working.add(work);
    });
    // The client closed the input: answer what was asked, then stop.
    lines.on("close", () => void Promise.all(working).then(() => done()));
  });
}
