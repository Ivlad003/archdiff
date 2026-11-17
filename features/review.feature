Feature: Reviewing a change by its architecture
  The diff of two revisions as counts, a picture and Markdown, for pull requests.

  Scenario: A new dependency between layers fails the review
    Given a repository committed on main
    And a change that makes a routes module import a db module
    When I run "archdiff review --base HEAD"
    Then the exit code is 1
    And the Markdown names "+routes→db"

  Scenario: The marks lie over a layer view
    Given a change that edits "src/lib/log.ts" and adds a function to it
    When I run "archdiff diagram layer:lib --changes --base HEAD --depth 0"
    Then "src/lib/log.ts" carries the changed mark
    And "src/lib/orders.ts" carries no mark

  Scenario: Only the change and its neighbours
    Given the same change
    When I run "archdiff diagram layer:lib --changes --base HEAD --only-changes"
    Then the picture holds only "src/lib/log.ts" and "src/lib/orders.ts"

  Scenario: Outside git
    Given a directory that is not a git repository
    When I run "archdiff review"
    Then the exit code is 2
    And stderr says "is not a git repository"

  Scenario: The timeline at one commit, and what git says of the files
    Given a branch of four commits by two authors, two of which change log.ts and step1.ts together
    When I run "archdiff diagram timeline --at" with the second commit
    Then the picture is the map of the code at that commit with log.ts and step1.ts marked changed
    When I run "archdiff diagram modules --overlay churn,coupling,ownership"
    Then step1.ts is labelled "3 changes" and "◉ Bob 67%"
    And a line "×2" joins log.ts and step1.ts without moving a shape

  Scenario: The uncommitted changes as a board
    Given a repository committed on main
    And a working tree that adds a loader to the route and a module the orders call
    When I run "archdiff diagram changes"
    Then the walk lists "routes · src/routes/" before "lib · src/lib/"
    When I run "archdiff diagram changes:lib:src/lib"
    Then the picture marks the new call in green and the page ends with the diff of the group's files

  Scenario: Several heads against one base
    Given branches a and b off main
    When I run "archdiff compare --heads a,b,WORKTREE"
    Then one picture holds the union of their changes
    And every changed module carries a glyph per head

  Scenario: The comment on a pull request
    Given the Markdown of a review that added a module and an import across two layers
    And the report of a check the code follows
    When the body of the pull request's comment is built
    Then its first line is the hidden marker "<!-- archdiff:pull-request-comment -->"
    And it holds the review's counts, the verdict, the picture and every change by kind, folded

  Scenario: A pull request with no architectural change
    Given the Markdown of a review of two source files changed in their comments only
    When the body of the pull request's comment is built
    Then it says "No architectural change" in one line
    And it has no picture

  Scenario: A failing check in the comment
    Given the report of a check with an import from db to routes against the contract
    When the body of the pull request's comment is built
    Then it says "✘ 1 import goes against ARCHITECTURE.md"
    And it lists the import with its line and its two layers

  Scenario: A review longer than a comment may be
    Given the Markdown of a review of 1800 changes
    When the body of the pull request's comment is built
    Then it is at most 65536 characters long
    And the picture is whole
    And every list holds the same number of its first items and counts the rest
