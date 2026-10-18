// A stand-in for `opencode run --format json` in the tests: prints
// OpenCode's events as it does (step_start, tool_use of a write, text,
// step_finish), each with its sessionID, writes the file the prompt names,
// and continues the session given by `--session <id>`.
// usage: node fake-opencode.mjs [--session <id>] [flags…] <prompt>
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const at = args.indexOf("--session");
const sessionID = at === -1 ? "ses_fake0001" : args[at + 1];
const prompt = args[args.length - 1] ?? "";
const line = (value) => process.stdout.write(`${JSON.stringify({ ...value, timestamp: 1, sessionID })}\n`);

line({ type: "step_start", part: { type: "step-start" } });
const file = prompt.match(/write-file: (\S+)/);

if (file) {
  writeFileSync(file[1], "export function planned(): number {\n  return 1;\n}\n");
  line({ type: "tool_use", part: { type: "tool", tool: "write", state: { status: "completed", input: { path: resolve(file[1]), content: "…" }, output: "Created file successfully" } } });
  line({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls" } });
  line({ type: "step_start", part: { type: "step-start" } });
}

line({ type: "text", part: { type: "text", text: at === -1 ? "done" : `continued ${sessionID}` } });
