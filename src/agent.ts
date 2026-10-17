// The coding agents archdiff can hand a task to: Claude Code (`claude -p`)
// and Cursor's CLI (`cursor-agent -p`), both run as a child process in the
// repository with `--output-format stream-json`, their events read line
// by line and kept for the page (the Chat tab streams them). A follow-up
// message resumes the agent's own session. A custom command (archdiff.json
// `agent.command`) runs the same way, which the tests use with a fake
// agent. Nothing starts without an explicit request: `web --agent` or the
// config enables the feature, and every run comes from a button.
//
// Sits at the I/O edge beside the server: Plan Markdown → process →
// AgentEvent[]. Entry points: `agentFromConfig`, `AgentRunner`,
// `parseAgentLine`, `AGENTS`.

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { isJsonObject, isJsonString, parseJson, type JsonValue } from "./json.ts";

export type AgentName = "claude" | "cursor";

/** How to run one agent: the command, and how to resume a session. */
export interface AgentSpec {
  name: string;
  /** The executable and its fixed arguments; the prompt is appended as the last argument. */
  command: string[];
  /** The flag that resumes a session, followed by the session ID; null when the agent cannot. */
  resumeFlag: string | null;
}

/** The built-in agents: print mode, streamed JSON, edits allowed without a prompt (shell commands still follow the agent's own rules). */
export const AGENTS: Record<AgentName, AgentSpec> = {
  claude: { name: "claude", command: ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"], resumeFlag: "--resume" },
  // `--trust`: the CLI otherwise stops to ask whether the directory is trusted, which print mode cannot answer; it does not force shell commands (that is `-f`).
  cursor: { name: "cursor", command: ["cursor-agent", "-p", "--output-format", "stream-json", "--trust"], resumeFlag: "--resume" },
};

/** The `agent` field of archdiff.json or `--agent`: a name, or `{ command: [...], resume?: "--flag" }`. Throws naming the field. */
export function agentFromConfig(value: JsonValue | undefined): AgentSpec | null {
  if (value === undefined || value === null) return null;

  if (isJsonString(value)) {
    if (value === "claude" || value === "cursor") return AGENTS[value];
    throw new Error(`agent: "${value}" is not claude or cursor`);
  }

  if (!isJsonObject(value) || !Array.isArray(value["command"]) || !value["command"].every(isJsonString) || value["command"].length === 0) throw new Error('agent: must be "claude", "cursor" or { "command": ["…"], "resume": "--flag" }');
  const resume = value["resume"];

  if (resume !== undefined && !isJsonString(resume)) throw new Error('agent: "resume" must be a string');

  return { name: isJsonString(value["name"]) ? value["name"] : "custom", command: value["command"], resumeFlag: resume ?? null };
}

/** One event of a run, as the page shows it. */
export interface AgentEvent {
  seq: number;
  kind: "text" | "tool" | "result" | "init" | "raw" | "stderr" | "exit";
  text: string;
  sessionId?: string;
  /** The files a tool event names (file_path, path, notebook_path of a tool_use), repository-relative when they are under it: the page lights their shapes. */
  files?: string[];
}

/** One stream-json line of Claude Code or Cursor read into an event; an unreadable line is kept raw. */
export function parseAgentLine(line: string): Omit<AgentEvent, "seq"> {
  let parsed: JsonValue;

  try {
    parsed = parseJson(line);
  } catch {
    return { kind: "raw", text: line };
  }

  if (!isJsonObject(parsed)) return { kind: "raw", text: line };
  const sessionId = isJsonString(parsed["session_id"]) ? parsed["session_id"] : isJsonString(parsed["chat_id"]) ? parsed["chat_id"] : undefined;
  const type = parsed["type"];
  const withSession = <T extends Omit<AgentEvent, "seq">>(event: T): T => (sessionId ? { ...event, sessionId } : event);

  if (type === "system" && parsed["subtype"] === "init") return withSession({ kind: "init", text: `session ${sessionId ?? "?"}` });

  // Other system events (thinking tokens, status): a one-line note, not the JSON.
  if (type === "system") return withSession({ kind: "init", text: isJsonString(parsed["subtype"]) ? parsed["subtype"].replace(/_/g, " ") : "system" });

  if (type === "result") return withSession({ kind: "result", text: isJsonString(parsed["result"]) ? parsed["result"] : "" });

  if ((type === "assistant" || type === "user") && isJsonObject(parsed["message"]) && Array.isArray(parsed["message"]["content"])) {
    const parts: string[] = [];
    const files: string[] = [];
    let kind: AgentEvent["kind"] = "text";

    for (const block of parsed["message"]["content"]) {
      if (!isJsonObject(block)) continue;

      if (block["type"] === "text" && isJsonString(block["text"])) parts.push(block["text"]);
      else if (block["type"] === "tool_use") {
        kind = "tool";
        const input = block["input"];

        if (isJsonObject(input)) for (const key of ["file_path", "path", "notebook_path"]) if (isJsonString(input[key])) files.push(input[key] as string);
        const summary = isJsonObject(input) ? Object.entries(input).map(([key, item]) => `${key}=${isJsonString(item) ? item.slice(0, 120) : JSON.stringify(item).slice(0, 120)}`).join(" ") : "";
        parts.push(`▶ ${isJsonString(block["name"]) ? block["name"] : "tool"} ${summary}`);
      } else if (block["type"] === "tool_result") {
        kind = "tool";
        const content = block["content"];
        parts.push(`◀ ${isJsonString(content) ? content.slice(0, 400) : Array.isArray(content) ? content.map((item) => (isJsonObject(item) && isJsonString(item["text"]) ? item["text"] : "")).join("").slice(0, 400) : ""}`);
      }
    }

    if (parts.length > 0) return withSession(files.length > 0 ? { kind, text: parts.join("\n"), files } : { kind, text: parts.join("\n") });
  }

  return withSession({ kind: "raw", text: line.slice(0, 400) });
}

/** One run of an agent: its events so far, who is waiting for more, and the process. */
export class AgentRun {
  readonly id: string;
  readonly events: AgentEvent[] = [];
  sessionId: string | null;
  done = false;
  exitCode: number | null = null;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly child: ChildProcess;

  constructor(id: string, child: ChildProcess, sessionId: string | null) {
    this.id = id;
    this.child = child;
    this.sessionId = sessionId;
    const out = createInterface({ input: child.stdout! });
    out.on("line", (line) => {
      if (line.trim() === "") return;
      const event = parseAgentLine(line);

      if (event.sessionId) this.sessionId = event.sessionId;
      this.push(event);
    });
    const err = createInterface({ input: child.stderr! });
    err.on("line", (line) => this.push({ kind: "stderr", text: line }));
    child.on("error", (error) => this.push({ kind: "stderr", text: error.message }));
    child.on("close", (code) => {
      this.exitCode = code;
      this.done = true;
      this.push({ kind: "exit", text: `exited with ${code ?? "signal"}` });
    });
  }

  private push(event: Omit<AgentEvent, "seq">): void {
    const full: AgentEvent = { ...event, seq: this.events.length };
    this.events.push(full);

    for (const listener of this.listeners) listener(full);
  }

  /** Calls `listener` for every event from `after` on, now and later; returns the unsubscribe. */
  subscribe(after: number, listener: (event: AgentEvent) => void): () => void {
    for (const event of this.events.slice(after)) listener(event);

    if (!this.done) this.listeners.add(listener);

    return () => this.listeners.delete(listener);
  }

  stop(): void {
    if (!this.done) this.child.kill();
  }
}

/** Starts and keeps the runs of one server. */
export class AgentRunner {
  readonly runs = new Map<string, AgentRun>();
  readonly spec: AgentSpec;
  private readonly root: string;
  private next = 1;

  constructor(root: string, spec: AgentSpec) {
    this.root = root;
    this.spec = spec;
  }

  /** Starts the agent on `prompt`; `resume` continues that session when the agent can. */
  start(prompt: string, resume: string | null): AgentRun {
    const args = [...this.spec.command.slice(1)];

    if (resume && this.spec.resumeFlag) args.push(this.spec.resumeFlag, resume);
    args.push(prompt);
    const child = spawn(this.spec.command[0]!, args, { cwd: this.root, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const id = `run-${this.next++}`;
    const run = new AgentRun(id, child, resume);
    this.runs.set(id, run);

    return run;
  }

  /** Runs `prompt` to its end and gives the result text (the agent's final answer), or the texts joined when there is no result event. */
  runToResult(prompt: string, timeoutMs = 180_000): Promise<string> {
    const run = this.start(prompt, null);

    return new Promise((resolve) => {
      const timer = setTimeout(() => run.stop(), timeoutMs);
      run.subscribe(0, (event) => {
        if (event.kind !== "exit") return;
        clearTimeout(timer);
        const result = run.events.find((candidate) => candidate.kind === "result")?.text;
        resolve(result && result.trim() !== "" ? result : run.events.filter((candidate) => candidate.kind === "text").map((candidate) => candidate.text).join("\n"));
      });
    });
  }

  stopAll(): void {
    for (const run of this.runs.values()) run.stop();
  }
}
