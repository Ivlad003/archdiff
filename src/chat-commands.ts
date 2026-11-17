// The commands of the Chat tab, described once: a line that starts with a
// slash does what a button, a key or a field of the page does — opens a
// view, switches how it is shown, opens modules in place, lays an overlay,
// starts a review, searches the code or the lines of a change — so the
// whole page can be driven from where the reader types. The page runs them
// (web/src/commands.ts holds what each does); `/help` lists them from this
// table, the suggestions under the field come from it, and so does the
// part of the protocol that tells an agent what it may show: a fenced
// `archdiff-do` block of its answer, one command a line, which the page
// runs for the reader. An agent is given the commands that only show
// something — none that writes a drawing, changes a setting or starts a
// run.
//
// No Node in it: the page imports the table as the server does. Entry
// points: `CHAT_COMMANDS`, `ChatCommand`, `commandNamed`, `parseCommandLine`,
// `commandsHelp`, `agentCommands`, `doCommands`, `DO_BLOCK`.

export interface ChatCommand {
  name: string;
  /** Its arguments as the help writes them; empty when it takes none. */
  args: string;
  /** What it does, in a line. */
  does: string;
  /** Whether an agent may run it from its answer: it shows something and writes nothing. */
  agent: boolean;
}

export const CHAT_COMMANDS: readonly ChatCommand[] = [
  { name: "help", args: "[command]", does: "The commands, or what one of them takes", agent: false },
  { name: "view", args: "<key | words>", does: "Open a view by its key (`calls:src/x.ts#fn`, `layers`) or by words of its title", agent: true },
  { name: "back", args: "", does: "The view before this one", agent: false },
  { name: "as", args: "canvas | 3d | markdown | code", does: "Show the view on the canvas, in 3D, as its page or as the code of its subject", agent: true },
  { name: "detail", args: "minimal | normal | full", does: "How much of the picture is drawn", agent: true },
  { name: "depth", args: "<n> | auto", does: "How far from the subject the picture goes", agent: true },
  { name: "limit", args: "<n> | auto", does: "More shapes than this fold by directory", agent: true },
  { name: "weight", args: "<n> | auto", does: "Leave out the lines that stand for fewer imports or calls", agent: true },
  { name: "hubs", args: "on | off", does: "A module most of the picture imports as a badge, or as lines", agent: true },
  { name: "packages", args: "on | off", does: "Draw the packages a module imports", agent: true },
  { name: "overlay", args: "<tests, storages, heat, instability, churn, coupling, ownership> | none", does: "Lay overlays over the picture", agent: true },
  { name: "changes", args: "on | off", does: "Lay the changes since the base over the picture", agent: true },
  { name: "changed", args: "on | off", does: "Keep only the files changed since the base", agent: true },
  { name: "preset", args: "reviewer | newcomer | architect", does: "The options of who is reading, at once", agent: true },
  { name: "mix", args: "<module> …", does: "Open modules in place: their functions among the other shapes", agent: true },
  { name: "unmix", args: "", does: "Close the modules opened in place", agent: true },
  { name: "lanes", args: "rows | columns", does: "Lay the lanes as rows or as columns", agent: true },
  { name: "select", args: "<shape> …", does: "Pick shapes of the picture by their name", agent: true },
  { name: "find", args: "<text>", does: "Light the shapes of the picture whose name has the text", agent: true },
  { name: "grep", args: "<text | /regex/>", does: "Search the code: every line that has the text, with its file and line", agent: true },
  { name: "diff", args: "<text | /regex/>", does: "Search the lines the change added and removed", agent: true },
  { name: "review", args: "[base] [head]", does: "The architectural diff of the head (the working tree) against the base", agent: true },
  { name: "compare", args: "<head> <head> …", does: "Several heads against the base, in one picture", agent: true },
  { name: "commit", args: "<sha>", does: "One commit's own change", agent: true },
  { name: "board", args: "", does: "The uncommitted changes, in groups", agent: true },
  { name: "impact", args: "<module | path#fn>", does: "What a change to it reaches, with the risk", agent: true },
  { name: "logic", args: "<path#fn | words>", does: "A function's body as a flowchart, with its rules", agent: true },
  { name: "export", args: "md | mermaid | json | drawio | excalidraw | archimate", does: "Download the picture", agent: false },
  { name: "split", args: "[view | off]", does: "A second picture beside this one: this view, or another by its key or words; off closes it", agent: true },
  { name: "dim", args: "", does: "The dim tool on or off: a tap dims the rest", agent: false },
  { name: "full", args: "", does: "The canvas across the whole page, or the panels back", agent: false },
  { name: "panel", args: "left | right", does: "Show or hide a side panel", agent: false },
  { name: "edit", args: "", does: "Draw on the picture", agent: false },
  { name: "done", args: "", does: "Back to reading", agent: false },
  { name: "ask", args: "<question>", does: "A question to the agent about the picture, answered without a change", agent: false },
  { name: "agent", args: "<name> | none", does: "Pick the agent the tasks and the questions go to", agent: false },
  { name: "stop", args: "", does: "Stop the agent's run", agent: false },
  { name: "check", args: "", does: "Run the contract check and the configured checks now", agent: false },
  { name: "code", args: "", does: "Fold the drawing into the contract and have the agent build it", agent: false },
  { name: "diagram", args: "[what to look at]", does: "Have the agent review ARCHITECTURE.md", agent: false },
  { name: "doc", args: "[text]", does: "A design note that becomes the contract", agent: false },
  { name: "settings", args: "", does: "The agents of this computer and the keys", agent: false },
];

/** The language of the fenced block an agent writes its commands in. */
export const DO_BLOCK = "archdiff-do";

export function commandNamed(name: string): ChatCommand | null {
  return CHAT_COMMANDS.find((command) => command.name === name) ?? null;
}

/** A line as a command: its name and what follows it; null for a line that is none (no slash, or a slash and no known name). */
export function parseCommandLine(line: string): { command: ChatCommand; argument: string } | null {
  const match = line.trim().match(/^\/([a-z]+)(?:\s+([\s\S]*))?$/);
  const command = match ? commandNamed(match[1]!) : null;

  return command ? { command, argument: (match![2] ?? "").trim() } : null;
}

/** The commands as a Markdown table, or one command's own line; null for a name that is no command. */
export function commandsHelp(name: string | null = null): string | null {
  const row = (command: ChatCommand): string => `| \`/${command.name}${command.args ? ` ${command.args.replace(/\|/g, "\\|")}` : ""}\` | ${command.does} |`;

  if (name !== null) {
    const command = commandNamed(name.replace(/^\//, ""));

    return command ? ["| command | what it does |", "| --- | --- |", row(command)].join("\n") : null;
  }

  return ["A line that starts with a slash is a command; the page does what it says, with or without an agent.", "", "| command | what it does |", "| --- | --- |", ...CHAT_COMMANDS.map(row)].join("\n");
}

/** What the protocol of a run tells an agent of the commands: how to write them, and which it may. */
export function agentCommands(): string {
  const listed = CHAT_COMMANDS.filter((command) => command.agent).map((command) => `\`/${command.name}${command.args ? ` ${command.args}` : ""}\``);

  return `To show the user something on the page they are looking at, write one fenced block \`\`\`${DO_BLOCK} with one command per line; the page runs them in order, and the user sees the picture change. The commands: ${listed.join(", ")}. A view's key is as \`archdiff views\` lists it (\`layers\`, \`module:src/x.ts\`, \`calls:src/x.ts#fn\`, \`logic:src/x.ts#fn\`, \`impact:src/x.ts\`). Use it when a picture answers better than words; say in a line what you are showing.`;
}

/** The command lines of the `archdiff-do` blocks of an agent's text, in order; a line that is no command is left out. */
export function doCommands(text: string): string[] {
  const lines: string[] = [];

  for (const block of text.matchAll(/```archdiff-do[ \t]*\r?\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.split(/\r?\n/)) if (line.trim().startsWith("/")) lines.push(line.trim());
  }

  return lines;
}
