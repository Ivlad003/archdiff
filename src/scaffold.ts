// `archdiff new`: a project from scratch, built from its diagram. Writes
// the skeleton that ties nothing to a framework — package.json, tsconfig
// for TypeScript, .gitignore, archdiff.json with the template's layers,
// ARCHITECTURE.md with the template's intent, a README — and makes the
// first commit, so the page opens on the intent view with lanes to draw
// in and an agent can build what is drawn. Everything else (the
// libraries, the framework) is the agent's to add from the drawing and
// its notes.
//
// Sits at the edge, beside the CLI: options → files on disk + git.
// Entry points: `scaffold`, `TEMPLATES`, `ScaffoldOptions`.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AgentName } from "./agent.ts";
import { commitFirst } from "./git.ts";
import { INTENT_FILE, intentMarkdown, type Intent } from "./intent.ts";

export type Language = "ts" | "js";

export const TEMPLATES = ["blank", "lib", "cli", "api", "web"] as const;

export type Template = (typeof TEMPLATES)[number];

export interface ScaffoldOptions {
  lang: Language;
  template: Template;
  /** The agent named in archdiff.json, the one the page's Chat tab picks first; null: none (the page offers what is installed). */
  agent: AgentName | null;
  /** `git init` and the first commit; off in tests that only look at the files. */
  git: boolean;
}

/** The layers of each template, with the globs that place files in them, and the intent they start from. */
function templateIntent(template: Template, extension: string): { layers: Record<string, string[]>; intent: Intent } {
  const e = extension;
  const before = (purpose: string): string => `# Architecture\n\n${purpose}\n\nA subgraph is a layer, a node is a module (its file path, then what it does), an arrow is an import. Draw on the intent view of \`archdiff web\` and run the agent to build what is drawn; \`archdiff check\` keeps the code to this contract.\n\n`;

  switch (template) {
    case "lib":
      return {
        layers: { api: [`src/index.${e}`], lib: ["src/lib/**"] },
        intent: {
          layers: [{ name: "api", description: "what the package exports" }, { name: "lib", description: "the implementation" }],
          modules: [
            { id: `src/index.${e}`, layer: "api", description: "the public entry: re-exports the library", fns: [] },
            { id: `src/lib/core.${e}`, layer: "lib", description: "the core of the library", fns: [] },
          ],
          edges: [{ from: `src/index.${e}`, to: `src/lib/core.${e}` }],
          before: before("A library published as an npm package."),
          after: "",
        },
      };
    case "cli":
      return {
        layers: { bin: ["bin/**"], commands: ["src/commands/**"], lib: ["src/lib/**"] },
        intent: {
          layers: [{ name: "bin", description: "the entry point" }, { name: "commands", description: "one module per command" }, { name: "lib", description: "shared code" }],
          modules: [
            { id: `bin/main.${e}`, layer: "bin", description: "parses the arguments and runs a command", fns: [] },
            { id: `src/commands/hello.${e}`, layer: "commands", description: "the first command", fns: [] },
            { id: `src/lib/output.${e}`, layer: "lib", description: "writes to stdout and stderr", fns: [] },
          ],
          edges: [
            { from: `bin/main.${e}`, to: `src/commands/hello.${e}` },
            { from: `src/commands/hello.${e}`, to: `src/lib/output.${e}` },
          ],
          before: before("A command-line tool."),
          after: "",
        },
      };
    case "api":
      return {
        layers: { routes: ["src/routes/**"], services: ["src/services/**"], domain: ["src/domain/**"], db: ["src/db/**"] },
        intent: {
          layers: [
            { name: "routes", description: "HTTP in, HTTP out; no logic" },
            { name: "services", description: "the use cases" },
            { name: "domain", description: "the types and the rules" },
            { name: "db", description: "storage" },
          ],
          modules: [
            { id: `src/routes/health.${e}`, layer: "routes", description: "GET /health", fns: [] },
            { id: `src/services/health.${e}`, layer: "services", description: "reports whether the service is up", fns: [] },
            { id: `src/domain/types.${e}`, layer: "domain", description: "the domain types", fns: [] },
            { id: `src/db/store.${e}`, layer: "db", description: "the store behind the services", fns: [] },
          ],
          edges: [
            { from: `src/routes/health.${e}`, to: `src/services/health.${e}` },
            { from: `src/services/health.${e}`, to: `src/domain/types.${e}` },
            { from: `src/services/health.${e}`, to: `src/db/store.${e}` },
          ],
          before: before("An HTTP API service."),
          after: "",
        },
      };
    case "web":
      return {
        layers: { pages: ["src/pages/**"], components: ["src/components/**"], state: ["src/state/**"], api: ["src/api/**"] },
        intent: {
          layers: [
            { name: "pages", description: "one module per screen" },
            { name: "components", description: "what the screens are made of" },
            { name: "state", description: "the data the screens share" },
            { name: "api", description: "talks to the backend" },
          ],
          modules: [
            { id: `src/pages/home.${e}`, layer: "pages", description: "the first screen", fns: [] },
            { id: `src/components/layout.${e}`, layer: "components", description: "the frame of every screen", fns: [] },
            { id: `src/state/store.${e}`, layer: "state", description: "the shared state", fns: [] },
            { id: `src/api/client.${e}`, layer: "api", description: "the HTTP client", fns: [] },
          ],
          edges: [
            { from: `src/pages/home.${e}`, to: `src/components/layout.${e}` },
            { from: `src/pages/home.${e}`, to: `src/state/store.${e}` },
            { from: `src/state/store.${e}`, to: `src/api/client.${e}` },
          ],
          before: before("A web application."),
          after: "",
        },
      };
    case "blank":
      return { layers: { app: ["src/**"] }, intent: { layers: [{ name: "app" }], modules: [], edges: [], before: before("A project drawn from scratch."), after: "" } };
  }
}

/**
 * Writes the project into `dir` (created when missing; refused when it
 * holds files already) and returns the files written. With `git`, the
 * repository is initialised on `main` with everything committed.
 */
export function scaffold(dir: string, options: ScaffoldOptions): string[] {
  if (existsSync(dir) && readdirSync(dir).some((name) => name !== ".git")) throw new Error(`${dir} is not empty`);
  mkdirSync(dir, { recursive: true });
  const name = basename(dir).replace(/[^a-z0-9-]+/gi, "-").toLowerCase() || "project";
  const extension = options.lang === "ts" ? "ts" : "js";
  const { layers, intent } = templateIntent(options.template, extension);
  const written: string[] = [];

  const write = (file: string, content: string): void => {
    const full = join(dir, file);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
    written.push(file);
  };

  const scripts: Record<string, string> = options.lang === "ts" ? { typecheck: "tsc --noEmit", test: "node --test" } : { test: "node --test" };
  const pkg: Record<string, unknown> = { name, version: "0.1.0", private: true, type: "module", scripts };

  if (options.lang === "ts") pkg["devDependencies"] = { typescript: "^5.9.0", "@types/node": "^22.0.0" };
  write("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

  if (options.lang === "ts") {
    write("tsconfig.json", `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, allowImportingTsExtensions: true, rewriteRelativeImportExtensions: true, skipLibCheck: true, types: ["node"] }, include: ["src", "bin", "tests"] }, null, 2)}\n`);
  }

  write(".gitignore", "node_modules/\ndist/\n.archdiff/facts.json.gz\n.archdiff/revisions.json.gz\n.archdiff/tasks/\n");
  const config: Record<string, unknown> = { layers };

  if (options.agent) config["agent"] = options.agent;
  write("archdiff.json", `${JSON.stringify(config, null, 2)}\n`);
  write(INTENT_FILE, intentMarkdown(intent));
  write("README.md", `# ${name}\n\nStarted with \`archdiff new\` (${options.template}, ${options.lang}). The architecture is drawn in [${INTENT_FILE}](${INTENT_FILE}); \`npx @ivlad003/archdiff web\` opens it, \`npx @ivlad003/archdiff check\` checks the code against it.\n`);

  // The layer directories exist from the start, so the page's lanes have somewhere to put files.
  for (const globs of Object.values(layers)) {
    for (const glob of globs) {
      const directory = glob.replace(/\/\*\*$/, "").replace(/\/[^/]*\.[a-z]+$/, "");

      if (directory && !directory.includes("*")) {
        mkdirSync(join(dir, directory), { recursive: true });
        write(join(directory, ".gitkeep"), "");
      }
    }
  }

  if (options.git && !existsSync(join(dir, ".git"))) commitFirst(dir, `archdiff new: ${options.template} (${options.lang})`);

  return written;
}
