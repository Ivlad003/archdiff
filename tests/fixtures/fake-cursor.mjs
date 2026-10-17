// A stand-in for `cursor-agent -p --output-format stream-json`: the same
// events as fake-agent.mjs but with Cursor's `chat_id`, resumed with
// `--resume <chatId>`. usage: node fake-cursor.mjs [--resume <id>] <prompt>
const args = process.argv.slice(2);
const at = args.indexOf("--resume");
const chat = at === -1 ? "chat-7" : args[at + 1];
const prompt = args[args.length - 1] ?? "";

const line = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

line({ type: "system", subtype: "init", chat_id: chat, model: "fake" });

if (/ask the user/i.test(prompt) && at === -1) {
  line({ type: "assistant", message: { content: [{ type: "text", text: 'One question first.\n```archdiff-question\n{"question": "Which database?", "options": ["SQLite", "Postgres"]}\n```' }] }, chat_id: chat });
} else {
  line({ type: "assistant", message: { content: [{ type: "text", text: at === -1 ? `Cursor read ${prompt.length} chars.` : `Cursor resumed: ${prompt.slice(0, 30)}.` }] }, chat_id: chat });
}

line({ type: "result", result: "Done.", chat_id: chat });
