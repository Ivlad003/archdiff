# Publishing

The package is published by hand with `npm publish` (the account has two-factor auth, so the publish asks for a one-time code in the browser). The tag `v<version>` marks the release in git; no workflow publishes from it (removed 2026-10-17; bring it back when an automation token is set up).

## Once

1. On npm, create an automation token (Access Tokens → Generate → Automation) and add it to the repository as the `NPM_TOKEN` secret — or set up trusted publishing for `Ivlad003/archdiff` and the `release.yml` workflow on the package's settings page, and drop the `NODE_AUTH_TOKEN` line.
2. The package is `@ivlad003/archdiff`: npm refused the bare `archdiff` as too similar to `arr-diff` (2026-10-17). The scope must be the npm account's own or an organisation it owns; a 403/404 on the scope means the organisation `ivlad003` does not exist yet (create it on npm, free for public packages) or the account's scope is another one.

## Every release

```bash
# 1. the version and the changelog
npm version 0.1.0 --no-git-tag-version   # or edit package.json
$EDITOR CHANGELOG.md
git commit -am "Release 0.1.0"

# 2. what the tarball holds (bin, dist, dist/wasm, dist/web; no tests, no sources)
npm pack --dry-run

# 3. the tag starts the workflow
git tag v0.1.0
git push origin master v0.1.0
```

By hand instead of the workflow:

```bash
npm login
npm publish --access public      # runs prepack: tsc, the grammars, the page bundle
```

`prepack` builds `dist/` and swaps `bin/archdiff.js` to the compiled entry; `postpack` swaps it back, so the checkout keeps running from `src/` with Node's type stripping.

## After

The registry answers 404 for a minute or two after the first publish of a scope, then shows a placeholder version `0.0.0-stage` while it processes the upload, then the real version (seen on 2026-10-17: about two minutes in all). `npm view @ivlad003/archdiff versions` shows where it is.

```bash
npx @ivlad003/archdiff@latest --version
npx @ivlad003/archdiff@latest web .
```
