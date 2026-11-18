// The two ends of a pull request, which its address does not say: the branch
// it is to be merged into, the branch it comes from, the commit that branch
// is at and the repository it is in (a fork has its own). GitHub's API says
// them for a public repository; for a private one, the pull request's own
// page does, read with the reader's session — the data the page embeds for
// its own script. Nothing but the number of the pull request is asked of
// GitHub, and what is read goes no further than this computer.
//
// Entry points: `pullEnds`, `pullFromApi`, `pullFromPage`, `PullEnds`.

import type { RepositoryPage } from "./hosts.ts";

export interface PullEnds {
  /** The branch the pull request is to be merged into. */
  base: string;
  /** The branch it comes from, as its own repository names it. */
  head: string;
  /** The commit the head is at on GitHub; null when the page did not say. */
  headSha: string | null;
  /** The repository the head is in, `owner/name`: another one than the pull request's when it comes from a fork; null when unknown. */
  headRepository: string | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function sha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value) ? value.toLowerCase() : null;
}

/** The ends in the answer of `GET /repos/{owner}/{repo}/pulls/{number}`; null when it is not one. */
export function pullFromApi(answer: unknown): PullEnds | null {
  if (typeof answer !== "object" || answer === null) return null;
  const { base, head } = answer as { base?: { ref?: unknown }; head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } | null } };
  const baseRef = text(base?.ref);
  const headRef = text(head?.ref);

  return baseRef === null || headRef === null ? null : { base: baseRef, head: headRef, headSha: sha(head?.sha), headRepository: text(head?.repo?.full_name) };
}

/** The first of the named string fields in a text that holds JSON somewhere: `"name":"value"`, the value read as JSON writes it. */
function field(source: string, names: readonly string[]): string | null {
  for (const name of names) {
    const found = new RegExp(`"${name}":("(?:[^"\\\\]|\\\\.)*")`).exec(source);

    if (!found) continue;

    try {
      const value = text(JSON.parse(found[1]!));

      if (value !== null) return value;
    } catch {
      // Not a string of JSON after all: the next name.
    }
  }

  return null;
}

/**
 * The ends in the page of a pull request: the data GitHub embeds in it for its own script names the two branches
 * (`baseBranch` and `headBranch`; `baseRefName` and `headRefName` in an older page), the head's commit and its
 * repository. Null when the page names no two branches — another page, or a GitHub that writes them otherwise.
 */
export function pullFromPage(html: string): PullEnds | null {
  // Embedded in a script the JSON is as it is; in an attribute its quotes are written as entities.
  for (const source of [html, html.replaceAll("&quot;", '"')]) {
    const base = field(source, ["baseBranch", "baseRefName"]);
    const head = field(source, ["headBranch", "headRefName"]);

    if (base === null || head === null) continue;
    const owner = field(source, ["headRepositoryOwnerLogin"]);
    const name = field(source, ["headRepositoryName"]);

    return { base, head, headSha: sha(field(source, ["headSha", "headRefOid"])), headRepository: owner !== null && name !== null ? `${owner}/${name}` : null };
  }

  return null;
}

/** What `pullEnds` asks with: `fetch`, or a stand-in for it. */
export type Fetcher = (address: string, init?: { credentials?: "include" | "omit"; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/**
 * The ends of pull request `number` of a repository: asked of GitHub's API first (a written contract, which answers
 * for a public repository without a sign-in), then read from the pull request's page as the reader's browser gets
 * it (their session: a private repository too). Null when neither says.
 */
export async function pullEnds(page: RepositoryPage, number: number, fetcher: Fetcher): Promise<PullEnds | null> {
  const repository = `${encodeURIComponent(page.owner)}/${encodeURIComponent(page.repo)}`;

  try {
    const answer = await fetcher(`https://api.${page.host}/repos/${repository}/pulls/${number}`, { credentials: "omit", headers: { accept: "application/vnd.github+json" } });
    const ends = answer.ok ? pullFromApi(await answer.json()) : null;

    if (ends) return ends;
  } catch {
    // Offline, or the API out of reach: the page may still say.
  }

  try {
    const answer = await fetcher(`https://${page.host}/${repository}/pull/${number}`, { credentials: "include" });

    return answer.ok ? pullFromPage(await answer.text()) : null;
  } catch {
    return null;
  }
}
