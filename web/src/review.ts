// The review: the base and head fields of the header with the review
// button, and the bar of the branches under the title (a base and any
// number of heads to compare: the heads a list to search, the ticked ones
// chips in the bar); the commits of a range to step through are
// commits.ts's. The base field is the link's base (link.ts reads it). The
// head field is the code the page shows, for every picture: a branch, a
// tag or a commit (the branches offered as it is typed, [ and ] step
// through them), the working tree when empty.
//
// Entry points: `showReviewBars`, `loadBranches`, `loadHeadRefs`,
// `stepHead`, `reviewBase`.

import { api, type Branch } from "./api.ts";
import { leaveEdit } from "./canvas.ts";
import { element, h } from "./dom.ts";
import { t } from "./i18n.ts";
import { reviewing, setLink, currentLink, type Link } from "./link.ts";

const baseInput = element<HTMLInputElement>("base");
const headInput = element<HTMLInputElement>("head");

/** The base and head fields as the link has them; the branches bar for a review or a comparison. */
export function showReviewBars(state: Link): void {
  // The base is the link's: a link without one is reviewed from the default base, whatever the field held before.
  baseInput.value = new URLSearchParams(location.hash.slice(1)).get("base") ?? "";
  headInput.value = state.head ?? "";
  element("branches").hidden = !reviewing(state.view);
}

element<HTMLButtonElement>("review").addEventListener("click", () => {
  if (leaveEdit()) setLink({ ...currentLink(), view: "review", head: headInput.value.trim() || null, heads: [] });
});
baseInput.addEventListener("change", () => {
  if (reviewing(currentLink().view)) setLink(currentLink());
});

// The head is the code of every picture: a change of it draws the same view at the other revision.
headInput.addEventListener("change", () => setLink({ ...currentLink(), head: headInput.value.trim() || null }));

/** The branches the head field offers, the working tree first (an empty head), local before remote. */
let headRefs: string[] = [""];
/** The branch a review starts from when the base field is empty: develop, main or master, as the server found it. */
let defaultBase: string | null = null;

/** The base of a review and of the branches' picture: the base field, else the repository's default base branch. */
export function reviewBase(): string | null {
  return baseInput.value.trim() || defaultBase;
}

/** Offers the branches in the head field; outside git, none (the field still takes a ref typed). */
export async function loadHeadRefs(): Promise<void> {
  try {
    const { branches, current, base } = await api.branches();
    defaultBase = base;
    headRefs = ["", ...branches.map((branch) => branch.name)];
    element("head-refs").replaceChildren(...branches.map((branch) => Object.assign(document.createElement("option"), { value: branch.name, label: `${branch.name}${branch.name === current ? ` (${t("checked out")})` : ""}${branch.remote ? ` (${t("remote")})` : ""} — ${branch.subject}` })));
  } catch {
    headRefs = [""];
  }
}

/** The next or the previous branch as the head ([ and ]), the working tree among them; the same view drawn at it. */
export function stepHead(step: 1 | -1): void {
  if (headRefs.length < 2) return;
  const now = currentLink();
  const at = Math.max(0, headRefs.indexOf(now.head ?? ""));
  const next = headRefs[(at + step + headRefs.length) % headRefs.length]!;
  setLink({ ...now, head: next || null });
}

// ── The branches: a base and any number of heads to compare ────────────────
//
// A repository may have a hundred branches: the heads are a list under a button, one row a branch (its name, whether
// it is a remote one, the day and the subject of its last commit), cut as the reader types; the ticked ones stand
// in the bar as chips, so what is compared is in sight with the list closed.

/** The working tree among the heads, by the value its box has. */
const WORKTREE = "WORKTREE";

const headList = element<HTMLDivElement>("head-list");
const headFilter = element<HTMLInputElement>("head-filter");
const headsMenu = element<HTMLDetailsElement>("heads-menu");

/** The branches the list was drawn from, as one text: a branch made or moved since is drawn on the next load. */
let listedBranches: string | null = null;
/** What the working tree is called in the bar (its branch beside it). */
let worktreeLabel = t("working tree");

function headBoxes(): HTMLInputElement[] {
  return [...headList.querySelectorAll<HTMLInputElement>("input")];
}

/** The ticked heads as chips in the bar, and the count under the list: how many rows the filter leaves, how many are ticked. */
function showTicked(): void {
  const ticked = headBoxes().filter((box) => box.checked);
  const chips = element<HTMLSpanElement>("head-chips");
  const SHOWN = 6;
  chips.replaceChildren(
    ...ticked.slice(0, SHOWN).map((box) =>
      h("button", { class: "chip", title: t("{head}: press to untick it", { head: box.value === WORKTREE ? worktreeLabel : box.value }), on: { click: () => {
        box.checked = false;
        showTicked();
      } } }, box.value === WORKTREE ? worktreeLabel : box.value, h("span", { class: "x" }, "×")),
    ),
    ...(ticked.length > SHOWN ? [h("span", { class: "muted" }, t("+{count} more", { count: ticked.length - SHOWN }))] : []),
    ...(ticked.length === 0 ? [h("span", { class: "muted" }, t("none ticked"))] : []),
  );
  const rows = [...headList.querySelectorAll<HTMLElement>(".head-row")];
  const shown = rows.filter((row) => !row.hidden).length;
  element("head-count").textContent = `${shown === rows.length ? t("{count} heads", { count: rows.length }) : t("{shown} of {count} heads", { shown, count: rows.length })} · ${t("{count} ticked", { count: ticked.length })}`;
}

/** The rows the words typed leave: every word must be in the branch's name or its last commit's subject. */
function filterHeads(): void {
  const words = headFilter.value.toLowerCase().split(/\s+/).filter(Boolean);

  for (const row of headList.querySelectorAll<HTMLElement>(".head-row")) row.hidden = !words.every((word) => (row.dataset["text"] ?? "").includes(word));
  const none = headList.querySelector<HTMLElement>(".none");

  if (none) none.hidden = headList.querySelector(".head-row:not([hidden])") !== null;
  showTicked();
}

/** One row of the list: the box, the name, what kind of head it is, and the last commit's day and subject. */
function headRow(value: string, name: string, tags: readonly string[], when: string, subject: string, title: string, classes: string): HTMLLabelElement {
  return h(
    "label",
    { class: `head-row ${classes}`.trim(), title, dataset: { text: `${name} ${subject}`.toLowerCase() } },
    h("input", { type: "checkbox", value, on: { change: () => showTicked() } }),
    h("span", { class: "name" }, name),
    ...tags.map((tag) => h("span", { class: "tag" }, tag)),
    h("span", { class: "when muted" }, when),
    h("span", { class: "subject muted" }, subject),
  );
}

export async function loadBranches(state: Link): Promise<void> {
  const note = element<HTMLSpanElement>("compare-note");

  try {
    const result = await api.branches();
    const baseSelect = element<HTMLSelectElement>("base-select");
    const listed = JSON.stringify([result.current, result.base, result.branches.map((branch) => [branch.name, branch.sha])]);

    if (listed !== listedBranches) {
      const option = (branch: Branch): HTMLOptionElement => new Option(branch.name, branch.name);
      const group = (label: string, branches: readonly Branch[]): HTMLOptGroupElement | null => (branches.length === 0 ? null : h("optgroup", { label }, ...branches.map(option)));
      baseSelect.replaceChildren(new Option(result.base ? t("{base} (default)", { base: result.base }) : "merge-base", ""));
      baseSelect.append(...[group(t("local"), result.branches.filter((branch) => !branch.remote)), group(t("remote"), result.branches.filter((branch) => branch.remote))].filter((each): each is HTMLOptGroupElement => each !== null));
      worktreeLabel = `${t("working tree")}${result.current ? ` (${result.current})` : ""}`;
      headList.replaceChildren(
        headRow(WORKTREE, t("working tree"), result.current ? [result.current] : [], "", t("the files as they are now, committed or not"), t("The working tree: the files as they are on the disk now"), "current"),
        ...result.branches.map((branch) => headRow(branch.name, branch.name, [...(branch.current ? [t("checked out")] : []), ...(branch.remote ? [t("remote")] : [])], branch.date, branch.subject, `${branch.sha} ${branch.date} ${branch.subject}`, `${branch.current ? "current" : ""} ${branch.remote ? "remote" : ""}`)),
        h("div", { class: "none muted", hidden: true }, t("no branch has these words")),
      );
      listedBranches = listed;
    }

    baseSelect.value = baseInput.value.trim();
    // The heads of the link: a comparison's, a review's one head, else the working tree.
    const ticked = new Set(state.heads.length > 0 ? state.heads : [state.head ?? WORKTREE]);

    for (const box of headBoxes()) box.checked = ticked.has(box.value);
    filterHeads();
    // The bar says what is compared; how to compare is the hint of its button and of the list — a line of advice here
    // took the bar a second row.
    note.textContent = state.heads.length > 1 ? t("{count} heads against {base}", { count: state.heads.length, base: baseInput.value.trim() || result.base || t("the merge-base") }) : "";
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : String(error);
  }
}

headFilter.addEventListener("input", () => filterHeads());
headFilter.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    // The first branch found is ticked (or unticked) without leaving the field: type, Enter, type the next.
    const first = headList.querySelector<HTMLInputElement>(".head-row:not([hidden]) input");

    if (first) {
      first.checked = !first.checked;
      showTicked();
    }

    event.preventDefault();
  } else if (event.key === "Escape" && headFilter.value !== "") {
    headFilter.value = "";
    filterHeads();
    event.stopPropagation();
  } else if (event.key === "ArrowDown") {
    headList.querySelector<HTMLInputElement>(".head-row:not([hidden]) input")?.focus();
    event.preventDefault();
  }
});
// The list opens with the field ready to type in.
headsMenu.addEventListener("toggle", () => {
  if (headsMenu.open) headFilter.focus();
});

element<HTMLSelectElement>("base-select").addEventListener("change", () => {
  baseInput.value = element<HTMLSelectElement>("base-select").value;
  setLink(currentLink());
});
element<HTMLButtonElement>("compare").addEventListener("click", () => {
  const heads = headBoxes().filter((box) => box.checked).map((box) => box.value);

  if (heads.length === 0) {
    element("compare-note").textContent = t("tick at least one head");

    return;
  }

  headsMenu.open = false;

  // One head that is the working tree is the plain review; one ref its review; two or more a comparison.
  if (heads.length === 1 && heads[0] === WORKTREE) setLink({ ...currentLink(), view: "review", head: null, heads: [] });
  else if (heads.length === 1) setLink({ ...currentLink(), view: "review", head: heads[0]!, heads: [] });
  else setLink({ ...currentLink(), view: "compare", head: null, heads });
});
