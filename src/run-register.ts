// The first module of a run's child process (`node --import run-register
// run-harness`): reads the plan the parent wrote (the file named by
// ARCHDIFF_RUN), registers the module hooks of run-hooks.ts with it, and
// sets up the recorder the traced code and the mocks report to. Runs
// before the harness imports the entry, so every project module loads
// through the hooks.

import { readFileSync } from "node:fs";
import { register } from "node:module";

interface Recorder {
  events: { kind: "enter" | "storage"; id?: string; module?: string; member?: string; args?: unknown[]; t: number }[];
  enter(id: string): void;
  storage(module: string, member: string, args: unknown[]): void;
}

const planFile = process.env["ARCHDIFF_RUN"];

if (!planFile) throw new Error("ARCHDIFF_RUN (the plan file) is not set");
const plan = JSON.parse(readFileSync(planFile, "utf8")) as { root: string };
let t = 0;

/** A value as the report can carry it: JSON, cut short; a function or a cycle becomes a word. */
const plain = (value: unknown): unknown => {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => (typeof item === "function" ? "[function]" : typeof item === "bigint" ? String(item) : item));

    return text === undefined ? String(value) : text.length > 400 ? `${text.slice(0, 399)}…` : JSON.parse(text);
  } catch {
    return String(value);
  }
};

const recorder: Recorder = {
  events: [],
  enter(id) {
    this.events.push({ kind: "enter", id, t: ++t });
  },
  storage(module, member, args) {
    this.events.push({ kind: "storage", module, member, args: args.map(plain), t: ++t });
  },
};

(globalThis as unknown as { __archdiff: Recorder }).__archdiff = recorder;

// The network is a storage too: fetch answers from the "fetch" mock (an object by URL, or one body for every call) and is recorded.
const mocks = (JSON.parse(readFileSync(planFile, "utf8")) as { mocks: Record<string, { content: unknown }> }).mocks;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  recorder.storage("fetch", init?.method ?? "GET", [url, init?.body ?? null]);
  const content = mocks["fetch"]?.content;
  const body = content && typeof content === "object" && !Array.isArray(content) && url in (content as Record<string, unknown>) ? (content as Record<string, unknown>)[url] : content;

  if (body === undefined) throw new Error(`archdiff run: no mock for fetch ${url} (the network is not reached)`);

  return new Response(typeof body === "string" ? body : JSON.stringify(body ?? null), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

register(new URL(import.meta.url.endsWith(".ts") ? "./run-hooks.ts" : "./run-hooks.js", import.meta.url), { data: JSON.parse(readFileSync(planFile, "utf8")), parentURL: import.meta.url });
void plan;
