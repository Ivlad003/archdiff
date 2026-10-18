import StateMachine from "javascript-state-machine";

// javascript-state-machine: the transitions as a list; `from` is a state or a list of states.
export const water = new StateMachine({
  init: "solid",
  transitions: [
    { name: "melt", from: "solid", to: "liquid" },
    { name: "freeze", from: "liquid", to: "solid" },
    { name: "vaporize", from: "liquid", to: "gas" },
    { name: "condense", from: "gas", to: "liquid" },
    { name: "reset", from: ["liquid", "gas"], to: "solid" },
  ],
});
