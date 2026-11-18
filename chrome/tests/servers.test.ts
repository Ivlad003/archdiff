// The archdiff of a repository (src/servers.ts): which addresses are asked,
// what an answer is taken for, and which server is the repository's — with
// stand-ins for the servers, and once against the archdiff of this checkout,
// whose answer is the contract.
//
// Entry point: run by `npm test` in chrome/.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { test } from "node:test";
import { ask, candidates, localOrigin, remoteFor, serving, type Fetcher, type Served } from "../src/servers.ts";
import { startArchdiff } from "./server.ts";

test("an address added is a port of this computer, and nothing else", () => {
  assert.equal(localOrigin("7123"), "http://127.0.0.1:7123");
  assert.equal(localOrigin(" localhost:7123 "), "http://localhost:7123");
  assert.equal(localOrigin("http://127.0.0.1:9000/#view=layers"), "http://127.0.0.1:9000");

  for (const other of ["", "archdiff", "127.0.0.1", "192.168.1.5:7080", "example.com:7080", "https://127.0.0.1:7080", "http://127.0.0.1.example.com:7080", "ftp://localhost:21"]) assert.equal(localOrigin(other), null, other);
});

test("the addresses asked are the reader's own, then the ports archdiff web takes by itself, each once", () => {
  const asked = candidates(["7090", "nonsense", "localhost:9000"]);

  assert.deepEqual(asked.slice(0, 3), ["http://127.0.0.1:7090", "http://localhost:9000", "http://127.0.0.1:7080"]);
  assert.equal(asked.length, 21);
  assert.equal(new Set(asked).size, asked.length);
  assert.equal(asked[asked.length - 1], "http://127.0.0.1:7099");
  assert.deepEqual(candidates([]).slice(0, 2), ["http://127.0.0.1:7080", "http://127.0.0.1:7081"]);
});

const SHOP: Served = { origin: "http://127.0.0.1:7080", name: "shop", root: "/home/me/shop", version: "0.9.0", remotes: [{ name: "origin", host: "github.com", path: "me/shop" }, { name: "upstream", host: "github.com", path: "Acme/Shop" }] };

/** Servers by their origin: what each answers to `GET /api/repository`. */
function servers(answers: Record<string, { status: number; body: unknown } | "refuses">): Fetcher {
  return async (address) => {
    const answer = answers[new URL(address).origin] ?? "refuses";

    if (answer === "refuses") throw new TypeError("Failed to fetch");

    return { status: answer.status, json: async () => (typeof answer.body === "string" ? (JSON.parse(answer.body) as unknown) : answer.body) };
  };
}

test("an answer is an archdiff that says what it serves, one too old to say, or nothing of archdiff's", async () => {
  const { origin, ...said } = SHOP;
  const fetcher = servers({
    "http://127.0.0.1:7080": { status: 200, body: { ...said, remotes: [...said.remotes, { name: "broken" }, "text"] } },
    "http://127.0.0.1:7081": { status: 404, body: { error: "no such API" } },
    "http://127.0.0.1:7082": { status: 404, body: { message: "Not Found" } },
    "http://127.0.0.1:7083": { status: 200, body: "<html>" },
    "http://127.0.0.1:7084": { status: 200, body: { name: "x" } },
    "http://127.0.0.1:7085": { status: 200, body: null },
  });

  // What is no remote in the answer is left out, the rest kept.
  assert.deepEqual(await ask(origin, fetcher), { kind: "served", served: SHOP });
  assert.deepEqual(await ask("http://127.0.0.1:7081", fetcher), { kind: "old", origin: "http://127.0.0.1:7081" });

  // Another program's 404, a page that is no JSON, an answer of another shape, nobody listening.
  for (const port of [7082, 7083, 7084, 7085, 7086]) assert.deepEqual(await ask(`http://127.0.0.1:${port}`, fetcher), { kind: "none" }, String(port));
});

test("a server that never answers is not waited for", async () => {
  const never: Fetcher = (_address, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
  const started = Date.now();

  assert.deepEqual(await ask("http://127.0.0.1:7080", never, 50), { kind: "none" });
  assert.ok(Date.now() - started < 2000);
});

test("the repository's server is the one with a remote at its address, whatever the case and the remote's name", async () => {
  assert.equal(remoteFor(SHOP, { host: "github.com", owner: "acme", repo: "shop" }), "upstream");
  assert.equal(remoteFor(SHOP, { host: "github.com", owner: "ME", repo: "Shop" }), "origin");
  assert.equal(remoteFor(SHOP, { host: "github.com", owner: "acme", repo: "other" }), null);
  assert.equal(remoteFor(SHOP, { host: "gitlab.com", owner: "acme", repo: "shop" }), null);

  const { origin: _origin, ...said } = SHOP;
  const other = { name: "docs", root: "/home/me/docs", version: "0.9.0", remotes: [{ name: "origin", host: "github.com", path: "acme/docs" }] };
  const fetcher = servers({ "http://127.0.0.1:7080": { status: 200, body: other }, "http://127.0.0.1:7081": { status: 404, body: { error: "no such API" } }, "http://127.0.0.1:7083": { status: 200, body: said } });
  const origins = ["http://127.0.0.1:7080", "http://127.0.0.1:7081", "http://127.0.0.1:7082", "http://127.0.0.1:7083"];
  const search = await serving({ host: "github.com", owner: "acme", repo: "shop" }, origins, fetcher);

  assert.deepEqual(search.match, { served: { ...SHOP, origin: "http://127.0.0.1:7083" }, remote: "upstream" });
  // Everything that answered is told, for the note that says what was found instead.
  assert.deepEqual(search.found.map((served) => served.name), ["docs", "shop"]);
  assert.deepEqual(search.old, ["http://127.0.0.1:7081"]);
  assert.equal((await serving({ host: "github.com", owner: "acme", repo: "none" }, origins, fetcher)).match, null);
});

test("the archdiff of this checkout says which repository it serves, by host and path and without who signs in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "archdiff-chrome-served-"));
  cpSync(join(import.meta.dirname, "..", "..", "tests", "fixtures", "sample"), dir, { recursive: true });

  for (const args of [["init", "-q", "-b", "main"], ["remote", "add", "origin", "https://reader:secret@github.com/acme/shop.git"], ["remote", "add", "mirror", "git@gitlab.example.com:group/sub/shop.git"], ["remote", "add", "disk", "../elsewhere"]]) {
    const result = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }

  const { origin, stop } = startArchdiff(dir);

  try {
    const answer = await ask(await origin, (address, init) => fetch(address, init), 30_000);

    assert.equal(answer.kind, "served");
    const served = (answer as { served: Served }).served;
    assert.equal(served.origin, await origin);
    assert.equal(served.name, basename(dir));
    assert.match(served.version, /^\d+\.\d+\.\d+/);
    // A remote that is a path on this computer is hosted nowhere, and is not told.
    assert.deepEqual(served.remotes, [{ name: "origin", host: "github.com", path: "acme/shop" }, { name: "mirror", host: "gitlab.example.com", path: "group/sub/shop" }]);
    assert.equal(remoteFor(served, { host: "github.com", owner: "Acme", repo: "Shop" }), "origin");
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});
