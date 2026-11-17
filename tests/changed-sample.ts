// The sample fixture as a repository with a change to review: one commit
// of the fixture as it is, and in the working tree its orders changed —
// `placeOrder` refuses an order placed twice (a new guard, a new exit) and
// `validate` is stricter (one condition rewritten). The tests of the logic
// held against the base and of the lines the Code tab marks read this one
// change, through the CLI, the HTTP API and the page.
//
// Entry points: `changedSample`, `ORDERS_CHANGED`.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The sample's `src/lib/orders.ts` after the change: line 10 is new, line 17 rewritten. */
export const ORDERS_CHANGED = [
  "/** Orders: the domain of the sample. */",
  'import { readOrder, saveOrder } from "@/db/store";',
  'import { log } from "./log.ts";',
  "",
  "export interface Order { id: string; total: number }",
  "",
  "export function placeOrder(id: string, total: number): Order {",
  "  const order: Order = { id, total };",
  "  validate(order);",
  '  if (readOrder(id)) throw new Error("placed twice");',
  "  saveOrder(order);",
  "  log(`placed ${id}`);",
  "  return order;",
  "}",
  "",
  "function validate(order: Order): void {",
  '  if (order.total <= 0) throw new Error("negative");',
  "}",
  "",
  "export function findOrder(id: string): Order | null {",
  "  return readOrder(id);",
  "}",
  "",
  "export class OrderService {",
  "  constructor(private readonly prefix: string) {}",
  "  place(total: number): Order {",
  "    return placeOrder(this.nextId(), total);",
  "  }",
  "  private nextId(): string {",
  "    return `${this.prefix}-${Date.now()}`;",
  "  }",
  "}",
  "",
].join("\n");

/** Makes the copy of the sample in `dir` a repository on `main` with one commit, and changes its orders in the working tree. */
export function changedSample(dir: string): void {
  const git = (...args: string[]): void => {
    const result = spawnSync("git", ["-C", dir, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q", "-b", "main");
  // The files go in as the checkout has them, so that the change below is two lines on every system.
  git("config", "core.autocrlf", "false");
  git("add", ".");
  git("commit", "-q", "-m", "base");
  const file = join(dir, "src/lib/orders.ts");
  writeFileSync(file, readFileSync(file, "utf8").includes("\r\n") ? ORDERS_CHANGED.replace(/\n/g, "\r\n") : ORDERS_CHANGED);
}
