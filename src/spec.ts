// The specification of a repository as tools read it: OpenSpec specs
// (`openspec/specs/<capability>/spec.md`, requirements with SHALL and
// scenarios with WHEN and THEN) and Gherkin features (`features/*.feature`).
// archdiff lists and reads them for the page's Spec tab, and writes the
// prompt that has the agent write or review them from the code, the
// contract and the pictures — so the specification is generated where it
// belongs, in the repository, in the formats `openspec validate` and
// Cucumber open.
//
// Sits at the edge beside intent.ts: the file system in, prompts out.
// Entry points: `listSpecs`, `readSpec`, `specPrompt`, `validateSpecs`.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import type { Analysis } from "./analyze.ts";
import { INTENT_FILE } from "./intent.ts";
import type { View } from "./view-keys.ts";

export const SPECS_DIRECTORY = "openspec/specs";

export const FEATURES_DIRECTORY = "features";

export interface SpecFile {
  /** The path relative to the root, POSIX. */
  path: string;
  /** The first heading or the feature's name. */
  title: string;
  kind: "openspec" | "gherkin";
}

/** The first `# ` heading of a Markdown file, or the `Feature:` line of a Gherkin file, or the file name. */
function titleOf(path: string, text: string): string {
  const heading = text.match(/^#\s+(.+)$/m)?.[1] ?? text.match(/^\s*Feature:\s*(.+)$/m)?.[1];

  return (heading ?? posix.basename(path)).trim();
}

/** Every spec and feature of the repository, sorted by path; `initialised` says whether `openspec/` exists at all. */
export function listSpecs(root: string): { initialised: boolean; specs: SpecFile[] } {
  const specs: SpecFile[] = [];
  const specsRoot = join(root, SPECS_DIRECTORY);

  if (existsSync(specsRoot)) {
    for (const entry of readdirSync(specsRoot).sort()) {
      const file = join(specsRoot, entry, "spec.md");

      if (statSync(join(specsRoot, entry)).isDirectory() && existsSync(file)) {
        const path = posix.join(SPECS_DIRECTORY, entry, "spec.md");
        specs.push({ path, title: titleOf(path, readFileSync(file, "utf8")), kind: "openspec" });
      }
    }
  }

  const featuresRoot = join(root, FEATURES_DIRECTORY);

  if (existsSync(featuresRoot)) {
    for (const entry of readdirSync(featuresRoot).sort()) {
      if (!entry.endsWith(".feature")) continue;
      const path = posix.join(FEATURES_DIRECTORY, entry);
      specs.push({ path, title: titleOf(path, readFileSync(join(featuresRoot, entry), "utf8")), kind: "gherkin" });
    }
  }

  return { initialised: existsSync(join(root, "openspec")), specs };
}

/** The text of one spec or feature by its relative path; null when the path is not one of the listed files (no other file is read this way). */
export function readSpec(root: string, path: string): string | null {
  if (!listSpecs(root).specs.some((spec) => spec.path === path)) return null;

  return readFileSync(join(root, ...path.split("/")), "utf8");
}

/** The OpenSpec format, as the agent is told it. */
const FORMAT = `## The OpenSpec format (openspec/specs/<capability>/spec.md)

\`\`\`markdown
# <Capability> Specification

## Purpose

One paragraph: what this capability is for.

## Requirements

### Requirement: <one sentence naming the behaviour>

The system SHALL <what it does, testable>; <limits, errors, defaults>.

#### Scenario: <a concrete case>

- **WHEN** <the input or the action>
- **THEN** <the observable result>
\`\`\`

Rules: every requirement has at least one scenario; use SHALL (or MUST) for what the system does; name concrete inputs and outputs (commands, flags, files, labels), not implementation; keep a requirement under 500 characters; one capability per file, named by a short kebab-case directory.

## The Gherkin format (features/<capability>.feature)

\`\`\`gherkin
Feature: <name>
  <one or two lines of purpose>

  Scenario: <a concrete case>
    Given <the setup>
    When <the action>
    Then <the result>
    And <more of the result>
\`\`\`

Rules: the scenarios mirror the ones the tests run; plain English; steps the reader can perform by hand.`;

/**
 * The prompt that has the agent write (`generate`) the spec of one subject
 * — a view's subject: a layer, a directory, a module, a function — or
 * review (`update`) every spec against the code. The agent reads the
 * code, ARCHITECTURE.md and archdiff's own pictures; it writes the files
 * and validates them with the OpenSpec CLI.
 */
export function specPrompt(analysis: Analysis, mode: "generate" | "update", subject: string | null): string {
  const { initialised, specs } = listSpecs(analysis.root);
  const existing = specs.length === 0 ? "none yet" : specs.map((spec) => `- ${spec.path} — ${spec.title}`).join("\n");
  const init = initialised ? "" : "\n- `openspec/` does not exist yet: run `npx -y @fission-ai/openspec init --tools none --no-animation .` first (it writes openspec/config.yaml and the empty specs/ and changes/ directories), then `mkdir -p features`.";
  const contract = analysis.intent ? `- ${INTENT_FILE} is the contract: ${analysis.intent.layers.length} layers, ${analysis.intent.modules.length} modules, ${analysis.intent.edges.length} imports. The specs must agree with it; where the code and the contract differ, say so in the spec's Purpose and specify what the code does.` : `- There is no ${INTENT_FILE}; specify what the code does.`;
  const lines = [`# ${mode === "generate" ? `Specify ${subject ?? "the repository"}` : "Review the specification against the code"}`, ""];
  lines.push(`Repository: ${analysis.root} (${analysis.stats.files} files, ${analysis.stats.modules} modules, ${analysis.graph.layers.length} layers: ${analysis.graph.layers.join(", ")}).`, "");
  lines.push("## What exists", "", existing, init, contract, "", "## How to look", "", "- `npx @ivlad003/archdiff views` lists every picture; `npx @ivlad003/archdiff diagram <view>` prints a picture as Markdown with its Mermaid, the shapes with `file:line`; `module:<path>`, `inside:<path>`, `calls:<path>#<fn>`, `usage:<path>`, `logic:<path>#<fn>` and `type:<path>#<Type>` are the ones that tell what a module does and who uses it.", "- Read the code the pictures point to before writing a requirement; a requirement states behaviour the code has (or the contract promises), with its inputs, outputs, limits and errors.", "");

  if (mode === "generate") {
    lines.push("## The task", "", `Write the OpenSpec specification of **${subject ?? "every layer of the repository"}** in \`openspec/specs/<capability>/spec.md\` (one capability per file; a layer or directory is usually one capability, a big module may be its own) and the matching Gherkin file in \`features/<capability>.feature\`${subject ? "" : ", one pair per layer"}.`, "", "Then run `npx -y @fission-ai/openspec validate --specs` and fix what it reports. Finish with the list of files written.", "");
  } else {
    lines.push("## The task", "", "Read every spec and feature listed above against the code it describes. Fix what is stale (a requirement the code no longer meets, a scenario with a changed name or flag), add what the code does that no requirement covers, and delete what no longer exists — one spec at a time, keeping the format. Then run `npx -y @fission-ai/openspec validate --specs` and fix what it reports. Finish with the list of files changed and, for each, one line on what changed.", "");
  }

  lines.push(FORMAT, "", "When a requirement is a real choice — what the behaviour SHOULD be where the code is ambiguous — ask the user with one archdiff-question block rather than guessing.");

  return `${lines.join("\n")}\n`;
}

/** What a spec of a view is about, in the words of the prompt: a module or a function by its ID, a layer, a directory; null for every layer. */
export function specSubject(view: View | null): string | null {
  if (!view || view.subject === null) return null;

  return view.kind === "layer" ? `the layer ${view.subject}` : view.kind === "dir" ? `the directory ${view.subject}` : view.subject;
}

/**
 * Runs the OpenSpec CLI's validation of the specs; the output, and whether it passed. Needs npm and the network for
 * the first run. A child process waited for, not blocked on: the server answers other requests meanwhile.
 */
export function validateSpecs(root: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolveResult) => {
    const child = spawn("npx", ["-y", "@fission-ai/openspec", "validate", "--specs", "--no-color"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    // Two minutes at most: a first run downloads the CLI.
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveResult({ ok: false, output: `openspec: ${error.message}` });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveResult({ ok: code === 0, output: output.trim() || (signal ? `openspec: stopped (${signal}) after two minutes` : `exit ${code}`) });
    });
  });
}
