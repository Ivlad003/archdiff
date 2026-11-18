# archdiff for GitHub (Chrome)

[archdiff](https://github.com/Ivlad003/archdiff) beside a page of GitHub. Open a pull request, a comparison, a branch or a commit, press the extension's button, and Chrome's side panel shows the picture archdiff draws of it: which modules, functions, imports and calls the change added, removed and changed, on the layers of the code. Tap a shape, and the tab goes to that file — in the pull request's list of files when the change touched it.

The extension draws nothing itself and reads none of your code. It finds the `archdiff web` running in your checkout of the repository, on your computer, and shows that server's page: the pictures are the same as in the terminal and in the browser, and nothing of the code leaves the computer.

## Install

The extension is in no store: it is installed from its build.

1. Download `archdiff-chrome-<version>.zip` from [the builds page](https://ivlad003.github.io/archdiff/) or from [the releases](https://github.com/Ivlad003/archdiff/releases), and unpack it into a folder that stays where it is.
2. Open `chrome://extensions` and turn on *Developer mode* (top right).
3. Press *Load unpacked* and pick that folder. Pin the extension's button to the toolbar.

To update, unpack the newer build over the same folder and press the reload arrow on the extension's card. *builds* in the panel opens the builds page with the version you have, and says whether a newer one is out.

Or build it from a checkout of archdiff (Node 22.18 or newer; the package installs nothing of its own, the repository's `npm ci` is enough):

```bash
npm ci
cd chrome
npm run package      # chrome/dist to load unpacked, and archdiff-chrome-<version>.zip
```

## Use

In your checkout of the repository, start archdiff:

```bash
npx @ivlad003/archdiff web
```

It needs an archdiff that says which repository it serves (`GET /api/repository`): a version after 0.8.0. Then open the repository on GitHub and press the extension's button. The panel follows the tab:

| The tab shows | The panel draws |
|---|---|
| a pull request, on any of its tabs | the review from where its head left its base, as GitHub lists its files |
| a comparison (`/compare/main...feature`) | the review of the head from their merge-base |
| a branch off the main line, or a file of one | the review of the branch against the main line; a file's own picture first |
| the main line, or a file of it | the layers of the code; a file's imports and its inside |
| a commit | that commit's own change |
| any other page of the repository | the checkout as it is: the layers, the uncommitted changes, the branches |

The select at the top switches between the pictures of the same subject — for a change: the review, the layers with the change marked, the impact (what it could break), the commits one by one, the code of the head. The choice is remembered for each kind of page. **⟳** looks again (after a fetch, a new push to the pull request, a server just started), **↗** opens the picture in a tab of its own with the whole page of archdiff, and *whole page* shows that page in the panel itself, with its lists and its Code tab, instead of the picture alone.

**The checkout has to have the commits.** archdiff reads git on your computer. The branches of a pull request are found as `<remote>/<branch>`; when the checkout has not got them, or is behind the pull request, the panel shows the one command that fetches it — the same for a pull request from a fork:

```bash
git fetch origin pull/123/head:refs/remotes/origin/pr/123
```

Run it in the checkout and press *look again*. Nothing is fetched for you: the extension sends the server nothing but questions.

**Where the server is looked for.** `archdiff web` takes port 7080, or the next free one above it; the panel asks the ports 7080 to 7099 of `127.0.0.1` which repository each serves, and shows the one whose remote is the repository of the tab. A server on another port (`--port`, or the one the VS Code extension starts) is added by its port on the card that says none was found. Only this computer is ever asked.

**A private repository.** The two branches of a pull request are asked of GitHub's API, which answers for a public repository. For a private one the extension reads the pull request's own page with your session in this browser, and takes the two branch names and the head's commit from it; nothing of that goes anywhere but into the question it asks your own archdiff.

## What it asks of Chrome

- *the side panel* and *its own storage* (the picture chosen for each kind of page, the ports you added, whether the whole page is shown);
- `https://github.com/*`: the address of the tab when it is GitHub's — no other tab's address is visible to it — and a pull request's page;
- `http://127.0.0.1/*` and `http://localhost/*`: the archdiff of your checkout. Its pages can frame and reach nothing else but GitHub.

## Good to know

- GitHub only (github.com). GitLab, Bitbucket and GitHub Enterprise are not read yet.
- The panel's texts are in the browser's language, English or Ukrainian; the page in the frame is in the language of archdiff's own settings.
- The tab is sent to a file as a link would send it: GitHub asks before a comment you have not posted is lost.
- A file the change did not touch opens at the head's revision; arriving there does not change the picture, and going back to the pull request does not draw it again.
- Chrome writes a line to the panel's console for every port nobody listens on. They are the search, not an error.

## Working on it

```bash
npm run typecheck    # the types, the build script's and the builds page's too
npm test             # the parts, the parts against the archdiff of this checkout, and the extension in a real Chrome
npm run build        # chrome/dist
```

`npm test` runs in the repository: it starts the archdiff around it on a temporary checkout, builds the extension, loads it into Chrome over the debugging protocol (Chrome's own build takes no extension from its command line any more) and opens the panel as a page pinned to an address: `panel.html?url=<address of GitHub>&server=<address of a server>`. The tests that need Chrome are skipped without it. Nothing is asked of GitHub: the pull request's ends are tested on the answers GitHub gave on 2026-11-18.

`scripts/icons.mjs` draws the icons again from `static/icons/icon.svg`. The builds page the extension carries is `../site/`, copied in by the build.
