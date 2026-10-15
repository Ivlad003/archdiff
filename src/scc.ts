// Strongly connected components of a directed module graph.
// A component is cyclic when it has two or more modules, or a self-loop.
// Works on the graph stage (source → FileFacts → graph): cycle rules in
// `check`, the map's cycle reports and layering use it. Entry points:
// `stronglyConnected` (cyclic components only), `components` (all, in Tarjan's
// order) and `cycleThrough` (one concrete cycle to show in a diagnostic).
// Every result is deterministic: nodes are visited in sorted order.

/** The cyclic components of `adj` (two or more nodes, or one node with a self-loop), each sorted. */
export function stronglyConnected(adj: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  return components(adj).filter((component) => component.length > 1 || (adj.get(component[0] ?? "")?.has(component[0] ?? "") ?? false));
}

/** Every strongly connected component, each after all components it reaches (Tarjan's order). */
export function components(adj: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const found: string[][] = [];
  // Targets without outgoing edges are nodes too, though `adj` has no key for them.
  const nodes = new Set<string>(adj.keys());

  for (const targets of adj.values()) for (const target of targets) nodes.add(target);

  // Tarjan with an explicit stack: a chain of thousands of modules must not overflow the call stack.
  // Each frame walks its successors in the same order the recursive form would.
  const visit = (root: string): void => {
    const frames: { node: string; next: Iterator<string> }[] = [];

    // Give `node` the next discovery index, put it on the Tarjan stack and push
    // a frame that will iterate its successors.
    const enter = (node: string): void => {
      indices.set(node, index);
      low.set(node, index);
      index += 1;
      stack.push(node);
      onStack.add(node);
      frames.push({ node, next: (adj.get(node) ?? new Set<string>()).values() });
    };

    enter(root);

    while (frames.length > 0) {
      const frame = frames.at(-1)!;
      const step = frame.next.next();

      // A successor left: descend into an unvisited one, or lower this node's
      // low-link through a back edge to a node still on the stack.
      if (!step.done) {
        const next = step.value;

        if (!indices.has(next)) enter(next);
        else if (onStack.has(next)) low.set(frame.node, Math.min(low.get(frame.node) ?? 0, indices.get(next) ?? 0));
        continue;
      }

      // All successors done: return to the parent and pass the low-link up.
      frames.pop();
      const node = frame.node;
      const parent = frames.at(-1);

      if (parent) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(node) ?? 0));

      // `node` is the root of a component: pop the stack down to it. Members
      // are sorted so the output does not depend on traversal order.
      if (low.get(node) !== indices.get(node)) continue;
      const component: string[] = [];

      for (;;) {
        const item = stack.pop();

        if (item === undefined) break;
        onStack.delete(item);
        component.push(item);

        if (item === node) break;
      }

      found.push(component.sort());
    }
  };

  // Start roots in sorted order so component order is stable across runs.
  for (const node of [...nodes].sort()) if (!indices.has(node)) visit(node);

  return found;
}

/** One cycle inside `members` that passes through `start`. */
export function cycleThrough(adj: ReadonlyMap<string, ReadonlySet<string>>, members: ReadonlySet<string>, start: string): string[] {
  if (adj.get(start)?.has(start)) return [start];
  // Depth-first search from `start` that stays inside the component and keeps
  // a parent pointer per node; the first edge back to `start` closes a cycle.
  const parent = new Map<string, string>();
  const stack = [start];
  const seen = new Set<string>([start]);

  while (stack.length > 0) {
    const node = stack.pop();

    if (node === undefined) break;

    for (const next of adj.get(node) ?? []) {
      if (!members.has(next)) continue;

      // Back at `start`: rebuild the path start → … → node from parent pointers.
      if (next === start) {
        const rev = [node];
        let cursor = node;

        while (cursor !== start) {
          const previous = parent.get(cursor);

          if (previous === undefined) break;
          rev.push(previous);
          cursor = previous;
        }

        return [start, ...rev.reverse().filter((id) => id !== start)];
      }

      if (seen.has(next)) continue;
      seen.add(next);
      parent.set(next, node);
      stack.push(next);
    }
  }

  // No cycle found (the caller passed a non-cyclic start): the node alone.
  return [start];
}
