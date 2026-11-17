// The review: the base and head fields of the header with the review
// button, and the bar of the branches under the title (a base and any
// number of heads to compare); the commits of a range to step through are
// commits.ts's. The base field is the link's base (link.ts reads it). The
// head field is the code the page shows, for every picture: a branch, a
// tag or a commit (the branches offered as it is typed, [ and ] step
// through them), the working tree when empty.
//
// Entry points: `showReviewBars`, `loadBranches`, `loadHeadRefs`,
// `stepHead`, `reviewBase`.

import { api } from "./api.ts";
import { leaveEdit } from "./canvas.ts";
import { element } from "./dom.ts";
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
    element("head-refs").replaceChildren(...branches.map((branch) => Object.assign(document.createElement("option"), { value: branch.name, label: `${branch.name}${branch.name === current ? " (checked out)" : ""}${branch.remote ? " (remote)" : ""} — ${branch.subject}` })));
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

let branchesLoaded = false;

export async function loadBranches(state: Link): Promise<void> {
  const note = element<HTMLSpanElement>("compare-note");

  try {
    const result = await api.branches();
    const baseSelect = element<HTMLSelectElement>("base-select");
    const list = element<HTMLSpanElement>("head-list");

    if (!branchesLoaded) {
      baseSelect.replaceChildren();
      const own = document.createElement("option");
      own.value = "";
      own.textContent = result.base ? `${result.base} (default)` : "merge-base";
      baseSelect.append(own);

      for (const branch of result.branches) {
        const option = document.createElement("option");
        option.value = branch.name;
        option.textContent = `${branch.name}${branch.remote ? " (remote)" : ""}`;
        baseSelect.append(option);
      }

      list.replaceChildren();
      const worktree = document.createElement("label");
      worktree.className = "current";
      const tick = document.createElement("input");
      tick.type = "checkbox";
      tick.value = "WORKTREE";
      worktree.append(tick, ` working tree${result.current ? ` (${result.current})` : ""}`);
      list.append(worktree);

      for (const branch of result.branches) {
        const label = document.createElement("label");
        label.className = `${branch.current ? "current" : ""} ${branch.remote ? "remote" : ""}`.trim();
        label.title = `${branch.sha} ${branch.date} ${branch.subject}`;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = branch.name;
        label.append(box, ` ${branch.name}`);
        list.append(label);
      }

      branchesLoaded = true;
    }

    baseSelect.value = baseInput.value.trim();
    // The heads of the link: a comparison's, a review's one head, else the working tree.
    const ticked = new Set(state.heads.length > 0 ? state.heads : [state.head ?? "WORKTREE"]);

    for (const box of list.querySelectorAll<HTMLInputElement>("input")) box.checked = ticked.has(box.value);
    note.textContent = state.heads.length > 1 ? `${state.heads.length} heads against ${baseInput.value.trim() || result.base || "the merge-base"}` : "tick two or more heads to compare branches";
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : String(error);
  }
}

element<HTMLSelectElement>("base-select").addEventListener("change", () => {
  baseInput.value = element<HTMLSelectElement>("base-select").value;
  setLink(currentLink());
});
element<HTMLButtonElement>("compare").addEventListener("click", () => {
  const heads = [...element("head-list").querySelectorAll<HTMLInputElement>("input:checked")].map((box) => box.value);

  if (heads.length === 0) {
    element("compare-note").textContent = "tick at least one head";

    return;
  }

  // One head that is the working tree is the plain review; one ref its review; two or more a comparison.
  if (heads.length === 1 && heads[0] === "WORKTREE") setLink({ ...currentLink(), view: "review", head: null, heads: [] });
  else if (heads.length === 1) setLink({ ...currentLink(), view: "review", head: heads[0]!, heads: [] });
  else setLink({ ...currentLink(), view: "compare", head: null, heads });
});
