# Builds Specification

## Purpose

The builds of archdiff's extensions, for people to download: the Chrome extension as a `.zip` to load unpacked and the VS Code extension as a `.vsix`, which no store carries. A workflow builds them and attaches them to releases on GitHub; a page — served by GitHub Pages, and carried inside the Chrome extension — lists them from there.

## Requirements

### Requirement: The Chrome extension is built to a folder and to an archive

The system SHALL, with `npm run build` in `chrome/`, build the extension into `chrome/dist`: the panel's and the worker's scripts bundled (not minified, with nothing left to import), the panel's page, its texts and the icons, the builds page as `builds/`, and the manifest stamped with the version of `chrome/package.json`; and, with `npm run package`, also write `archdiff-chrome-<version>.zip` with every file of that folder, the manifest at the archive's root. The same sources SHALL pack to the same bytes. A build between releases (`ARCHDIFF_BUILD=<number>`) SHALL carry the version `<version>.<number>` — newer than `<version>` and older than the next version, as Chrome compares them — and name its number and its commit (`ARCHDIFF_COMMIT`) in the version people see.

#### Scenario: A release

- **WHEN** `chrome/package.json` says `0.1.0` and no build number is given
- **THEN** the manifest's version is `0.1.0`, with no other name, and the archive is `archdiff-chrome-0.1.0.zip`

#### Scenario: A build of master

- **WHEN** the build number is 57 and the commit `1a2b3c4d5e`
- **THEN** the manifest's version is `0.1.0.57` and its name `0.1.0 build 57 (1a2b3c4)`

### Requirement: The builds are attached to releases on GitHub

The system SHALL, in the workflow `builds.yml`, build both extensions without a way to write to the repository, and then: on a tag `v<version>`, attach them to the release of that tag — making the release when there is none, replacing the builds of one that is there; on a push to master, replace the files of the release `dev` with them and move its tag to the pushed commit, so that `dev` always holds the one build of master's last commit, marked as no release of a version. A run for a version and a run for master SHALL not wait for each other.

#### Scenario: A version is tagged

- **WHEN** the tag `v0.9.0` is pushed
- **THEN** the release *archdiff 0.9.0* holds `archdiff-chrome-<version>.zip` and `archdiff-vscode-<version>.vsix`

#### Scenario: Two pushes to master

- **WHEN** master is pushed twice
- **THEN** `dev` holds the builds of the second push alone, the Chrome one with the higher number

### Requirement: The builds page lists them to download

The system SHALL serve a page (`site/`: three static files and an icon, with no build step) that asks GitHub's API for the releases of the repository when it is opened and lays out the ones that hold a build: the newest version with a button for each build — what it is, its version, its kind of file and its size — the build of master's last commit under its own heading with the day its files were put there, and the versions before as a list. A file SHALL be a build by its name (`archdiff-chrome-<version>.zip`, `archdiff-vscode-<version>.vsix`); a draft and a release without a build SHALL not be listed. The page SHALL say how each extension is installed and updated, say that there are no builds yet when there are none, and when GitHub does not answer say so with a link to the releases. Opened with `?have=<version>` — as the Chrome extension opens the copy it carries — it SHALL say whether that build is the newest, and link the newer one: the newest version's when that is newer, else the build of master's last commit when that is. Its texts SHALL be in English or, for a browser in Ukrainian (or `?lang=uk`), in Ukrainian, every text in both; and it SHALL load nothing but its own files and connect to GitHub's API alone.

#### Scenario: A reader with the newest version

- **WHEN** the page is opened with `?have=0.1.0`, the newest version holds the Chrome build 0.1.0 and `dev` holds 0.1.0.61
- **THEN** it says a newer one is out and links `archdiff-chrome-0.1.0.61.zip`

#### Scenario: No release holds a build yet

- **WHEN** GitHub answers with no release that holds one
- **THEN** the page says there are no builds yet, and how an extension is built from the repository

### Requirement: The builds page is an app that works on a phone and without a network

The system SHALL publish the builds page with a web app manifest (a name, relative `start_url` and `scope`, `standalone` display, icons of 192 and 512 pixels and a maskable one) and a service worker, so that a browser can install it; the page SHALL offer an install button when the browser says it can be installed. The service worker SHALL keep the page's own files, answer from the network first so that a published change is shown at once, answer from what it kept when the network fails or takes over three seconds, and handle no request of another site. The page SHALL keep the last list of releases it read, with the time it was read; when GitHub cannot be asked it SHALL draw that list under a note that says the day it was saved and that downloads need a connection, SHALL show the downloads as out of reach while the browser has no network, and SHALL read the list again by itself when the network comes back. On a screen 320 pixels wide nothing SHALL run off the side of the page, a download SHALL be at least 44 pixels high, and on a touch screen the page SHALL say that the extensions are installed on a computer. Inside the Chrome extension the page SHALL register no service worker.

#### Scenario: Opened without a network

- **WHEN** the page was opened once, and is opened again with no network and the site out of reach
- **THEN** it shows the versions it read last, says the day it saved them, and shows the downloads as out of reach

#### Scenario: The network comes back

- **WHEN** the browser gets a network again while that page is open
- **THEN** the fresh list takes the saved one's place and the note is gone

#### Scenario: A phone

- **WHEN** the page is opened on a touch screen 390 or 320 pixels wide
- **THEN** it does not scroll sideways, and it says the extensions are installed on a computer

### Requirement: The page is published when it changes

The system SHALL, in the workflow `site.yml`, publish `site/` to GitHub Pages as it is on every push to master that changes it, and on request. Until the repository's owner has set Pages to be built by GitHub Actions the workflow SHALL fail and say so, and the builds stay downloadable from the releases.

#### Scenario: The page's script changes

- **WHEN** a push to master changes `site/builds.js`
- **THEN** the page is published again
