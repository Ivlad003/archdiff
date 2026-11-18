# Chrome Extension Specification

## Purpose

archdiff beside a page of GitHub: the side panel of Chrome shows the picture archdiff draws of what the tab shows — the review of a pull request, of a comparison or of a branch, a commit's own change, the code of the main line or of a file — and a shape tapped on it sends the tab to that file on GitHub. The extension (`chrome/`, a package of its own, built to a folder Chrome loads and to a `.zip`) draws and reads nothing of the code itself: it finds the `archdiff web` that serves the repository on the reader's computer, asks it over HTTP and frames its page.

## Requirements

### Requirement: archdiff web says which repository it serves

The system SHALL answer `GET /api/repository` with the name and the path of the folder it serves, its own version, and the remotes of the repository that are hosted somewhere — each by its name, its host in lower case (with the port of an http address that names one) and the repository's path on the host without `.git` — read from `https://host/path`, `ssh://user@host/path` and `user@host:path` alike, and never with the name, the password or the token an address carries. A remote that is a path on the computer SHALL be left out; outside git, or without a remote, the list SHALL be empty.

#### Scenario: A remote with a token in its address

- **WHEN** the remote `origin` is `https://reader:secret@github.com/acme/shop.git`
- **THEN** the answer names `{ "name": "origin", "host": "github.com", "path": "acme/shop" }` and holds neither `reader` nor `secret`

#### Scenario: Outside git

- **WHEN** the folder served is no git repository
- **THEN** the answer has the folder's name, the version and no remote

### Requirement: archdiff web says what the checkout has of a change

The system SHALL answer `GET /api/refs` with the commit each `ref=` names (a branch, a tag, a commit; null for one git does not know in this checkout), in the order asked, at most 24 at once, and — when both `base=` and `head=` are given — with `fork`, the merge-base of the two: the commit a pull request of the head into the base starts from (null when they share none, or when git knows one of them not). It SHALL refuse with 400 a ref git would read as an option, and any ref outside git.

#### Scenario: A branch that left main two commits ago

- **WHEN** `feature` left `main` one commit before `main`'s last, and `/api/refs?ref=main&ref=origin/feature&base=main&head=feature` is asked
- **THEN** `main` has its commit, `origin/feature` has null, and `fork` is the commit before `main`'s last

### Requirement: The panel reads what the tab shows from its address

The system SHALL follow the active tab of the window the panel is in, and read from an address of `https://github.com/<owner>/<repository>/…` what the page shows: a pull request by its number on any of its tabs (`/pull/N`, `/pull/N/files`, `/pull/N/commits`), one commit (`/commit/<sha>`, `/pull/N/commits/<sha>`), a comparison with its two ends (`/compare/<base>...<head>`, the head alone when the address has no base, the head's owner when it names a fork), a branch, a tag or a commit with a directory under it (`/tree/…`, `/commits/…`), a file at a revision (`/blob/…`, `/blame/…`), and for any other page of a repository the repository itself. Where a branch's name ends in `<ref>/<path>` SHALL be decided by the checkout's own branches — the longest that the text starts with, by whole segments — else at the first slash. An address of another site, or of a page of GitHub that is no repository's (`/settings/…`, `/orgs/…`), SHALL show the note that there is nothing to draw. The tab's other tabs of the same subject, and a change of its hash, SHALL leave the picture as it is.

#### Scenario: A branch with a slash in its name

- **WHEN** the tab shows `https://github.com/acme/shop/tree/feature/loud/src/lib` and the checkout has a branch `origin/feature/loud`
- **THEN** the panel's subject is `feature/loud`

#### Scenario: From the conversation to the files

- **WHEN** the tab goes from `/pull/7` to `/pull/7/files`
- **THEN** the picture is not drawn again

### Requirement: The panel finds the archdiff of the repository on this computer

The system SHALL ask `GET /api/repository` of `http://127.0.0.1:7080` to `:7099` at once — the ports `archdiff web` takes by itself — and of every address the reader added, waiting a second and a half for each at most, and show the page of the first server one of whose remotes is the repository of the tab (the host equal, the owner and the name in any case). The server found for a repository SHALL be asked first, alone, the next time. An address added SHALL be a port of `127.0.0.1` or of `localhost` and no other host. When no server serves the repository the panel SHALL say so with the command that starts one (`npx @ivlad003/archdiff web`), list the servers it found with the folder and the remotes of each, and name every address where an archdiff too old to answer the question listens.

#### Scenario: Another repository is served

- **WHEN** the tab shows `acme/other` and the only archdiff running serves `acme/shop`
- **THEN** the panel says no archdiff serves `acme/other` on this computer, and names the one found with `github.com/acme/shop`

#### Scenario: An address of another computer

- **WHEN** the reader adds `192.168.1.5:7080`
- **THEN** it is refused, and nothing is asked of it

### Requirement: A pull request is reviewed from where its head left its base

The system SHALL read the two branches of a pull request, the commit its head is at and the repository the head is in from GitHub's API (`GET /repos/<owner>/<repository>/pulls/N`, without the reader's session), and when that does not say — a private repository, the hourly limit, no network — from the pull request's own page as the reader's browser gets it: the data the page embeds for its script. It SHALL take for the head, among what the checkout has, a name that is at that commit (`<remote>/pr/N`, `<remote>/<branch>` and `<branch>` when the head is in the same repository; never a branch of the same name when it is in a fork), else the commit itself, else whatever it has of the branch; for the base `<remote>/<branch>`, else `<branch>`; and review from the merge-base of the two. When what is shown is not the pull request's commit it SHALL say so with the command `git fetch <remote> pull/N/head:refs/remotes/<remote>/pr/N`; when the checkout has nothing of the head it SHALL show that command in place of a picture, and `git fetch <remote>` when it lacks the base. A pull request whose branches neither source says SHALL be said as such. What is read of a pull request SHALL be kept for two minutes, and read again when the reader asks to look again.

#### Scenario: Up to date

- **WHEN** pull request 7 goes from `fix/it` at commit `b…` into `main`, and the checkout has `origin/fix/it` at `b…` and `origin/main`
- **THEN** the page is framed on `view=review&base=<their merge-base>&head=origin/fix/it`

#### Scenario: From a fork, not fetched

- **WHEN** the head is `main` of `someone/shop` and the checkout has neither its commit nor `origin/pr/7`
- **THEN** the panel shows `git fetch origin pull/7/head:refs/remotes/origin/pr/7`, and the checkout's own `main` is not taken for it

#### Scenario: Behind the pull request

- **WHEN** the checkout has `origin/fix/it` at an older commit and not the pull request's
- **THEN** the review of `origin/fix/it` is shown under a note with the command that fetches the pull request

### Requirement: Every kind of page has its pictures

The system SHALL offer, in a select of the panel, the pictures that fit the page, each as a link of the server's page: for a change (a pull request, a comparison, a branch off the main line) the review, the layers with the change marked, the impact, the commits one by one and the layers of the head's code; for a comparison its ends as the address names them — the remote's branch before the local one, a tag, a fork's branch under the remote of the fork — reviewed from their merge-base, and from where the head left the main line when the address has no base; for a branch that is the main line the layers and every module; for a file that is a module of the code its imports and its inside first; for a commit its own change and the code at it; for the repository itself the checkout as it is: the layers, every module, the uncommitted changes and the branches. A ref the checkout has not got SHALL be named with the command that fetches it, and a base SHALL never be swapped for another. The picture chosen SHALL be remembered for each kind of page.

#### Scenario: A comparison

- **WHEN** the tab shows `/compare/main...feature/loud` of a repository whose checkout has both branches under `origin`
- **THEN** the select offers review, changes, impact, timeline and code, and the frame is on the review from the merge-base to `origin/feature/loud`

#### Scenario: A file of the main line

- **WHEN** the tab shows `/blob/main/src/lib/orders.ts`, a module of the code
- **THEN** the frame is on `view=module:src/lib/orders.ts&head=origin/main`

### Requirement: The picture is the server's own page, and the panel writes nothing

The system SHALL show a picture by framing the server's page on its link, the picture alone and hosted (`?embed=1&host=1`) unless the reader asks for the whole page, which is then framed as it is in a browser. Another picture of the same server SHALL change the view of the page already there without loading it again. The panel SHALL send the server no request but GET, and SHALL keep what it remembers — the pictures chosen, the addresses added, whether the whole page is shown — in the extension's own storage. A button SHALL open the picture in a tab of its own, with the whole page.

#### Scenario: Another picture

- **WHEN** the reader picks *the layers of this code* while the review is shown
- **THEN** the page in the frame draws the layers, and is the same page as before

### Requirement: A place picked on the picture is shown on GitHub

The system SHALL, when the page in the frame tells its host of a place of the code (`archdiff:open`), send the tab to that place on GitHub: a file the change touched to the list of the change's files — the pull request's, the comparison's, the commit's, a branch's comparison with the default branch — under the anchor GitHub gives the file (`#diff-` and the SHA-256 of its path); any other file at the head's revision, in the head's repository, at its lines (`…/blob/<revision>/<path>#L12-L30`). The files of a change SHALL be asked of the server once, when a place is first picked. The message SHALL be taken only from the panel's frame on the server's origin; and the tab arriving where the panel sent it SHALL leave the picture as it is.

#### Scenario: A changed file of a comparison

- **WHEN** the reader taps the shape of `src/lib/log.ts`, which the change touched, on the review of `/compare/main...feature/loud`
- **THEN** the tab goes to that address with `#diff-<the SHA-256 of "src/lib/log.ts">`

#### Scenario: A message from elsewhere

- **WHEN** a window other than the panel's frame posts `archdiff:open`
- **THEN** the tab goes nowhere

### Requirement: The extension asks Chrome for no more than it uses

The system SHALL declare the permissions `sidePanel` and `storage`, the hosts `https://github.com/*`, `http://127.0.0.1/*` and `http://localhost/*`, and a content security policy under which its pages run no script but their own, frame only this computer's servers and connect only to them and to GitHub. It SHALL say its texts in the browser's language, English or Ukrainian, every text in both.

#### Scenario: The built manifest

- **WHEN** the extension is built
- **THEN** its manifest names those two permissions and those three hosts, and no other
