// A stand-in for an agent that starts a process of its own, as an agent
// behind npm's shim does (node running the agent's program): the child
// holds the output open for a minute, so a run that is stopped ends only
// when the child is stopped with it.
// usage: node fake-tree.mjs <prompt>
import { spawn } from "node:child_process";

spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "inherit" });
process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "tree-1" })}\n`);
setTimeout(() => {}, 60_000);
