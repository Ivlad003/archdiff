// The view of a place in the editor and the address of the page on it
// (src/views.ts): a file's path as archdiff names it, the function the
// cursor is in among archdiff's own, and the link the panel's frame gets.
//
// Entry point: run by `npm test` in vscode/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { functionAt, functionsOfInside, functionView, insideRequest, moduleView, pageUrl, repositoryPath, type FunctionSpot } from "../src/views.ts";

/** The functions of the sample's src/lib/orders.ts, as its inside picture names them: three functions, and a class with its methods. */
const ORDERS: FunctionSpot[] = [
  { id: "src/lib/orders.ts#placeOrder", line: 7, endLine: 13 },
  { id: "src/lib/orders.ts#validate", line: 15, endLine: 17 },
  { id: "src/lib/orders.ts#findOrder", line: 19, endLine: 21 },
  { id: "src/lib/orders.ts#OrderService", line: 23, endLine: 31 },
  { id: "src/lib/orders.ts#OrderService.constructor", line: 24, endLine: 24 },
  { id: "src/lib/orders.ts#OrderService.place", line: 25, endLine: 27 },
  { id: "src/lib/orders.ts#OrderService.nextId", line: 28, endLine: 30 },
];

test("a file is named as archdiff names it: relative to the workspace folder, with slashes; a file outside the folder has no name", () => {
  assert.equal(repositoryPath("/home/dev/shop", "/home/dev/shop/src/lib/orders.ts", "linux"), "src/lib/orders.ts");
  assert.equal(repositoryPath("/home/dev/shop", "/home/dev/other/src/x.ts", "linux"), null);
  assert.equal(repositoryPath("/home/dev/shop", "/home/dev/shop", "linux"), null);
  // A sibling whose name starts alike is outside too.
  assert.equal(repositoryPath("/home/dev/shop", "/home/dev/shop-api/x.ts", "linux"), null);
  // Windows: backslashes become slashes, and the letters' case is no difference; another drive is outside.
  assert.equal(repositoryPath("C:\\Users\\dev\\shop", "c:\\users\\dev\\shop\\src\\lib\\orders.ts", "win32"), "src/lib/orders.ts");
  assert.equal(repositoryPath("C:\\Users\\dev\\shop", "D:\\shop\\src\\x.ts", "win32"), null);
});

test("a file's view is its module's, a function's the kind chosen with archdiff's ID", () => {
  assert.equal(moduleView("src/lib/orders.ts"), "module:src/lib/orders.ts");
  assert.equal(functionView("calls", "src/lib/orders.ts#OrderService.place"), "calls:src/lib/orders.ts#OrderService.place");
  assert.equal(functionView("logic", "src/lib/orders.ts#validate"), "logic:src/lib/orders.ts#validate");
});

test("the function at the cursor is the innermost one whose lines hold it; between functions there is none", () => {
  assert.equal(functionAt(ORDERS, 7)?.id, "src/lib/orders.ts#placeOrder");
  assert.equal(functionAt(ORDERS, 13)?.id, "src/lib/orders.ts#placeOrder");
  // A method, not the class around it; the class on a line of its own.
  assert.equal(functionAt(ORDERS, 26)?.id, "src/lib/orders.ts#OrderService.place");
  assert.equal(functionAt(ORDERS, 24)?.id, "src/lib/orders.ts#OrderService.constructor");
  assert.equal(functionAt(ORDERS, 23)?.id, "src/lib/orders.ts#OrderService");
  assert.equal(functionAt(ORDERS, 31)?.id, "src/lib/orders.ts#OrderService");
  // The imports above the first function, a blank line between two, the end of the file.
  assert.equal(functionAt(ORDERS, 1), null);
  assert.equal(functionAt(ORDERS, 14), null);
  assert.equal(functionAt(ORDERS, 40), null);
  assert.equal(functionAt([], 3), null);
  // The order given does not matter, and a function without a last line runs on to the next one's start.
  assert.equal(functionAt([...ORDERS].reverse(), 26)?.id, "src/lib/orders.ts#OrderService.place");
  assert.equal(functionAt([{ id: "a.py#first", line: 2 }, { id: "a.py#second", line: 9 }], 5)?.id, "a.py#first");
  assert.equal(functionAt([{ id: "a.py#first", line: 2 }, { id: "a.py#second", line: 9 }], 30)?.id, "a.py#second");
  // Two that start on one line: the one that ends first is the inner one.
  assert.equal(functionAt([{ id: "x.ts#outer", line: 3, endLine: 9 }, { id: "x.ts#inner", line: 3, endLine: 3 }], 3)?.id, "x.ts#inner");
});

test("the functions of a file are read from the picture of its inside: its own functions with their lines, not what they call elsewhere", () => {
  const answer = {
    diagram: {
      nodes: [
        { id: "src/lib/orders.ts#validate", kind: "fn", ref: { id: "src/lib/orders.ts#validate", file: "src/lib/orders.ts", line: 15, endLine: 17 } },
        { id: "src/lib/orders.ts#placeOrder", kind: "fn", ref: { id: "src/lib/orders.ts#placeOrder", file: "src/lib/orders.ts", line: 7, endLine: 13 } },
        { id: "src/lib/orders.ts#old", kind: "fn", ref: { file: "src/lib/orders.ts", line: 40 } },
        // A function of another file the module calls, a shape that is no function, and shapes without a place.
        { id: "src/db/store.ts#saveOrder", kind: "fn", ref: { file: "src/db/store.ts", line: 6, endLine: 8 } },
        { id: "src/lib/orders.ts", kind: "module", ref: { file: "src/lib/orders.ts" } },
        { id: "src/lib/orders.ts#ghost", kind: "fn" },
        { id: "src/lib/orders.ts#lineless", kind: "fn", ref: { file: "src/lib/orders.ts" } },
        null,
      ],
    },
    markdown: "",
  };

  assert.deepEqual(functionsOfInside(answer, "src/lib/orders.ts"), [
    { id: "src/lib/orders.ts#placeOrder", line: 7, endLine: 13 },
    { id: "src/lib/orders.ts#validate", line: 15, endLine: 17 },
    { id: "src/lib/orders.ts#old", line: 40 },
  ]);

  // An answer of another form names no function.
  for (const other of [null, [], "text", {}, { diagram: null }, { diagram: { nodes: "many" } }, { error: "unknown view" }]) assert.deepEqual(functionsOfInside(other, "src/lib/orders.ts"), []);
});

test("the request for a module's inside and the page's address carry the path and the view as a query writes them", () => {
  assert.equal(insideRequest("src/lib/orders.ts"), "/api/diagram?view=inside%3Asrc%2Flib%2Forders.ts&limit=2000");
  assert.equal(new URLSearchParams(insideRequest("src/a b/x&y.ts").split("?")[1]).get("view"), "inside:src/a b/x&y.ts");

  const origin = "http://127.0.0.1:7123";
  assert.equal(pageUrl(origin, null, false), "http://127.0.0.1:7123/?host=1");
  assert.equal(pageUrl(origin, "module:src/lib/orders.ts", false), "http://127.0.0.1:7123/?host=1#view=module%3Asrc%2Flib%2Forders.ts");
  assert.equal(pageUrl(origin, "calls:src/lib/orders.ts#OrderService.place", true), "http://127.0.0.1:7123/?host=1&embed=1#view=calls%3Asrc%2Flib%2Forders.ts%23OrderService.place");
  // The page reads the hash as a query: the view comes back as written, `#` and all.
  const url = new URL(pageUrl(origin, "calls:src/a b/x.ts#f", true));
  assert.equal(new URLSearchParams(url.hash.slice(1)).get("view"), "calls:src/a b/x.ts#f");
  assert.deepEqual([url.searchParams.get("host"), url.searchParams.get("embed")], ["1", "1"]);
});
