// What a tap on the canvas picks and what the page shows for it: a
// shape's page with its neighbours as chips, a line's page with the
// chain onward, a selection of several shapes (two light the chain
// between them), the walk along the arrows with the keys, and the two
// tools that change what a tap does — mix opens a module in place, dim
// fades all but a shape's neighbours. The canvas reports the taps
// (app.ts hands `tap` and `openShape` to it); the shapes and lines are
// the current picture's, read through the page.
//
// Entry points: `tap`, `openShape`, `select`, `toggleSelected`,
// `pickShape`, `askSelected`, `showEdge`, `walk`, `resetSelection`,
// `selection`, `lastPicked`, `tools`, `labelOf`.

import { api, type Shape } from "./api.ts";
import { chainBetween, chainFrom, neighbourhoodOf } from "./chains.ts";
import { askAbout } from "./chat.ts";
import { h, element } from "./dom.ts";
import { VIEW_LINK, type PickedLine } from "./editor.tsx";
import { currentLink, refsOf, setLink } from "./link.ts";
import { closeMenu } from "./menu.ts";
import { page } from "./page.ts";
import { markdownPanel, setMarkdown, showCode, showPicturePage, showTab } from "./panel.ts";
import { notice } from "./title.ts";
import { lineElementId, opensView, standsFor, tagOf } from "../../src/shape-keys.ts";

/** The tools of the canvas that change what a tap does: the toolbar turns them on and off, one at a time. */
export const tools = { mix: false, dim: false };

/** The shapes selected with Shift or Ctrl (or a box in the editor), in the order picked; a plain tap selects one. */
let selected: string[] = [];

/** The shape picked last: the start of the next chain, of the arrow-key walk, and what Enter opens. */
let picked: string | null = null;

/** Where the arrow-key walk is: the direction pressed, the shape it started from, how many presses cycled the neighbours. */
let walked: { direction: string; from: string; index: number } = { direction: "", from: "", index: 0 };

export function selection(): readonly string[] {
  return selected;
}

export function lastPicked(): string | null {
  return picked;
}

/** The first line of a shape's label, or its ID when the shape is not in the picture. */
export function labelOf(id: string): string {
  return page.nodes().get(id)?.label.split("\n")[0] ?? id;
}

// ── A shape's page ───────────────────────────────────────────────────────────

/** The page of a shape (as the server writes it for the picture shown), its neighbours and its code; null: the picture's page. */
async function showNode(id: string | null): Promise<void> {
  const state = currentLink();
  const node = id === null ? null : page.nodes().get(id);

  if (!node) {
    showPicturePage();
    renderNeighbours(null);

    return;
  }

  let markdown: string;

  try {
    markdown = (await api.shape(state.view, node.id, state, refsOf(state))).markdown;
  } catch (error) {
    markdown = error instanceof Error ? error.message : String(error);
  }

  // A review: the commits that touched the shape's file (a module's page says what the change did to it, another
  // shape its mark). A comparison's module page says what each head did; the history here is the checkout's, not theirs.
  const file = node.ref?.file;

  if (state.view === "review" && file) {
    try {
      const { commits } = await api.fileHistory(file);
      markdown += `${node.kind === "module" ? "" : `\n\n_${node.diff ?? "context"} in this change._`}${commits.length > 0 ? `\n\n## Commits that touched it\n\n${commits.map((commit) => `- \`${commit.short}\` ${commit.date} ${commit.author}: ${commit.subject}`).join("\n")}` : ""}\n`;
    } catch {
      // Outside git: the shape's page alone.
    }
  }

  setMarkdown(markdownPanel, markdown);
  showTab("markdown");
  renderNeighbours(node);
  await showCode(node);
}

/** The lines of the picture that leave a shape (out) or come into it (into), between shapes the picture shows. */
function neighbourLines(id: string, direction: "out" | "into") {
  const nodes = page.nodes();

  return page.edges().filter((edge) => edge.kind !== "lifeline" && (direction === "out" ? edge.from === id && nodes.has(edge.to) : edge.to === id && nodes.has(edge.from)));
}

/** A neighbour beyond the picture, short: a function as its name and file, a module as its path. */
function outsideLabel(id: string): string {
  const at = id.indexOf("#");

  return at === -1 ? id : `${id.slice(at + 1)} (${id.slice(0, at).split("/").pop()})`;
}

/**
 * The strip above a shape's page: its neighbours in this picture — what it imports or calls (→) and what imports or
 * calls it (←) — as chips. A click picks the neighbour here (sideways, the same picture); Shift+click opens the
 * neighbour's own view (sideways, the same kind of picture for another subject). The ← → keys do the same walk.
 * Then its neighbours beyond the picture's depth (`beyond`), dashed: before it (◂) and after it (▸); a click opens
 * the neighbour's own picture, Shift+click everything joined to it.
 */
function renderNeighbours(node: Shape | null): void {
  const strip = element<HTMLDivElement>("neighbours");
  strip.replaceChildren();
  strip.className = "line-strip neighbours";
  const out = node ? neighbourLines(node.id, "out") : [];
  const into = node ? neighbourLines(node.id, "into") : [];
  const beyond = node?.beyond;
  strip.hidden = out.length === 0 && into.length === 0 && beyond === undefined;

  if (strip.hidden) return;

  const chip = (id: string, arrow: string): HTMLButtonElement =>
    h(
      "button",
      {
        title: `${arrow === "→" ? "imported or called by this shape" : "imports or calls this shape"}: click picks it here, Shift+click opens its own view, ← → walk the neighbours`,
        on: {
          click: (event) => {
            if (!event.shiftKey) return pickShape(id);
            const shape = page.nodes().get(id);
            const own = shape ? opensView(shape) : null;

            if (own) setLink({ ...currentLink(), view: own });
          },
        },
      },
      `${arrow} ${labelOf(id)}`,
    );

  if (into.length > 0) strip.append(h("span", { class: "muted" }, `${into.length} in:`), ...into.slice(0, 12).map((edge) => chip(edge.from, "←")));

  if (out.length > 0) strip.append(h("span", { class: "muted" }, `${out.length} out:`), ...out.slice(0, 12).map((edge) => chip(edge.to, "→")));

  if (!beyond) return;
  // A neighbour the picture does not draw opens its own picture: a function its calls, a module (or a module's top level) its dependencies.
  const outside = (id: string, side: "before" | "after"): HTMLButtonElement =>
    h(
      "button",
      {
        class: "beyond",
        title: `${id}: ${side === "before" ? "imports or calls this shape" : "imported or called by this shape"} beyond this picture — click opens its own picture, Shift+click everything joined to it`,
        on: { click: (event) => setLink({ ...currentLink(), view: event.shiftKey ? `focus:${id}` : id.includes("#") ? `calls:${id}` : `module:${id}` }) },
      },
      side === "before" ? `◂ ${outsideLabel(id)}` : `${outsideLabel(id)} ▸`,
    );

  for (const side of ["before", "after"] as const) {
    const { count, ids } = beyond[side];

    if (count === 0) continue;
    strip.append(h("span", { class: "muted", title: "Past the depth of this picture: the next step of depth, or the shape's focus view, draws them" }, side === "before" ? `beyond ◂ ${count}:` : `beyond ${count} ▸:`), ...ids.slice(0, 8).map((id) => outside(id, side)));

    if (count > Math.min(8, ids.length)) strip.append(h("span", { class: "muted" }, `+${count - Math.min(8, ids.length)} more (the Markdown lists them)`));
  }
}

/** Picks a shape as a tap would: centred, lit, its page shown; the start of the next chain or arrow-key walk. */
export function pickShape(id: string): void {
  if (!page.nodes().has(id)) return;
  select([id], true);
}

// ── The selection: several shapes at once ────────────────────────────────────

/** The strip under the tabs: the selected shapes as chips, and what to do with them together. */
function renderSelection(): void {
  const strip = element<HTMLDivElement>("selection");
  strip.replaceChildren();
  strip.className = "line-strip";
  strip.hidden = selected.length < 2;

  if (strip.hidden) return;
  strip.append(h("span", { class: "muted" }, `${selected.length} selected:`));

  for (const id of selected) strip.append(h("button", { class: "chip", title: "Centre on it; Shift+click takes it out of the selection", on: { click: (event) => (event.shiftKey ? toggleSelected(id) : page.canvas()?.centreOn(id)) } }, labelOf(id)));
  strip.append(
    h("button", { class: "act", title: "Ask the agent about the selected shapes (the Chat tab): their code and calls go along as context", on: { click: () => askSelected() } }, "ask about them"),
    h("button", { class: "act", title: "Dim everything but the selected shapes and their neighbours", on: { click: () => page.canvas()?.dim([...new Set(selected.flatMap((id) => neighbourhoodOf(page.edges(), id)))]) } }, "dim others"),
    h("button", { class: "act", title: "Clear the selection (Esc)", on: { click: () => select([]) } }, "clear"),
  );
}

/**
 * Selects shapes: one is picked (its page, its neighbours), two light the
 * shortest chain of lines between them, more list themselves with the lines among
 * them; an empty list clears everything back to the picture's page.
 */
export function select(ids: string[], centre = false): void {
  selected = ids.filter((id) => page.nodes().has(id));
  page.canvas()?.highlight(selected);
  renderSelection();

  if (selected.length === 1) {
    picked = selected[0]!;

    if (centre) page.canvas()?.centreOn(picked);
    void showNode(picked);
  } else if (selected.length === 2) showChain(selected[0]!, selected[1]!);
  else if (selected.length > 2) showSelection();
  else {
    // Nothing picked: nothing to dim around either.
    page.canvas()?.dim(null);
    void showNode(null);
  }
}

/** A new picture, or a new pick: nothing selected yet, and no neighbours of a shape shown (the page is the caller's to show). */
export function resetSelection(): void {
  selected = [];
  renderSelection();
  renderNeighbours(null);
}

export function toggleSelected(id: string): void {
  if (!page.nodes().has(id)) return;
  select(selected.includes(id) ? selected.filter((each) => each !== id) : [...selected, id]);
}

/** The page of several selected shapes: what each is, and the lines among them in this picture. */
function showSelection(): void {
  const nodes = page.nodes();
  const lines = [
    `# ${selected.length} shapes selected`,
    "",
    ...selected.map((id) => {
      const node = nodes.get(id)!;

      return `- **${labelOf(id)}** (${node.kind})${node.ref?.file ? ` — \`${node.ref.file}${node.ref.line ? `:${node.ref.line}` : ""}\`` : ""}`;
    }),
  ];
  const among = page.edges().filter((edge) => selected.includes(edge.from) && selected.includes(edge.to) && edge.kind !== "lifeline");
  lines.push("", `## Lines among them (${among.length})`, "", ...(among.length === 0 ? ["none in this picture"] : among.map((edge) => `- ${labelOf(edge.from)} → **${labelOf(edge.to)}**${edge.kind === "dependency" ? "" : ` (${edge.kind})`}`)), "", "_Shift+tap or Ctrl+tap adds or removes a shape; **ask about them** sends them to the agent; **dim others** keeps their neighbourhood._");
  setMarkdown(markdownPanel, `${lines.join("\n")}\n`);
  showTab("markdown");
  renderNeighbours(null);
}

/** The question box of the Chat tab with the shapes attached: the selection, else the picked shape, else the picture alone. */
export function askSelected(ids: readonly string[] = selected.length > 0 ? selected : picked ? [picked] : []): void {
  const nodes = page.nodes();
  askAbout(ids.map((id) => nodes.get(id)).filter((node): node is Shape => node !== undefined).map(tagOf).filter((tag): tag is { tag: string; label: string } => tag !== null));
}

// ── Chains ───────────────────────────────────────────────────────────────────

/** Lights the shortest chain of lines between two shapes and writes it to the Markdown panel. */
function showChain(from: string, to: string): void {
  const edges = page.edges();
  const directed = chainBetween(edges, from, to, true);
  const chain = directed ?? chainBetween(edges, from, to, false);
  const title = `# Chain: ${labelOf(from)} → ${labelOf(to)}`;

  if (!chain) {
    page.canvas()?.highlight([from, to]);
    setMarkdown(markdownPanel, `${title}\n\nNo chain of lines joins them in this picture, in either direction.\n`);
    showTab("markdown");

    return;
  }

  const ids = new Set([from, to]);

  for (const step of chain) {
    ids.add(lineElementId(step.edge, step.index));
    ids.add(step.edge.from);
    ids.add(step.edge.to);
  }

  page.canvas()?.highlight([...ids]);
  const lines = [title, "", `${chain.length} ${chain.length === 1 ? "line" : "lines"}${directed ? "" : ", read against the arrows where needed"}:`, ""];

  for (const [i, step] of chain.entries()) lines.push(`${i + 1}. ${labelOf(step.edge.from)} → **${labelOf(step.edge.to)}**${step.edge.kind === "dependency" ? "" : ` (${step.edge.kind})`}`);
  setMarkdown(markdownPanel, `${lines.join("\n")}\n`);
  showTab("markdown");
}

/** Where a shape's code is, as a `file:line` code span for a page; empty for a shape without code. */
function codeSpanOf(id: string): string {
  const ref = page.nodes().get(id)?.ref;

  return ref?.file ? ` — \`${ref.file}${ref.line ? `:${ref.line}` : ""}\`` : "";
}

/**
 * The page of tapped lines: the nearest line's page, a strip to pick another of the bundle when several ran under
 * the tap, and `follow` to light the chain onward from the line (Shift+tap does the same) with the shapes it reaches.
 */
export async function showEdge(lines: PickedLine[], follow: boolean): Promise<void> {
  const state = currentLink();
  const line = lines[0]!;
  const chain = follow ? chainFrom(page.edges(), line) : null;
  page.canvas()?.highlight(chain ? [...chain.lineIds, ...chain.nodeIds] : [...new Set(lines.flatMap((each) => [each.id, each.from, each.to]))]);
  let markdown: string;

  try {
    markdown = (await api.line(state.view, line.from, line.to, line.kind, state, refsOf(state))).markdown;
  } catch (error) {
    markdown = error instanceof Error ? error.message : String(error);
  }

  if (chain) {
    const reached = chain.nodeIds.slice(2);
    markdown += `\n## Chain onward (${chain.hops.length} lines, ${reached.length} shapes)\n\n`;
    markdown += chain.hops.length === 0 ? "Nothing leads on from here in this view.\n" : chain.hops.map((hop) => `- ${"  ".repeat(hop.depth - 1)}${labelOf(hop.edge.from)} → **${labelOf(hop.edge.to)}**${hop.edge.kind === "dependency" ? "" : ` (${hop.edge.kind})`}${codeSpanOf(hop.edge.to)}`).join("\n");

    if (chain.lineIds.length >= 300) markdown += "\n- … cut at 300 lines";
    markdown += "\n";
  }

  setMarkdown(markdownPanel, markdown);

  // The strip above the page: the bundle under the tap and the follow switch.
  const strip = h("div", { class: "line-strip" });

  if (lines.length > 1) {
    strip.append(h("span", { class: "muted" }, `${lines.length} lines under the tap:`));

    for (const each of lines) {
      const button = h("button", { title: `Show this line (${each.kind})`, on: { click: () => void showEdge([each, ...lines.filter((other) => other.id !== each.id)], false) } }, `${labelOf(each.from)} → ${labelOf(each.to)}`);
      button.classList.toggle("active", each.id === line.id);
      strip.append(button);
    }
  }

  const followButton = h("button", { title: follow ? "Light only this line again" : "Light every line and shape the arrows lead on to from here (Shift+tap does the same)", on: { click: () => void showEdge(lines, !follow) } }, follow ? "stop following" : "follow →");
  followButton.classList.toggle("active", follow);
  strip.append(followButton);
  markdownPanel.prepend(strip);
  showTab("markdown");
}

// ── The walk with the arrow keys ─────────────────────────────────────────────

/** The next shape along the arrows from the picked one (→), against them (←), or beside it in its lane (↑ ↓); cycles on repeated presses. */
export function walk(direction: "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown"): void {
  const nodes = page.nodes();
  const current = picked === null ? undefined : nodes.get(picked);

  if (!current) return;
  let candidates: string[];

  if (direction === "ArrowRight") candidates = neighbourLines(current.id, "out").map((edge) => edge.to);
  else if (direction === "ArrowLeft") candidates = neighbourLines(current.id, "into").map((edge) => edge.from);
  else {
    // Up and down: the shapes of the same lane, by their place from the top; the next below or above.
    const lane = [...nodes.values()].filter((node) => node.group === current.group && node.kind !== "anchor").sort((a, b) => a.y - b.y || a.x - b.x);
    const at = lane.findIndex((node) => node.id === current.id);
    candidates = at === -1 ? [] : [lane[(at + (direction === "ArrowDown" ? 1 : lane.length - 1)) % lane.length]!.id];
  }

  if (candidates.length === 0) return;
  // Along the arrows: repeated presses cycle through the neighbours.
  const previous = walked.direction === direction && walked.from === current.id ? walked.index + 1 : 0;
  const next = candidates[previous % candidates.length]!;
  walked = { direction, from: current.id, index: previous };
  pickShape(next);
  // Picking moved the start; keep the cycle anchored at where the walk began.
  walked.from = next;
}

// ── The taps the canvas reports ──────────────────────────────────────────────

/**
 * A tap on the canvas: on lines, their page (Shift: the chain onward); with Shift or Ctrl on a shape, the shape joins
 * the selection or leaves it; with the mix tool on a module, the module opens in place (or closes); else the shape is
 * picked (the dim tool fades all but its neighbours) and a tap on nothing clears the pick. A tap without Shift or
 * Ctrl starts a new pick: the last one's selection and lights go, and a dim the dim tool does not keep.
 */
export function tap(id: string | null, lines?: PickedLine[], extend?: boolean): void {
  closeMenu();

  if (!extend) {
    resetSelection();

    if (!tools.dim) page.canvas()?.dim(null);
  }

  if (lines && lines.length > 0) {
    void showEdge(lines, extend === true);

    return;
  }

  const node = id === null ? undefined : page.nodes().get(id);

  // Shift or Ctrl held: a tap on nothing changes nothing.
  if (extend) {
    if (node) toggleSelected(node.id);

    return;
  }

  page.canvas()?.highlight([]);

  if (node) picked = node.id;

  if (tools.mix && node && (node.kind === "module" || node.kind === "participant")) {
    const module = standsFor(node);
    const now = currentLink();
    setLink({ ...now, expand: now.expand.includes(module) ? now.expand.filter((each) => each !== module) : [...now.expand, module] });

    return;
  }

  if (tools.dim) page.canvas()?.dim(node ? neighbourhoodOf(page.edges(), node.id) : null);
  select(node ? [node.id] : []);
}

/**
 * The view a second tap on a shape opens: its own (as the export wrote it into the scene), a shape of an older drawing
 * by its link; the function a call tree starts from, whose own view is the picture already, its logic. Null when the
 * shape opens nothing, or nothing but the picture shown.
 */
export function deeperView(id: string, link: string | null = null): string | null {
  const node = page.nodes().get(id);
  const key = node ? opensView(node) : link?.startsWith(VIEW_LINK) ? decodeURIComponent(link.slice(VIEW_LINK.length)) : null;
  const now = currentLink().view;

  if (key === now && node?.kind === "fn" && standsFor(node).includes("#")) return `logic:${standsFor(node)}`;

  return key === now ? null : key;
}

/** A double tap on a shape, or Enter on the picked one: the view it opens; one that opens nothing says so rather than doing nothing. Reading only. */
export function openShape(id: string, link: string | null = null): void {
  if (page.mode() !== "view") return;
  const key = deeperView(id, link);

  if (key) setLink({ ...currentLink(), view: key });
  else notice(`${labelOf(id)}: nothing opens from this shape — a tap shows it on the right, a right click lists its other pictures`);
}
