// A stand-in for `claude -p` / `cursor-agent -p` in the tests: prints
// stream-json events like theirs, writes the file the prompt names (so a
// run changes the repository the way an agent would), and resumes a
// session when asked. usage: node fake-agent.mjs [--resume <id>] <prompt>
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const at = args.indexOf("--resume");
const session = at === -1 ? "fake-session-1" : args[at + 1];
const prompt = args[args.length - 1] ?? "";

const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

line({ type: "system", subtype: "init", session_id: session });
line({ type: "assistant", message: { content: [{ type: "text", text: `Reading the task (${prompt.length} chars)${at === -1 ? "" : ", resumed"}.` }] } });
const file = prompt.match(/write-file: (\S+)/);

if (file) {
  writeFileSync(file[1], "export function planned(): number {\n  return 1;\n}\n");
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: file[1] } }] } });
}

// A prompt that mentions a choice: the question protocol, answered by the next (resumed) message.
if (/ask the user/i.test(prompt) && at === -1) {
  line({ type: "assistant", message: { content: [{ type: "text", text: 'Which store?\n```archdiff-question\n{"question": "Which store should orders use?", "options": ["in memory", "SQLite", "Postgres"]}\n```' }] } });
} else if (at !== -1) {
  line({ type: "assistant", message: { content: [{ type: "text", text: `Noted: ${prompt.slice(0, 40)}.` }] } });
}

// A prompt that asks the agent to take its time: a run still going when the next one is asked for.
const wait = prompt.match(/wait-ms: (\d+)/);

if (wait) await new Promise((resolve) => setTimeout(resolve, Number(wait[1])));

line({ type: "result", result: "Done.", session_id: session });
