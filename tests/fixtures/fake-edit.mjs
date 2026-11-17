// A stand-in for an agent that edits the repository as its task says:
// a line `write: <path> <JSON string>` writes the file with that content
// and a line `remove: <path>` deletes it, each told as a tool call, in
// stream-json like Claude Code's. The test of a run's report has it fix
// one violation of the contract and add another.
// usage: node fake-edit.mjs <prompt>
import { rmSync, writeFileSync } from "node:fs";

const prompt = process.argv.at(-1) ?? "";
const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

line({ type: "system", subtype: "init", session_id: "edit-1" });

for (const [, path, content] of prompt.matchAll(/^write: (\S+) (".*")$/gm)) {
  writeFileSync(path, JSON.parse(content));
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: path } }] } });
}

for (const [, path] of prompt.matchAll(/^remove: (\S+)$/gm)) {
  rmSync(path, { force: true });
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: `rm ${path}` } }] } });
}

line({ type: "result", result: "Edited.", session_id: "edit-1" });
