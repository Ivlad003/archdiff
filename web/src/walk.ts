// The walks of the page: what the keys `.` and `,` step through. A guided
// tour being played, the groups of the board of uncommitted changes and
// the commits of a range under the slider each offer a walk while they
// are on the page; a press steps the first of them that is offered, in
// that order — a tour played over the board steps the tour.
//
// Entry points: `offerWalk`, `stepWalk`, `Walk`.

/** The walks, in the order a press of `.` or `,` looks for one. */
const WALKS = ["tour", "board", "commits"] as const;

export type Walk = (typeof WALKS)[number];

const offered = new Map<Walk, (step: 1 | -1) => void>();

/** Offers a walk (its step forward and back) while it is on the page; null takes it away. */
export function offerWalk(name: Walk, step: ((step: 1 | -1) => void) | null): void {
  if (step === null) offered.delete(name);
  else offered.set(name, step);
}

/** One step of the first walk offered; false when there is none to step. */
export function stepWalk(step: 1 | -1): boolean {
  for (const name of WALKS) {
    const walk = offered.get(name);

    if (walk) {
      walk(step);

      return true;
    }
  }

  return false;
}
