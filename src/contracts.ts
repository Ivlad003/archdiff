// The contract of an API operation as the code uses it: what the call sites
// send (the first argument's shape, merged across them) and what the code
// reads of the result — directly (`const { data } = await op(); data.x`),
// or through a function that returns (a part of) the result, followed up to
// four calls. Custom attributes (`c_…`) among the fields read are listed on
// their own: the platform's extensions the storefront depends on.
//
// Sits over the graph and the facts (apiCalls, CallFact.shape, FileFacts.reads,
// DeclFact.returnsFrom); the operation pages, the `apis` report and the
// Postman export read it. Pure: computed once per analysis.
//
// Entry points: `contractsOf`, `contractsMarkdown`, `sendsText`, `readsText`.

import type { Analysis } from "./analyze.ts";
import { operationLabel, operationOf, operationId, API_SHORT, type ApiOperation } from "./apis.ts";
import type { ShapeFact, ShapeValue } from "./extract/facts.ts";
import { moduleOf } from "./graph.ts";
import { counted } from "./words.ts";

/** What a field holds across the call sites that send it: how many send it, as what, with which literals, names and declared types. */
export interface ContractField {
  count: number;
  kinds: string[];
  /** Literal values and names as written, a few. */
  texts: string[];
  /** The declared types of the names sent (`PaymentInstrument`). */
  types: string[];
  fields?: ContractShape;
  items?: ContractField;
}

export type ContractShape = Record<string, ContractField>;

export interface OperationContract {
  operation: ApiOperation;
  /** How many call sites, and the modules they are in. */
  calls: number;
  callers: string[];
  sends: ContractShape;
  /** The fields read of the result, each with how many reads: `data.productItems.c_fromStoreId`. */
  reads: { path: string; count: number }[];
  /** The custom attributes (`c_…`) among the fields read. */
  custom: string[];
}

const contracts = new WeakMap<Analysis, Map<string, OperationContract>>();

/** The contracts of every operation the code calls, by operation ID; computed once per analysis. */
export function contractsOf(analysis: Analysis): Map<string, OperationContract> {
  let known = contracts.get(analysis);

  if (!known) {
    known = computeContracts(analysis);
    contracts.set(analysis, known);
  }

  return known;
}

/** Up to this many literals or names a field keeps as examples. */
const EXAMPLES = 6;
/** How many functions a read's value is followed back through (`const b = await getBasket(); b.x` → getBasket returns an operation's data). */
const RETURN_HOPS = 4;

function computeContracts(analysis: Analysis): Map<string, OperationContract> {
  const { graph, facts } = analysis;
  const families = new Set(Object.keys(analysis.scapi.table));
  const out = new Map<string, OperationContract>();

  const entry = (operation: ApiOperation): OperationContract => {
    const id = operationId(operation);
    let found = out.get(id);

    if (!found) {
      found = { operation, calls: 0, callers: [], sends: {}, reads: [], custom: [] };
      out.set(id, found);
    }

    return found;
  };

  // What each call site sends, merged per operation.
  for (const call of graph.apiCalls) {
    const contract = entry(call);
    contract.calls++;
    const module = moduleOf(call.from);

    if (!contract.callers.includes(module)) contract.callers.push(module);

    if (call.shape) mergeShape(contract.sends, call.shape);
  }

  // What is read of each operation's result: directly, or through the functions that return it.
  const edgesAt = new Map<string, string[]>();

  for (const edge of graph.calls) {
    if (edge.kind !== "call") continue;
    const key = `${moduleOf(edge.from)}\u0000${edge.line}`;
    edgesAt.set(key, [...(edgesAt.get(key) ?? []), edge.to]);
  }

  const sources = new Map<string, { operation: ApiOperation; prefix: string[] } | null>();

  /** The operation a call at `line` of `module` gives the result of, with the path of the part the function returns, followed `hops` deep. */
  const sourceOf = (module: string, line: number, hops: number): { operation: ApiOperation; prefix: string[] } | null => {
    const key = `${module}\u0000${line}`;

    if (sources.has(key)) return sources.get(key)!;
    sources.set(key, null);
    let found: { operation: ApiOperation; prefix: string[] } | null = null;

    // The operation called at that line, else a function called there that returns an operation's result.
    const direct = graph.apiCalls.find((call) => moduleOf(call.from) === module && call.line === line);

    if (direct) found = { operation: direct, prefix: [] };
    else if (hops < RETURN_HOPS) {
      for (const target of edgesAt.get(key) ?? []) {
        const node = graph.nodes.get(target);
        const returned = node ? declOf(facts, node.module, node.name, node.parent ?? null)?.returnsFrom : undefined;

        if (!returned) continue;
        const operation = operationOf(returned, families);
        const below = operation ? { operation, prefix: [] } : sourceOf(node!.module, returned.callLine, hops + 1);

        if (below) {
          found = { operation: below.operation, prefix: [...below.prefix, ...returned.path] };
          break;
        }
      }
    }

    sources.set(key, found);

    return found;
  };

  const counts = new Map<string, Map<string, number>>();

  for (const file of facts.values()) {
    for (const read of file.reads ?? []) {
      const direct = operationOf(read, families);
      const source = direct ? { operation: direct, prefix: [] } : sourceOf(file.path, read.callLine, 0);

      if (!source) continue;
      const id = operationId(source.operation);
      const path = [...source.prefix, ...read.path].join(".");
      const byPath = counts.get(id) ?? new Map<string, number>();
      byPath.set(path, (byPath.get(path) ?? 0) + 1);
      counts.set(id, byPath);
      entry(source.operation);
    }
  }

  for (const [id, byPath] of counts) {
    const contract = out.get(id)!;
    contract.reads = [...byPath].map(([path, count]) => ({ path, count })).sort((a, b) => (a.path < b.path ? -1 : 1));
    contract.custom = [...new Set(contract.reads.flatMap((read) => read.path.split(".").filter((segment) => segment.startsWith("c_"))))].sort();
  }

  return new Map([...out].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

/** The declaration fact of a node, by its module, name and class. */
function declOf(facts: Analysis["facts"], module: string, name: string, parent: string | null) {
  const file = facts.get(module);

  if (!file) return undefined;

  if (parent === null) return file.decls.find((decl) => decl.name === name);

  return file.decls.find((decl) => decl.name === parent)?.members.find((member) => member.name === name);
}

/** A shape merged into the contract's: counts, kinds, examples and types per key, nested objects and arrays followed. */
function mergeShape(into: ContractShape, shape: ShapeFact): void {
  for (const [key, value] of Object.entries(shape)) {
    const field = into[key] ?? { count: 0, kinds: [], texts: [], types: [] };
    mergeValue(field, value);
    into[key] = field;
  }
}

function mergeValue(field: ContractField, value: ShapeValue): void {
  field.count++;

  if (!field.kinds.includes(value.kind)) field.kinds.push(value.kind);

  if (value.text !== undefined && (value.kind === "string" || value.kind === "number" || value.kind === "boolean" || value.kind === "name") && !field.texts.includes(value.text) && field.texts.length < EXAMPLES) field.texts.push(value.text);

  if (value.type && !field.types.includes(value.type)) field.types.push(value.type);

  if (value.fields) {
    field.fields ??= {};
    mergeShape(field.fields, value.fields);
  }

  if (value.items) {
    field.items ??= { count: 0, kinds: [], texts: [], types: [] };
    mergeValue(field.items, value.items);
  }
}

/** The lines of what an operation sends, one per leaf key with its path: `params.path.basketId — name basketId: string (3 of 3)`. */
export function sendsLines(contract: OperationContract): string[] {
  const lines: string[] = [];

  const walk = (shape: ContractShape, prefix: string): void => {
    for (const [key, field] of Object.entries(shape)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (field.fields && Object.keys(field.fields).length > 0) {
        walk(field.fields, path);
        continue;
      }

      if (field.items) {
        if (field.items.fields && Object.keys(field.items.fields).length > 0) {
          walk(field.items.fields, `${path}[]`);
          continue;
        }

        lines.push(`${path}[] — ${describe(field.items)}${contract.calls > 1 ? ` (${field.count} of ${contract.calls})` : ""}`);
        continue;
      }

      lines.push(`${path} — ${describe(field)}${contract.calls > 1 ? ` (${field.count} of ${contract.calls})` : ""}`);
    }
  };

  walk(contract.sends, "");

  return lines;
}

/** A field in a few words: its kinds, its examples, its declared types. */
function describe(field: ContractField): string {
  const kinds = field.kinds.join("/");
  const examples = field.texts.map((text) => (field.kinds.includes("string") && !/^[\w$.]+$/.test(text) ? JSON.stringify(text) : text)).join(", ");
  const types = field.types.length > 0 ? `: ${field.types.join(" | ")}` : "";

  return `${kinds}${examples ? ` ${examples}` : ""}${types}`;
}

/** One line of what an operation sends and reads, for a label or a list: `sends params.path.basketId, body[].productId · reads data.currency, data.productItems`. */
export function contractSummary(contract: OperationContract): string {
  const sends = sendsLines(contract).map((line) => line.split(" — ")[0]!);
  const reads = contract.reads.map((read) => read.path);
  const parts = [sends.length > 0 ? `sends ${sends.slice(0, 8).join(", ")}${sends.length > 8 ? ", …" : ""}` : "", reads.length > 0 ? `reads ${reads.slice(0, 8).join(", ")}${reads.length > 8 ? ", …" : ""}` : ""];

  return parts.filter(Boolean).join(" · ");
}

/** The Markdown of an operation's contract: the sends as a list, the reads with their counts, the custom attributes. */
export function contractMarkdown(contract: OperationContract): string[] {
  const lines: string[] = [];
  const sends = sendsLines(contract);

  if (sends.length > 0) lines.push("Sends:", "", ...sends.map((line) => `- ${line}`), "");

  if (contract.reads.length > 0) lines.push("Reads of the result:", "", ...contract.reads.map((read) => `- ${read.path}${read.count > 1 ? ` (×${read.count})` : ""}`), "");

  if (contract.custom.length > 0) lines.push(`Custom attributes read: ${contract.custom.join(", ")}`, "");

  if (lines.length === 0) lines.push("Nothing sent as an object literal, nothing read of the result in the code.", "");

  return lines;
}

/** The report of every operation's contract, by family: who calls it, what it sends, what it reads. */
export function contractsMarkdown(analysis: Analysis): string {
  const all = [...contractsOf(analysis).values()];
  const lines = ["<!-- archdiff:generated — apis -->", `# APIs: ${counted(all.length, "operation")} of ${API_SHORT.scapi} the code calls, with their contracts as used`, ""];

  if (all.length === 0) {
    lines.push("No call of an operation of an API archdiff knows (SCAPI's `clients.shopperBaskets.getBasket()`).", "");

    return `${lines.join("\n")}\n`;
  }

  const customs = new Map<string, Set<string>>();

  for (const contract of all) for (const custom of contract.custom) customs.set(custom, new Set([...(customs.get(custom) ?? []), operationLabel(contract.operation)]));
  const families = [...new Set(all.map((contract) => contract.operation.family))].sort();
  lines.push(`${counted(families.length, "family", "families")}: ${families.join(", ")}. The contract of an operation is what the code sends (the first argument, key by key, with the literals, names and declared types written) and what it reads of the result, directly or through the functions that return it.`, "");

  for (const family of families) {
    lines.push(`## ${family}`, "");

    for (const contract of all.filter((candidate) => candidate.operation.family === family)) {
      lines.push(`### ${contract.operation.operation}`, "", `${counted(contract.calls, "call")} from ${contract.callers.join(", ") || "no module (read through a function's result)"}.`, "", ...contractMarkdown(contract));
    }
  }

  if (customs.size > 0) {
    lines.push("## Custom attributes", "", "The `c_…` fields the code reads, with the operations whose results hold them: the platform's extensions (Business Manager metadata, hooks) the storefront depends on.", "");

    for (const [custom, operations] of [...customs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) lines.push(`- ${custom} — ${[...operations].sort().join(", ")}`);
    lines.push("");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
