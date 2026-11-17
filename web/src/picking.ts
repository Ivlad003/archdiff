// What a tap on the canvas picks and what the page shows for it: a
// shape's page with its neighbours as chips, a line's page with the
// chain onward, a selection of several shapes (two light the chain
// between them), the walk along the arrows with the keys, and the two
// tools that change what a tap does — mix opens a module in place, dim
// fades all but a shape's neighbours. The canvas reports the taps
// (app.ts hands `tap` and `openShape` to it); the shapes and lines are
// the current picture's, read through the page.
//
// A shape picked under the open drawer of the details (layout.ts) is moved
// clear of it with its picture, which goes back when the drawer does.
//
// Entry points: `tap`, `openShape`, `select`, `toggleSelected`,
// `pickShape`, `askSelected`, `explainSelected`, `showPath`, `showEdge`, `walk`, `resetSelection`,
// `givePlaceBack`, `selection`, `lastPicked`, `tools`, `labelOf`.

import { api, type Shape } from "./api.ts";
import { loading } from "./busy.ts";
import { chainBetween, chainFrom, neighbourhoodOf } from "./chains.ts";
import { askAbout, explain } from "./chat.ts";
import { h, element } from "./dom.ts";
import { VIEW_LINK, type PickedLine } from "./editor.tsx";
import { hosted } from "./host.ts";
import { t } from "./i18n.ts";
import { detailsCover, onDetailsClosed, releaseDetails, revealDetails } from "./layout.ts";
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

/** The pages asked for (a shape's, a line's): a page that comes after a newer pick is dropped, so the panel is the last pick's. */
let pageLoads = 0;

/** Another page takes the Markdown tab now (a chain, a selection, a new picture): one still being read is dropped when it comes. */
function dropPageLoad(): void {
  pageLoads++;
  loading(markdownPanel, false);
}

/**
 * The page of a shape (as the server writes it for the picture shown), its neighbours and its code; null: the
 * picture's page. What the picture itself knows is shown at the press — the neighbours' strip, and the tab the pick
 * is read on in front: the Code tab for a shape of a file, the Markdown tab for one of none — and the page and the
 * code are read side by side, each dimmed until it lands. Nothing moves a second time when the answers come.
 */
async function showNode(id: string | null, front = true): Promise<void> {
  const mine = ++pageLoads;
  const state = currentLink();
  const node = id === null ? null : page.nodes().get(id);

  if (!node) {
    loading(markdownPanel, false);
    showPicturePage();
    renderNeighbours(null);

    return;
  }

  renderNeighbours(node);
  const code = showCode(node, front);

  // A shape of no file is read on its page; so is every shape in an editor, which opens the code itself.
  if (front && (!node.ref?.file || hosted)) showTab("markdown");
  loading(markdownPanel, true);
  let markdown: string;

  try {
    markdown = (await api.shape(state.view, node.id, state, refsOf(state))).markdown;
  } catch (error) {
    markdown = error instanceof Error ? error.message : String(error);
  }

  if (mine !== pageLoads) return;

  // A review: the commits that touched the shape's file (a module's page says what the change did to it, another
  // shape its mark). A comparison's module page says what each head did; the history here is the checkout's, not theirs.
  const file = node.ref?.file;

  if (state.view === "review" && file) {
    try {
      const { commits } = await api.fileHistory(file);
      markdown += `${node.kind === "module" ? "" : `\n\n${t("_{mark} in this change._", { mark: node.diff ?? "context" })}`}${commits.length > 0 ? `\n\n${t("## Commits that touched it")}\n\n${commits.map((commit) => `- \`${commit.short}\` ${commit.date} ${commit.author}: ${commit.subject}`).join("\n")}` : ""}\n`;
    } catch {
      // Outside git: the shape's page alone.
    }

    if (mine !== pageLoads) return;
  }

  setMarkdown(markdownPanel, markdown);
  loading(markdownPanel, false);
  await code;
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
        title: arrow === "→" ? t("imported or called by this shape: click picks it here, Shift+click opens its own view, ← → walk the neighbours") : t("imports or calls this shape: click picks it here, Shift+click opens its own view, ← → walk the neighbours"),
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

  if (into.length > 0) strip.append(h("span", { class: "muted" }, t("{count} in:", { count: into.length })), ...into.slice(0, 12).map((edge) => chip(edge.from, "←")));

  if (out.length > 0) strip.append(h("span", { class: "muted" }, t("{count} out:", { count: out.length })), ...out.slice(0, 12).map((edge) => chip(edge.to, "→")));

  if (!beyond) return;
  // A neighbour the picture does not draw opens its own picture: a function its calls, a module (or a module's top level) its dependencies.
  const outside = (id: string, side: "before" | "after"): HTMLButtonElement =>
    h(
      "button",
      {
        class: "beyond",
        title: side === "before" ? t("{id}: imports or calls this shape beyond this picture — click opens its own picture, Shift+click everything joined to it", { id }) : t("{id}: imported or called by this shape beyond this picture — click opens its own picture, Shift+click everything joined to it", { id }),
        on: { click: (event) => setLink({ ...currentLink(), view: event.shiftKey ? `focus:${id}` : id.includes("#") ? `calls:${id}` : `module:${id}` }) },
      },
      side === "before" ? `◂ ${outsideLabel(id)}` : `${outsideLabel(id)} ▸`,
    );

  for (const side of ["before", "after"] as const) {
    const { count, ids } = beyond[side];

    if (count === 0) continue;
    strip.append(h("span", { class: "muted", title: t("Past the depth of this picture: the next step of depth, or the shape's focus view, draws them") }, side === "before" ? t("beyond ◂ {count}:", { count }) : t("beyond {count} ▸:", { count })), ...ids.slice(0, 8).map((id) => outside(id, side)));

    if (count > Math.min(8, ids.length)) strip.append(h("span", { class: "muted" }, t("+{count} more (the Markdown lists them)", { count: count - Math.min(8, ids.length) })));
  }
}

/** Picks a shape as a tap would: centred, lit, its page shown; the start of the next chain or arrow-key walk. */
export function pickShape(id: string): void {
  if (!page.nodes().has(id)) return;
  select([id], true);
}

// ── A pick under the details' drawer ─────────────────────────────────────────

/** The room left between a picked shape and the edge of what the drawer leaves of the canvas, in screen pixels. */
const DRAWER_GAP = 24;

/** How far the picture was moved for the picks under the drawer (scene units), and where that left it: to give back. */
let movedForDrawer: { by: number; at: number } | null = null;

/**
 * A shape picked where the open drawer of the details covers the canvas is moved clear of it, the picture with it:
 * what is read on the right is seen on the left. Never so far that the shape's own left edge leaves the canvas.
 */
function keepInSight(id: string): void {
  const canvas = page.canvas();
  const cover = detailsCover();
  const at = canvas?.viewport();
  const shape = cover > 0 ? canvas?.scene().find((element) => element.id === id && !element.isDeleted) : undefined;

  if (!canvas || !at || !shape) return;
  const room = canvas.size().width - cover - DRAWER_GAP;
  const left = (shape.x + at.scrollX) * at.zoom;
  const by = Math.min(left + shape.width * at.zoom - room, left - DRAWER_GAP) / at.zoom;

  if (by <= 0) return;
  // A move the reader has not panned away from since carries on; one they have is theirs now.
  const carried = movedForDrawer && Math.abs(at.scrollX - movedForDrawer.at) < 0.5 ? movedForDrawer.by : 0;
  canvas.setViewport({ ...at, scrollX: at.scrollX - by });
  movedForDrawer = { by: carried + by, at: at.scrollX - by };
}

/** The picture back where it was before it moved for the drawer — unless the reader moved it since, or another picture is on the canvas. */
export function givePlaceBack(): void {
  const canvas = page.canvas();
  const at = canvas?.viewport();

  if (movedForDrawer && canvas && at && Math.abs(at.scrollX - movedForDrawer.at) < 0.5) canvas.setViewport({ ...at, scrollX: at.scrollX + movedForDrawer.by });
  movedForDrawer = null;
}

onDetailsClosed(givePlaceBack);

// ── The selection: several shapes at once ────────────────────────────────────

/** The strip under the tabs: the selected shapes as chips, and what to do with them together. */
function renderSelection(): void {
  const strip = element<HTMLDivElement>("selection");
  strip.replaceChildren();
  strip.className = "line-strip";
  strip.hidden = selected.length < 2;

  if (strip.hidden) return;
  strip.append(h("span", { class: "muted" }, t("{count} selected:", { count: selected.length })));

  for (const id of selected) strip.append(h("button", { class: "chip", title: t("Centre on it; Shift+click takes it out of the selection"), on: { click: (event) => (event.shiftKey ? toggleSelected(id) : page.canvas()?.centreOn(id)) } }, labelOf(id)));
  strip.append(
    h("button", { class: "act", title: t("Ask the agent about the selected shapes (the Chat tab): their code and calls go along as context"), on: { click: () => askSelected() } }, t("ask about them")),
    h("button", { class: "act", title: t("Have the agent explain the selected shapes as a tour: steps through the pictures, each with what it shows and why"), on: { click: () => explainSelected() } }, t("explain")),
    h("button", { class: "act", title: t("Dim everything but the selected shapes and their neighbours"), on: { click: () => page.canvas()?.dim([...new Set(selected.flatMap((id) => neighbourhoodOf(page.edges(), id)))]) } }, t("dim others")),
    h("button", { class: "act", title: t("Clear the selection (Esc)"), on: { click: () => select([]) } }, t("clear")),
  );
}

/**
 * Selects shapes: one is picked (its page, its neighbours), two light the
 * shortest chain of lines between them, more list themselves with the lines among
 * them; an empty list clears everything back to the picture's page. The page
 * of what is selected comes to the front, unless `front` is false: a command
 * of the Chat tab fills it behind the transcript, which the reader keeps.
 */
export function select(ids: string[], centre = false, front = true): void {
  selected = ids.filter((id) => page.nodes().has(id));
  page.canvas()?.highlight(selected);
  renderSelection();

  // What is picked is read on the right: a drawer opens for it, and goes when nothing is picked any more.
  if (selected.length > 0) revealDetails();
  else releaseDetails();

  if (selected.length === 1) {
    picked = selected[0]!;

    if (centre) page.canvas()?.centreOn(picked);
    keepInSight(picked);
    void showNode(picked, front);
  } else if (selected.length === 2) showChain(selected[0]!, selected[1]!, front);
  else if (selected.length > 2) showSelection(front);
  else {
    // Nothing picked: nothing to dim around either.
    page.canvas()?.dim(null);
    void showNode(null);
  }
}

/** A new picture, or a new pick: nothing selected yet, and no neighbours of a shape shown (the page is the caller's to show). */
export function resetSelection(): void {
  dropPageLoad();
  selected = [];
  // The arrow keys walk from a shape of this picture, never from one the last picture had.
  picked = null;
  renderSelection();
  renderNeighbours(null);
}

export function toggleSelected(id: string): void {
  if (!page.nodes().has(id)) return;
  select(selected.includes(id) ? selected.filter((each) => each !== id) : [...selected, id]);
}

/** The page of several selected shapes: what each is, and the lines among them in this picture. */
function showSelection(front = true): void {
  dropPageLoad();
  const nodes = page.nodes();
  const lines = [
    t("# {count} shapes selected", { count: selected.length }),
    "",
    ...selected.map((id) => {
      const node = nodes.get(id)!;

      return `- **${labelOf(id)}** (${node.kind})${node.ref?.file ? ` — \`${node.ref.file}${node.ref.line ? `:${node.ref.line}` : ""}\`` : ""}`;
    }),
  ];
  const among = page.edges().filter((edge) => selected.includes(edge.from) && selected.includes(edge.to) && edge.kind !== "lifeline");
  lines.push("", t("## Lines among them ({count})", { count: among.length }), "", ...(among.length === 0 ? [t("none in this picture")] : among.map((edge) => `- ${labelOf(edge.from)} → **${labelOf(edge.to)}**${edge.kind === "dependency" ? "" : ` (${edge.kind})`}`)), "", t("_Shift+tap or Ctrl+tap adds or removes a shape; **ask about them** sends them to the agent; **dim others** keeps their neighbourhood._"));
  setMarkdown(markdownPanel, `${lines.join("\n")}\n`);

  if (front) showTab("markdown");
  renderNeighbours(null);
}

/** The question box of the Chat tab with the shapes attached: the selection, else the picked shape, else the picture alone. */
export function askSelected(ids: readonly string[] = selected.length > 0 ? selected : picked ? [picked] : []): void {
  const nodes = page.nodes();
  askAbout(ids.map((id) => nodes.get(id)).filter((node): node is Shape => node !== undefined).map(tagOf).filter((tag): tag is { tag: string; label: string } => tag !== null));
}

/** Has the agent explain the shapes — the selection, else the picked shape, else the picture alone — or what `words` name, as a tour the page plays (chat.ts). */
export function explainSelected(ids: readonly string[] = selected.length > 0 ? selected : picked ? [picked] : [], words = ""): void {
  const nodes = page.nodes();
  explain(ids.map((id) => nodes.get(id)).filter((node): node is Shape => node !== undefined).map(tagOf).filter((tag): tag is { tag: string; label: string } => tag !== null), words);
}

// ── Chains ───────────────────────────────────────────────────────────────────

/**
 * A way through shapes in the order given — a step of a tour, the `/path` command: the shortest chain of lines from
 * each to the next is lit (with the arrows where it can be, against them where it must), and the Markdown panel lists
 * the lines walked. Fewer than two shapes of the picture are a selection. The tab in front stays where it is: a way is
 * asked for from the Chat tab or shown under a tour's note.
 */
export function showPath(ids: readonly string[]): void {
  const on = ids.filter((id) => page.nodes().has(id));

  if (on.length < 2) return select([...on], true, false);
  dropPageLoad();
  selected = [...on];
  renderSelection();
  revealDetails();
  const edges = page.edges();
  const lit = new Set<string>(on);
  const lines = [t("# Path: {shapes}", { shapes: on.map(labelOf).join(" → ") }), ""];
  let walked = 0;

  for (let i = 0; i + 1 < on.length; i++) {
    const chain = chainBetween(edges, on[i]!, on[i + 1]!, true) ?? chainBetween(edges, on[i]!, on[i + 1]!, false);

    if (!chain) {
      lines.push(t("- no chain of lines joins {from} and {to} in this picture", { from: labelOf(on[i]!), to: labelOf(on[i + 1]!) }));
      continue;
    }

    for (const step of chain) {
      lit.add(lineElementId(edges, step.index));
      lit.add(step.edge.from);
      lit.add(step.edge.to);
      lines.push(`${++walked}. ${labelOf(step.edge.from)} → **${labelOf(step.edge.to)}**${step.edge.kind === "dependency" ? "" : ` (${step.edge.kind})`}`);
    }
  }

  page.canvas()?.highlight([...lit]);
  setMarkdown(markdownPanel, `${lines.join("\n")}\n`);
  renderNeighbours(null);
}

/** Lights the shortest chain of lines between two shapes and writes it to the Markdown panel. */
function showChain(from: string, to: string, front = true): void {
  dropPageLoad();
  const edges = page.edges();
  const directed = chainBetween(edges, from, to, true);
  const chain = directed ?? chainBetween(edges, from, to, false);
  const title = t("# Chain: {from} → {to}", { from: labelOf(from), to: labelOf(to) });

  if (!chain) {
    page.canvas()?.highlight([from, to]);
    setMarkdown(markdownPanel, `${title}\n\n${t("No chain of lines joins them in this picture, in either direction.")}\n`);

    if (front) showTab("markdown");

    return;
  }

  const ids = new Set([from, to]);

  for (const step of chain) {
    ids.add(lineElementId(page.edges(), step.index));
    ids.add(step.edge.from);
    ids.add(step.edge.to);
  }

  page.canvas()?.highlight([...ids]);
  const lines = [title, "", `${chain.length === 1 ? t("{count} line", { count: chain.length }) : t("{count} lines", { count: chain.length })}${directed ? "" : t(", read against the arrows where needed")}:`, ""];

  for (const [i, step] of chain.entries()) lines.push(`${i + 1}. ${labelOf(step.edge.from)} → **${labelOf(step.edge.to)}**${step.edge.kind === "dependency" ? "" : ` (${step.edge.kind})`}`);
  setMarkdown(markdownPanel, `${lines.join("\n")}\n`);

  if (front) showTab("markdown");
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
  revealDetails();
  page.canvas()?.highlight(chain ? [...chain.lineIds, ...chain.nodeIds] : [...new Set(lines.flatMap((each) => [each.id, each.from, each.to]))]);
  // A line is read on its page: the tab comes at the press, dimmed until the page lands; a pick made meanwhile takes it.
  const mine = ++pageLoads;
  showTab("markdown");
  loading(markdownPanel, true);
  let markdown: string;

  try {
    markdown = (await api.line(state.view, line.from, line.to, line.kind, state, refsOf(state))).markdown;
  } catch (error) {
    markdown = error instanceof Error ? error.message : String(error);
  }

  if (mine !== pageLoads) return;
  loading(markdownPanel, false);

  if (chain) {
    const reached = chain.nodeIds.slice(2);
    markdown += `\n${t("## Chain onward ({lines} lines, {shapes} shapes)", { lines: chain.hops.length, shapes: reached.length })}\n\n`;
    markdown += chain.hops.length === 0 ? `${t("Nothing leads on from here in this view.")}\n` : chain.hops.map((hop) => `- ${"  ".repeat(hop.depth - 1)}${labelOf(hop.edge.from)} → **${labelOf(hop.edge.to)}**${hop.edge.kind === "dependency" ? "" : ` (${hop.edge.kind})`}${codeSpanOf(hop.edge.to)}`).join("\n");

    if (chain.lineIds.length >= 300) markdown += `\n${t("- … cut at 300 lines")}`;
    markdown += "\n";
  }

  setMarkdown(markdownPanel, markdown);

  // The strip above the page: the bundle under the tap and the follow switch.
  const strip = h("div", { class: "line-strip" });

  if (lines.length > 1) {
    strip.append(h("span", { class: "muted" }, t("{count} lines under the tap:", { count: lines.length })));

    for (const each of lines) {
      const button = h("button", { title: t("Show this line ({kind})", { kind: each.kind }), on: { click: () => void showEdge([each, ...lines.filter((other) => other.id !== each.id)], false) } }, `${labelOf(each.from)} → ${labelOf(each.to)}`);
      button.classList.toggle("active", each.id === line.id);
      strip.append(button);
    }
  }

  const followButton = h("button", { title: follow ? t("Light only this line again") : t("Light every line and shape the arrows lead on to from here (Shift+tap does the same)"), on: { click: () => void showEdge(lines, !follow) } }, follow ? t("stop following") : t("follow →"));
  followButton.classList.toggle("active", follow);
  strip.append(followButton);
  markdownPanel.prepend(strip);
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
  else notice(t("{shape}: nothing opens from this shape — a tap shows it on the right, a right click lists its other pictures", { shape: labelOf(id) }));
}
