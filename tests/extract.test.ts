// Unit tests of the language frontends on small sources: what each
// records of imports, declarations, calls, decorators, states and guards.
// The CLI tests cover the fixtures end to end; these pin the facts a
// snippet gives, which is where a regression in an extractor shows first.

import assert from "node:assert/strict";
import { test } from "node:test";
import { extractAny } from "../src/extract/any.ts";

test("TypeScript: imports with their bindings and type-only marks, declarations with signatures, calls with receivers, decorators", async () => {
  const facts = await extractAny(
    "src/a.ts",
    `import { readFileSync } from "node:fs";
import type { Order } from "./order.ts";
import * as log from "./log.ts";
import { type A, b } from "./ab.ts";

/** Places an order. */
export function place(id: string, total = 1): Order {
  const store = new Store();
  store.save(id);
  log.info("placed");
  return { id, total } as Order;
}

export class Store {
  @Inject("db") private readonly db: Db;
  save(id: string): void {
    this.db.write(id);
  }
}

export default function main(): void {
  place("x");
}
`,
  );
  assert.deepEqual(facts.imports.map((fact) => [fact.source, fact.typeOnly ?? false, fact.inlineTypeOnly ?? false, fact.bindings.map((binding) => (binding.kind === "named" ? binding.imported : binding.kind))]), [
    ["node:fs", false, false, ["readFileSync"]],
    ["./order.ts", true, false, ["Order"]],
    ["./log.ts", false, false, ["module"]],
    ["./ab.ts", false, false, ["A", "b"]],
  ]);
  const place = facts.decls.find((decl) => decl.name === "place")!;
  assert.equal(place.kind, "fn");
  assert.equal(place.signature, "(id: string, total = 1) → Order");
  assert.equal(place.doc?.trim(), "Places an order.");
  assert.equal(place.exported, true);
  assert.deepEqual(place.calls.map((call) => [call.callee, call.receiver ?? null]), [["Store", null], ["store.save", "Store"], ["log.info", null]]);
  const store = facts.decls.find((decl) => decl.name === "Store")!;
  assert.equal(store.kind, "class");
  assert.deepEqual(store.members.map((member) => member.name), ["save"]);
  assert.deepEqual(store.decorators?.map((decorator) => decorator.name) ?? store.members[0]?.decorators?.map((decorator) => decorator.name) ?? [], []);
  assert.ok(facts.exports.has("place") && facts.exports.has("Store") && facts.exports.has("default"));
  assert.ok(facts.exportRows.some((row) => row.name === "default" && row.local === "main"));
  assert.equal(facts.parseError, null);
});

test("TypeScript: the guards of a call and the states of a field, as control.ts records them", async () => {
  const facts = await extractAny(
    "src/m.ts",
    `type Phase = "idle" | "busy" | "done";
let phase: Phase = "idle";

export function tick(items: string[]): void {
  for (const item of items) {
    if (phase === "idle") {
      phase = "busy";
      work(item);
    } else {
      skip(item);
    }
  }

  switch (phase) {
    case "busy":
      phase = "done";
      finish();
      break;
  }
}

function work(item: string): void {}
function skip(item: string): void {}
function finish(): void {}
`,
  );
  const tick = facts.decls.find((decl) => decl.name === "tick")!;
  const guards = tick.calls.map((call) => [call.callee, (call.guards ?? []).map((guard) => `${guard.kind}:${guard.text}`).join(" > ")]);
  assert.deepEqual(guards, [
    ["work", "loop:const item of items > if:phase === \"idle\""],
    ["skip", "loop:const item of items > else:not phase === \"idle\""],
    ["finish", "case:\"busy\""],
  ]);
  assert.deepEqual(facts.states?.map((state) => [state.kind, state.value, state.within, state.under ?? null, state.initial ?? false]), [
    ["assign", "idle", null, null, true],
    ["compare", "idle", "tick", null, false],
    ["assign", "busy", "tick", ["idle"], false],
    ["case", "busy", "tick", null, false],
    ["assign", "done", "tick", ["busy"], false],
  ]);
});

test("JavaScript: CommonJS requires and exports, a class field state, and an XState machine", async () => {
  const facts = await extractAny(
    "lib/light.js",
    `const { createMachine } = require("xstate");
const util = require("./util");

class Light {
  colour = "red";
  next() {
    if (this.colour === "red") this.colour = "green";
  }
}

const machine = createMachine({ id: "light", initial: "green", states: { green: { on: { TIMER: "yellow" } }, yellow: { on: { TIMER: "red" } }, red: { on: { TIMER: "green" } } } });

module.exports = { Light, machine, helper: util.helper };
`,
  );
  assert.deepEqual(facts.imports.map((fact) => [fact.source, fact.bindings.map((binding) => binding.local)]), [["xstate", ["createMachine"]], ["./util", ["util"]]]);
  assert.ok(facts.exports.has("Light") && facts.exports.has("machine"));
  assert.deepEqual(facts.states?.map((state) => [state.subject, state.kind, state.value, state.under ?? null]), [["this.colour", "assign", "red", null], ["this.colour", "compare", "red", null], ["this.colour", "assign", "green", ["red"]]]);
  assert.deepEqual(facts.machines?.map((machine) => [machine.name, machine.library, machine.initial, machine.states, machine.transitions.length]), [["light", "xstate", "green", ["green", "yellow", "red"], 3]]);
});

test("Python: imports, defs and methods with their receivers, decorators, docstrings, and the states of self", async () => {
  const facts = await extractAny(
    "app/door.py",
    `"""The door."""
from app.store import save
import logging


class Door:
    """A door."""

    def __init__(self):
        self.state = "closed"

    @property
    def is_open(self):
        return self.state == "open"

    def open(self):
        if self.state == "closed":
            self.state = "open"
            save(self)
            logging.info("opened")
`,
  );
  assert.equal(facts.doc, "The door.");
  assert.deepEqual(facts.imports.map((fact) => [fact.source, fact.bindings.map((binding) => binding.local)]), [["app.store.save", ["save"]], ["logging", ["logging"]]]);
  const door = facts.decls.find((decl) => decl.name === "Door")!;
  assert.equal(door.kind, "class");
  assert.equal(door.doc, "A door.");
  assert.deepEqual(door.members.map((member) => [member.name, member.accessor ?? false]), [["__init__", false], ["is_open", true], ["open", false]]);
  const open = door.members.find((member) => member.name === "open")!;
  assert.deepEqual(open.calls.map((call) => [call.callee, (call.guards ?? []).map((guard) => guard.kind).join(">")]), [["save", "if"], ["logging.info", "if"]]);
  assert.deepEqual(facts.states?.filter((state) => state.kind === "assign").map((state) => [state.value, state.within, state.under ?? null, state.initial ?? false]), [["closed", "Door.__init__", null, true], ["open", "Door.open", ["closed"], false]]);
});

test("Rust: use paths, pub fns and impl methods, calls through the module tree; PHP: namespaces, use, classes and methods", async () => {
  const rust = await extractAny(
    "src/orders.rs",
    `use crate::store::{read_order, save_order};

pub struct Order { pub id: String }

impl Order {
    pub fn new(id: &str) -> Order { Order { id: id.to_string() } }
}

pub fn place(id: &str) -> Order {
    let order = Order::new(id);
    save_order(&order);
    order
}
`,
  );
  assert.deepEqual(rust.imports.map((fact) => [fact.source, fact.bindings.map((binding) => binding.local)]), [["crate::store::read_order", ["read_order"]], ["crate::store::save_order", ["save_order"]]]);
  const order = rust.decls.find((decl) => decl.name === "Order")!;
  assert.equal(order.kind, "class");
  assert.deepEqual(order.members.map((member) => member.name), ["new"]);
  const place = rust.decls.find((decl) => decl.name === "place")!;
  // A path call is written with dots, as every callee is (`Order::new` → `Order.new`).
  assert.deepEqual(place.calls.map((call) => call.callee), ["Order.new", "save_order"]);
  const php = await extractAny(
    "src/Domain/Orders.php",
    `<?php
namespace App\\Domain;

use App\\Store\\OrderStore;

final class Orders
{
    public function __construct(private OrderStore $store) {}

    public function place(string $id): Order
    {
        $order = new Order($id);
        $this->store->save($order);
        return $order;
    }
}
`,
  );
  // The `use` and, by name, the class of the same namespace the body constructs: both are names the resolver finds a file for.
  assert.deepEqual(php.imports.map((fact) => fact.source), ["App\\Store\\OrderStore", "App\\Domain\\Order"]);
  const orders = php.decls.find((decl) => decl.name === "Orders")!;
  assert.equal(orders.kind, "class");
  assert.deepEqual(orders.members.map((member) => member.name), ["__construct", "place"]);
  const placePhp = orders.members.find((member) => member.name === "place")!;
  assert.deepEqual(placePhp.calls.map((call) => [call.callee, call.receiver ?? null]), [["Order", null], ["this.store.save", "OrderStore"]]);
  assert.deepEqual(php.symbols?.map((symbol) => symbol.qualified), ["App\\Domain\\Orders"]);
});
