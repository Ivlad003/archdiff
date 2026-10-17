// An order of items by the imports (or calls) between them, so that most
// lines point forward: an item nothing of the rest imports goes next (a
// source of the remaining graph, the busiest importer first), so an
// acyclic graph comes out in topological order; inside a cycle, where
// every item is imported, the one importing the most and imported the
// least goes next. Deterministic: ties by name. The matrix orders its
// layers by it, the layout its lanes when they lie as columns.
//
// Pure. Entry point: `greedyOrder`.

/** `counts` is keyed `from\u0000to`. */
export function greedyOrder(items: readonly string[], counts: ReadonlyMap<string, number>): string[] {
  const remaining = new Set(items);
  const order: string[] = [];

  while (remaining.size > 0) {
    let best: string | null = null;
    let bestScore = -Infinity;

    for (const item of [...remaining].sort()) {
      let out = 0;
      let into = 0;

      for (const other of remaining) {
        if (other === item) continue;
        out += counts.get(`${item}\u0000${other}`) ?? 0;
        into += counts.get(`${other}\u0000${item}`) ?? 0;
      }

      // A source of what remains outranks every item still imported by something; among sources the busiest importer first.
      const score = into === 0 ? 1_000_000 + out : out - into;

      if (score > bestScore) {
        bestScore = score;
        best = item;
      }
    }

    order.push(best!);
    remaining.delete(best!);
  }

  return order;
}
