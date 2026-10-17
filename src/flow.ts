// The data-flow view of a call tree, without running anything: the steps
// from an entry point in call order, each with its parameters and return
// type as the signature writes them, the storages on the way (modules
// whose name or imports say they hold data), and the mock values the user
// attached — an input for the entry, a content for a storage — carried
// to every parameter or property of the same name. What it shows is what
// the types and the names say; a value that reaches a step by another
// route is not claimed. Optional on the page (the Flow tab).
//
// Pure: Analysis + entry + mocks → DataFlow. Entry points: `dataFlow`,
// `parseSignature`, `storageOf`, `DataFlow`.

import type { Analysis } from "./analyze.ts";
import { moduleOf, type GraphNode } from "./graph.ts";
import type { Mock } from "./scene.ts";

export interface FlowParam {
  name: string;
  type: string;
  /** A mock value carried here, as JSON text, and where it came from. */
  value?: string;
  from?: string;
}

export interface FlowStep {
  id: string;
  name: string;
  module: string;
  line: number;
  /** The depth from the entry: 0 the entry itself. */
  depth: number;
  /** The step that calls this one. */
  caller: string | null;
  params: FlowParam[];
  returns: string | null;
  /** The storage the step's module is, when it is one: the package or the name that says so. */
  storage?: string;
  /** The mock content of the storage, when the user gave one. */
  content?: string;
  /** Calls from this step archdiff could not follow. */
  gaps: number;
}

export interface DataFlow {
  entry: string;
  steps: FlowStep[];
  /** The storages of the tree, for the mock panel. */
  storages: { id: string; module: string; storage: string; content?: string }[];
  /** The mock input of the entry as given, when any. */
  input?: string;
}

/** Packages whose import makes a module a storage. */
const STORAGE_PACKAGES: Record<string, string> = {
  pg: "PostgreSQL (pg)",
  postgres: "PostgreSQL (postgres)",
  mysql: "MySQL",
  mysql2: "MySQL (mysql2)",
  mongoose: "MongoDB (mongoose)",
  mongodb: "MongoDB",
  "@prisma/client": "Prisma",
  redis: "Redis",
  ioredis: "Redis (ioredis)",
  knex: "SQL (knex)",
  typeorm: "TypeORM",
  sequelize: "Sequelize",
  "better-sqlite3": "SQLite",
  sqlite3: "SQLite",
  "drizzle-orm": "Drizzle",
  "@aws-sdk/client-dynamodb": "DynamoDB",
  "@aws-sdk/client-s3": "S3",
  "firebase-admin": "Firebase",
  "node:fs": "the file system",
};

/** A module path that names a store: `store`, `db`, `repository`, `cache`… as a path segment or file name. */
const STORAGE_NAME = /(^|\/)(db|database|store|stores|storage|repo|repos|repository|repositories|cache|persistence|dao|models?)(\/|\.|$)/i;

/** Why a module is a storage, or null. */
export function storageOf(analysis: Analysis, module: string): string | null {
  const { graph } = analysis;

  for (const dep of graph.deps) {
    if (dep.from !== module || dep.typeOnly) continue;
    const external = graph.externals.get(dep.to);

    if (!external) continue;
    const key = external.kind === "builtin" ? `node:${external.name}` : external.name;

    if (STORAGE_PACKAGES[key]) return STORAGE_PACKAGES[key]!;
  }

  const match = module.match(STORAGE_NAME);

  return match ? `named ${match[2]}` : null;
}

/** `(a: T, b?: U = 1) → R` → the parameters and the return type; a signature archdiff does not understand gives no parameters. */
export function parseSignature(signature: string | null): { params: FlowParam[]; returns: string | null } {
  if (!signature || !signature.startsWith("(")) return { params: [], returns: null };
  // The parameter list ends at the parenthesis that balances the first.
  let depth = 0;
  let end = -1;

  for (let i = 0; i < signature.length; i++) {
    const char = signature[i];

    if (char === "(" || char === "[" || char === "{" || char === "<") depth++;
    else if (char === ")" || char === "]" || char === "}" || char === ">") depth--;

    if (depth === 0) {
      end = i;
      break;
    }
  }

  if (end === -1) return { params: [], returns: null };
  const inside = signature.slice(1, end);
  const rest = signature.slice(end + 1).replace(/^\s*(→|=>|:)\s*/, "").trim();
  const params: FlowParam[] = [];
  let current = "";
  depth = 0;

  const push = (): void => {
    const text = current.trim();
    current = "";

    if (text === "") return;
    const at = text.search(/[?:=]/);
    const name = (at === -1 ? text : text.slice(0, at)).replace(/^\.\.\./, "").trim();
    const typeMatch = text.match(/:\s*([^=]+?)(\s*=.*)?$/);
    params.push({ name, type: typeMatch ? typeMatch[1]!.trim() : "unknown" });
  };

  for (const char of inside) {
    if (char === "(" || char === "[" || char === "{" || char === "<") depth++;
    else if (char === ")" || char === "]" || char === "}" || char === ">") depth--;

    if (char === "," && depth === 0) push();
    else current += char;
  }

  push();

  return { params, returns: rest === "" ? null : rest };
}

/** The keys of a JSON object text, with each value as JSON text; nothing for other JSON. */
function fields(text: string): Map<string, string> {
  const out = new Map<string, string>();

  try {
    const parsed: unknown = JSON.parse(text);

    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) out.set(key, JSON.stringify(value));
  } catch {
    // Not JSON: the mock stays a text the panel shows as it is.
  }

  return out;
}

/** The steps from `entry` over resolved calls, depth first in call order, `depth` levels, with the mocks carried by name. */
export function dataFlow(analysis: Analysis, entry: string, mocks: readonly Mock[], depth = 4): DataFlow {
  const { graph } = analysis;
  const start = graph.nodes.get(entry);
  const steps: FlowStep[] = [];
  const storages: DataFlow["storages"] = [];

  if (!start) return { entry, steps, storages };
  const input = mocks.find((mock) => mock.kind === "input" && mock.id === entry)?.value;
  const inputFields = input === undefined ? new Map<string, string>() : fields(input);
  const storageMocks = new Map(mocks.filter((mock) => mock.kind === "storage").map((mock) => [mock.id, mock.value]));
  const callsFrom = new Map<string, { to: string; line: number }[]>();

  for (const call of graph.calls) if (call.kind === "call") callsFrom.set(call.from, [...(callsFrom.get(call.from) ?? []), { to: call.to, line: call.line }]);
  const gapsFrom = new Map<string, number>();

  for (const gap of graph.gaps) if (gap.reason === "dynamic" || gap.reason === "unknown-member" || gap.reason === "interface") gapsFrom.set(gap.from, (gapsFrom.get(gap.from) ?? 0) + 1);
  const seen = new Set<string>();
  const storageCache = new Map<string, string | null>();
  // The storage fields seen so far on the path: a parameter named like a field of a mocked storage reads it.
  const known = new Map<string, { value: string; from: string }>();

  for (const [key, value] of inputFields) known.set(key, { value, from: "input" });

  const visit = (node: GraphNode, level: number, caller: string | null): void => {
    if (seen.has(node.id) || level > depth) return;
    seen.add(node.id);
    const module = moduleOf(node.id);
    let storage = storageCache.get(module);

    if (storage === undefined) {
      storage = storageOf(analysis, module);
      storageCache.set(module, storage);
    }

    const { params, returns } = parseSignature(node.signature);

    for (const param of params) {
      // `{ request, context }`: each key of the pattern is a name of its own; the value carried is the object of those keys.
      const names = param.name.startsWith("{") ? param.name.replace(/^\{|\}$/g, "").split(",").map((part) => part.split(":")[0]!.trim()).filter((name) => name !== "" && name !== "...") : [param.name];
      const carried = names.map((name) => [name, known.get(name)] as const).filter((entry): entry is readonly [string, { value: string; from: string }] => entry[1] !== undefined);

      if (carried.length === 1 && names.length === 1) {
        param.value = carried[0]![1].value;
        param.from = carried[0]![1].from;
      } else if (carried.length > 0) {
        param.value = `{ ${carried.map(([name, entry]) => `${name}: ${entry.value}`).join(", ")} }`;
        param.from = [...new Set(carried.map(([, entry]) => entry.from))].join(", ");
      }
    }

    const step: FlowStep = { id: node.id, name: node.parent ? `${node.parent}.${node.name}` : node.name, module, line: node.line, depth: level, caller, params, returns, gaps: gapsFrom.get(node.id) ?? 0 };

    if (storage) {
      step.storage = storage;
      const content = storageMocks.get(node.id) ?? storageMocks.get(module);

      if (content !== undefined) {
        step.content = content;

        for (const [key, value] of fields(content)) if (!known.has(key)) known.set(key, { value, from: `storage ${module}` });
      }

      if (!storages.some((candidate) => candidate.module === module)) {
        const row: DataFlow["storages"][number] = { id: module, module, storage };

        if (content !== undefined) row.content = content;
        storages.push(row);
      }
    }

    steps.push(step);
    const calls = (callsFrom.get(node.id) ?? []).sort((a, b) => a.line - b.line);

    for (const call of calls) {
      const next = graph.nodes.get(call.to);

      if (next) visit(next, level + 1, node.id);
    }
  };

  visit(start, 0, null);
  const flow: DataFlow = { entry, steps, storages };

  if (input !== undefined) flow.input = input;

  return flow;
}

/** The flow as Markdown: a numbered list of steps with their values, and the storages. */
export function flowMarkdown(flow: DataFlow): string {
  const lines = [`<!-- archdiff:generated — flow ${flow.entry} -->`, `# Data flow from ${flow.entry}`, ""];

  if (flow.steps.length === 0) {
    lines.push("_no such function_");

    return `${lines.join("\n")}\n`;
  }

  lines.push(flow.input === undefined ? "No mock input: attach one on the Flow tab to see values carried by name." : `Mock input: \`${flow.input}\``, "");

  for (const step of flow.steps) {
    const indent = "  ".repeat(step.depth);
    const params = step.params.map((param) => `${param.name}: ${param.type}${param.value !== undefined ? ` = ${param.value} (${param.from})` : ""}`).join(", ");
    lines.push(`${indent}- **${step.name}**(${params})${step.returns ? ` → ${step.returns}` : ""} — ${step.module}:${step.line}${step.storage ? ` — storage: ${step.storage}${step.content !== undefined ? ` holds \`${step.content}\`` : ""}` : ""}${step.gaps > 0 ? ` — ${step.gaps} calls not followed` : ""}`);
  }

  if (flow.storages.length > 0) {
    lines.push("", "## Storages on the way", "");

    for (const storage of flow.storages) lines.push(`- ${storage.module} — ${storage.storage}${storage.content !== undefined ? ` — mock: \`${storage.content}\`` : ""}`);
  }

  return `${lines.join("\n")}\n`;
}

/** A JSON value for a TypeScript-ish type, for a mock: `string` → "example", `number` → 1, an object literal type field by field, an array empty, a union its first literal. */
export function mockFromType(type: string, name = "value"): unknown {
  const text = type.trim().replace(/\s*\|\s*(undefined|null)$/, "");

  // A union: its first member stands for it (`'a' | 'b'` → "a").
  if (text.includes("|") && !/^\{/.test(text)) return mockFromType(text.split("|")[0]!, name);

  if (/^['"`]/.test(text)) return text.replace(/^['"`]|['"`]$/g, "");

  if (/^(string|String)$/.test(text)) return /id$/i.test(name) ? `${name.replace(/Id$|_id$/i, "") || "id"}-1` : "example";

  if (/^(number|bigint|Number)$/.test(text)) return 1;

  if (/^(boolean|Boolean)$/.test(text)) return true;

  if (/^(Date)$/.test(text)) return "2026-01-01T00:00:00.000Z";

  if (/\[\]$/.test(text) || /^(Array|ReadonlyArray|Set)</.test(text)) return [];

  if (/^(Record|Map)</.test(text)) return {};

  if (/^\{/.test(text)) {
    // `{ a: T; b?: U }`: shallow, one level of nesting kept by the balanced split.
    const inside = text.slice(1, text.lastIndexOf("}"));
    const out: Record<string, unknown> = {};
    let depth = 0;
    let current = "";
    const fields: string[] = [];

    for (const char of inside) {
      if (char === "{" || char === "(" || char === "<") depth++;
      else if (char === "}" || char === ")" || char === ">") depth--;

      if ((char === ";" || char === ",") && depth === 0) {
        fields.push(current);
        current = "";
      } else current += char;
    }

    fields.push(current);

    for (const field of fields) {
      const at = field.indexOf(":");

      if (at === -1) continue;
      const key = field.slice(0, at).replace(/\?$/, "").trim();

      if (key) out[key] = mockFromType(field.slice(at + 1), key);
    }

    return out;
  }

  if (/^(void|undefined|null|never|unknown|any)$/.test(text)) return null;

  // A named type: an object with the name as a hint, so the user sees what to fill.
  return { [`<${text}>`]: "fill in" };
}

/** Mocks from the types alone: the entry's parameters as an object, every storage as `{ "rows": [] }`. */
export function mocksFromTypes(flow: DataFlow): { input: Record<string, unknown>; storages: Record<string, unknown> } {
  const entry = flow.steps[0];
  const input: Record<string, unknown> = {};

  for (const param of entry?.params ?? []) {
    if (param.name.startsWith("{")) {
      const object = mockFromType(param.type, param.name);

      if (object && typeof object === "object" && !Array.isArray(object)) Object.assign(input, object);
    } else input[param.name] = mockFromType(param.type, param.name);
  }

  const storages: Record<string, unknown> = {};

  for (const storage of flow.storages) storages[storage.module] = { rows: [] };

  return { input, storages };
}

/** What to ask an agent for: JSON mocks for the entry's parameters and the storages, shaped by the types, following the description. */
export function mockPrompt(flow: DataFlow, description: string): string {
  const entry = flow.steps[0];
  const lines = [
    `Produce realistic mock data for a run of \`${flow.entry}\`, as one JSON object and nothing else (no prose, no code fence).`,
    "",
    "Shape:",
    '{ "input": { <one key per parameter of the entry> }, "storages": { "<module path>": <what that storage holds before the run, as JSON> } }',
    "",
    "Parameters of the entry:",
    ...(entry?.params.map((param) => `- ${param.name}: ${param.type}`) ?? ["- (none)"]),
    "",
    "Storages on the way (module — what it is):",
    ...(flow.storages.length > 0 ? flow.storages.map((storage) => `- ${storage.module} — ${storage.storage}`) : ["- (none)"]),
    "",
    "Steps the run goes through, with their parameter types, to make the values consistent:",
    ...flow.steps.slice(0, 20).map((step) => `- ${step.name}(${step.params.map((param) => `${param.name}: ${param.type}`).join(", ")})${step.returns ? ` → ${step.returns}` : ""} — ${step.module}:${step.line}`),
  ];

  if (description.trim() !== "") lines.push("", "The user describes the scenario as:", description.trim());

  return lines.join("\n");
}

/** The JSON object in an agent's answer, when there is one. */
export function jsonInAnswer(text: string): { input?: Record<string, unknown>; storages?: Record<string, unknown> } | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end <= start) return null;

  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));

    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as { input?: Record<string, unknown>; storages?: Record<string, unknown> }) : null;
  } catch {
    return null;
  }
}
