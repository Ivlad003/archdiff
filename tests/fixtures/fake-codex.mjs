// A stand-in for `codex exec --json` in the tests: prints Codex's events as
// it does (thread.started, item.completed of an agent message and of a file
// change, turn.completed), writes the file the prompt names, and resumes a
// thread given as `resume <id>` (as `codex exec resume <id>` does).
// usage: node fake-codex.mjs [resume <id>] [flags…] <prompt>
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const at = args.indexOf("resume");
const thread = at === -1 ? "0199aaaa-fake-thread-0001" : args[at + 1];
const prompt = args[args.length - 1] ?? "";
const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

line({ type: "thread.started", thread_id: thread });
line({ type: "turn.started" });
line({ type: "item.completed", item: { id: "item_0", type: "agent_message", text: at === -1 ? `Reading the task (${prompt.length} chars).` : `Resumed ${thread}.` } });
const file = prompt.match(/write-file: (\S+)/);

if (file) {
  writeFileSync(file[1], "export function planned(): number {\n  return 1;\n}\n");
  line({ type: "item.started", item: { id: "item_1", type: "file_change", changes: [{ path: resolve(file[1]), kind: "add" }], status: "in_progress" } });
  line({ type: "item.completed", item: { id: "item_1", type: "file_change", changes: [{ path: resolve(file[1]), kind: "add" }], status: "completed" } });
}

line({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: "done" } });
line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
