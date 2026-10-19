// External APIs the code calls by name. An operation of an SDK the
// diagrams know — SCAPI, the Salesforce Commerce API as the storefront-next
// runtime and commerce-sdk-isomorphic expose it: `clients.shopperBaskets.getBasket()`
// — is a call out of the repository that can be named: a shape of its own
// on a call tree, a message to its family's lifeline in a sequence, a
// storage of the path and the flow, never a blind spot. The OCAPI hooks a
// cartridge declares (hooks.json: `dw.ocapi.shop.basket.modifyGETResponse`)
// modify the resource their name holds, served by an SCAPI family.
//
// Sits between extraction and the graph: graph.ts asks `operationOf` for a
// call it could not follow into the repository, the views read the
// operations the graph recorded. Plain data and pure functions.
//
// Entry points: `operationOf`, `hookOf`, `familyId`, `operationId`,
// `operationFromId`, `parseApiId`, `isApiId`, `operationLabel`,
// `participantLabel`, `API_LABELS`, `API_SHORT`, `SCAPI`.

import { MEMBER_FORMS, type CallFact } from "./extract/facts.ts";

/** An operation of an external API: SCAPI's `ShopperBaskets.getBasket`. */
export interface ApiOperation {
  api: "scapi";
  /** The client, as the SDK names it: `ShopperBaskets`, `ShopperBasketsV2`, `ShopperProducts`. */
  family: string;
  operation: string;
}

/** An OCAPI hook as its name says: what it does, to which resource, and the SCAPI families that serve the resource. */
export interface ApiHook {
  name: string;
  /** `shop` or `data`. */
  scope: string;
  /** `basket`, `basket.billing_address`, `product_search`. */
  resource: string;
  /** `modify GET response`, `before POST`, `validateBasket`. */
  does: string;
  /** The HTTP method the hook sits on, when its name holds one. */
  method: string | null;
  families: string[];
}

/** The one API archdiff knows today: the hooks of a cartridge are joined to its families. */
export const SCAPI: ApiOperation["api"] = "scapi";

/** The name an API is drawn with, and its short form for a label's second line. */
export const API_LABELS: Record<ApiOperation["api"], string> = { scapi: "Salesforce Commerce API (SCAPI)" };
export const API_SHORT: Record<ApiOperation["api"], string> = { scapi: "SCAPI" };

/** An operation as a label: `ShopperBaskets.getBasket`. */
export function operationLabel(operation: ApiOperation): string {
  return `${operation.family}.${operation.operation}`;
}

/** `shopperBasketsV2`, `shopperProducts`: an SCAPI client as the runtime's `AppClients` and the SDK name them. */
const SCAPI_CLIENT = /^shopper[A-Z][A-Za-z0-9]*$/;
/** `ShopperBasketsV2`, `ShopperProductsClient`: the class or type of a client. */
const SCAPI_TYPE = /^Shopper[A-Z][A-Za-z0-9]*$/;

/**
 * The operation a call names, or null: `clients.shopperBaskets.getBasket()`,
 * `this.clients.shopperOrders.getOrder()`, a destructured `shopperProducts.getProducts()`
 * (the client's name before the operation), or a call on a value typed with a client's class
 * (`baskets: ShopperBasketsV2`) — when the family is one the SCAPI table knows (`families`), so a
 * store named `shopperStore` is no API. Asked of a call the graph could not follow into the
 * repository, so a class of the repository named like a client keeps its own calls.
 */
export function operationOf(call: Pick<CallFact, "callee" | "form">, families: ReadonlySet<string>): ApiOperation | null {
  const { form } = call;
  const known = (family: string, operation: string): ApiOperation | null => (families.has(family) && /^[a-z][A-Za-z0-9]*$/.test(operation) ? { api: SCAPI, family, operation } : null);

  if (form.kind === "typed") return SCAPI_TYPE.test(form.type) ? known(form.type.replace(/Client$/, ""), form.member) : null;

  if (!MEMBER_FORMS.has(form.kind)) return null;
  const parts = call.callee.split(".");

  if (parts.length < 2) return null;
  const operation = parts[parts.length - 1]!;
  const client = parts[parts.length - 2]!;

  return SCAPI_CLIENT.test(client) ? known(client[0]!.toUpperCase() + client.slice(1), operation) : null;
}

/** The SCAPI families serving an OCAPI resource (the first segment of a nested one: `basket.billing_address` is the basket's). */
const RESOURCE_FAMILIES: Record<string, string[]> = {
  basket: ["ShopperBaskets", "ShopperBasketsV2"],
  order: ["ShopperOrders"],
  product: ["ShopperProducts"],
  category: ["ShopperProducts"],
  product_search: ["ShopperSearch"],
  search_suggestion: ["ShopperSearch"],
  customer: ["ShopperCustomers"],
  promotion: ["ShopperPromotions"],
  store: ["ShopperStores"],
  content: ["ShopperExperience"],
  site: ["ShopperContext"],
  gift_certificate: ["ShopperGiftCertificates"],
  session: ["ShopperLogin"],
};

/** `dw.ocapi.shop.basket.modifyGETResponse`, `dw.ocapi.shop.basket.billing_address.beforePUT`, `dw.ocapi.shop.basket.validateBasket`: read apart; null for a name of another shape. */
export function hookOf(name: string): ApiHook | null {
  const parts = name.split(".");

  if (parts.length < 5 || parts[0] !== "dw" || parts[1] !== "ocapi") return null;
  const scope = parts[2]!;
  const hook = parts[parts.length - 1]!;
  const resource = parts.slice(3, -1).join(".");
  const stage = /^(before|after|modify)(GET|POST|PUT|PATCH|DELETE)(Response)?$/.exec(hook);
  const does = stage ? `${stage[1]} ${stage[2]}${stage[3] ? " response" : ""}` : hook;

  return { name, scope, resource, does, method: stage ? stage[2]! : null, families: RESOURCE_FAMILIES[resource.split(".")[0]!] ?? [] };
}

/** The shape ID of a family: `api:scapi:ShopperBaskets`. */
export function familyId(api: ApiOperation["api"], family: string): string {
  return `api:${api}:${family}`;
}

/** The shape ID of an operation: `api:scapi:ShopperBaskets.getBasket`. */
export function operationId(operation: ApiOperation): string {
  return `${familyId(operation.api, operation.family)}.${operation.operation}`;
}

/** Whether a shape or node ID names an API family or operation. */
export function isApiId(id: string): boolean {
  return id.startsWith("api:");
}

/** The family and operation an ID names: `api:scapi:ShopperBaskets.getBasket` → ShopperBaskets, getBasket (operation null for a family). */
export function parseApiId(id: string): { api: ApiOperation["api"]; family: string; operation: string | null } | null {
  const match = /^api:(scapi):([A-Za-z0-9]+)(?:\.([A-Za-z0-9]+))?$/.exec(id);

  return match ? { api: match[1] as ApiOperation["api"], family: match[2]!, operation: match[3] ?? null } : null;
}

/** The operation an ID names, or null for a family or another ID. */
export function operationFromId(id: string): ApiOperation | null {
  const parsed = parseApiId(id);

  return parsed && parsed.operation !== null ? { api: parsed.api, family: parsed.family, operation: parsed.operation } : null;
}

/** What a participant of a sequence is called: a module by its path, a family of an API by its name and the API's (`ShopperBaskets (SCAPI)`). */
export function participantLabel(id: string): string {
  const api = parseApiId(id);

  return api ? `${api.family} (${API_SHORT[api.api]})` : id;
}

/** A family's base path and operations (method, path template) as the storefront-next runtime declares them. */
export interface ScapiFamilySpec {
  basePath: string;
  operations: Record<string, { method: string; path: string }>;
}

export type ScapiTable = Record<string, ScapiFamilySpec>;
