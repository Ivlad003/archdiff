// An explanation as a walk through the pictures: the reader asks an agent
// to explain a picture, some shapes or anything they name, and the agent
// answers with a guided tour — steps in the order to read them, each a
// view, the shapes to look at there (a path through them, when they are
// one) and a note that says what the step shows, how it works and why it
// is so. The page keeps the tour beside the others and plays it at once:
// the pictures change, the shapes light, the notes stand under the title,
// and the reader steps through them, back and forth, as often as they like.
//
// Here are the two ends of that exchange, described once: the task the
// agent is given (`explainPrompt`) and the block of its answer the page
// takes for a tour (`tourInAnswer`). No Node in it: the page imports it.
// Entry points: `explainPrompt`, `tourInAnswer`, `explainedName`,
// `Explained`, `ExplainedStep`, `TOUR_BLOCK`.

import { parseView } from "./view-keys.ts";

/** The language of the fenced block an agent writes a tour in. */
export const TOUR_BLOCK = "archdiff-tour";

/** A step of an explanation as the agent writes it: the view by its key, the shapes by their IDs, whether they are a path, and what the step says. */
export interface ExplainedStep {
  view: string;
  select: string[];
  path: boolean;
  note: string;
}

export interface Explained {
  title: string;
  steps: ExplainedStep[];
}

/** Steps of an explanation, at most: more than these is no walk a reader takes. */
const MAX_STEPS = 20;

/**
 * The task of an explanation: what to explain — in the reader's words, with the tags of the picture or the shapes it
 * is about — and how to write it, as a tour the page plays. The agent changes no file.
 */
export function explainPrompt(what: string): string {
  return [
    "Explain this to someone who reads the repository for the first time, as a guided tour on archdiff's page. Read the code you need, and change no file.",
    "",
    `What to explain: ${what}`,
    "",
    `Write the explanation as ONE fenced block \`\`\`${TOUR_BLOCK} that holds JSON, then one line that sums it up:`,
    "",
    `\`\`\`${TOUR_BLOCK}`,
    '{"title": "How an order is placed", "steps": [{"view": "calls:src/routes/checkout.tsx#action", "select": ["src/routes/checkout.tsx#action", "src/lib/orders.ts#placeOrder", "src/db/store.ts#saveOrder"], "path": true, "note": "The request enters at `action`, which …"}]}',
    "```",
    "",
    "- Three to eight steps, in the order a reader should take them: where it starts, what it goes through, where it ends; for a change, what was there, what the change does, what it touches.",
    "- `view` is a view's key as `archdiff views` lists them: `layers`, `layer:<name>`, `module:<path>`, `inside:<path>`, `calls:<path>#<fn>`, `logic:<path>#<fn>`, `impact:<path>`, `review`. Take the view on which the shapes of the step are all drawn.",
    "- `select` names the shapes of that view to look at, by their IDs: a layer by its name, a module by its path (`src/x.ts`), a function by `<path>#<name>`, a method by `<path>#<Class>.<method>`. Name only shapes the view draws — its page lists them (the `diagram` tool, or `archdiff diagram <view>`); a name that is on no shape of the picture is left out when the step is shown.",
    "- `path` is true when the shapes are a way to follow in that order (a call after a call, an import after an import): the lines from each to the next are lit.",
    "- `note` is two to five sentences of Markdown: what the reader is looking at, how it works, and why it is done so. Say what the code says, with its `file:line`; where a reason is your guess, say that it is one.",
  ].join("\n");
}

/** The name of the file an explanation is kept under: `explained-`, the words of its title, and a mark of the moment so that no two share one. */
export function explainedName(title: string, at: number): string {
  const words = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");

  return `explained-${words === "" ? "tour" : words}-${at.toString(36)}`;
}

/**
 * The tour an agent wrote in its answer: null when the answer holds no `archdiff-tour` block; the problem when the
 * block is no tour — not JSON, no step, a step that names no view — said so that the agent, or the reader, can mend it.
 */
export function tourInAnswer(text: string): { tour: Explained } | { problem: string } | null {
  const block = text.match(/```archdiff-tour[ \t]*\r?\n([\s\S]*?)```/);

  if (!block) return null;
  let written: unknown;

  try {
    written = JSON.parse(block[1]!);
  } catch (error) {
    return { problem: `the tour is no JSON: ${error instanceof Error ? error.message : String(error)}` };
  }

  if (typeof written !== "object" || written === null || !Array.isArray((written as { steps?: unknown }).steps)) return { problem: 'the tour needs "steps": a list' };
  const { title, steps } = written as { title?: unknown; steps: unknown[] };

  if (steps.length === 0 || steps.length > MAX_STEPS) return { problem: `the tour needs one to ${MAX_STEPS} steps, not ${steps.length}` };
  const read: ExplainedStep[] = [];

  for (const [index, step] of steps.entries()) {
    const { view, select, path, note } = (typeof step === "object" && step !== null ? step : {}) as { view?: unknown; select?: unknown; path?: unknown; note?: unknown };

    if (typeof view !== "string" || parseView(view) === null) return { problem: `step ${index + 1} names no view (${typeof view === "string" ? `"${view}" is none` : 'it needs "view"'}: archdiff views lists them)` };

    if (select !== undefined && !(Array.isArray(select) && select.every((id) => typeof id === "string"))) return { problem: `"select" of step ${index + 1} must be a list of shape IDs` };
    read.push({ view, select: (select as string[] | undefined) ?? [], path: path === true, note: typeof note === "string" ? note : "" });
  }

  return { tour: { title: typeof title === "string" && title.trim() !== "" ? title.trim() : "An explanation", steps: read } };
}
