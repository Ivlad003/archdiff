// The commits bar under the title: the commits of a range to step
// through, on a review and on the timeline — a list, the buttons ‹ and ›
// (`,` and `.`), a slider over them whose left end is the whole range, and
// play (`k`), which steps by itself at the pace the reader picked
// (remembered) until the last commit or a press. On a review a commit is
// that commit's own change against the one before it (the link's base and
// head move; the bar keeps the range). On the timeline a commit is the
// code as it was then, the whole map with what the commit did marked
// (`at=<sha>` in the link; the range stays the link's base and head).
// Beside the slider, the three overlays read from git — churn, change
// coupling, ownership — are switched like the boxes of the options, and
// are of the range up to the commit the slider is at.
//
// Entry points: `showCommitsBar`, `loadCommits`, `togglePlay`.

import { api, type Commit } from "./api.ts";
import { leaveEdit } from "./canvas.ts";
import { element, rememberText, rememberedText } from "./dom.ts";
import { t } from "./i18n.ts";
import { currentLink, setLink, type Link } from "./link.ts";
import { notice } from "./title.ts";
import { offerWalk } from "./walk.ts";
import { GIT_OVERLAYS, type Overlay } from "../../src/options.ts";

const bar = element<HTMLDivElement>("commits");
const baseInput = element<HTMLInputElement>("base");
const commitList = element<HTMLSelectElement>("commit-list");
const slider = element<HTMLInputElement>("commit-slider");
const playButton = element<HTMLButtonElement>("commit-play");
const speedSelect = element<HTMLSelectElement>("commit-speed");
const note = element<HTMLSpanElement>("commit-note");

/** What the bar steps through: a review's commits (each its own change) or the timeline's (the code at each). */
type Mode = "review" | "timeline";

let commits: Commit[] = [];
/** The range the bar lists (its base and head), kept while a commit of it is picked: stepping stays in the range. */
let range: { base: string | null; head: string | null } | null = null;
/** Which view the commits were listed for: a review's range is not the timeline's. */
let listedFor: Mode | null = null;
/** The index of the commit picked, among `commits`; -1 for the whole range. */
let picked = -1;

function modeOf(view: string): Mode | null {
  return view === "review" || view === "timeline" ? view : null;
}

// ── Play ─────────────────────────────────────────────────────────────────────

/** Where this browser keeps how long a commit stays while playing. */
const SPEED_KEY = "archdiff.slider.speed";

/** How long each commit stays while playing, in milliseconds, by the name the select shows. */
const SPEEDS: Readonly<Record<string, number>> = { slow: 3000, normal: 1500, fast: 700 };

let playing = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function setPlaying(on: boolean): void {
  playing = on;

  if (timer !== null) clearTimeout(timer);
  timer = null;
  playButton.textContent = on ? "⏸" : "▶";
  playButton.classList.toggle("active", on);
  playButton.setAttribute("aria-pressed", String(on));
  playButton.title = on ? t("Pause at this commit (k)") : t("Play: step through the commits of the range by itself, the picture drawn again at each (k)");
}

/** The next commit after the pace picked, once the picture of this one is drawn; at the last commit the play ends. */
function playOn(): void {
  if (!playing) return;

  if (picked >= commits.length - 1) return setPlaying(false);
  timer = setTimeout(() => {
    timer = null;

    if (playing) pick(picked + 1);
  }, SPEEDS[speedSelect.value] ?? SPEEDS["normal"]!);
}

/** Starts or pauses the play (`k`); from the whole range or the last commit it starts at the first. */
export function togglePlay(): void {
  if (bar.hidden || commits.length === 0) return;

  if (playing) return setPlaying(false);
  setPlaying(true);

  if (picked === -1 || picked >= commits.length - 1) pick(0);
  else playOn();
}

// ── The bar ──────────────────────────────────────────────────────────────────

/** The bar on a review and on the timeline, as the link says — before the picture comes; elsewhere a play ends. */
export function showCommitsBar(state: Link): void {
  const mode = modeOf(state.view);
  bar.hidden = mode === null;
  offerWalk("commits", mode === null ? null : (by) => step(by));

  if (mode === null) setPlaying(false);

  for (const button of document.querySelectorAll<HTMLButtonElement>("#git-overlays button")) {
    const on = state.overlays.includes(button.dataset["overlay"] as Overlay);
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  }
}

/** The list, the slider and the note as the pick is now. */
function showPick(mode: Mode, state: Link): void {
  commitList.value = picked === -1 ? "" : commits[picked]!.sha;
  slider.max = String(commits.length);
  slider.value = String(picked + 1);
  slider.disabled = commits.length === 0;
  playButton.disabled = commits.length === 0;
  const at = picked === -1 ? "" : `${t("commit {n} of {count}", { n: picked + 1, count: commits.length })} · `;
  note.textContent = commits.length === 0 ? t("no commits between the base and the head") : mode === "review" ? (picked === -1 ? t("pick a commit to see its own change") : `${at}${t("this commit against the one before it")}`) : picked === -1 ? (state.at ? t("this commit is not of the range") : t("drag the slider or press ▶: the code as it was at each commit")) : `${at}${t("the code as it was then, what the commit did marked")}`;
}

/** Fills the list with the commits of a range, the whole range first. */
function fill(listed: readonly Commit[], base: string, head: string | null): void {
  commits = [...listed];
  commitList.replaceChildren(new Option(t("whole range: {base} → {head} ({count} commits)", { base: base.slice(0, 10), head: head ?? t("working tree"), count: commits.length }), ""));

  for (const commit of commits) commitList.append(new Option(`${commit.short} ${commit.date} ${commit.subject}`, commit.sha));
}

/**
 * The commits of the picture's range and the one picked, once the picture is drawn: a review lists its range anew
 * unless the link is one commit of the range already listed; the timeline lists the link's base and head. While
 * playing, the next commit follows after the pace.
 */
export async function loadCommits(state: Link): Promise<void> {
  const mode = modeOf(state.view);

  if (mode === null) return;
  const at = (ref: string | null): number => (ref === null ? -1 : commits.findIndex((commit) => commit.sha === ref || commit.short === ref));

  try {
    if (mode === "review") {
      // A commit of the listed range picked (its own change, base the commit before it): the bar keeps the range and moves the pick.
      const index = listedFor === "review" ? at(state.head) : -1;
      const before = index > 0 ? commits[index - 1]!.sha : (range?.base ?? "");

      if (!(range && index !== -1 && baseInput.value.trim() === before)) {
        range = { base: baseInput.value.trim() || null, head: state.head };
        const result = await api.commits(range.base, range.head);
        fill(result.commits, result.base, state.head);
        listedFor = "review";
      }

      picked = at(state.head);
    } else {
      const wanted = { base: baseInput.value.trim() || null, head: state.head };

      if (!(listedFor === "timeline" && range && range.base === wanted.base && range.head === wanted.head)) {
        const result = await api.commits(wanted.base, wanted.head);
        fill(result.commits, result.base, state.head);
        range = wanted;
        listedFor = "timeline";
      }

      picked = at(state.at);
    }

    showPick(mode, state);
    playOn();
  } catch (error) {
    setPlaying(false);
    note.textContent = error instanceof Error ? error.message : String(error);
  }
}

/** Opens a commit of the listed range by its index, or the whole range (-1). */
function pick(index: number): void {
  const now = currentLink();
  const mode = modeOf(now.view);
  const commit = commits[index];

  if (mode === null || !leaveEdit()) return;

  if (mode === "timeline") return setLink({ ...now, at: commit?.sha ?? null });

  if (!commit) {
    // The whole range again: its own base and head, and the bar reads it afresh.
    const whole = range;
    range = null;
    baseInput.value = whole?.base ?? "";

    return setLink({ ...now, view: "review", head: whole?.head ?? null, heads: [] });
  }

  // The first commit of the range against the range's own base, each later one against the one before it.
  const previous = commits[index - 1];
  baseInput.value = previous ? previous.sha : (range?.base ?? "");
  setLink({ ...now, view: "review", head: commit.sha, heads: [] });
}

/** The next or the previous commit, as › and ‹ step: on from the whole range to the first, back from it to the last. */
function step(by: 1 | -1): void {
  if (commits.length === 0) return;
  setPlaying(false);

  if (by === 1 && picked === commits.length - 1) return notice(t("the last commit of the range"));
  pick(by === 1 ? picked + 1 : picked <= 0 ? commits.length - 1 : picked - 1);
}

commitList.addEventListener("change", () => {
  setPlaying(false);
  pick(commits.findIndex((commit) => commit.sha === commitList.value));
});
element<HTMLButtonElement>("commit-prev").addEventListener("click", () => step(-1));
element<HTMLButtonElement>("commit-next").addEventListener("click", () => step(1));
playButton.addEventListener("click", () => togglePlay());
// The thumb names the commit it is over while it is dragged; let go, the picture of that commit is drawn.
slider.addEventListener("input", () => {
  const commit = commits[Number(slider.value) - 1];
  note.textContent = commit ? `${t("{n} of {count}", { n: slider.value, count: commits.length })} · ${commit.short} ${commit.date} ${commit.subject}` : t("the whole range");
});
slider.addEventListener("change", () => {
  setPlaying(false);
  pick(Number(slider.value) - 1);
});

/** The paces as the select names them, in the page's language; the value kept is the pace's own name. */
const SPEED_NAMES: Readonly<Record<string, string>> = { slow: t("slow"), normal: t("normal"), fast: t("fast") };

for (const name of Object.keys(SPEEDS)) speedSelect.append(new Option(SPEED_NAMES[name] ?? name, name));
speedSelect.value = rememberedText(SPEED_KEY) ?? "normal";

if (speedSelect.value === "") speedSelect.value = "normal";
speedSelect.addEventListener("change", () => rememberText(SPEED_KEY, speedSelect.value));

for (const button of document.querySelectorAll<HTMLButtonElement>("#git-overlays button")) {
  button.addEventListener("click", () => {
    const now = currentLink();
    const overlay = GIT_OVERLAYS.find((candidate) => candidate === button.dataset["overlay"]);

    if (overlay !== undefined) setLink({ ...now, overlays: now.overlays.includes(overlay) ? now.overlays.filter((each) => each !== overlay) : [...now.overlays, overlay] });
  });
}

setPlaying(false);
