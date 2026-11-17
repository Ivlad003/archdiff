# archdiff in CI

## GitHub Actions

The action at the root of this repository (`action.yml`) runs `archdiff review` of a pull request's head against where it left the base (their merge-base) and `archdiff check` against `ARCHITECTURE.md`, writes both to the job summary, keeps them as one comment on the pull request, and fails the job when the check finds an import between layers that the contract does not allow. The comment is rewritten on every push: the action finds its own by the hidden first line `<!-- archdiff:pull-request-comment -->` and creates one when there is none. The fact cache is restored from the previous run, so a 2000-file repository reviews in about a second after the first run.

```yaml
# .github/workflows/archdiff.yml
name: archdiff
on:
  pull_request:
permissions:
  contents: read
  pull-requests: write # the comment
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
        # with:
        #   base: develop          # default: the pull request's base ref
        #   fail-on-check: "false" # default "true": the job fails when archdiff check does
        #   comment: "false"       # default "true"; "false" writes the job summary only
        #   working-directory: packages/api
```

| input | default | what it does |
| --- | --- | --- |
| `base` | the pull request's base ref | The ref the head is compared with, from where it left it (their merge-base), so what the base gained since is not read as the head's doing |
| `fail-on-check` | `true` | Fail the job when `archdiff check` finds an import between layers that `ARCHITECTURE.md` does not allow |
| `comment` | `true` | Keep the comment on the pull request; `false` writes the job summary only |
| `working-directory` | `.` | The directory archdiff runs in: the repository, or one package of it |

The comment holds the review's title and counts, the verdict of the check with its violations (the import, its line, the pair of layers the contract lacks), the dependencies between layers that appeared and went, the Mermaid picture, and every change by kind, folded. A pull request that changed no module, function, import or call gets one line saying so. GitHub takes no comment over 65 536 characters: past it the picture stays and the lists are cut, each to the same number of its first items, with a count of what was left out, then the violations; a picture longer than the limit by itself gives way to a line. The job summary has room for all of it.

`fetch-depth: 0` matters: the action measures from the merge-base of the base and the checkout, whichever the job checked out (the pull request's merge commit or its head), and a clone without the base stops with a message naming the fix. The base ref is looked for as a branch of `origin` too, where a checkout in CI has it. The comment needs `pull-requests: write`; a pull request from a fork gets a read-only token, so the comment is left out with a warning and the job summary still has the review. The check is of the whole code at the head, so an import against the contract that the base already had fails the job too; without an `ARCHITECTURE.md` that names layers there is nothing to check against, and the comment says so. The action needs Node 22.18 or newer (it runs `scripts/pr-comment.ts`, which builds the body, with Node's own type stripping) and runs the published `@ivlad003/archdiff` through `npx`.

## Any CI

```bash
npx @ivlad003/archdiff review --base origin/main --out archdiff-review.md   # 0 ok, 1 new layer coupling, 2 error
npx @ivlad003/archdiff history --base origin/main --head HEAD              # the drift commit by commit
```

Persist `.archdiff/facts.json.gz` and `.archdiff/revisions.json.gz` between runs (a cache keyed by the lockfile is enough) and the review is sub-second after the first run; the second file holds the base's and the history's files.
