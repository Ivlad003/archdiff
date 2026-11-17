// A stand-in for `claude -p` / `cursor-agent -p` in the tests: prints
// stream-json events like theirs, writes the file the prompt names (so a
// run changes the repository the way an agent would), and resumes a
// session when asked. usage: node fake-agent.mjs [--resume <id>] <prompt>
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const at = args.indexOf("--resume");
const session = at === -1 ? "fake-session-1" : args[at + 1];
// As Claude Code reads its arguments: `--allowedTools` takes everything after it up to `--`; a prompt swallowed by it is no prompt.
const tools = args.indexOf("--allowedTools");
const end = args.indexOf("--");

if (tools !== -1 && end === -1) {
  process.stderr.write("Error: Input must be provided either through stdin or as a prompt argument when using --print\n");
  process.exit(1);
}

const prompt = (end !== -1 ? args[end + 1] : args[args.length - 1]) ?? "";

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

// A task of an explanation (it names the block a tour is written in): a tour of three steps through the sample — the
// layers as a way, the call of the checkout down to the store as a way, and a function's logic — as an agent writes it.
if (prompt.includes("```archdiff-tour")) {
  const tour = {
    title: "How an order is placed",
    steps: [
      { view: "layers", select: ["routes", "lib", "db"], path: true, note: "A request goes **routes → lib → db**: the route knows nothing of the store." },
      { view: "calls:src/routes/checkout.tsx#action", select: ["src/routes/checkout.tsx#action", "src/lib/orders.ts#placeOrder", "src/db/store.ts#saveOrder"], path: true, note: "`action` has the service place the order, and `placeOrder` saves it (`src/lib/orders.ts:10`)." },
      { view: "logic:src/lib/orders.ts#validate", select: [], note: "An order with a negative total is refused before it is saved." },
    ],
  };
  line({ type: "assistant", message: { content: [{ type: "text", text: `Here is the tour.\n\`\`\`archdiff-tour\n${JSON.stringify(tour)}\n\`\`\`\nThree steps: the layers, the calls, the guard.` }] } });
}

// A prompt that has the agent show something on the page: the commands it names (`do-commands: /view layers; /as 3d`),
// written as an agent writes them, one a line in an archdiff-do block.
const shown = prompt.match(/do-commands: ([^\n]+)/);

if (shown) line({ type: "assistant", message: { content: [{ type: "text", text: `Here it is on the page.\n\`\`\`archdiff-do\n${shown[1].split(";").map((command) => command.trim()).join("\n")}\n\`\`\`` }] } });

// A prompt that asks the agent to take its time: a run still going when the next one is asked for.
const wait = prompt.match(/wait-ms: (\d+)/);

if (wait) await new Promise((resolve) => setTimeout(resolve, Number(wait[1])));

line({ type: "result", result: "Done.", session_id: session });
