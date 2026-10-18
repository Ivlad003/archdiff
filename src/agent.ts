// The coding agents archdiff can hand a task to: Claude Code (`claude -p`),
// Cursor's CLI (`cursor-agent -p`), Codex (`codex exec --json`) and
// OpenCode (`opencode run --format json`), each run as a child process in
// the repository, its JSON events read line by line — by the protocol the
// agent speaks — and kept for the page (the Chat tab streams them). A
// follow-up message resumes the agent's own session. A custom command
// (archdiff.json `agent.command`, with the protocol it speaks) runs the
// same way, which the tests use with fake agents. The page offers the
// agents installed here and says which one each run takes; nothing starts
// without a button.
//
// Sits at the I/O edge beside the server: Plan Markdown → process →
// AgentEvent[]. Entry points: `agentFromConfig`, `AgentRunner`,
// `parseAgentLine`, `eventReader`, `installedAgents`, `AGENTS`.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";
import { isJsonObject, isJsonString, parseJson, type JsonObject, type JsonValue } from "./json.ts";

export type AgentName = "claude" | "cursor" | "codex" | "opencode";

/** The JSON an agent writes on stdout: Claude Code's and Cursor's stream-json, Codex's events, OpenCode's events. */
export type AgentProtocol = "stream-json" | "codex" | "opencode";

/** How to run one agent: the command, how to resume a session, and how to read what it writes. */
export interface AgentSpec {
  name: string;
  /** What the page calls it. */
  label: string;
  /** The executable and its fixed arguments; the prompt is appended as the last argument. */
  command: string[];
  /** The flag that resumes a session, followed by the session ID; null when the agent cannot, or resumes by `resumeCommand`. */
  resumeFlag: string | null;
  /** The command of a resumed run when it is another one (Codex's `codex exec resume <id>`): `{session}` stands for the ID. */
  resumeCommand?: string[];
  protocol: AgentProtocol;
  /** Lines the agent writes on stderr every time, which say nothing of the run (Codex's note that it reads stdin). */
  quiet?: RegExp;
  /** Claude Code: the tools it may use without asking, appended as `--allowedTools` (the checks of archdiff.json, archdiff itself). */
  allowedTools?: string[];
}

/** Codex's sandbox for a task: it writes in the repository and nowhere else, and asks nothing (print mode cannot answer). */
const CODEX_SANDBOX = ["-c", 'sandbox_mode="workspace-write"', "--skip-git-repo-check"];

/** The built-in agents: print mode, streamed JSON, edits in the repository allowed without a prompt (shell commands follow each agent's own rules). */
export const AGENTS: Record<AgentName, AgentSpec> = {
  claude: { name: "claude", label: "Claude Code", command: ["claude", "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits"], resumeFlag: "--resume", protocol: "stream-json" },
  // `--trust`: the CLI otherwise stops to ask whether the directory is trusted, which print mode cannot answer; it does not force shell commands (that is `-f`).
  cursor: { name: "cursor", label: "Cursor", command: ["cursor-agent", "-p", "--output-format", "stream-json", "--trust"], resumeFlag: "--resume", protocol: "stream-json" },
  codex: { name: "codex", label: "Codex", command: ["codex", "exec", "--json", ...CODEX_SANDBOX], resumeFlag: null, resumeCommand: ["codex", "exec", "resume", "{session}", "--json", ...CODEX_SANDBOX], protocol: "codex", quiet: /^Reading additional input from stdin/ },
  // `--auto`: the permissions it would ask for are granted, unless the project's OpenCode config denies them.
  opencode: { name: "opencode", label: "OpenCode", command: ["opencode", "run", "--format", "json", "--auto"], resumeFlag: "--session", protocol: "opencode" },
};

const NAMES = Object.keys(AGENTS) as AgentName[];

function isAgentName(value: string): value is AgentName {
  return (NAMES as string[]).includes(value);
}

/** The `agent` field of archdiff.json or `--agent`: a name, or `{ command: [...], resume?: "--flag", protocol? }`. Throws naming the field. */
export function agentFromConfig(value: JsonValue | undefined): AgentSpec | null {
  if (value === undefined || value === null) return null;

  if (isJsonString(value)) {
    if (isAgentName(value)) return AGENTS[value];
    throw new Error(`agent: "${value}" is not ${NAMES.slice(0, -1).join(", ")} or ${NAMES.at(-1)}`);
  }

  if (!isJsonObject(value) || !Array.isArray(value["command"]) || !value["command"].every(isJsonString) || value["command"].length === 0) throw new Error(`agent: must be ${NAMES.map((name) => `"${name}"`).join(", ")} or { "command": ["…"], "resume": "--flag" }`);
  const resume = value["resume"];

  if (resume !== undefined && !isJsonString(resume)) throw new Error('agent: "resume" must be a string');
  const protocol = value["protocol"];

  if (protocol !== undefined && protocol !== "stream-json" && protocol !== "codex" && protocol !== "opencode") throw new Error('agent: "protocol" must be "stream-json", "codex" or "opencode"');
  const name = isJsonString(value["name"]) ? value["name"] : "custom";

  return { name, label: name, command: value["command"], resumeFlag: resume ?? null, protocol: protocol ?? "stream-json" };
}

/** Whether a command can be started: a path that exists, or a name found in a directory of PATH. */
function onPath(command: string): boolean {
  if (command.includes("/") || command.includes("\\")) return existsSync(command);
  const extensions = process.platform === "win32" ? ["", ...(process.env["PATHEXT"] ?? ".EXE;.CMD;.BAT").split(";")] : [""];

  return (process.env["PATH"] ?? "").split(delimiter).some((directory) => directory !== "" && extensions.some((extension) => existsSync(join(directory, command + extension))));
}

/** The agents the page may offer: the built-in ones, then the configured one when it is no built-in, each with whether it is installed here. */
export function installedAgents(configured: AgentSpec | null): { spec: AgentSpec; installed: boolean }[] {
  const specs = [...NAMES.map((name) => AGENTS[name]), ...(configured && !isAgentName(configured.name) ? [configured] : [])];

  return specs.map((spec) => ({ spec, installed: onPath(spec.command[0]!) }));
}

/** One event of a run, as the page shows it. */
export interface AgentEvent {
  seq: number;
  kind: "text" | "tool" | "result" | "init" | "raw" | "stderr" | "exit" | "check";
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

/** Reads an agent's lines into events (null for a line the page need not show), and at its end the answer it left unsaid. */
export interface EventReader {
  read(line: string): Omit<AgentEvent, "seq"> | null;
  /** The run's answer when the agent wrote none of its own (Codex and OpenCode end with their last message): a `result`. */
  finish(): Omit<AgentEvent, "seq"> | null;
}

/** The reader of a protocol: Claude Code's stream-json as it is, Codex's and OpenCode's events into the same kinds. */
export function eventReader(protocol: AgentProtocol): EventReader {
  if (protocol === "codex") return codexReader();

  if (protocol === "opencode") return opencodeReader();

  // Claude Code and Cursor end with a `result` of their own.
  return { read: parseAgentLine, finish: () => null };
}

/** A JSON object of a line, or null for anything else. */
function objectOf(line: string): JsonObject | null {
  try {
    const parsed = parseJson(line);

    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A tool's input in one line: its fields, each cut to 120 characters. */
function inputSummary(input: JsonValue | undefined): string {
  return isJsonObject(input) ? Object.entries(input).map(([key, item]) => `${key}=${isJsonString(item) ? item.slice(0, 120) : JSON.stringify(item).slice(0, 120)}`).join(" ") : "";
}

/**
 * Codex's `exec --json`: `thread.started` (the session), `item.completed` of an `agent_message` (its text), a
 * `command_execution` (a shell command and its output), a `file_change` (the files written), an `mcp_tool_call` or a
 * `web_search` (a tool), `turn.completed` (the turn's end: its last message is the answer), and `turn.failed` or
 * `error`. Items started or updated, reasoning and to-do lists are not shown.
 */
function codexReader(): EventReader {
  let last = "";
  let answered = false;

  const read = (line: string): Omit<AgentEvent, "seq"> | null => {
    const event = objectOf(line);

    if (!event) return { kind: "raw", text: line.slice(0, 400) };
    const type = event["type"];

    if (type === "thread.started" && isJsonString(event["thread_id"])) return { kind: "init", text: `session ${event["thread_id"]}`, sessionId: event["thread_id"] };

    if (type === "turn.completed") {
      answered = true;

      return { kind: "result", text: last };
    }

    if (type === "turn.failed" || type === "error") {
      const error = event["error"];
      const message = isJsonObject(error) && isJsonString(error["message"]) ? error["message"] : isJsonString(event["message"]) ? event["message"] : type;

      return { kind: "stderr", text: message };
    }

    const item = event["item"];

    if (type !== "item.completed" || !isJsonObject(item)) return null;

    if (item["type"] === "agent_message" && isJsonString(item["text"])) {
      last = item["text"];

      return { kind: "text", text: item["text"] };
    }

    if (item["type"] === "command_execution" && isJsonString(item["command"])) {
      const output = isJsonString(item["aggregated_output"]) ? item["aggregated_output"].slice(0, 400) : "";

      return { kind: "tool", text: `▶ shell ${item["command"].slice(0, 200)}${output ? `\n◀ ${output}` : ""}` };
    }

    if (item["type"] === "file_change" && Array.isArray(item["changes"])) {
      const changes = item["changes"].filter(isJsonObject);
      const files = changes.map((change) => change["path"]).filter(isJsonString);

      return { kind: "tool", text: changes.map((change) => `▶ ${isJsonString(change["kind"]) ? change["kind"] : "change"} ${isJsonString(change["path"]) ? change["path"] : ""}`).join("\n"), files };
    }

    if (item["type"] === "mcp_tool_call" || item["type"] === "web_search") return { kind: "tool", text: `▶ ${isJsonString(item["tool"]) ? item["tool"] : item["type"]} ${inputSummary(item["arguments"])}`.trimEnd() };

    return null;
  };

  return { read, finish: () => (answered || last === "" ? null : { kind: "result", text: last }) };
}

/**
 * OpenCode's `run --format json`: every event carries its `sessionID`; `text` (a part of the answer), `tool_use`
 * (a tool, its input and its output: `write`, `edit` and `read` name a path), `step_start` and `step_finish`
 * (a step of the run, not shown), `error`. Its last text is the answer, given when the process ends.
 */
function opencodeReader(): EventReader {
  let last = "";
  let announced = false;

  const read = (line: string): Omit<AgentEvent, "seq"> | null => {
    const event = objectOf(line);

    if (!event) return { kind: "raw", text: line.slice(0, 400) };
    const sessionId = isJsonString(event["sessionID"]) ? event["sessionID"] : undefined;
    const withSession = (shown: Omit<AgentEvent, "seq">): Omit<AgentEvent, "seq"> => (sessionId ? { ...shown, sessionId } : shown);
    const part = isJsonObject(event["part"]) ? event["part"] : {};
    const type = event["type"];

    if (type === "text" && isJsonString(part["text"])) {
      last = part["text"];

      return withSession({ kind: "text", text: part["text"] });
    }

    if (type === "tool_use") {
      const state = isJsonObject(part["state"]) ? part["state"] : {};
      const input = state["input"];
      const files = isJsonObject(input) ? ["path", "filePath", "file_path"].map((key) => input[key]).filter(isJsonString) : [];
      const output = isJsonString(state["output"]) ? `\n◀ ${state["output"].slice(0, 400)}` : "";
      const shown: Omit<AgentEvent, "seq"> = { kind: "tool", text: `▶ ${isJsonString(part["tool"]) ? part["tool"] : "tool"} ${inputSummary(input)}`.trimEnd() + output };

      return withSession(files.length > 0 ? { ...shown, files } : shown);
    }

    if (type === "error") {
      const error = event["error"];

      return withSession({ kind: "stderr", text: isJsonObject(error) && isJsonString(error["message"]) ? error["message"] : isJsonObject(error) && isJsonObject(error["data"]) && isJsonString(error["data"]["message"]) ? error["data"]["message"] : "error" });
    }

    // The first step names the session, once: the page resumes it.
    if (sessionId && type === "step_start" && !announced) {
      announced = true;

      return { kind: "init", text: `session ${sessionId}`, sessionId };
    }

    return null;
  };

  return { read, finish: () => (last === "" ? null : { kind: "result", text: last }) };
}

/** One run of an agent: its events so far, who is waiting for more, and the process. */
export class AgentRun {
  readonly id: string;
  readonly events: AgentEvent[] = [];
  /** The agent the run is of (its name): a follow-up resumes the session with the same one. */
  readonly agent: string;
  sessionId: string | null;
  done = false;
  exitCode: number | null = null;
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly child: ChildProcess;

  constructor(id: string, child: ChildProcess, sessionId: string | null, afterRun: (() => Promise<Omit<AgentEvent, "seq">[]>) | null = null, reader: EventReader = eventReader("stream-json"), agent = "", quiet: RegExp | null = null) {
    this.id = id;
    this.child = child;
    this.sessionId = sessionId;
    this.agent = agent;
    const out = createInterface({ input: child.stdout! });
    out.on("line", (line) => {
      if (line.trim() === "") return;
      const event = reader.read(line);

      if (!event) return;

      if (event.sessionId) this.sessionId = event.sessionId;
      this.push(event);
    });
    const err = createInterface({ input: child.stderr! });
    err.on("line", (line) => {
      if (!quiet?.test(line)) this.push({ kind: "stderr", text: line });
    });
    child.on("error", (error) => this.push({ kind: "stderr", text: error.message }));
    child.on("close", (code) => {
      this.exitCode = code;
      // The answer an agent left as its last message (Codex, OpenCode), as the run's result.
      const answer = reader.finish();

      if (answer) this.push(answer);
      // The checks run after the agent, before the run is over: their events reach whoever listens, then the exit.
      void (afterRun ? afterRun() : Promise.resolve([])).catch((error: unknown): Omit<AgentEvent, "seq">[] => [{ kind: "stderr", text: `checks: ${error instanceof Error ? error.message : String(error)}` }]).then((events) => {
        for (const event of events) this.push(event);
        this.done = true;
        this.push({ kind: "exit", text: `exited with ${code ?? "signal"}` });
      });
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

/** Starts and keeps the runs of one server, of whichever agent each run names. */
export class AgentRunner {
  readonly runs = new Map<string, AgentRun>();
  private readonly root: string;
  private readonly afterRun: (() => Promise<Omit<AgentEvent, "seq">[]>) | null;
  private next = 1;

  /** `afterRun`: what runs once the agent exits (the checks), its events appended to the run before the exit. */
  constructor(root: string, afterRun: (() => Promise<Omit<AgentEvent, "seq">[]>) | null = null) {
    this.root = root;
    this.afterRun = afterRun;
  }

  /** Starts `spec` on `prompt`; `resume` continues that session — by the agent's flag, or its own resume command. */
  start(spec: AgentSpec, prompt: string, resume: string | null, checks = true): AgentRun {
    const command = resume && spec.resumeCommand ? spec.resumeCommand.map((part) => (part === "{session}" ? resume : part)) : spec.command;
    const args = [...command.slice(1)];

    if (resume && !spec.resumeCommand && spec.resumeFlag) args.push(spec.resumeFlag, resume);

    if (spec.allowedTools && spec.allowedTools.length > 0) args.push("--allowedTools", ...spec.allowedTools);
    args.push(prompt);
    const child = spawn(command[0]!, args, { cwd: this.root, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const id = `run-${this.next++}`;
    const run = new AgentRun(id, child, resume, checks ? this.afterRun : null, eventReader(spec.protocol), spec.name, spec.quiet ?? null);
    this.runs.set(id, run);

    return run;
  }

  /** Runs `prompt` to its end and gives the result text (the agent's final answer), or the texts joined when there is no result event. */
  runToResult(spec: AgentSpec, prompt: string, timeoutMs = 180_000): Promise<string> {
    // A question to the agent (mocks, a document): no checks after it.
    const run = this.start(spec, prompt, null, false);

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

  /** The run still going, when there is one: a task's or a question's. */
  running(): AgentRun | null {
    return [...this.runs.values()].find((run) => !run.done) ?? null;
  }
}
