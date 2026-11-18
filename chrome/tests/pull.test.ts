// The two ends of a pull request (src/pull.ts): read from the answer of
// GitHub's API, and from the data the pull request's page embeds — in the
// form GitHub served it in November 2026, and the older names — and which
// of the two is asked when.
//
// Entry point: run by `npm test` in chrome/.

import assert from "node:assert/strict";
import { test } from "node:test";
import { pageOf } from "../src/hosts.ts";
import { pullEnds, pullFromApi, pullFromPage, type Fetcher } from "../src/pull.ts";

const SHA = "b11a0fb4cf95369b4460010a9cf4bbcdf432ffc1";

test("the API's answer names the two branches, the head's commit and its repository", () => {
  assert.deepEqual(pullFromApi({ number: 7, base: { ref: "trunk", sha: "x" }, head: { ref: "fix/it", sha: SHA.toUpperCase(), repo: { full_name: "someone/cli" } } }), { base: "trunk", head: "fix/it", headSha: SHA, headRepository: "someone/cli" });
  // A fork deleted since: the head has no repository any more.
  assert.deepEqual(pullFromApi({ base: { ref: "main" }, head: { ref: "fix", sha: "short", repo: null } }), { base: "main", head: "fix", headSha: null, headRepository: null });

  for (const other of [null, "text", [], {}, { message: "Not Found" }, { base: { ref: "main" } }, { base: { ref: "" }, head: { ref: "x" } }]) assert.equal(pullFromApi(other), null, JSON.stringify(other));
});

test("the page of a pull request names them in the data it embeds for its own script", () => {
  // As GitHub wrote it in November 2026: one object among much else, in a script of the page.
  const page = `<html><body><script type="application/json" data-target="react-app.embeddedData">{"payload":{"pullRequestsLayoutRoute":{"pullRequest":{"author":{"login":"babakks"},"baseBranch":"trunk","headBranch":"babakks/event-listen-dup-note","headRepositoryName":"cli","headRepositoryOwnerLogin":"cli","headSha":"${SHA}","number":15094,"state":"OPEN","title":"say \\"it\\" \\u003conce\\u003e"}}}}</script></body></html>`;

  assert.deepEqual(pullFromPage(page), { base: "trunk", head: "babakks/event-listen-dup-note", headSha: SHA, headRepository: "cli/cli" });
  // A name written as JSON writes it is read as JSON reads it.
  assert.equal(pullFromPage(`{"baseBranch":"main","headBranch":"fix/\\u00e9t\\u00e9-\\"x\\""}`)?.head, 'fix/été-"x"');
  // The names of an older page, and JSON in an attribute, its quotes as entities.
  assert.deepEqual(pullFromPage(`<div data-props="{&quot;baseRefName&quot;:&quot;main&quot;,&quot;headRefName&quot;:&quot;fix&quot;,&quot;headRefOid&quot;:&quot;${SHA}&quot;}"></div>`), { base: "main", head: "fix", headSha: SHA, headRepository: null });
  // A page that names no two branches: a sign-in page, a 404, another GitHub.
  assert.equal(pullFromPage("<html><body>Sign in to GitHub</body></html>"), null);
  assert.equal(pullFromPage(`{"baseBranch":"main"}`), null);
});

test("the API is asked first, without the reader's session; the page next, with it", async () => {
  const page = pageOf("https://github.com/acme/shop/pull/7")!;
  const asked: { address: string; credentials: string | undefined }[] = [];
  const answers = (api: { status: number; body: unknown } | "offline", html: { status: number; body: string }): Fetcher => async (address, init) => {
    asked.push({ address, credentials: init?.credentials });
    const answer = address.startsWith("https://api.") ? api : html;

    if (answer === "offline") throw new TypeError("Failed to fetch");

    return { ok: answer.status === 200, status: answer.status, json: async () => answer.body, text: async () => String(answer.body) };
  };

  // A public repository: the API says, and the page is not read.
  assert.deepEqual(await pullEnds(page, 7, answers({ status: 200, body: { base: { ref: "main" }, head: { ref: "fix", sha: SHA, repo: { full_name: "acme/shop" } } } }, { status: 500, body: "" })), { base: "main", head: "fix", headSha: SHA, headRepository: "acme/shop" });
  assert.deepEqual(asked, [{ address: "https://api.github.com/repos/acme/shop/pulls/7", credentials: "omit" }]);

  // A private one: the API knows none of that name, the page read with the reader's session does.
  asked.length = 0;
  assert.deepEqual(await pullEnds(page, 7, answers({ status: 404, body: { message: "Not Found" } }, { status: 200, body: `{"baseBranch":"main","headBranch":"fix"}` })), { base: "main", head: "fix", headSha: null, headRepository: null });
  assert.deepEqual(asked, [{ address: "https://api.github.com/repos/acme/shop/pulls/7", credentials: "omit" }, { address: "https://github.com/acme/shop/pull/7", credentials: "include" }]);

  // The API out of reach, or out of its hourly answers: the page still says.
  assert.equal((await pullEnds(page, 7, answers("offline", { status: 200, body: `{"baseBranch":"main","headBranch":"fix"}` })))?.head, "fix");
  // Neither says: no ends.
  assert.equal(await pullEnds(page, 7, answers({ status: 403, body: { message: "rate limit" } }, { status: 404, body: "Not Found" })), null);
  assert.equal(await pullEnds(page, 7, async () => Promise.reject(new TypeError("Failed to fetch"))), null);
});
