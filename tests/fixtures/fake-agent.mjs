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

line({ type: "result", result: "Done.", session_id: session });
