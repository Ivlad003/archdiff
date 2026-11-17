# Publishing

A release publishes itself. A tag `v<version>` pushed to GitHub starts `.github/workflows/publish.yml`, which runs the checks of CI on the tagged commit, packs the package, tries the packed file as its user would get it (`archdiff --version`, a picture of this repository) and publishes it to npm. No token is kept in the repository and no one-time code is typed: npm trusts the workflow by its name (trusted publishing, over OIDC), and the package carries the proof of where it was built (provenance, without a flag).

The workflow refuses a tag that is not `v` and the `version` of `package.json`, a tag on a commit that is not on master, and a version npm already has.

## Once: npm is told to trust the workflow

Only the owner of the package can do this, on npmjs.com, signed in:

1. Packages → `@ivlad003/archdiff` → Settings → **Trusted publishing** → GitHub Actions.
2. Organization or user: `Ivlad003`. Repository: `archdiff`. Workflow filename: `publish.yml` (the name alone, with its extension, no path). Environment name: empty.
3. Allowed actions: tick **`npm publish`** too. A new trusted publisher may only stage a package unless it is given this (`npm stage publish`, which waits for an approval — see below).
4. Save.

Three things the page does not say when it saves:

- **The fields are checked at the first publish, not at the save**, and they are case-sensitive: `Ivlad003`, not `ivlad003`. The `repository.url` of `package.json` must be this repository's (it is).
- **A new trusted publisher that publishes nothing for two days expires** and cannot be used or edited any more. Add it when the next release is about to be tagged, not weeks before.
- It needs a runner of GitHub's own; the workflow uses one.

When the first release has gone through, the tokens can be closed: Settings → Publishing access → *Require two-factor authentication and disallow tokens*. The workflow is not a token and keeps publishing.

## Every release

```bash
# 1. the version and the changelog ("## Unreleased" becomes "## 0.8.0 — <date>")
npm version 0.8.0 --no-git-tag-version
$EDITOR CHANGELOG.md
git commit -am "Release 0.8.0"

# 2. master first: the tag must be on a commit of master
git push origin master

# 3. the tag is the release
git tag v0.8.0
git push origin v0.8.0
```

The run is under Actions → *publish*: its `test` job takes what CI takes, then `publish` packs, tries and publishes; its summary names the version and its page on npm. Nothing else is needed. The tag can be pushed with master in one command; waiting for CI's `test` job on the release commit first only saves a tag when a test fails on Linux that passed at home.

## When the run fails

- **In `test`**: nothing was published. Fix it on master, move on to the next version — or, when the tagged commit itself is to be released after a flaky test, run the failed job again from the run's page.
- **In `publish`, before the last step** (the tag is not the version, the commit is not on master, the version is on npm already, the packed file does not run): nothing was published; the message says which. A tag on the wrong commit is deleted (`git push origin :v0.8.0`, `git tag -d v0.8.0`) and made again.
- **In the last step, with a 401, 403 or 404 from npm**: npm did not find the workflow among the package's trusted publishers. The usual causes: a field of the trusted publisher that is not exactly `Ivlad003`, `archdiff`, `publish.yml`; `npm publish` not ticked among its allowed actions; a trusted publisher that expired unused. Correct it on npmjs.com and run the failed job again: the same tag, the same commit.

## By hand, when the workflow cannot

The way every release up to 0.7.0 went, and the way back if GitHub or the trust is down:

```bash
git clone https://github.com/Ivlad003/archdiff.git && cd archdiff && git checkout v0.8.0
npm ci
npm pack                                   # prepack builds dist/
npm login                                  # the account has two-factor auth
npm publish ./ivlad003-archdiff-0.8.0.tgz --access public
```

Pack from a clean clone, not from a checkout with work in it. The file can be tried before it is published: `npm install <the .tgz>` in an empty directory, then `npx archdiff --version`, `npx archdiff diagram layers <repo>` and `npx archdiff web <repo>`.

## With an approval instead

npm can hold what a workflow sends until a maintainer approves it with two-factor auth (staged publishing; npm 11.15 or later). For that the last step of the workflow stages instead of publishing — `npm stage publish` in place of `npm publish`, after the package is built — and the trusted publisher needs no `npm publish` among its allowed actions; the release then waits under *Staged Packages* on npmjs.com (or `npm stage approve <stage-id>`). The workflow here publishes directly, and the staged way has not been tried on this package: whether `npm stage publish` builds the package as `npm publish` does (prepack) is to be checked before relying on it.

## What a release holds

`prepack` builds `dist/` (tsc, the grammars, the page's bundle) and swaps `bin/archdiff.js` to the compiled entry; `postpack` swaps it back, so the checkout keeps running from `src/` with Node's type stripping. `npm pack --dry-run`, which CI runs on every push, lists what the file holds: `bin`, `dist`, `dist/wasm`, `dist/web`; no tests, no sources.

The package is `@ivlad003/archdiff`: npm refused the bare `archdiff` as too similar to `arr-diff` (2026-10-17).

## After

The registry takes a few minutes to serve a new version: `latest` stayed at 0.6.0 for about four minutes after 0.7.0 was published (2026-11-17), and after the first publish of the scope it answered 404, then a placeholder `0.0.0-stage`, then the real version. `npm view @ivlad003/archdiff dist-tags` shows where it is.

```bash
npx @ivlad003/archdiff@latest --version
npx @ivlad003/archdiff@latest web .
```
