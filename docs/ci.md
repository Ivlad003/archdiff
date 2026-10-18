# archdiff in CI

## GitHub Actions

The action at the root of this repository (`action.yml`) runs `archdiff review` on a pull request, writes the Markdown (with its Mermaid diagram) to the job summary, posts it as one comment on the pull request (updated on every push, found by its `<!-- archdiff:generated` marker), and fails the check when a new dependency between layers appeared (`review` exits 1). The fact cache is restored from the previous run, so a 2000-file repository reviews in about a second after the first run.

```yaml
# .github/workflows/archdiff.yml
name: archdiff
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # the merge-base needs the history
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: Ivlad003/archdiff@v0
        with:
          fail-on-layer-coupling: "true"
```

`fetch-depth: 0` matters: with a shallow clone `review` has no merge-base and stops with a message naming the fix. `--base` can be given through the `base` input; by default the pull request's base commit is used.

## Any CI

```bash
npx @ivlad003/archdiff review --base origin/main --out archdiff-review.md   # 0 ok, 1 new layer coupling, 2 error
npx @ivlad003/archdiff history --base origin/main --head HEAD              # the drift commit by commit
```

Persist `.archdiff/facts.json.gz` and `.archdiff/revisions.json.gz` between runs (a cache keyed by the lockfile is enough) and the review is sub-second after the first run; the second file holds the base's and the history's files.
