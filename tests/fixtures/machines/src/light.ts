/** A traffic light as XState writes it: an explicit machine. */
export const lightMachine = createMachine({
  id: "light",
  initial: "green",
  states: {
    green: { on: { TIMER: "yellow" } },
    yellow: { on: { TIMER: { target: "red" } } },
    red: { on: { TIMER: "green", PANIC: [{ target: "red" }] }, after: { 5000: "green" } },
  },
});

function createMachine(config: { id: string; initial: string; states: Record<string, unknown> }): { config: typeof config } {
  return { config };
}
