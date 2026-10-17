# Publishing

The package publishes from a git tag through `.github/workflows/release.yml`; the tag must equal `v<version>` of package.json. Locally, the same can be done by hand.

## Once

1. On npm, create an automation token (Access Tokens → Generate → Automation) and add it to the repository as the `NPM_TOKEN` secret — or set up trusted publishing for `Ivlad003/archdiff` and the `release.yml` workflow on the package's settings page, and drop the `NODE_AUTH_TOKEN` line.
2. The name `archdiff` is free on npm (checked 2026-10-15); the first publish claims it.

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

```bash
npx archdiff@latest --version
npx archdiff@latest web .
```
