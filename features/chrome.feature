Feature: The Chrome extension and the builds page
  archdiff beside a page of GitHub: the side panel shows the picture of what the tab shows, drawn by the archdiff of the reader's checkout, and a tapped shape sends the tab to that file on GitHub.
  The scenarios here are the ones chrome/tests run (npm test in chrome/): the parts by themselves, the parts against the archdiff of this checkout, and the built extension loaded into a real Chrome.

  Scenario: What an address of GitHub shows
    Given the address "https://github.com/acme/shop/pull/12/files"
    Then it is pull request 12 of acme/shop, on the tab of its files
    Given "https://github.com/acme/shop/compare/main...someone:fix"
    Then it is the comparison of main with fix, of the fork of someone
    Given "https://github.com/acme/shop/tree/feature/x/src/lib" and a checkout with a branch feature/x
    Then the branch is feature/x and the directory src/lib
    Given "https://github.com/settings/profile", or an address of another site
    Then it is no repository's page

  Scenario: The two ends of a pull request
    Given a public repository
    Then GitHub's API says the two branches, the head's commit and its repository, asked without the reader's session
    Given a private one, which the API does not know
    Then the pull request's page says them, read with the reader's session from the data it embeds
    Given neither says
    Then the panel says the branches could not be read

  Scenario: The archdiff of the repository
    Given archdiff web running on a checkout whose remote is "https://reader:secret@github.com/acme/shop.git"
    Then it says it serves github.com/acme/shop, and neither "reader" nor "secret"
    And the panel on a page of acme/shop finds it among the ports 7080 to 7099 and the addresses added
    Given a page of acme/other
    Then the panel says no archdiff serves acme/other on this computer, and names the one it found
    Given an archdiff from before it could say what it serves
    Then its address is named as too old

  Scenario: A pull request is reviewed from where its head left its base
    Given pull request 7 from fix/it at a commit the checkout has as origin/fix/it, into main
    Then the page is framed on the review from their merge-base to origin/fix/it
    Given the checkout has an older commit of the branch only
    Then that one is shown under a note with "git fetch origin pull/7/head:refs/remotes/origin/pr/7"
    Given the pull request comes from a fork and is not fetched
    Then the command is shown in place of a picture, and a branch of the same name here is not taken for it

  Scenario: A comparison in a real Chrome
    Given the built extension loaded into Chrome, and archdiff web on a checkout of acme/shop where feature/loud left main one commit ago
    When the panel is on "https://github.com/acme/shop/compare/main...feature/loud"
    Then the server's page draws the review in the panel's frame, from the merge-base to origin/feature/loud
    And the select offers review, changes, impact, timeline and code
    When I tap the shape of src/lib/log.ts, which the change touched
    Then the tab is sent to the comparison's list of files, at the anchor of that path
    When I pick the layers of the code
    Then the page draws them without being loaded again

  Scenario: A branch, a file, a commit
    Given the panel on the tree of feature/loud
    Then it is framed on the review of origin/feature/loud against the main line
    Given the panel on the file src/lib/orders.ts of main
    Then it is framed on the module's own picture at origin/main
    Given the panel on a commit
    Then it is framed on that commit's own change

  Scenario: What the checkout lacks
    Given the panel on a comparison with a branch the checkout has not got
    Then it names the comparison and shows "git fetch origin"

  Scenario: A place on GitHub
    Given a change whose files are listed at "https://github.com/acme/shop/pull/7/files"
    Then a file the change touched is at that address with "#diff-" and the SHA-256 of its path
    And any other file is read at the head's revision, at its lines: "…/blob/feature/x/src/db/store.ts#L12-L30"

  Scenario: The build
    When I run "npm run package" in chrome/
    Then chrome/dist is the extension Chrome loads, and archdiff-chrome-0.1.0.zip holds its files with the manifest at the root
    And the manifest asks for the side panel, the extension's storage, GitHub's pages and this computer's ports, and no more
    Given the build number 57 and the commit 1a2b3c4d5e
    Then the version is 0.1.0.57, named "0.1.0 build 57 (1a2b3c4)"
    And every text the panel says is in English and in Ukrainian

  Scenario: The builds page
    Given the releases of the repository as GitHub's API lists them
    Then the newest version, the build of master's last commit and the versions before are laid out, each build a file to download
    And a draft, and a release with no build, are not listed
    Given the page opened with "?have=0.1.0" when the build of master's last commit is 0.1.0.61
    Then it says a newer one is out, and links it
    And every text of the page has its Ukrainian
