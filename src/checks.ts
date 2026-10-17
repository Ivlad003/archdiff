// The checks run after an agent's run, or on request from the page: the
// contract (`archdiff check`, in process) and the commands archdiff.json
// names in `checks` (`npm test`, `npm run typecheck`, `npx -y
// @fission-ai/openspec validate --specs`), each run in a shell in the
// repository with a time limit, its exit code and the tail of its output
// kept. The agent sees them too: Claude Code is allowed to run exactly
// these commands (`--allowedTools Bash(<command>:*)`), so it can verify
// its own work before it finishes.
//
// Sits at the I/O edge beside the agent. Entry points: `runChecks`,
// `checkEvents`, `allowedToolsFor`, `CheckResult`.

import { spawn } from "node:child_process";
import type { AgentEvent } from "./agent.ts";
import type { Analysis } from "./analyze.ts";
import { checkIntent } from "./intent.ts";

export interface CheckResult {
  command: string;
  ok: boolean;
  /** The tail of what the command wrote, or the contract's findings. */
  output: string;
  /** The exit code of a command; absent for the contract check. */
  code?: number | null;
}

/** How long one check may run. */
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

/** How much of a command's output is kept: the end, where the summary is. */
const TAIL = 4000;

/** Runs one shell command in `root`; the result keeps the tail of its output. */
function runCommand(root: string, command: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: root, shell: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let output = "";
    const keep = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`.slice(-TAIL);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    const timer = setTimeout(() => {
      output = `${output}\n(stopped after ${CHECK_TIMEOUT_MS / 60000} minutes)`;
      child.kill();
    }, CHECK_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ command, ok: false, output: error.message, code: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ command, ok: code === 0, output: output.trim(), code });
    });
  });
}

/** The contract check, then every configured command, in order; an analysis without a contract skips the first. */
export async function runChecks(analysis: Analysis): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  if (analysis.intent) {
    const report = checkIntent(analysis, analysis.intent);
    results.push({ command: "archdiff check", ok: report.ok, output: report.ok ? "the code follows ARCHITECTURE.md" : report.violations.map((violation) => `${violation.from}:${violation.line} imports ${violation.to}: ${violation.fromLayer} → ${violation.toLayer} is not in the contract`).join("\n") });
  }

  for (const command of analysis.config.checks) results.push(await runCommand(analysis.root, command));

  return results;
}

/** The results as events of a run, for the Chat tab: one line per check, the tail of a failure under it. */
export function checkEvents(results: readonly CheckResult[]): Omit<AgentEvent, "seq">[] {
  return results.map((result) => ({ kind: "check", text: result.ok ? `✔ ${result.command}${result.command === "archdiff check" ? `: ${result.output}` : ""}` : `✘ ${result.command}${result.code !== undefined ? ` (exit ${result.code ?? "signal"})` : ""}\n${result.output}` }));
}

/** The Claude Code tools the checks need: a Bash pattern per command, and archdiff's own CLI, so the agent can verify its work. */
export function allowedToolsFor(checks: readonly string[]): string[] {
  return [...new Set([...checks.map((command) => `Bash(${command}:*)`), "Bash(npx @ivlad003/archdiff:*)", "Bash(npx -y @ivlad003/archdiff:*)", "Bash(archdiff:*)"])];
}
