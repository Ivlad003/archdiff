// Gherkin features read as data, and test skeletons written from them:
// `archdiff spec --tests` turns every scenario of `features/*.feature`
// into a `test(...)` of `tests/<feature>.test.ts` marked to do, with the
// steps as comments, so the specification and the tests start from the
// same list and a scenario without a test is visible. A file archdiff
// wrote is rewritten; any other file is left alone.
//
// Pure parsing plus one writer. Entry points: `parseFeature`,
// `testSkeleton`, `writeTestSkeletons`.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { FEATURES_DIRECTORY } from "./spec.ts";

export interface Scenario {
  name: string;
  /** The steps as written: `Given …`, `When …`, `Then …`, `And …`, `But …`. */
  steps: string[];
  line: number;
}

export interface Feature {
  name: string;
  /** The lines under the feature's name, before the first scenario. */
  description: string[];
  background: string[];
  scenarios: Scenario[];
}

/** One `.feature` file: the feature, its background, its scenarios with their steps; tags and comments are skipped. */
export function parseFeature(text: string): Feature {
  const feature: Feature = { name: "", description: [], background: [], scenarios: [] };
  let section: "feature" | "background" | "scenario" = "feature";

  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();

    if (line === "" || line.startsWith("#") || line.startsWith("@")) return;
    const head = line.match(/^(Feature|Background|Scenario Outline|Scenario|Example|Rule):\s*(.*)$/);

    if (head) {
      const keyword = head[1]!;

      if (keyword === "Feature") {
        feature.name = head[2]!.trim();
        section = "feature";
      } else if (keyword === "Background") section = "background";
      else if (keyword === "Rule") section = "feature";
      else {
        feature.scenarios.push({ name: head[2]!.trim(), steps: [], line: index + 1 });
        section = "scenario";
      }

      return;
    }

    if (section === "feature") feature.description.push(line);
    else if (section === "background") feature.background.push(line);
    else feature.scenarios[feature.scenarios.length - 1]?.steps.push(line);
  });

  return feature;
}

/** The test file of a feature: one test per scenario, to do, its steps as comments; the background as the file's note. */
export function testSkeleton(feature: Feature, source: string): string {
  const quote = (text: string): string => JSON.stringify(text);
  const lines = [`// archdiff:generated — test skeletons of ${source}: one test per scenario, to be written.`, `// ${feature.name}${feature.description.length > 0 ? `: ${feature.description.join(" ")}` : ""}`, ...feature.background.map((step) => `// Background: ${step}`), "", 'import { test } from "node:test";', ""];

  for (const scenario of feature.scenarios) {
    lines.push(`test(${quote(scenario.name)}, { todo: "not written yet" }, () => {`);

    for (const step of scenario.steps) lines.push(`  // ${step}`);
    lines.push("});", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Writes `<outDir>/<feature>.test.ts` for every feature — `outDir` relative to the root (`tests` by default) or
 * absolute; a file not written by archdiff is skipped and named. The paths are as the caller wrote the directory.
 */
export function writeTestSkeletons(root: string, outDir = "tests"): { written: string[]; skipped: string[] } {
  const written: string[] = [];
  const skipped: string[] = [];
  const directory = join(root, FEATURES_DIRECTORY);

  if (!existsSync(directory)) return { written, skipped };
  // An absolute directory is where it says; `join` would put it under the root.
  const out = resolve(root, outDir);
  mkdirSync(out, { recursive: true });

  for (const name of readdirSync(directory).filter((file) => file.endsWith(".feature")).sort()) {
    const feature = parseFeature(readFileSync(join(directory, name), "utf8"));
    const target = join(outDir, `${name.replace(/\.feature$/, "")}.test.ts`);
    const full = join(out, `${name.replace(/\.feature$/, "")}.test.ts`);

    if (existsSync(full) && !readFileSync(full, "utf8").startsWith("// archdiff:generated")) {
      skipped.push(target);
      continue;
    }

    writeFileSync(full, testSkeleton(feature, `${FEATURES_DIRECTORY}/${name}`));
    written.push(target);
  }

  return { written, skipped };
}
