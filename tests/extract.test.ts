// Unit tests of the language frontends on small sources: what each
// records of imports, declarations, calls, decorators, states and guards.
// The CLI tests cover the fixtures end to end; these pin the facts a
// snippet gives, which is where a regression in an extractor shows first.
//
// Entry point: run by `npm test`.

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
  assert.deepEqual(place.calls.map((call) => [call.callee, call.form.kind === "typed" ? call.form.type : null]), [["Store", null], ["store.save", "Store"], ["log.info", null]]);
  const store = facts.decls.find((decl) => decl.name === "Store")!;
  assert.equal(store.kind, "class");
  assert.deepEqual(store.members.map((member) => member.name), ["save"]);
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
  assert.deepEqual(door.members.map((member) => [member.name, member.accessor ?? false]), [["__init__", false], ["is_open", "get"], ["open", false]]);
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
  assert.deepEqual(placePhp.calls.map((call) => [call.callee, call.form.kind === "typed" ? call.form.type : null]), [["Order", null], ["this.store.save", "OrderStore"]]);
  assert.deepEqual(php.symbols?.map((symbol) => symbol.qualified), ["App\\Domain\\Orders"]);
});

test("JavaScript: `exports.f = f` exports the declared f; a flag set on the export (`exports.f.public = true`) is no export", async () => {
  const facts = await extractAny("cartridges/app/cartridge/scripts/hooks/category.js", "var Logger = require('dw/system/Logger');\nfunction modifyGETResponse(category, doc) {\n  return doc;\n}\nexports.modifyGETResponse = modifyGETResponse;\nexports.modifyGETResponse.public = true;\nmodule.exports.helper = function () {};\nmodule.exports.helper.public = true;\n");
  assert.deepEqual([...facts.exports].sort(), ["helper", "modifyGETResponse"]);
  assert.deepEqual(facts.decls.map((decl) => [decl.name, decl.exported]), [["modifyGETResponse", true], ["helper", true]]);
});

test("TypeScript: what a member call sends (its object literal, key by key), what is read of a call's result, what a function returns of one", async () => {
  const facts = await extractAny(
    "src/cart.ts",
    `export async function addItem(clients: AppClients, basketId: string, item: ProductItem) {
  const { data: basket } = await clients.shopperBasketsV2.addItemToBasket({ params: { path: { basketId }, query: { locale: "en-US" } }, body: [item] });
  const names = basket.productItems.map((line) => line.productName);
  const sum = basket.productItems.reduce((acc, line) => acc + line.price, 0);
  return basket;
}
export async function total(clients: AppClients) {
  const basket = await addItem(clients, "b1", {} as ProductItem);
  return basket.orderTotal;
}
`,
  );
  const [addItem, total] = facts.decls;
  const call = addItem!.calls.find((candidate) => candidate.callee === "clients.shopperBasketsV2.addItemToBasket")!;
  assert.deepEqual(call.shape, { params: { kind: "object", fields: { path: { kind: "object", fields: { basketId: { kind: "name", text: "basketId", type: "string" } } }, query: { kind: "object", fields: { locale: { kind: "string", text: "en-US" } } } } }, body: { kind: "array", items: { kind: "name", text: "item", type: "ProductItem" } } });
  // The destructured `basket` is `data` of the result; the callback's parameter an element of `productItems`; `return basket` returns `data`.
  assert.deepEqual(facts.reads?.map((read) => [read.callee, read.path.join("."), read.callLine]), [["clients.shopperBasketsV2.addItemToBasket", "data.productItems", 2], ["clients.shopperBasketsV2.addItemToBasket", "data.productItems.productName", 2], ["addItem", "orderTotal", 8]]);
  assert.deepEqual(addItem!.returnsFrom, { callee: "clients.shopperBasketsV2.addItemToBasket", form: { kind: "value" }, path: ["data"], callLine: 2 });
  assert.deepEqual(total!.returnsFrom, { callee: "addItem", form: { kind: "name", name: "addItem" }, path: ["orderTotal"], callLine: 8 });
});

test("Go: the packages imported and every declaration used of them, structs with fields and methods, an interface's shape, calls by receiver, type and result, a method of a type of another file", async () => {
  const facts = await extractAny(
    "internal/orders/orders.go",
    `// Package orders places orders.
package orders

import (
	"net/http"

	"example.com/shop/internal/store"
)

// Service places orders.
type Service struct {
	repo *store.Repo
	Limits
}

// Placer is what a service does.
type Placer interface {
	Place(id string) error
}

// NewService makes a service.
func NewService(repo *store.Repo) *Service {
	return &Service{repo: repo}
}

// Place checks and saves an order.
func (s *Service) Place(id string) error {
	if err := validate(id); err != nil {
		return err
	}

	for _, line := range s.lines(id) {
		s.repo.Save(line)
	}

	audit := store.NewAudit()
	audit.Record(id)

	return nil
}

func (s *Service) lines(id string) []string { return nil }

func Routes(service *Service, mux *http.ServeMux) {
	mux.HandleFunc("/orders", service.handle)
}

func (c *Cache) Drop() {}

func main() {
	Routes(NewService(store.NewRepo()), http.NewServeMux())
}
`,
  );
  assert.equal(facts.doc, "Package orders places orders.");
  assert.equal(facts.parseError, null);
  // The two packages (a module object each), then a declaration per name used: `store.Repo` is `Repo` of that package,
  // `validate`, `Limits` and `Cache` names of the file's own package another file may declare (optional: nothing missing when none does).
  assert.deepEqual(
    facts.imports.map((fact) => [fact.source, fact.bindings.map((binding) => `${binding.kind}:${binding.local}`).join(), fact.optional ?? false]),
    [
      ["net/http", "module:http", false],
      ["example.com/shop/internal/store", "module:store", false],
      [".validate", "named:validate", true],
      ["example.com/shop/internal/store.NewAudit", "named:store::NewAudit", false],
      ["example.com/shop/internal/store.NewRepo", "named:store::NewRepo", false],
      ["net/http.NewServeMux", "named:http::NewServeMux", false],
      ["example.com/shop/internal/store.Repo", "named:store::Repo", false],
      [".Limits", "named:Limits", true],
      ["net/http.ServeMux", "named:http::ServeMux", false],
      [".Cache", "named:Cache", true],
    ],
  );
  assert.deepEqual(facts.decls.map((decl) => [decl.kind, decl.name, decl.exported]), [["class", "Service", true], ["type", "Placer", true], ["fn", "NewService", true], ["fn", "Routes", true], ["class", "Cache", true], ["fn", "main", false]]);
  const service = facts.decls.find((decl) => decl.name === "Service")!;
  assert.equal(service.doc, "Service places orders.");
  // An embedded type is a field named as itself, and the base its methods come from.
  assert.deepEqual(service.fields, [{ name: "repo", class: "*store.Repo" }, { name: "Limits", class: "Limits" }]);
  assert.equal(service.base, "Limits");
  assert.deepEqual(service.members.map((member) => [member.name, member.exported, member.signature]), [["Place", true, "(id string) → error"], ["lines", false, "(id string) → []string"]]);
  assert.deepEqual(facts.decls.find((decl) => decl.name === "Placer")!.shape, [{ name: "Place", optional: false, type: "(id string) => error" }]);
  const place = service.members.find((member) => member.name === "Place")!;
  assert.equal(place.branches, 2);
  // By the receiver, by the type its field declares, by what the call that made the local returns; the guard as written.
  assert.deepEqual(place.calls.map((call) => [call.callee, call.form.kind, (call.guards ?? []).map((guard) => `${guard.kind}:${guard.text}`).join(" > ")]), [
    ["validate", "name", ""],
    ["this.lines", "own", ""],
    ["s.repo.Save", "typed", "loop:_, line := range s.lines(id)"],
    ["store.NewAudit", "name", ""],
    ["audit.Record", "result", ""],
  ]);
  assert.deepEqual(place.calls[2]!.form, { kind: "typed", type: "store::Repo", member: "Save" });
  assert.deepEqual(place.calls[4]!.form, { kind: "result", of: { call: { kind: "name", name: "store::NewAudit" } }, member: "Record" });
  assert.deepEqual(facts.decls.find((decl) => decl.name === "NewService")!.result, { class: "Service" });
  // A handler handed to the router: the method of the parameter's type.
  const routes = facts.decls.find((decl) => decl.name === "Routes")!;
  assert.deepEqual(routes.calls.map((call) => [call.callee, call.form, (call.passes ?? []).map((pass) => [pass.arg, pass.callee, pass.form])]), [["mux.HandleFunc", { kind: "typed", type: "http::ServeMux", member: "HandleFunc" }, [[1, "service.handle", { kind: "typed", type: "Service", member: "handle" }]]]]);
  // `Cache` is declared in another file of the package: this one holds a part of it, the method.
  assert.deepEqual(facts.decls.find((decl) => decl.name === "Cache")!.members.map((member) => member.name), ["Drop"]);
  assert.deepEqual(facts.symbols, [
    { name: "Service", qualified: "internal/orders.Service", table: "class" },
    { name: "Placer", qualified: "internal/orders.Placer", table: "class" },
    { name: "NewService", qualified: "internal/orders.NewService", table: "function" },
    { name: "Routes", qualified: "internal/orders.Routes", table: "function" },
    { name: "Cache", qualified: "internal/orders.Cache", table: "class", part: true },
    { name: "main", qualified: "internal/orders.main", table: "function" },
  ]);
  // Every top-level name is visible to the other files of the package, whatever its case.
  assert.deepEqual([...facts.exports], ["Service", "Placer", "NewService", "Routes", "Cache", "main"]);
});

test("Go: a blank and a dot import, `init` and a package variable's initializer as the file's own code, the class of a variable, a conversion as no call, a file checked out with CRLF", async () => {
  const source = `package store

import (
	_ "github.com/lib/pq"
	. "example.com/shop/internal/util"
	"database/sql"
)

var Default = NewRepo()
var fallback Repo
var ids = []int64{int64(len(name))}

func init() {
	sql.Register("memory", driver{})
}

func touch() {
	Default.Save()
	fallback.Save()
	handlers[0]()
}
`;
  const facts = await extractAny("store/store.go", source);
  assert.deepEqual(facts.imports.slice(0, 3).map((fact) => [fact.source, fact.bindings.map((binding) => binding.local), fact.glob ?? false]), [["_ github.com/lib/pq", [], false], ["example.com/shop/internal/util", [], true], ["database/sql", ["sql"], false]]);
  assert.ok(facts.unsupported.some((fact) => fact.reason.startsWith("dot import of `example.com/shop/internal/util`")));
  // `init` is no declaration: the package's loading runs it, as it runs the initializers. `int64(…)` converts; `len` is the language's.
  assert.deepEqual(facts.decls.map((decl) => decl.name), ["touch"]);
  assert.deepEqual(facts.moduleCalls.map((call) => call.callee), ["NewRepo", "len", "sql.Register"]);
  assert.deepEqual(facts.instances, [{ name: "Default", of: { call: { kind: "name", name: "NewRepo" } } }, { name: "fallback", class: "Repo" }]);
  // A member called through a package variable is looked up on the class of its value; an element of a slice is a value.
  assert.deepEqual(facts.decls[0]!.calls.map((call) => [call.callee, call.form]), [["Default.Save", { kind: "member", head: "Default", member: "Save" }], ["fallback.Save", { kind: "member", head: "fallback", member: "Save" }], ["handlers[0]", { kind: "value" }]]);
  const crlf = await extractAny("store/store.go", source.replace(/\n/g, "\r\n"));
  assert.deepEqual(crlf.decls.map((decl) => [decl.name, decl.line, decl.fingerprint]), facts.decls.map((decl) => [decl.name, decl.line, decl.fingerprint]));
  assert.deepEqual(crlf.imports.map((fact) => fact.source), facts.imports.map((fact) => fact.source));
});

test("Java: the classes imported and the candidates of every class used without an import, a class with fields, methods, a constructor and nested types, calls by field, local, result and static import", async () => {
  const source = `package shop.orders;

import shop.store.OrderRepository;
import shop.util.*;
import static shop.util.Checks.require;
import java.util.List;

/**
 * Places orders.
 *
 * @since 1.0
 */
public class OrderService extends BaseService implements Placer {
    private final OrderRepository repository;
    private List<Order> recent;

    public OrderService(OrderRepository repository) {
        super("orders");
        this.repository = repository;
    }

    /** Places one order. */
    @Override
    public Order place(String id, long total) {
        require(total >= 0);
        Order order = new Order(id, total);

        if (order.total() > Limits.MAX) {
            audit(order);
        } else {
            this.repository.save(order);
        }

        var saved = repository.find(id);
        saved.touch();
        recent.forEach(this::audit);

        return Orders.latest(repository);
    }

    private void audit(Order order) {
        Line line = new Line(order.id());
        line.print();
    }

    public static void main(String[] args) {
        new OrderService(null).place("a", 1);
    }

    interface Placer {
        Order place(String id, long total);
    }

    static class Line {
        Line(String id) {
        }

        void print() {
        }
    }
}
`;
  const facts = await extractAny("src/main/java/shop/orders/OrderService.java", source);
  assert.equal(facts.parseError, null);
  // The Javadoc of the type the file is named after, without its block tags.
  assert.equal(facts.doc, "Places orders.");
  // An import names a class; a static import the class its member is of; `.*` a package, which binds nothing. A class used
  // without an import is one of the file's package or of a `.*` package, in the order Java tries them (optional: `java.lang` has the rest).
  assert.deepEqual(
    facts.imports.map((fact) => [fact.source, fact.bindings.map((binding) => binding.local).join(), fact.optional ?? false, fact.glob ?? false]),
    [
      ["shop.store.OrderRepository", "OrderRepository", false, false],
      ["shop.util.*", "", false, true],
      ["shop.util.Checks", "Checks", false, false],
      ["java.util.List", "List", false, false],
      ["shop.orders.Order ?? shop.util.Order", "Order", true, false],
      ["shop.orders.Limits ?? shop.util.Limits", "Limits", true, false],
      ["shop.orders.Orders ?? shop.util.Orders", "Orders", true, false],
      ["shop.orders.BaseService ?? shop.util.BaseService", "BaseService", true, false],
    ],
  );
  const [service] = facts.decls;
  assert.deepEqual([service!.kind, service!.name, service!.exported, service!.base, service!.implements], ["class", "OrderService", true, "BaseService", ["Placer"]]);
  assert.deepEqual(service!.fields, [{ name: "repository", class: "OrderRepository" }, { name: "recent", class: "List<Order>" }]);
  assert.deepEqual(service!.members.map((member) => [member.kind, member.name, member.exported, member.static ?? false, member.signature]), [
    ["fn", "constructor", true, false, "(OrderRepository repository)"],
    ["fn", "place", true, false, "(String id, long total) → Order"],
    ["fn", "audit", false, false, "(Order order) → void"],
    ["fn", "main", true, true, "(String[] args) → void"],
    ["type", "Placer", true, false, null],
    ["class", "Line", true, false, null],
  ]);
  const member = (name: string) => service!.members.find((each) => each.name === name)!;
  assert.deepEqual(member("constructor").calls.map((call) => [call.callee, call.form]), [["super", { kind: "super", member: "constructor" }]]);
  assert.equal(member("place").doc, "Places one order.");
  assert.deepEqual(member("place").result, { class: "Order" });
  // A static import's member is the class's; a field's, a parameter's and a local's class as declared; a `var` made by a call is what the call returns; a capitalised name is a class.
  assert.deepEqual(member("place").calls.map((call) => [call.callee, call.form, (call.guards ?? []).map((guard) => `${guard.kind}:${guard.text}`).join(" > ")]), [
    ["require", { kind: "member", head: "Checks", member: "require" }, ""],
    ["Order", { kind: "name", name: "Order" }, ""],
    ["order.total", { kind: "typed", type: "Order", member: "total" }, ""],
    ["audit", { kind: "own", member: "audit" }, "if:order.total() > Limits.MAX"],
    ["this.repository.save", { kind: "typed", type: "OrderRepository", member: "save" }, "else:not order.total() > Limits.MAX"],
    ["repository.find", { kind: "typed", type: "OrderRepository", member: "find" }, ""],
    ["saved.touch", { kind: "result", of: { call: { kind: "typed", type: "OrderRepository", member: "find" } }, member: "touch" }, ""],
    ["recent.forEach", { kind: "typed", type: "List", member: "forEach" }, ""],
    ["Orders.latest", { kind: "member", head: "Orders", member: "latest" }, ""],
  ]);
  // A method reference handed over is a function passed.
  assert.deepEqual(member("place").calls[7]!.passes?.map((pass) => [pass.arg, pass.callee, pass.form]), [[0, "this.audit", { kind: "own", member: "audit" }]]);
  // An interface's method without a body is its shape: a call of it goes to the classes implementing it.
  assert.deepEqual([member("Placer").shape, member("Placer").members], [[{ name: "place", optional: false, type: "(String id, long total) => Order" }], []]);
  assert.deepEqual(member("Line").members.map((each) => each.name), ["constructor", "print"]);
  // A nested type is declared under its outer class's name, and imported by its own.
  assert.deepEqual(facts.symbols, [
    { name: "OrderService", qualified: "shop.orders.OrderService", table: "class" },
    { name: "Placer", qualified: "shop.orders.OrderService.Placer", table: "class" },
    { name: "Line", qualified: "shop.orders.OrderService.Line", table: "class" },
  ]);
  assert.deepEqual(facts.exportRows, [{ name: "OrderService", kind: "class", local: null }, { name: "Placer", kind: "type", local: "OrderService.Placer" }, { name: "Line", kind: "class", local: "OrderService.Line" }]);
  const crlf = await extractAny("src/main/java/shop/orders/OrderService.java", source.replace(/\n/g, "\r\n"));
  assert.deepEqual([crlf.doc, crlf.decls[0]!.fingerprint, crlf.imports.map((fact) => fact.source)], [facts.doc, service!.fingerprint, facts.imports.map((fact) => fact.source)]);
});

test("Java: a record's components are fields and methods, an enum's constants fields, an initializer the class's own code, a method no class of the file declares one of a static `.*` import", async () => {
  const facts = await extractAny(
    "src/test/java/shop/OrderTest.java",
    `package shop;

import static org.junit.jupiter.api.Assertions.*;

record Order(String id, Customer customer) {
    String label() { return customer().name(); }
}

enum Status { NEW, PAID; boolean open() { return this == NEW; } }

class OrderTest {
    private final Clock clock = Clock.fixed();

    void labels() {
        assertEquals("a", new Order("a", null).label());
    }
}
`,
  );
  const [order, status, test] = facts.decls;
  assert.deepEqual(order!.fields, [{ name: "id", class: "String" }, { name: "customer", class: "Customer" }]);
  assert.deepEqual(order!.members.map((member) => [member.name, member.signature, member.result ?? null]), [["id", "() → String", { class: "String" }], ["customer", "() → Customer", { class: "Customer" }], ["label", "() → String", { class: "String" }]]);
  // `customer().name()`: a member of what the record's own accessor returns.
  assert.deepEqual(order!.members[2]!.calls.map((call) => [call.callee, call.form]), [["customer().name", { kind: "result", of: { call: { kind: "own", member: "customer" } }, member: "name" }], ["customer", { kind: "own", member: "customer" }]]);
  assert.deepEqual([status!.kind, status!.fields, status!.members.map((member) => member.name)], ["class", [{ name: "NEW", class: "Status" }, { name: "PAID", class: "Status" }], ["open"]]);
  assert.deepEqual(test!.calls.map((call) => [call.callee, call.form]), [["Clock.fixed", { kind: "member", head: "Clock", member: "fixed" }]]);
  assert.deepEqual(test!.members[0]!.calls.map((call) => [call.callee, call.form]), [["assertEquals", { kind: "member", head: "Assertions", member: "assertEquals" }], ["new Order(\"a\", null).label", { kind: "typed", type: "Order", member: "label" }], ["Order", { kind: "name", name: "Order" }]]);
});
