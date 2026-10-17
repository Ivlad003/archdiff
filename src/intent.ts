// The intended architecture of a repository: ARCHITECTURE.md, a Markdown
// file with one Mermaid flowchart that archdiff reads and writes. A
// subgraph is a layer, a node is a module (its label the file path, a
// second line its description) or a function (`path#name`), an arrow is
// an import (between modules) or a call (between functions). The prose
// around the block is the owner's and stays as written.
//
// The file is the contract: the `intent` view draws it against the code
// (what is planned and not built yet, what the code has beyond it),
// `check` lists the imports between layers the contract does not allow,
// and the drawing of the intent view adds to it (a drawn module is written
// here before the agent builds it). Agents read and write the same file,
// which is why it is Markdown and Mermaid, not a format of archdiff's own.
//
// Pure except `readIntent` / `writeIntent`. Entry points: `parseIntent`,
// `intentMarkdown`, `intentView`, `checkIntent`, `checkMarkdown`,
// `mergePlan`, `intentFromCode`, `INTENT_FILE`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Analysis } from "./analyze.ts";
import type { Diagram, DiagramEdge, DiagramGroup, DiagramNode } from "./diagram.ts";
import { moduleOf, type Graph } from "./graph.ts";
import type { Plan } from "./plan.ts";
import { CONFIG_FILE } from "./config.ts";
import { isJsonObject, parseJson, type JsonValue } from "./json.ts";

export const INTENT_FILE = "ARCHITECTURE.md";

export interface IntentLayer {
  name: string;
  description?: string;
}

export interface IntentFunction {
  name: string;
  description?: string;
}

export interface IntentModule {
  /** The file path, the module's ID in the graph. */
  id: string;
  layer?: string;
  description?: string;
  fns: IntentFunction[];
}

/** An import between modules, or a call between functions (`path#name` on both ends). */
export interface IntentEdge {
  from: string;
  to: string;
  label?: string;
}

export interface Intent {
  layers: IntentLayer[];
  modules: IntentModule[];
  edges: IntentEdge[];
  /** The Markdown before the Mermaid block (the title, the prose). */
  before: string;
  /** The Markdown after the block. */
  after: string;
}

const EMPTY_BEFORE = "# Architecture\n\nThe intended architecture: a subgraph is a layer, a node is a module (its file path, then what it does), an arrow is an import. archdiff draws it (`archdiff diagram intent`), checks the code against it (`archdiff check`) and adds to it what is drawn on the page.\n\n";

export const EMPTY_INTENT: Intent = { layers: [], modules: [], edges: [], before: EMPTY_BEFORE, after: "" };

const BLOCK = /```mermaid\s*\n([\s\S]*?)```/;

/** A Mermaid label: `["text"]`, `[text]`, `(text)`, `(["text"])`, `{text}`, `>text]` → the text, `<br>` and `\n` as line breaks. */
function labelOf(rest: string): string | null {
  const match = rest.match(/^\s*(\(\[|\[\[|\[\(|\[|\(\(|\(|\{\{|\{|>)\s*"?([\s\S]*?)"?\s*(\]\)|\]\]|\)\]|\]|\)\)|\)|\}\}|\})\s*$/);

  if (!match) return null;

  return match[2]!.replace(/<br\s*\/?>/gi, "\n").replace(/\\n/g, "\n").replace(/#quot;|&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}

/** Splits `a & b & c` into its nodes: on `&` outside brackets and quotes only, so a label with an ampersand or an HTML entity stays whole. */
function splitNodes(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (char === '"') quoted = !quoted;
    else if (!quoted && "[({".includes(char)) depth++;
    else if (!quoted && "])}".includes(char)) depth = Math.max(0, depth - 1);
    else if (char === "&" && depth === 0 && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(text.slice(start));

  return parts.filter((part) => part.trim() !== "");
}

/** The text of a line's first line and the rest as a description. */
function splitLabel(label: string): { name: string; description?: string } {
  const [first = "", ...rest] = label.split("\n");
  const description = rest.join(" ").trim();
  // "path: what it does" on one line is read the same way.
  const colon = first.indexOf(": ");

  if (!description && colon !== -1 && !first.includes("#") && /[/.]/.test(first.slice(0, colon))) return { name: first.slice(0, colon).trim(), description: first.slice(colon + 2).trim() };

  return description ? { name: first.trim(), description } : { name: first.trim() };
}

/**
 * Reads ARCHITECTURE.md: the first Mermaid block as the intent, the text
 * around it kept. A file without a block is an empty intent with the text
 * as `before`. Tolerant of what Mermaid tolerates in a flowchart: labels
 * in any bracket, `-->`, `-.->`, `==>`, `---`, labels on arrows, several
 * nodes on one line joined by `&`, comments (`%%`), `classDef` and
 * `style` lines (ignored).
 */
export function parseIntent(markdown: string): Intent {
  const match = markdown.match(BLOCK);

  if (!match) return { ...EMPTY_INTENT, before: markdown.endsWith("\n") || markdown === "" ? markdown : `${markdown}\n`, after: "" };
  const before = markdown.slice(0, match.index);
  const after = markdown.slice(match.index! + match[0].length);
  const body = match[1]!;
  const layers: IntentLayer[] = [];
  const modules = new Map<string, IntentModule>();
  const edges: IntentEdge[] = [];
  // Mermaid IDs → the names in the labels (a path cannot be an ID: it has slashes and dots).
  const names = new Map<string, string>();
  const descriptions = new Map<string, string>();
  const layerOfNode = new Map<string, string>();
  let currentLayer: string | null = null;

  const nameOf = (id: string): string => names.get(id) ?? id;

  // A node written as `id[label]` or bare: records its name and its layer (the current subgraph).
  const declare = (text: string): string | null => {
    const node = text.trim().match(/^([\w.\-/#@:]+)([\s\S]*)$/);

    if (!node) return null;
    const id = node[1]!;
    const label = node[2]!.trim() === "" ? null : labelOf(node[2]!);

    if (label !== null) {
      const { name, description } = splitLabel(label);
      names.set(id, name);

      if (description) descriptions.set(id, description);
    }

    if (currentLayer !== null && !layerOfNode.has(id)) layerOfNode.set(id, currentLayer);

    return id;
  };

  for (const raw of body.split("\n")) {
    const line = raw.replace(/;\s*$/, "").trim();

    if (line === "" || line.startsWith("%%") || /^(flowchart|graph)\b/.test(line) || /^(classDef|class|style|linkStyle|click|direction)\b/.test(line)) continue;
    const subgraph = line.match(/^subgraph\s+(.+)$/);

    if (subgraph) {
      const head = subgraph[1]!.trim();
      const titled = head.match(/^([\w.\-/@]+)\s*(\[[\s\S]*\])?$/);
      let name = head;
      let description: string | undefined;

      if (titled) {
        name = titled[1]!;
        const label = titled[2] ? labelOf(titled[2]) : null;

        if (label !== null) {
          const split = splitLabel(label);
          name = split.name.split(" — ")[0]!.trim() || name;
          description = split.description ?? (split.name.includes(" — ") ? split.name.split(" — ").slice(1).join(" — ").trim() : undefined);
        }
      } else if (head.startsWith('"') || head.startsWith("[")) {
        name = head.replace(/^["[]+|["\]]+$/g, "");
      }

      currentLayer = name;

      if (!layers.some((layer) => layer.name === name)) layers.push(description ? { name, description } : { name });
      continue;
    }

    if (line === "end") {
      currentLayer = null;
      continue;
    }

    // Edges: `a --> b`, `a -->|label| b`, `a -- text --> b`, `a -.-> b`, `a ==> b`, `a --- b`; chains `a --> b --> c`.
    const parts = line.split(/\s*(?:-{2,}>|-\.->|-\.-|={2,}>|-{3,}|--\s*[^-]*?\s*-->)\s*/);

    if (parts.length > 1) {
      const labels = [...line.matchAll(/-->\s*\|([^|]*)\|/g)].map((hit) => hit[1]!.trim());
      const inline = [...line.matchAll(/--\s*([^-|>]+?)\s*-->/g)].map((hit) => hit[1]!.trim());
      let labelIndex = 0;

      for (let i = 0; i < parts.length - 1; i++) {
        const froms = splitNodes(parts[i]!.replace(/^\|[^|]*\|\s*/, "")).map((text) => declare(text)).filter((id): id is string => id !== null);
        const tos = splitNodes(parts[i + 1]!.replace(/^\|[^|]*\|\s*/, "")).map((text) => declare(text)).filter((id): id is string => id !== null);
        const label = labels[labelIndex] ?? inline[labelIndex];
        labelIndex++;

        for (const from of froms) for (const to of tos) edges.push(label ? { from, to, label } : { from, to });
      }

      continue;
    }

    for (const text of splitNodes(line)) declare(text);
  }

  // Modules and functions from every ID seen, named by their labels; a function sits in the module its name points to.
  const ids = new Set<string>([...names.keys(), ...layerOfNode.keys(), ...edges.flatMap((edge) => [edge.from, edge.to])]);

  const moduleEntry = (id: string, layer: string | undefined): IntentModule => {
    let module = modules.get(id);

    if (!module) {
      module = { id, fns: [] };

      if (layer) module.layer = layer;
      modules.set(id, module);
    } else if (layer && !module.layer) module.layer = layer;

    return module;
  };

  for (const id of ids) {
    const name = nameOf(id);
    const description = descriptions.get(id);
    const layer = layerOfNode.get(id);

    if (name.includes("#")) {
      const module = moduleEntry(moduleOf(name), layer);
      const fnName = name.slice(name.indexOf("#") + 1);

      if (!module.fns.some((fn) => fn.name === fnName)) module.fns.push(description ? { name: fnName, description } : { name: fnName });
    } else {
      const module = moduleEntry(name, layer);

      if (description && !module.description) module.description = description;
    }
  }

  const resolved = edges.map((edge) => ({ ...edge, from: nameOf(edge.from), to: nameOf(edge.to) })).filter((edge, i, all) => all.findIndex((other) => other.from === edge.from && other.to === edge.to) === i);

  return { layers, modules: [...modules.values()], edges: resolved, before, after };
}

/** A Mermaid ID for a name: letters, digits and underscores, unique within the block. */
function mermaidId(name: string): string {
  return `n_${name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

function mermaidLabel(name: string, description?: string): string {
  const text = description ? `${name}<br>${description}` : name;

  return `["${text.replace(/"/g, "#quot;")}"]`;
}

/** The Markdown of an intent: the prose as it was, the Mermaid block regenerated (layers as subgraphs, modules and functions as nodes, edges as arrows). */
export function intentMarkdown(intent: Intent): string {
  const lines = ["```mermaid", "flowchart LR"];
  const layers = [...intent.layers];

  for (const module of intent.modules) if (module.layer && !layers.some((layer) => layer.name === module.layer)) layers.push({ name: module.layer });
  const nodeLines = (module: IntentModule): string[] => [
    `${mermaidId(module.id)}${mermaidLabel(module.id, module.description)}`,
    ...module.fns.map((fn) => `${mermaidId(`${module.id}#${fn.name}`)}${mermaidLabel(`${module.id}#${fn.name}`, fn.description)}`),
  ];

  for (const layer of layers) {
    lines.push(`  subgraph ${mermaidId(layer.name)}["${layer.name}${layer.description ? ` — ${layer.description}` : ""}"]`);

    for (const module of intent.modules.filter((module) => module.layer === layer.name)) for (const line of nodeLines(module)) lines.push(`    ${line}`);
    lines.push("  end");
  }

  for (const module of intent.modules.filter((module) => !module.layer)) for (const line of nodeLines(module)) lines.push(`  ${line}`);

  for (const edge of intent.edges) lines.push(`  ${mermaidId(edge.from)} -->${edge.label ? `|${edge.label.replace(/\|/g, "/")}|` : ""} ${mermaidId(edge.to)}`);
  lines.push("```");
  const before = intent.before.trim() === "" ? EMPTY_BEFORE : intent.before.endsWith("\n\n") ? intent.before : `${intent.before.trimEnd()}\n\n`;
  const after = intent.after.trim() === "" ? "" : `\n${intent.after.replace(/^\n+/, "")}`;

  return `${before}${lines.join("\n")}\n${after}`;
}

/** The intent of a repository, or null without ARCHITECTURE.md. */
export function readIntent(root: string): Intent | null {
  const file = join(root, INTENT_FILE);

  return existsSync(file) ? parseIntent(readFileSync(file, "utf8")) : null;
}

export function writeIntent(root: string, intent: Intent): string {
  writeFileSync(join(root, INTENT_FILE), intentMarkdown(intent));
  syncConfigLayers(root, intent);

  return INTENT_FILE;
}

/**
 * archdiff.json's `layers` follow the intent: each intent layer gets the
 * directories of its modules as globs, so a file the agent adds beside an
 * intended one lands in the same lane. Other fields stay; a layer the
 * intent has but whose modules have no directory yet keeps any globs it
 * had.
 */
export function syncConfigLayers(root: string, intent: Intent): void {
  const file = join(root, CONFIG_FILE);
  let config: Record<string, JsonValue> = {};

  if (existsSync(file)) {
    try {
      const parsed = parseJson(readFileSync(file, "utf8"));

      if (isJsonObject(parsed)) config = { ...parsed };
    } catch {
      return;
    }
  }

  const previous = isJsonObject(config["layers"]) ? config["layers"] : {};
  const layers: Record<string, JsonValue> = {};
  const names = [...intent.layers.map((layer) => layer.name), ...intent.modules.map((module) => module.layer).filter((layer): layer is string => layer !== undefined)];

  const directoryOf = (id: string): string => id.slice(0, id.lastIndexOf("/"));

  for (const name of [...new Set(names)]) {
    const own = intent.modules.filter((module) => module.layer === name && module.id.includes("/"));
    const foreign = intent.modules.filter((module) => module.layer !== name && module.id.includes("/")).map((module) => directoryOf(module.id));
    // A directory is the layer's glob only when no other layer lives in it or below it; else the files themselves,
    // so `src/main.ts` in "entry" does not make `src/**` swallow `src/http/**`.
    const directories = [...new Set(own.map((module) => {
      const directory = directoryOf(module.id);

      return foreign.some((other) => other === directory || other.startsWith(`${directory}/`)) ? module.id : `${directory}/**`;
    }))].sort();
    const kept = previous[name];
    if (directories.length > 0) layers[name] = directories;
    else if (Array.isArray(kept)) layers[name] = kept;
    else layers[name] = [];
  }

  if (Object.keys(layers).length === 0) return;
  // The intent's layers come first (the first matching glob wins, so a specific intent layer beats a template's catch-all
  // like `app: src/**`); the configured layers the intent does not name follow with their globs.
  const rest: Record<string, JsonValue> = {};

  for (const [name, globs] of Object.entries(previous)) if (!(name in layers)) rest[name] = globs;
  config["layers"] = { ...layers, ...rest };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

/** What every agent run is told about archdiff: the file that is the contract, and how to ask the user. */
export const AGENT_PROTOCOL = `## Working with archdiff

- \`${INTENT_FILE}\` holds the intended architecture as a Mermaid flowchart: a subgraph is a layer, a node's label is a file path (then what it does), an arrow is an import. It is the contract: when you add a module or an import between layers, add it there too; when the task is about the diagram itself, edit only that file and keep the Mermaid valid.
- When a decision is the user's to make — a name, a library, a split, a trade-off — do not guess. Write exactly one fenced block \`\`\`archdiff-question with JSON {"question": "…", "options": ["…", "…"]} (two to four short options) and stop; the answer comes as your next message.
- Finish with the files you changed as a list of \`file:line\`.`;

/** The prompt that turns a document (a design note, an ISD, a spec in prose) into the Mermaid block of the intent. */
export function documentPrompt(text: string, lang: string | null): string {
  return `Read the document below and write the intended architecture of the project it describes as ONE Mermaid flowchart, nothing else around it.

Rules of the flowchart:
- \`flowchart LR\`; one \`subgraph name["name — what the layer is for"]\` per layer, in the order a request flows (entry first, storage last).
- One node per module: \`id["path/file.${lang ?? "ts"}<br>what it does"]\`; the path is relative to the repository root, under \`src/\` unless the document says otherwise; the id is letters and underscores only.
- One arrow \`a --> b\` per import a module makes; a label \`-->|why|\` where the reason is not obvious.
- Six to twenty modules; no libraries or frameworks as nodes (name them in a module's description instead).
- If the document leaves a real choice open, still choose and say so in the layer description.

Answer with the Mermaid block only.

---

${text}`;
}


/** A module's layer by the intent, else by the code (archdiff.json or the directory). */
function layerOf(intent: Intent, graph: Graph, id: string): string | undefined {
  return intent.modules.find((module) => module.id === id)?.layer ?? graph.modules.get(id)?.layer;
}

/**
 * The intent drawn against the code: lanes are the intent's layers, shapes
 * its modules and functions — plain when the code has them, `planned`
 * (dashed blue) when not yet — plus, in those layers, the code's modules
 * the intent does not name (`warning`, orange). Lines likewise: planned
 * when the import or call is not in the code, orange when the code has
 * one the intent does not.
 */
export function intentView(analysis: Analysis, intent: Intent | null): Diagram {
  if (!intent) return { view: "intent", title: "Intent", nodes: [], edges: [], groups: [], reason: `no ${INTENT_FILE}: archdiff intent --init writes one from the code, archdiff import <file> from a document, or draw here and run the agent` };
  const { graph } = analysis;
  const layerNames = [...intent.layers.map((layer) => layer.name)];

  for (const module of intent.modules) if (module.layer && !layerNames.includes(module.layer)) layerNames.push(module.layer);
  const nodes: DiagramNode[] = [];
  const edges: DiagramEdge[] = [];
  const shown = new Set<string>();
  let planned = 0;
  let beyond = 0;

  for (const module of intent.modules) {
    const built = graph.modules.has(module.id);
    // The path is the label; the description goes to the panel (`doc`), where it has room.
    const node: DiagramNode = { id: module.id, kind: "module", label: module.id, ref: { id: module.id, file: module.id, line: 1 }, x: 0, y: 0, w: 0, h: 0 };

    if (module.layer) node.group = module.layer;

    if (!built) {
      node.diff = "planned";
      planned++;
    }

    if (module.description) node.doc = module.description;
    nodes.push(node);
    shown.add(module.id);

    for (const fn of module.fns) {
      const id = `${module.id}#${fn.name}`;
      const real = graph.nodes.get(id);
      const fnNode: DiagramNode = { id, kind: "fn", label: fn.name, ref: real ? { id, file: real.module, line: real.line, endLine: real.endLine } : { id, file: module.id }, x: 0, y: 0, w: 0, h: 0 };

      if (module.layer) fnNode.group = module.layer;

      if (!real) {
        fnNode.diff = "planned";
        planned++;
      }

      if (fn.description) fnNode.doc = fn.description;
      nodes.push(fnNode);
      shown.add(id);
    }
  }

  // The code's modules of the intent's layers that the intent does not name: beyond the drawing.
  const layerSet = new Set(layerNames);

  for (const module of [...graph.modules.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (shown.has(module.id) || !layerSet.has(module.layer)) continue;
    nodes.push({ id: module.id, kind: "module", label: `${module.id}\nnot in the intent`, ref: { id: module.id, file: module.id, line: 1 }, group: module.layer, diff: "warning", x: 0, y: 0, w: 0, h: 0 });
    shown.add(module.id);
    beyond++;
  }

  const seen = new Set<string>();

  const push = (edge: DiagramEdge): void => {
    const key = `${edge.from}\u0000${edge.to}`;

    if (seen.has(key) || edge.from === edge.to) return;
    seen.add(key);
    edges.push(edge);
  };

  const inCode = (from: string, to: string): boolean => (from.includes("#") || to.includes("#") ? graph.calls.some((call) => call.from === from && call.to === to) : graph.deps.some((dep) => dep.from === from && dep.to === to));

  for (const edge of intent.edges) {
    if (!shown.has(edge.from) || !shown.has(edge.to)) continue;
    const kind = edge.from.includes("#") || edge.to.includes("#") ? "call" : "dependency";
    const line: DiagramEdge = { from: edge.from, to: edge.to, kind };

    if (edge.label) line.label = edge.label;

    if (!inCode(edge.from, edge.to)) line.diff = "planned";
    push(line);
  }

  const intended = new Set(intent.edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  let extra = 0;

  for (const dep of graph.deps) {
    if (!shown.has(dep.from) || !shown.has(dep.to) || dep.typeOnly || intended.has(`${dep.from}\u0000${dep.to}`)) continue;
    push({ from: dep.from, to: dep.to, kind: "dependency", diff: "warning" });
    extra++;
  }

  const groups: DiagramGroup[] = layerNames.map((name) => ({ id: name, label: intent.layers.find((layer) => layer.name === name)?.description ? `${name} — ${intent.layers.find((layer) => layer.name === name)!.description}` : name, kind: "lane", x: 0, y: 0, w: 0, h: 0 }));
  const parts = [planned > 0 ? `${planned} planned, not built yet (dashed)` : "everything planned is built", beyond > 0 ? `${beyond} modules beyond the intent (orange)` : "", extra > 0 ? `${extra} imports beyond the intent (orange)` : ""].filter(Boolean);

  return { view: "intent", title: `Intent: ${INTENT_FILE} against the code`, nodes, edges, groups, reason: parts.join("; "), question: "what was intended, what is built, and where the code went beyond the intent" };
}

export interface IntentReport {
  /** Intended modules and functions the code lacks. */
  planned: string[];
  /** Intended imports and calls the code lacks. */
  plannedEdges: string[];
  /** The code's modules in the intent's layers that the intent does not name. */
  beyond: string[];
  /** Imports between two of the intent's layers that no intended import allows: the violations. */
  violations: { from: string; to: string; fromLayer: string; toLayer: string; line: number }[];
  /** Imports among intended modules that the intent does not name (same or allowed layers). */
  unintended: string[];
  ok: boolean;
}

/**
 * The code against the intent. A layer pair is allowed when some intended
 * import crosses it; an import of the code between two intent layers
 * without such a pair is a violation (the exit code of `check`). What is
 * planned and not built, what is built beyond the intent, and imports
 * the intent does not name are listed too, as news, not failures.
 */
export function checkIntent(analysis: Analysis, intent: Intent): IntentReport {
  const { graph } = analysis;
  const layers = new Set([...intent.layers.map((layer) => layer.name), ...intent.modules.map((module) => module.layer).filter((layer): layer is string => layer !== undefined)]);
  const allowed = new Set<string>();

  for (const edge of intent.edges) {
    const from = layerOf(intent, graph, moduleOf(edge.from));
    const to = layerOf(intent, graph, moduleOf(edge.to));

    if (from && to) allowed.add(`${from}\u0000${to}`);
  }

  const planned: string[] = [];

  for (const module of intent.modules) {
    if (!graph.modules.has(module.id)) planned.push(module.id);

    for (const fn of module.fns) if (!graph.nodes.has(`${module.id}#${fn.name}`)) planned.push(`${module.id}#${fn.name}`);
  }

  const plannedEdges = intent.edges
    .filter((edge) => (edge.from.includes("#") || edge.to.includes("#") ? !graph.calls.some((call) => call.from === edge.from && call.to === edge.to) : !graph.deps.some((dep) => dep.from === edge.from && dep.to === edge.to)))
    .map((edge) => `${edge.from} → ${edge.to}`);
  const named = new Set(intent.modules.map((module) => module.id));
  const beyond = [...graph.modules.values()].filter((module) => layers.has(module.layer) && !named.has(module.id)).map((module) => module.id).sort();
  const intended = new Set(intent.edges.map((edge) => `${edge.from}\u0000${edge.to}`));
  const violations: IntentReport["violations"] = [];
  const unintended: string[] = [];

  for (const dep of graph.deps) {
    if (dep.typeOnly || dep.from === dep.to) continue;
    const fromLayer = layerOf(intent, graph, dep.from);
    const toLayer = layerOf(intent, graph, dep.to);

    if (!fromLayer || !toLayer || !layers.has(fromLayer) || !layers.has(toLayer)) continue;

    if (fromLayer !== toLayer && !allowed.has(`${fromLayer}\u0000${toLayer}`)) violations.push({ from: dep.from, to: dep.to, fromLayer, toLayer, line: dep.line });
    else if (named.has(dep.from) && named.has(dep.to) && !intended.has(`${dep.from}\u0000${dep.to}`)) unintended.push(`${dep.from} → ${dep.to} (${dep.from}:${dep.line})`);
  }

  return { planned, plannedEdges, beyond, violations, unintended: [...new Set(unintended)], ok: violations.length === 0 };
}

export function checkMarkdown(report: IntentReport, root: string): string {
  const lines = [`<!-- archdiff:generated — check -->`, `# Check: the code of ${root} against ${INTENT_FILE}`, ""];
  lines.push(report.ok ? "**No import between layers goes against the intent.**" : `**${report.violations.length} ${report.violations.length === 1 ? "import goes" : "imports go"} against the intent.**`, "");

  if (report.violations.length > 0) {
    lines.push("## Violations", "");

    for (const violation of report.violations) lines.push(`- \`${violation.from}:${violation.line}\` imports \`${violation.to}\`: layer **${violation.fromLayer}** → **${violation.toLayer}** is not in the intent. Add the arrow to ${INTENT_FILE} if it is wanted, else move the import.`);
    lines.push("");
  }

  if (report.planned.length > 0) lines.push(`## Planned, not built (${report.planned.length})`, "", ...report.planned.map((item) => `- \`${item}\``), "");

  if (report.plannedEdges.length > 0) lines.push(`## Planned imports and calls, not built (${report.plannedEdges.length})`, "", ...report.plannedEdges.map((item) => `- ${item}`), "");

  if (report.beyond.length > 0) lines.push(`## Built beyond the intent (${report.beyond.length})`, "", ...report.beyond.map((item) => `- \`${item}\` — name it in ${INTENT_FILE}, or it is a drift`), "");

  if (report.unintended.length > 0) lines.push(`## Imports the intent does not name (${report.unintended.length})`, "", ...report.unintended.map((item) => `- ${item}`), "");

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * The plan drawn on a view folded into the intent: new modules, functions
 * and layers added, arrows as edges (their ends named in the intent too,
 * with the layer the code gives them), removals taken out, notes kept
 * under the block.
 */
export function mergePlan(intent: Intent, plan: Plan, graph: Graph | null = null): Intent {
  const next: Intent = { ...intent, layers: [...intent.layers], modules: intent.modules.map((module) => ({ ...module, fns: [...module.fns] })), edges: [...intent.edges] };

  const module = (id: string, layer?: string): IntentModule => {
    let found = next.modules.find((candidate) => candidate.id === id);

    if (!found) {
      found = { id, fns: [] };

      if (layer) found.layer = layer;
      next.modules.push(found);
    } else if (layer && !found.layer) found.layer = layer;

    if (layer && !next.layers.some((candidate) => candidate.name === layer)) next.layers.push({ name: layer });

    return found;
  };

  for (const node of plan.added) {
    if (node.kind === "layer") {
      if (!next.layers.some((layer) => layer.name === node.name)) next.layers.push({ name: node.name });
    } else if (node.kind === "module") module(node.name, node.layer);
    else if (node.module) {
      const owner = module(node.module, node.layer);

      if (!owner.fns.some((fn) => fn.name === node.name)) owner.fns.push({ name: node.name });
    }
  }

  for (const edge of plan.edges) {
    for (const end of [edge.from.label, edge.to.label]) {
      const owner = moduleOf(end);
      const layer = graph?.modules.get(owner)?.layer;
      const found = module(owner, next.modules.find((candidate) => candidate.id === owner)?.layer ?? layer);

      if (end.includes("#")) {
        const fnName = end.slice(end.indexOf("#") + 1);

        if (!found.fns.some((fn) => fn.name === fnName)) found.fns.push({ name: fnName });
      }
    }

    if (!next.edges.some((candidate) => candidate.from === edge.from.label && candidate.to === edge.to.label)) next.edges.push({ from: edge.from.label, to: edge.to.label });
  }

  // A module drawn without a lane takes the layer the code gives it, when the code has it.
  for (const candidate of next.modules) {
    const layer = graph?.modules.get(candidate.id)?.layer;

    if (!candidate.layer && layer) {
      candidate.layer = layer;

      if (!next.layers.some((known) => known.name === layer)) next.layers.push({ name: layer });
    }
  }

  for (const removal of plan.removed) {
    next.modules = next.modules.filter((candidate) => candidate.id !== removal.label);

    for (const candidate of next.modules) candidate.fns = candidate.fns.filter((fn) => `${candidate.id}#${fn.name}` !== removal.label);
    next.edges = next.edges.filter((edge) => edge.from !== removal.label && edge.to !== removal.label && moduleOf(edge.from) !== removal.label && moduleOf(edge.to) !== removal.label);
  }

  if (plan.notes.length > 0) next.after = `${next.after.trimEnd()}\n\n## Notes from the drawing\n\n${plan.notes.map((note) => `- ${note}`).join("\n")}\n`;

  return next;
}

/** An intent seeded from the code: its layers, every module in its layer, and the imports among them. The start for a repository that has code but no contract yet. */
export function intentFromCode(analysis: Analysis): Intent {
  const { graph } = analysis;
  const layers = graph.layers.map((name) => ({ name }));
  const modules: IntentModule[] = [...graph.modules.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((module) => ({ id: module.id, layer: module.layer, fns: [] }));
  const edges: IntentEdge[] = [];
  const seen = new Set<string>();

  for (const dep of graph.deps) {
    if (dep.typeOnly || !graph.modules.has(dep.to) || dep.from === dep.to || seen.has(`${dep.from}\u0000${dep.to}`)) continue;
    seen.add(`${dep.from}\u0000${dep.to}`);
    edges.push({ from: dep.from, to: dep.to });
  }

  return { layers, modules, edges, before: EMPTY_BEFORE, after: "" };
}
