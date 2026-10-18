// The review's bars: the commits of the branch to step through, and the
// branches (a base and any number of heads to compare). Takes the page
// as its context (page.ts).

import { api } from "./api.ts";
import { element } from "./dom.ts";
import { page } from "./page.ts";
import { reviewing, setHash, stateFromHash, type State } from "./state.ts";

const commitList = element<HTMLSelectElement>("commit-list");
let commits: import("./api.ts").Commit[] = [];

export async function loadCommits(state: State): Promise<void> {
  try {
    const result = await api.commits(page.baseInput.value.trim() || null, state.head);
    commits = result.commits;
    commitList.replaceChildren();
    const whole = document.createElement("option");
    whole.value = "";
    whole.textContent = `whole range: ${result.base.slice(0, 10)} → ${state.head ?? "working tree"} (${commits.length} commits)`;
    commitList.append(whole);

    for (const commit of commits) {
      const option = document.createElement("option");
      option.value = commit.sha;
      option.textContent = `${commit.short} ${commit.date} ${commit.subject}`;
      commitList.append(option);
    }

    // The picked commit is the head whose base is the commit before it.
    const picked = commits.find((commit) => commit.sha === state.head || commit.short === state.head);
    commitList.value = picked ? picked.sha : "";
    element("commit-note").textContent = picked ? `this commit against the one before it` : commits.length === 0 ? "no commits between the base and the head" : "pick a commit to see its own change";
  } catch (error) {
    element("commit-note").textContent = error instanceof Error ? error.message : String(error);
  }
}

function reviewCommit(index: number): void {
  const commit = commits[index];

  if (!commit) return;
  const previous = commits[index - 1];
  page.baseInput.value = previous ? previous.sha : "";
  setHash({ ...stateFromHash(), view: "review", head: commit.sha, heads: [] });
}

commitList.addEventListener("change", () => {
  const index = commits.findIndex((commit) => commit.sha === commitList.value);

  if (index === -1) {
    page.baseInput.value = "";
    setHash({ ...stateFromHash(), view: "review", head: null, heads: [] });
  } else reviewCommit(index);
});
element<HTMLButtonElement>("commit-prev").addEventListener("click", () => {
  const index = commits.findIndex((commit) => commit.sha === commitList.value);
  reviewCommit(index <= 0 ? commits.length - 1 : index - 1);
});
element<HTMLButtonElement>("commit-next").addEventListener("click", () => {
  const index = commits.findIndex((commit) => commit.sha === commitList.value);
  reviewCommit(index === -1 ? 0 : Math.min(commits.length - 1, index + 1));
});
// The head input itself is reached directly here: this listener is attached at import, before the page is bound.
element<HTMLInputElement>("head").addEventListener("change", () => {
  if (reviewing(stateFromHash().view)) setHash({ ...stateFromHash(), head: page.headInput.value.trim() || null });
});

// ── The branches: a base and any number of heads to compare ────────────────

let branchesLoaded = false;

export async function loadBranches(state: State): Promise<void> {
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

    baseSelect.value = page.baseInput.value.trim();
    const ticked = new Set(state.heads.length > 0 ? state.heads : ["WORKTREE"]);

    for (const box of list.querySelectorAll<HTMLInputElement>("input")) box.checked = ticked.has(box.value);
    note.textContent = state.heads.length > 1 ? `${state.heads.length} heads against ${page.baseInput.value.trim() || result.base || "the merge-base"}` : "tick two or more heads to compare branches";
  } catch (error) {
    note.textContent = error instanceof Error ? error.message : String(error);
  }
}

element<HTMLSelectElement>("base-select").addEventListener("change", () => {
  page.baseInput.value = element<HTMLSelectElement>("base-select").value;
  setHash(stateFromHash());
});
element<HTMLButtonElement>("compare").addEventListener("click", () => {
  const heads = [...element("head-list").querySelectorAll<HTMLInputElement>("input:checked")].map((box) => box.value);

  if (heads.length === 0) {
    element("compare-note").textContent = "tick at least one head";

    return;
  }

  // One head that is the working tree is the plain review; one ref its review; two or more a comparison.
  if (heads.length === 1 && heads[0] === "WORKTREE") setHash({ ...stateFromHash(), view: "review", head: null, heads: [] });
  else if (heads.length === 1) setHash({ ...stateFromHash(), view: "review", head: heads[0]!, heads: [] });
  else setHash({ ...stateFromHash(), view: "compare", head: null, heads });
});
