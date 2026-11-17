// A stand-in for an agent that tells what it was started with: its
// arguments (all but the task, the last one) and the variables of its
// environment a test asks for (`show-env: NAME,NAME` in the task), printed
// as stream-json. The tests of the settings read from it that a model and
// the keys reached the agent, and that a key's value never reaches the page.
// usage: node fake-env.mjs [arguments…] <prompt>

const args = process.argv.slice(2);
const prompt = args.at(-1) ?? "";
const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const names = (prompt.match(/show-env: ([A-Z0-9_,]+)/)?.[1] ?? "").split(",").filter(Boolean);

line({ type: "system", subtype: "init", session_id: "env-1" });
line({ type: "assistant", message: { content: [{ type: "text", text: `args: ${JSON.stringify(args.slice(0, -1))}` }] } });
line({ type: "assistant", message: { content: [{ type: "text", text: `task: ${prompt.length} chars, ${prompt.split("\n").length} lines` }] } });

for (const name of names) line({ type: "assistant", message: { content: [{ type: "text", text: `${name}=${name in process.env ? `[${process.env[name]}]` : "(unset)"}` }] } });

line({ type: "result", result: "Done.", session_id: "env-1" });
