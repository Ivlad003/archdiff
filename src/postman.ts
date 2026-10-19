// A Postman collection (v2.1) of the SCAPI operations the code calls: a
// folder per family, a request per operation with the method and path the
// runtime declares, the path parameters as collection variables, the query
// parameters and the body as the code sends them (contracts.ts), and in the
// description who calls it and what it reads of the result. The paths come
// from the runtime the repository installed (node_modules), else from the
// table archdiff ships (scapi-table.ts); an operation neither knows gets a
// placeholder URL that says so.
//
// Sits over the contracts and the analysis's SCAPI table; the CLI
// (`archdiff postman`) and the page's export menu write it. The other way —
// a collection read against the code — is collections.ts and the `postman`
// view.
//
// Entry points: `postmanCollection`, `collectionName`.

import { basename } from "node:path";
import type { Analysis } from "./analyze.ts";
import { operationLabel, API_LABELS, API_SHORT } from "./apis.ts";
import { contractsOf, sendsLines, type ContractField, type ContractShape, type OperationContract } from "./contracts.ts";
import { operationPath } from "./scapi-runtime.ts";
import { counted } from "./words.ts";

/** A Postman collection as its v2.1 schema writes it, as far as archdiff fills it. */
export interface PostmanCollection {
  info: { name: string; description: string; schema: string };
  variable: { key: string; value: string }[];
  item: PostmanFolder[];
}

export interface PostmanFolder {
  name: string;
  description: string;
  item: PostmanRequest[];
}

export interface PostmanRequest {
  name: string;
  request: {
    method: string;
    header: { key: string; value: string }[];
    url: { raw: string; host: string[]; path: string[]; query: { key: string; value: string }[] };
    body?: { mode: "raw"; raw: string; options: { raw: { language: "json" } } };
    description: string;
  };
}

const SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

/** The name a collection is written with: the repository's directory and the API, the family when it is one family's. */
export function collectionName(analysis: Analysis, family: string | null): string {
  return `${basename(analysis.root)} — ${API_SHORT.scapi}${family ? ` ${family}` : ""}`;
}

/** The collection of every operation the code calls, or of one family's; null for a family the code calls no operation of. */
export function postmanCollection(analysis: Analysis, family: string | null = null, name = collectionName(analysis, family)): PostmanCollection | null {
  const { table, source } = analysis.scapi;
  const contracts = [...contractsOf(analysis).values()].filter((contract) => family === null || contract.operation.family === family);

  if (family !== null && contracts.length === 0) return null;
  const variables = new Map<string, string>([["baseUrl", "https://{{shortCode}}.api.commercecloud.salesforce.com"], ["shortCode", ""], ["organizationId", ""], ["siteId", ""], ["token", ""]]);
  const folders: PostmanFolder[] = [];

  for (const familyName of [...new Set(contracts.map((contract) => contract.operation.family))].sort()) {
    const spec = table[familyName];
    const items = contracts.filter((contract) => contract.operation.family === familyName).map((contract) => {
      const made = requestOf(contract, table);

      for (const variable of made.variables) if (!variables.has(variable)) variables.set(variable, "");

      return made.request;
    });
    folders.push({ name: familyName, description: spec ? `${API_LABELS.scapi}, base path ${spec.basePath}` : `${API_LABELS.scapi}; the family is not in ${source}: paths unknown`, item: items });
  }

  const description = `The ${API_LABELS.scapi} operations ${basename(analysis.root)} calls, as archdiff read them: a request per operation with the parameters and the body the code sends, who calls it and what it reads of the result in the description. Paths from ${source}. Fill the variables: shortCode, organizationId, siteId, token (a SLAS access token), and each path parameter.`;

  return { info: { name, description, schema: SCHEMA }, variable: [...variables].map(([key, value]) => ({ key, value })), item: folders };
}

/** The request of one operation: its URL from the table, the query and body from what the code sends, the contract in the description; and the variables the URL and query name. */
function requestOf(contract: OperationContract, table: Analysis["scapi"]["table"]): { request: PostmanRequest; variables: string[] } {
  const { operation } = contract;
  const known = operationPath(table, operation);
  // `{basketId}` of the path becomes the variable `{{basketId}}`.
  const path = known ? known.path.replace(/\{(\w+)\}/g, (_, name: string) => `{{${name}}}`) : `/${operation.family}/${operation.operation}`;
  const variables = [...path.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!);
  const sent = contract.sends;
  // The query parameters the code sends, each a variable of its own name; `siteId` always, as every shopper API takes it.
  const queryKeys = Object.keys(fieldsAt(sent, ["params", "query"]) ?? fieldsAt(sent, ["parameters"]) ?? {}).filter((key) => !/^(organizationId|siteId)$/.test(key) && !pathHas(path, key));
  const query = [{ key: "siteId", value: "{{siteId}}" }, ...queryKeys.map((key) => ({ key, value: `{{${key}}}` }))];
  variables.push(...queryKeys);
  const headers = [{ key: "Authorization", value: "Bearer {{token}}" }];
  const body = sent["body"];
  const raw = body ? exampleOf(body) : undefined;

  if (raw !== undefined) headers.push({ key: "Content-Type", value: "application/json" });
  const lines = [
    known ? `${known.method} ${known.path}` : `Path unknown: ${operationLabel(operation)} is not among the runtime's declared operations; the URL is a placeholder.`,
    "",
    `Called from: ${contract.callers.join(", ") || "no module directly"} (${counted(contract.calls, "call")}).`,
    ...(sendsLines(contract).length > 0 ? ["", "Sends:", ...sendsLines(contract).map((line) => `- ${line}`)] : []),
    ...(contract.reads.length > 0 ? ["", "Reads of the result:", ...contract.reads.map((read) => `- ${read.path}`)] : []),
    ...(contract.custom.length > 0 ? ["", `Custom attributes read: ${contract.custom.join(", ")}`] : []),
  ];
  const request: PostmanRequest["request"] = {
    method: known?.method ?? "GET",
    header: headers,
    url: { raw: `{{baseUrl}}${path}?${query.map((pair) => `${pair.key}=${pair.value}`).join("&")}`, host: ["{{baseUrl}}"], path: path.split("/").filter(Boolean), query },
    description: lines.join("\n"),
  };

  if (raw !== undefined) request.body = { mode: "raw", raw: JSON.stringify(raw, null, 2), options: { raw: { language: "json" } } };

  return { request: { name: operation.operation, request }, variables };
}

/** The fields under a path of keys in a contract shape, or null. */
function fieldsAt(shape: ContractShape, path: string[]): ContractShape | null {
  let at: ContractShape | undefined = shape;

  for (const key of path) {
    at = at?.[key]?.fields;

    if (!at) return null;
  }

  return at;
}

function pathHas(path: string, key: string): boolean {
  return path.includes(`{{${key}}}`);
}

/**
 * An example JSON value for a field as the code sends it: an object field by field, an array of one example, a
 * literal's first value, a name as the variable `{{name}}`, a call as a note; a spread is left out.
 */
function exampleOf(field: ContractField): unknown {
  if (field.fields && Object.keys(field.fields).length > 0) return Object.fromEntries(Object.entries(field.fields).filter(([key]) => !key.startsWith("...")).map(([key, inner]) => [key, exampleOf(inner)]));

  if (field.items) return [exampleOf(field.items)];
  const kind = field.kinds[0];
  const text = field.texts[0];

  switch (kind) {
    case "string":
      return text ?? "";
    case "number":
      return Number(text ?? 0);
    case "boolean":
      return text === "true";
    case "null":
      return null;
    case "name":
      // A variable named as the code names the value; its declared type is in the request's description.
      return `{{${(text ?? "value").replace(/[^\w$]/g, "_")}}}`;
    case "object":
      return {};
    case "array":
      return [];
    case "call":
      return `<${text ?? "a call's result"}>`;
    default:
      return "";
  }
}
